import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  CompletionItem,
  CompletionItemKind,
  TextDocumentSyncKind,
  Hover,
  MarkupKind,
  Location,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  InlayHint,
  InlayHintKind,
  WorkspaceEdit,
  TextEdit,
  Range,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  SymbolKind,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { KEYWORDS_4GL, KEYWORDS_PER } from './providers/keywords';
import { parsePackageClasses, Package, PackageClass, Method } from './Handlers/packageHandler';
import { ImportType } from './Handlers/importTypes';
import { logError, logInfo, logWarn, setLogWriter } from './utils/logger';

const connection = createConnection(ProposedFeatures.all);
setLogWriter((level, message) => {
  if (level === 'error') {
    connection.console.error(message);
    return;
  }

  if (level === 'warn') {
    connection.console.warn(message);
    return;
  }

  connection.console.log(message);
});
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const workspaceFolders = new Set<string>();
const workspaceFunctionRecordsByUri = new Map<string, FunctionDefinitionRecord[]>();
const diagnosticBucketsByUri = new Map<string, { unused: Diagnostic[]; semantic: Diagnostic[] }>();
const pendingDiagnosticTimers = new Map<string, NodeJS.Timeout>();
const pendingSemanticTokenRefreshTimers = new Map<string, NodeJS.Timeout>();
let workspaceFunctionCacheInitialized = false;
let libraryPathsList: string[] = [];
const libraryFunctionRecordsByUri = new Map<string, FunctionDefinitionRecord[]>();
let libraryFunctionCacheInitialized = false;
const DIAGNOSTIC_DEBOUNCE_MS = 2500;
const SEMANTIC_TOKENS_REFRESH_DEBOUNCE_MS = 80;
const SEMANTIC_TOKEN_TYPES = ['function', 'parameter', 'variable', 'type', 'keyword'] as const;
const SEMANTIC_TOKEN_TYPE_INDEX: Record<(typeof SEMANTIC_TOKEN_TYPES)[number], number> = {
  function: 0,
  parameter: 1,
  variable: 2,
  type: 3,
  keyword: 4
};

logInfo('[LSP Server] Starting Genero FGL Language Server');

connection.onInitialize((params: InitializeParams): InitializeResult => {
  logInfo('[LSP Server] onInitialize called');
  workspaceFolders.clear();
  workspaceFunctionRecordsByUri.clear();
  workspaceFunctionCacheInitialized = false;
  for (const folder of params.workspaceFolders ?? []) {
    if (folder.uri.startsWith('file:')) {
      workspaceFolders.add(URI.parse(folder.uri).fsPath);
    }
  }
  if (workspaceFolders.size === 0 && params.rootUri?.startsWith('file:')) {
    workspaceFolders.add(URI.parse(params.rootUri).fsPath);
  }
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: true
      },
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...SEMANTIC_TOKEN_TYPES],
          tokenModifiers: []
        },
        full: true
      },
      inlayHintProvider: true,
      referencesProvider: true,
      callHierarchyProvider: true,
      renameProvider: {
        prepareProvider: true
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
        retriggerCharacters: [',']
      },
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')
      }
    }
  };
});

connection.onInitialized(async () => {
  logInfo('[LSP Server] onInitialized - server is ready');
  await refreshLibraryPathsAndCache();
});

documents.onDidOpen((event) => {
  logInfo('[LSP Server] Document opened:', event.document.uri, 'languageId:', event.document.languageId);
  updateFunctionDefinitionCache(event.document);
  cancelScheduledValidation(event.document.uri);
  void validateAllDiagnostics(event.document);
});

documents.onDidChangeContent((change) => {
  logInfo('[LSP Server] Document changed:', change.document.uri);
  updateFunctionDefinitionCache(change.document);
  scheduleSemanticTokensRefresh(change.document.uri);
  clearSemanticDiagnostics(change.document.uri);
  scheduleValidation(change.document);
});

documents.onDidSave((event) => {
  logInfo('[LSP Server] Document saved:', event.document.uri);
  updateFunctionDefinitionCache(event.document);
  cancelScheduledValidation(event.document.uri);
  void validateAllDiagnostics(event.document);
});

documents.onDidClose((event) => {
  cancelScheduledValidation(event.document.uri);
  cancelScheduledSemanticTokensRefresh(event.document.uri);
  restoreFunctionDefinitionCacheForUri(event.document.uri);
  diagnosticBucketsByUri.delete(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDidChangeConfiguration(async () => {
  for (const timer of pendingDiagnosticTimers.values()) {
    clearTimeout(timer);
  }
  pendingDiagnosticTimers.clear();
  for (const timer of pendingSemanticTokenRefreshTimers.values()) {
    clearTimeout(timer);
  }
  pendingSemanticTokenRefreshTimers.clear();
  await refreshLibraryPathsAndCache();
  for (const document of documents.all()) {
    void validateAllDiagnostics(document);
  }
  void connection.languages.semanticTokens.refresh();
});

function cancelScheduledValidation(uri: string): void {
  const timer = pendingDiagnosticTimers.get(uri);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  pendingDiagnosticTimers.delete(uri);
}

function scheduleValidation(document: TextDocument): void {
  cancelScheduledValidation(document.uri);
  pendingDiagnosticTimers.set(document.uri, setTimeout(() => {
    pendingDiagnosticTimers.delete(document.uri);
    void validateUnusedDiagnostics(document);
  }, DIAGNOSTIC_DEBOUNCE_MS));
}

function cancelScheduledSemanticTokensRefresh(uri: string): void {
  const timer = pendingSemanticTokenRefreshTimers.get(uri);
  if (!timer) {
    return;
  }

  clearTimeout(timer);
  pendingSemanticTokenRefreshTimers.delete(uri);
}

function scheduleSemanticTokensRefresh(uri: string): void {
  cancelScheduledSemanticTokensRefresh(uri);
  pendingSemanticTokenRefreshTimers.set(uri, setTimeout(() => {
    pendingSemanticTokenRefreshTimers.delete(uri);
    void connection.languages.semanticTokens.refresh();
  }, SEMANTIC_TOKENS_REFRESH_DEBOUNCE_MS));
}

function getKeywords(languageId: string): { name: string; type?: string; description?: string; documentation?: string }[] {
  if (languageId === 'per') return KEYWORDS_PER;
  return KEYWORDS_4GL;
}

const REGEX_PATTERNS = {
  FUNCTION: /^\s*(?:PUBLIC|PRIVATE|STATIC)?\s*FUNCTION\s+([A-Za-z0-9_]+)\b/i,
  REPORT: /^\s*REPORT\s+([A-Za-z0-9_]+)\b/i,
  MAIN_START: /^\s*MAIN\b/i,
  END_FUNCTION: /^\s*END\s+FUNCTION\b/i,
  END_MAIN: /^\s*END\s+MAIN\b/i,
  END_GLOBALS: /^\s*END\s+GLOBALS\b/i,
  FGL_KEYWORDS: /^(END|IF|THEN|ELSE|ELSEIF|FOR|WHILE|CASE|WHEN|RETURN|CALL|LET|DISPLAY|PRINT|MESSAGE|CONTINUE|EXIT|FUNCTION|MAIN|RECORD|TYPE|DEFINE|GLOBAL|GLOBALS|LIKE|TO|FROM|WHERE|SELECT|INSERT|UPDATE|DELETE|NULL|TRUE|FALSE)$/i
};

interface VariableDefinition {
  name: string;
  type: string;
  line: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  scope: 'main' | 'function' | 'module' | 'global';
}

interface FunctionBlock {
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}

interface GlobalsBlock {
  content: string;
  startLine: number;
  endLine: number;
}

interface FunctionDefinitionRecord {
  uri: string;
  block: FunctionBlock;
  signature: EnhancedFunctionSignature | null;
}

interface FunctionCallOccurrence {
  name: string;
  range: Range;
  argumentCount: number;
}

interface SemanticTokenEntry {
  line: number;
  char: number;
  length: number;
  tokenType: (typeof SEMANTIC_TOKEN_TYPES)[number];
}

interface EnhancedFunctionSignature {
  name: string;
  bracketParameters: string[];
  defineParameters: string[];
  allParameters: string[];
}

function stripInlineComment(line: string): string {
  if (!line) return line;
  return line.replace(/#.*/g, '').replace(/--.*$/, '');
}

function maskNonCodePreserveColumns(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const maskedLines: string[] = [];
  let inBlockComment = false;

  for (const sourceLine of lines) {
    const chars = sourceLine.split('');

    for (let index = 0; index < chars.length; index++) {
      if (inBlockComment) {
        if (chars[index] === '}') {
          chars[index] = ' ';
          inBlockComment = false;
        } else {
          chars[index] = ' ';
        }
        continue;
      }

      if (chars[index] === '\'') {
        chars[index] = ' ';
        index++;
        while (index < chars.length) {
          const currentChar = chars[index];
          if (currentChar === '\'' && chars[index + 1] === '\'') {
            chars[index] = ' ';
            chars[index + 1] = ' ';
            index += 2;
            continue;
          }

          chars[index] = ' ';
          if (currentChar === '\'') {
            break;
          }
          index++;
        }
        continue;
      }

      if (chars[index] === '"') {
        chars[index] = ' ';
        index++;
        while (index < chars.length) {
          const currentChar = chars[index];
          if (currentChar === '"' && chars[index + 1] === '"') {
            chars[index] = ' ';
            chars[index + 1] = ' ';
            index += 2;
            continue;
          }

          chars[index] = ' ';
          if (currentChar === '"') {
            break;
          }
          index++;
        }
        continue;
      }

      if (chars[index] === '`') {
        chars[index] = ' ';
        index++;
        while (index < chars.length) {
          const isClosingBacktick = chars[index] === '`';
          chars[index] = ' ';
          if (isClosingBacktick) {
            break;
          }
          index++;
        }
        continue;
      }

      const nextChar = index + 1 < chars.length ? chars[index + 1] : '';
      if (chars[index] === '{') {
        chars[index] = ' ';
        inBlockComment = true;
        continue;
      }

      if (chars[index] === '#') {
        for (let rest = index; rest < chars.length; rest++) {
          chars[rest] = ' ';
        }
        break;
      }

      if (chars[index] === '-' && nextChar === '-') {
        for (let rest = index; rest < chars.length; rest++) {
          chars[rest] = ' ';
        }
        break;
      }
    }

    maskedLines.push(chars.join(''));
  }

  return maskedLines;
}

function extractMainBlock(text: string): { content: string; startLine: number; endLine: number } | null {
  const lines = text.split(/\r?\n/);
  let mainStart = -1;
  let mainEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (REGEX_PATTERNS.MAIN_START.test(line)) {
      mainStart = i;
    }
    if (REGEX_PATTERNS.END_MAIN.test(line) && mainStart !== -1) {
      mainEnd = i;
      break;
    }
  }
  if (mainStart === -1) return null;
  if (mainEnd === -1) mainEnd = lines.length - 1;
  return { content: lines.slice(mainStart, mainEnd + 1).join('\n'), startLine: mainStart, endLine: mainEnd };
}

function extractFunctionBlocks(text: string): FunctionBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: FunctionBlock[] = [];
  let current: FunctionBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]).trim();
    const functionMatch = line.match(REGEX_PATTERNS.FUNCTION);
    if (functionMatch) {
      current = { name: functionMatch[1], content: '', startLine: i, endLine: -1 };
    }
    if (REGEX_PATTERNS.END_FUNCTION.test(line) && current) {
      current.endLine = i;
      current.content = lines.slice(current.startLine, i + 1).join('\n');
      blocks.push(current);
      current = null;
    }
  }
  return blocks;
}

function extractGlobalsBlocks(text: string): GlobalsBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: GlobalsBlock[] = [];
  let startLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]).trim();
    if (/^\s*GLOBALS\b/i.test(line)) {
      startLine = i;
      continue;
    }

    if (startLine !== -1 && REGEX_PATTERNS.END_GLOBALS.test(line)) {
      blocks.push({
        content: lines.slice(startLine, i + 1).join('\n'),
        startLine,
        endLine: i
      });
      startLine = -1;
    }
  }

  if (startLine !== -1) {
    blocks.push({
      content: lines.slice(startLine).join('\n'),
      startLine,
      endLine: lines.length - 1
    });
  }

  return blocks;
}

function findFunctionBlockAtLine(text: string, line: number): FunctionBlock | null {
  for (const block of extractFunctionBlocks(text)) {
    if (line >= block.startLine && line <= block.endLine) {
      return block;
    }
  }
  return null;
}

function parseEnhancedFunctionSignature(functionContent: string): EnhancedFunctionSignature | null {
  const lines = functionContent.split(/\r?\n/);
  const first = stripInlineComment(lines[0] || '');
  const match = first.match(/^\s*(?:PUBLIC|PRIVATE|STATIC)?\s*FUNCTION\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/i);
  if (!match) return null;
  const bracketParams = (match[2] || '').trim()
    ? match[2].split(',').map(part => part.trim()).filter(Boolean)
    : [];
  const defineParams = extractDefineParameters(functionContent, bracketParams);
  return {
    name: match[1],
    bracketParameters: bracketParams,
    defineParameters: defineParams,
    allParameters: Array.from(new Set([...bracketParams, ...defineParams]))
  };
}

function extractDefineParameters(functionContent: string, bracketParameters: string[]): string[] {
  const lines = functionContent.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]).trim();
    if (!line) continue;
    const recordLike = line.match(/^\s*DEFINE\s+([A-Za-z0-9_]+)\s+RECORD\s+LIKE\s+[A-Za-z0-9_\.]+/i);
    if (recordLike) {
      if (bracketParameters.includes(recordLike[1])) out.push(recordLike[1]);
      continue;
    }
    const defineMatch = line.match(/^\s*DEFINE\s+([^#\n]+?)\s+(?:LIKE\s+[A-Za-z0-9_\.]+|STRING|INTEGER|CHAR|DECIMAL|SMALLINT|BIGINT|DATE|DATETIME|VARCHAR|FLOAT|REAL|MONEY|BOOLEAN|BYTE|TEXT)\b/i);
    if (defineMatch) {
      for (const variable of defineMatch[1].split(',').map(part => part.trim()).filter(Boolean)) {
        if (bracketParameters.includes(variable)) out.push(variable);
      }
    }
  }
  return out;
}

function parseRecordDefinition(lines: string[], startIndex: number, actualLineNumber: number, scope: 'main' | 'function' | 'module' | 'global'): VariableDefinition | null {
  const firstLine = stripInlineComment(lines[startIndex]).trim();
  const match = firstLine.match(/^\s*DEFINE\s+([A-Za-z0-9_]+)\s+RECORD\s*$/i);
  if (!match) return null;
  let end = startIndex + 1;
  while (end < lines.length) {
    const candidate = stripInlineComment(lines[end]).trim();
    if (/^\s*END\s+RECORD\s*$/i.test(candidate)) break;
    end++;
  }
  return {
    name: match[1],
    type: 'RECORD',
    line: actualLineNumber,
    range: {
      start: { line: actualLineNumber, character: 0 },
      end: { line: actualLineNumber + (end - startIndex), character: lines[end] ? lines[end].length : 0 }
    },
    scope
  };
}

function parseDefineStatements(blockContent: string, startLineOffset: number, scope: 'main' | 'function' | 'module' | 'global'): VariableDefinition[] {
  const out: VariableDefinition[] = [];
  const lines = blockContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const actualLine = startLineOffset + i;
    const line = stripInlineComment(rawLine);
    if (!line.trim()) continue;
    if (/^\s*(?:PUBLIC|PRIVATE|STATIC)?\s*FUNCTION\s+/i.test(line) || /^\s*END\s+FUNCTION\s*$/i.test(line)) continue;
    if (/^\s*MAIN\b/i.test(line) || /^\s*END\s+MAIN\b/i.test(line)) continue;

    const recordLike = line.match(/^\s*DEFINE\s+([A-Za-z0-9_]+)\s+RECORD\s+LIKE\s+[A-Za-z0-9_\.]+\s*/i);
    if (recordLike) {
      out.push({
        name: recordLike[1],
        type: 'RECORD LIKE',
        line: actualLine,
        range: { start: { line: actualLine, character: 0 }, end: { line: actualLine, character: line.length } },
        scope
      });
      continue;
    }

    const single = line.match(/^\s*DEFINE\s+(.+?)\s+(STRING|INTEGER|SMALLINT|BIGINT|DATE|DATETIME|CHAR|VARCHAR|DECIMAL|FLOAT|REAL|MONEY|BOOLEAN|BYTE|TEXT|DYNAMIC\s+ARRAY\s+OF\s+\w+|LIKE\s+[A-Za-z0-9_]+\.[A-Za-z0-9_]+|LIKE\s+[A-Za-z0-9_\.]+)\s*.*$/i);
    if (single) {
      for (const variable of single[1].split(',').map(part => part.trim())) {
        if (variable && !/^(DEFINE|END|RECORD)$/i.test(variable)) {
          out.push({
            name: variable,
            type: single[2],
            line: actualLine,
            range: { start: { line: actualLine, character: 0 }, end: { line: actualLine, character: line.length } },
            scope
          });
        }
      }
      continue;
    }

    const continuation = line.match(/^\s+([A-Za-z0-9_]+)\s+(STRING|INTEGER|SMALLINT|BIGINT|DATE|DATETIME|CHAR|VARCHAR|DECIMAL|FLOAT|REAL|MONEY|BOOLEAN|BYTE|TEXT|DYNAMIC\s+ARRAY\s+OF\s+\w+|LIKE\s+[A-Za-z0-9_]+\.[A-Za-z0-9_]+|LIKE\s+[A-Za-z0-9_\.]+|[A-Za-z0-9_\.]+)\s*,?\s*$/i);
    if (continuation) {
      if (!REGEX_PATTERNS.FGL_KEYWORDS.test(continuation[1])) {
        out.push({
          name: continuation[1],
          type: continuation[2],
          line: actualLine,
          range: { start: { line: actualLine, character: 0 }, end: { line: actualLine, character: line.length } },
          scope
        });
      }
      continue;
    }

    if (/^\s*DEFINE\s+\w+\s+RECORD\s*$/i.test(line)) {
      const record = parseRecordDefinition(lines, i, actualLine, scope);
      if (record) {
        out.push(record);
        while (i < lines.length) {
          const next = stripInlineComment(lines[i]);
          if (/^\s*END\s+RECORD\s*$/i.test(next)) break;
          i++;
        }
      }
    }
  }
  return out;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isVariableUsedInLine(line: string, variableName: string): boolean {
  const clean = line.replace(/#.*/g, '').replace(/--.*$/, '');
  const variable = escapeRegExp(variableName);
  const patterns = [
    new RegExp(`\\bLET\\s+${variable}(\\.\\w+)?\\s*[=\\[]`, 'i'),
    new RegExp(`[=+\\-*/()\\s]${variable}[+\\-*/()\\s]`, 'i'),
    new RegExp(`\\bCALL\\s+\\w+\\s*\\([^)]*${variable}[^)]*\\)`, 'i'),
    new RegExp(`\\bIF\\s+[^\\n]*${variable}`, 'i'),
    new RegExp(`\\b(DISPLAY|PRINT|MESSAGE)\\s+[^\\n]*${variable}`, 'i'),
    new RegExp(`\\bINTO\\s+[^\\n]*${variable}(\\.\\*)?\\b`, 'i'),
    new RegExp(`\\bINITIALIZE\\s+${variable}(\\.\\*)?\\s+TO`, 'i'),
    new RegExp(`\\bINSERT\\s+INTO\\s+[^\\n]*VALUES\\s*\\([^)]*${variable}(\\.\\*)?[^)]*\\)`, 'i'),
    new RegExp(`\\bUPDATE\\s+[^\\n]*SET\\s+[^\\n]*${variable}`, 'i'),
    new RegExp(`\\b${variable}\\b`, 'i')
  ];
  return patterns.some(pattern => pattern.test(clean));
}

function analyzeVariableUsage(blockContent: string, variables: VariableDefinition[]): Map<string, boolean> {
  const usage = new Map<string, boolean>();
  for (const variable of variables) {
    usage.set(variable.name, false);
  }
  for (const line of blockContent.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || /^\s*--/.test(line) || /^\s*DEFINE\s+/.test(line)) {
      continue;
    }
    for (const variable of variables) {
      if (isVariableUsedInLine(line, variable.name)) {
        usage.set(variable.name, true);
      }
    }
  }
  return usage;
}

function buildUnusedVariableDiagnostics(text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  const mainBlock = extractMainBlock(text);
  if (mainBlock) {
    const variables = parseDefineStatements(mainBlock.content, mainBlock.startLine, 'main');
    const usage = analyzeVariableUsage(mainBlock.content, variables);
    for (const variable of variables) {
      if (!usage.get(variable.name)) {
        diagnostics.push({
          range: variable.range,
          severity: DiagnosticSeverity.Warning,
          source: 'Genero FGL',
          code: 'unused-variable',
          tags: [DiagnosticTag.Unnecessary],
          message: `未使用的變數 '${variable.name}'`
        });
      }
    }
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*GLOBALS\b/i.test(lines[i].trim())) {
      let end = i + 1;
      while (end < lines.length && !REGEX_PATTERNS.END_GLOBALS.test(stripInlineComment(lines[end]))) {
        end++;
      }
      parseDefineStatements(lines.slice(i, Math.min(end, lines.length - 1) + 1).join('\n'), i, 'global');
      i = end;
    }
  }

  for (const block of extractFunctionBlocks(text)) {
    const signature = parseEnhancedFunctionSignature(block.content);
    const parameters = signature ? signature.allParameters : [];
    const variables = parseDefineStatements(block.content, block.startLine, 'function').filter(variable => !parameters.includes(variable.name));
    const usage = analyzeVariableUsage(block.content, variables);
    for (const variable of variables) {
      if (!usage.get(variable.name)) {
        diagnostics.push({
          range: variable.range,
          severity: DiagnosticSeverity.Warning,
          source: 'Genero FGL',
          code: 'unused-variable',
          tags: [DiagnosticTag.Unnecessary],
          message: `函式 '${block.name}' 中未使用的變數 '${variable.name}'`
        });
      }
    }
  }

  return diagnostics;
}

function collectFunctionCallOccurrences(block: FunctionBlock): FunctionCallOccurrence[] {
  const calls: FunctionCallOccurrence[] = [];
  const lines = block.content.split(/\r?\n/);
  const seen = new Set<string>();

  for (let localLine = 0; localLine < lines.length; localLine++) {
    const line = stripInlineComment(lines[localLine]);
    const absoluteLine = block.startLine + localLine;

    const push = (name: string, start: number, end: number, argumentCount: number) => {
      if (REGEX_PATTERNS.FGL_KEYWORDS.test(name)) {
        return;
      }
      const key = `${absoluteLine}:${start}:${end}:${name.toLowerCase()}:${argumentCount}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      calls.push({
        name,
        argumentCount,
        range: {
          start: { line: absoluteLine, character: start },
          end: { line: absoluteLine, character: end }
        }
      });
    };

    const callWithArgsRegex = /\bCALL\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)/ig;
    let callWithArgsMatch: RegExpExecArray | null;
    while ((callWithArgsMatch = callWithArgsRegex.exec(line)) !== null) {
      const start = callWithArgsMatch.index + callWithArgsMatch[0].length - callWithArgsMatch[1].length - (callWithArgsMatch[2]?.length ?? 0) - 2;
      push(callWithArgsMatch[1], start, start + callWithArgsMatch[1].length, countArguments(callWithArgsMatch[2] ?? ''));
    }

    const bareCallRegex = /\bCALL\s+([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/ig;
    let bareCallMatch: RegExpExecArray | null;
    while ((bareCallMatch = bareCallRegex.exec(line)) !== null) {
      const start = bareCallMatch.index + bareCallMatch[0].length - bareCallMatch[1].length;
      push(bareCallMatch[1], start, start + bareCallMatch[1].length, 0);
    }

    const parenRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b\s*\((.*)\)/ig;
    let parenMatch: RegExpExecArray | null;
    while ((parenMatch = parenRegex.exec(line)) !== null) {
      push(parenMatch[1], parenMatch.index, parenMatch.index + parenMatch[1].length, countArguments(parenMatch[2] ?? ''));
    }
  }

  return calls;
}

function countArguments(argumentText: string): number {
  const trimmed = argumentText.trim();
  if (!trimmed) {
    return 0;
  }

  let count = 1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < argumentText.length; i++) {
    const ch = argumentText[i];
    const previous = i > 0 ? argumentText[i - 1] : '';
    if (ch === '"' && previous !== '\\') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')' && depth > 0) {
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      count++;
    }
  }
  return count;
}

function collectFunctionDefinitionRecordsFromText(text: string, uri: string): FunctionDefinitionRecord[] {
  return extractFunctionBlocks(text).map(block => ({
    uri,
    block,
    signature: parseEnhancedFunctionSignature(block.content)
  }));
}

function ensureWorkspaceFunctionCache(): void {
  if (workspaceFunctionCacheInitialized) {
    return;
  }

  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const uri = URI.file(filePath).toString();
    if (workspaceFunctionRecordsByUri.has(uri)) {
      continue;
    }

    try {
      const text = fs.readFileSync(filePath, 'utf8');
      workspaceFunctionRecordsByUri.set(uri, collectFunctionDefinitionRecordsFromText(text, uri));
    } catch (error) {
      logError('[LSP] Error building function cache for', filePath, error);
    }
  }

  workspaceFunctionCacheInitialized = true;
}

function ensureLibraryFunctionCache(): void {
  if (libraryFunctionCacheInitialized) return;
  for (const filePath of collectLibraryFiles(['.4gl'])) {
    const uri = URI.file(filePath).toString();
    if (libraryFunctionRecordsByUri.has(uri)) continue;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      libraryFunctionRecordsByUri.set(uri, collectFunctionDefinitionRecordsFromText(text, uri));
    } catch (error) {
      logError('[LSP] Error building library function cache for', filePath, error);
    }
  }
  libraryFunctionCacheInitialized = true;
}

async function refreshLibraryPathsAndCache(): Promise<void> {
  try {
    const paths = await connection.workspace.getConfiguration('GeneroFGL.4gl.library.paths');
    libraryPathsList = Array.isArray(paths)
      ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
  } catch {
    libraryPathsList = [];
  }
  libraryFunctionRecordsByUri.clear();
  libraryFunctionCacheInitialized = false;
  ensureLibraryFunctionCache();
  logInfo('[LSP Server] Library paths refreshed, count:', libraryPathsList.length);
}

function updateFunctionDefinitionCache(document: TextDocument): void {
  if (document.languageId !== '4gl') {
    return;
  }

  workspaceFunctionRecordsByUri.set(document.uri, collectFunctionDefinitionRecordsFromText(document.getText(), document.uri));
}

function restoreFunctionDefinitionCacheForUri(uri: string): void {
  if (!uri.startsWith('file:')) {
    workspaceFunctionRecordsByUri.delete(uri);
    return;
  }

  try {
    const filePath = URI.parse(uri).fsPath;
    if (!filePath.toLowerCase().endsWith('.4gl') || !fs.existsSync(filePath)) {
      workspaceFunctionRecordsByUri.delete(uri);
      return;
    }

    const text = fs.readFileSync(filePath, 'utf8');
    workspaceFunctionRecordsByUri.set(uri, collectFunctionDefinitionRecordsFromText(text, uri));
  } catch (error) {
    workspaceFunctionRecordsByUri.delete(uri);
    logError('[LSP] Error restoring function cache for', uri, error);
  }
}

function getFunctionDefinitionIndex(currentUri?: string): Map<string, FunctionDefinitionRecord> {
  ensureLibraryFunctionCache();
  ensureWorkspaceFunctionCache();

  const index = new Map<string, FunctionDefinitionRecord>();

  // ① 當前開啟的文件（最優先）
  if (currentUri) {
    for (const record of workspaceFunctionRecordsByUri.get(currentUri) ?? []) {
      const key = record.block.name.toLowerCase();
      if (!index.has(key)) index.set(key, record);
    }
  }

  // ② Library paths 下的函式庫
  for (const records of libraryFunctionRecordsByUri.values()) {
    for (const record of records) {
      const key = record.block.name.toLowerCase();
      if (!index.has(key)) index.set(key, record);
    }
  }

  // ③ 其他 Workspace 檔案
  for (const [uri, records] of workspaceFunctionRecordsByUri.entries()) {
    if (currentUri && uri === currentUri) continue;
    for (const record of records) {
      const key = record.block.name.toLowerCase();
      if (!index.has(key)) index.set(key, record);
    }
  }

  return index;
}

function collectSemanticTokens(text: string): SemanticTokenEntry[] {
  const tokens: SemanticTokenEntry[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  const maskedLines = maskNonCodePreserveColumns(text);
  const maskedText = maskedLines.join('\n');
  const keywordNames = Array.from(new Set(KEYWORDS_4GL.map(keyword => keyword.name.toUpperCase()))).sort((a, b) => b.length - a.length);

  const pushToken = (line: number, char: number, length: number, tokenType: (typeof SEMANTIC_TOKEN_TYPES)[number]) => {
    if (line < 0 || char < 0 || length <= 0) return;
    const key = `${line}:${char}:${length}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push({ line, char, length, tokenType });
  };

  const pushWordOccurrences = (line: number, textLine: string, word: string, tokenType: (typeof SEMANTIC_TOKEN_TYPES)[number]) => {
    const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'ig');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(textLine)) !== null) {
      pushToken(line, match.index, match[0].length, tokenType);
    }
  };

  const mainBlock = extractMainBlock(maskedText);
  if (mainBlock) {
    for (const variable of parseDefineStatements(mainBlock.content, mainBlock.startLine, 'main')) {
      pushWordOccurrences(variable.line, maskedLines[variable.line] || '', variable.name, 'variable');
      const typeIndex = (maskedLines[variable.line] || '').toUpperCase().indexOf(variable.type.toUpperCase());
      if (typeIndex >= 0) {
        pushToken(variable.line, typeIndex, variable.type.length, 'type');
      }
    }
  }

  for (const block of extractGlobalsBlocks(maskedText)) {
    for (const variable of parseDefineStatements(block.content, block.startLine, 'global')) {
      pushWordOccurrences(variable.line, maskedLines[variable.line] || '', variable.name, 'variable');
      const typeIndex = (maskedLines[variable.line] || '').toUpperCase().indexOf(variable.type.toUpperCase());
      if (typeIndex >= 0) {
        pushToken(variable.line, typeIndex, variable.type.length, 'type');
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = maskedLines[i] || '';

    const functionMatch = line.match(REGEX_PATTERNS.FUNCTION);
    if (functionMatch) {
      const functionIndex = line.toLowerCase().indexOf(functionMatch[1].toLowerCase());
      if (functionIndex >= 0) {
        pushToken(i, functionIndex, functionMatch[1].length, 'function');
      }
    }

    const reportMatch = line.match(REGEX_PATTERNS.REPORT);
    if (reportMatch) {
      const reportIndex = line.toLowerCase().indexOf(reportMatch[1].toLowerCase());
      if (reportIndex >= 0) {
        pushToken(i, reportIndex, reportMatch[1].length, 'function');
      }
    }

    for (const keywordName of keywordNames) {
      const regex = new RegExp(`\\b${escapeRegExp(keywordName)}\\b`, 'ig');
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        pushToken(i, match.index, match[0].length, 'keyword');
      }
    }
  }

  for (const block of extractFunctionBlocks(maskedText)) {
    const signature = parseEnhancedFunctionSignature(block.content);
    const signatureLine = maskedLines[block.startLine] || '';
    if (signature) {
      for (const parameter of signature.allParameters) {
        pushWordOccurrences(block.startLine, signatureLine, parameter, 'parameter');
      }
      for (let line = block.startLine + 1; line <= block.endLine; line++) {
        const textLine = maskedLines[line] || '';
        for (const parameter of signature.allParameters) {
          pushWordOccurrences(line, textLine, parameter, 'parameter');
        }
      }
    }

    for (const variable of parseDefineStatements(block.content, block.startLine, 'function')) {
      pushWordOccurrences(variable.line, maskedLines[variable.line] || '', variable.name, 'variable');
      const typeIndex = (maskedLines[variable.line] || '').toUpperCase().indexOf(variable.type.toUpperCase());
      if (typeIndex >= 0) {
        pushToken(variable.line, typeIndex, variable.type.length, 'type');
      }
    }

    for (const call of collectFunctionCallOccurrences(block)) {
      pushToken(call.range.start.line, call.range.start.character, call.name.length, 'function');
    }
  }

  tokens.sort((a, b) => a.line - b.line || a.char - b.char || a.length - b.length);
  return tokens;
}

function buildSemanticTokens(text: string): SemanticTokens {
  const builder = new SemanticTokensBuilder();
  for (const token of collectSemanticTokens(text)) {
    builder.push(token.line, token.char, token.length, SEMANTIC_TOKEN_TYPE_INDEX[token.tokenType], 0);
  }
  return builder.build();
}

async function buildSemanticDiagnostics(document: TextDocument): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const text = document.getText();
  const definitionIndex = getFunctionDefinitionIndex(document.uri);

  for (const block of extractFunctionBlocks(text)) {
    for (const call of collectFunctionCallOccurrences(block)) {
      const definition = definitionIndex.get(call.name.toLowerCase()) ?? null;
      if (!definition) {
        diagnostics.push({
          range: call.range,
          severity: DiagnosticSeverity.Hint,
          source: 'Genero FGL',
          code: 'undefined-function',
          message: `找不到函式 '${call.name}' 的定義`
        });
        continue;
      }

      const expectedCount = definition.signature?.allParameters.length;
      if (typeof expectedCount === 'number' && expectedCount !== call.argumentCount) {
        diagnostics.push({
          range: call.range,
          severity: DiagnosticSeverity.Warning,
          source: 'Genero FGL',
          code: 'function-arity-mismatch',
          message: `函式 '${call.name}' 需要 ${expectedCount} 個參數，但目前傳入 ${call.argumentCount} 個`
        });
      }
    }
  }

  return diagnostics;
}

async function isDiagnosticEnabled(): Promise<boolean> {
  try {
    const enabled = await connection.workspace.getConfiguration('GeneroFGL.4gl.diagnostic.enable');
    return enabled !== false;
  } catch {
    return true;
  }
}

function getDiagnosticBuckets(uri: string): { unused: Diagnostic[]; semantic: Diagnostic[] } {
  let buckets = diagnosticBucketsByUri.get(uri);
  if (!buckets) {
    buckets = { unused: [], semantic: [] };
    diagnosticBucketsByUri.set(uri, buckets);
  }
  return buckets;
}

function sendMergedDiagnostics(uri: string): void {
  const buckets = diagnosticBucketsByUri.get(uri);
  if (!buckets) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  connection.sendDiagnostics({
    uri,
    diagnostics: [...buckets.unused, ...buckets.semantic]
  });
}

function updateDiagnosticBucket(uri: string, bucket: 'unused' | 'semantic', diagnostics: Diagnostic[]): void {
  const buckets = getDiagnosticBuckets(uri);
  buckets[bucket] = diagnostics;
  sendMergedDiagnostics(uri);
}

function clearSemanticDiagnostics(uri: string): void {
  const buckets = getDiagnosticBuckets(uri);
  if (buckets.semantic.length === 0) {
    return;
  }

  buckets.semantic = [];
  sendMergedDiagnostics(uri);
}

async function canValidateDocument(document: TextDocument): Promise<boolean> {
  if (document.languageId !== '4gl') {
    diagnosticBucketsByUri.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    return false;
  }
  if (!await isDiagnosticEnabled()) {
    diagnosticBucketsByUri.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    return false;
  }
  return true;
}

async function validateUnusedDiagnostics(document: TextDocument): Promise<void> {
  if (!await canValidateDocument(document)) {
    return;
  }

  try {
    updateDiagnosticBucket(document.uri, 'unused', buildUnusedVariableDiagnostics(document.getText()));
  } catch (error) {
    logError('[LSP] validateUnusedDiagnostics failed', error);
    updateDiagnosticBucket(document.uri, 'unused', []);
  }
}

async function validateSemanticDiagnostics(document: TextDocument): Promise<void> {
  if (!await canValidateDocument(document)) {
    return;
  }

  try {
    updateDiagnosticBucket(document.uri, 'semantic', await buildSemanticDiagnostics(document));
  } catch (error) {
    logError('[LSP] validateSemanticDiagnostics failed', error);
    updateDiagnosticBucket(document.uri, 'semantic', []);
  }
}

async function validateAllDiagnostics(document: TextDocument): Promise<void> {
  if (!await canValidateDocument(document)) {
    return;
  }

  try {
    const unusedDiagnostics = buildUnusedVariableDiagnostics(document.getText());
    const semanticDiagnostics = await buildSemanticDiagnostics(document);
    diagnosticBucketsByUri.set(document.uri, {
      unused: unusedDiagnostics,
      semantic: semanticDiagnostics
    });
    sendMergedDiagnostics(document.uri);
  } catch (error) {
    logError('[LSP] validateAllDiagnostics failed', error);
    diagnosticBucketsByUri.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  }
}

function buildHoverMarkdown(languageId: string, word: string): Hover | null {
  const keyword = getKeywords(languageId).find(entry => entry.name.toLowerCase() === word.toLowerCase());
  if (!keyword) return null;
  const sections = [`\`\`\`genero 4gl\n${keyword.name}\n\`\`\``];
  if (keyword.description) sections.push(keyword.description);
  if (keyword.documentation) sections.push(keyword.documentation);
  if (keyword.type) sections.push(`**Type**: ${keyword.type}`);
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: sections.join('\n\n')
    }
  };
}

function findDefinitionInText(text: string, name: string, uri: string): Location | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/#.*/g, '').replace(/--.*$/, '').trim();
    const functionMatch = line.match(REGEX_PATTERNS.FUNCTION);
    if (functionMatch && functionMatch[1].toLowerCase() === name.toLowerCase()) {
      return Location.create(uri, {
        start: { line: i, character: 0 },
        end: { line: i, character: 0 }
      });
    }
    const reportMatch = line.match(REGEX_PATTERNS.REPORT);
    if (reportMatch && reportMatch[1].toLowerCase() === name.toLowerCase()) {
      return Location.create(uri, {
        start: { line: i, character: 0 },
        end: { line: i, character: 0 }
      });
    }
  }
  return null;
}

function collectWorkspaceFiles(extensions: string[]): string[] {
  const files: string[] = [];
  for (const root of workspaceFolders) {
    collectFilesRecursive(root, extensions, files);
  }
  return files;
}

function collectLibraryFiles(extensions: string[]): string[] {
  const files: string[] = [];
  for (const libDir of libraryPathsList) {
    collectFilesRecursive(libDir, extensions, files);
  }
  return files;
}

function collectFilesRecursive(root: string, extensions: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') {
      continue;
    }
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(fullPath, extensions, out);
      continue;
    }
    if (extensions.some(extension => fullPath.toLowerCase().endsWith(extension.toLowerCase()))) {
      out.push(fullPath);
    }
  }
}

async function findDefinition(name: string, currentUri: string, currentText: string): Promise<Location | null> {
  const local = findDefinitionInText(currentText, name, currentUri);
  if (local) return local;

  const currentPath = currentUri.startsWith('file:') ? URI.parse(currentUri).fsPath : currentUri;
  const seen = new Set<string>([path.normalize(currentPath)]);
  for (const filePath of collectLibraryFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const found = findDefinitionInText(text, name, URI.file(filePath).toString());
      if (found) return found;
    } catch (error) {
      logError('[LSP] Error searching definition in library', filePath, error);
    }
  }
  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const found = findDefinitionInText(text, name, URI.file(filePath).toString());
      if (found) return found;
    } catch (error) {
      logError('[LSP] Error searching definition in', filePath, error);
    }
  }

  return null;
}

function findFunctionSignatureInText(text: string, name: string): EnhancedFunctionSignature | null {
  for (const block of extractFunctionBlocks(text)) {
    if (block.name.toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    const signature = parseEnhancedFunctionSignature(block.content);
    if (signature) {
      return signature;
    }
  }
  return null;
}

function findFunctionDefinitionRecordInText(text: string, name: string, uri: string): FunctionDefinitionRecord | null {
  for (const block of extractFunctionBlocks(text)) {
    if (block.name.toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    return {
      uri,
      block,
      signature: parseEnhancedFunctionSignature(block.content)
    };
  }
  return null;
}

async function findFunctionSignature(name: string, currentUri: string, currentText: string): Promise<EnhancedFunctionSignature | null> {
  const local = findFunctionSignatureInText(currentText, name);
  if (local) return local;

  const currentPath = currentUri.startsWith('file:') ? URI.parse(currentUri).fsPath : currentUri;
  const seen = new Set<string>([path.normalize(currentPath)]);
  for (const filePath of collectLibraryFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const signature = findFunctionSignatureInText(text, name);
      if (signature) return signature;
    } catch (error) {
      logError('[LSP] Error searching signature in library', filePath, error);
    }
  }
  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const signature = findFunctionSignatureInText(text, name);
      if (signature) {
        return signature;
      }
    } catch (error) {
      logError('[LSP] Error searching signature in', filePath, error);
    }
  }

  return null;
}

async function findFunctionDefinitionRecord(name: string, currentUri: string, currentText: string): Promise<FunctionDefinitionRecord | null> {
  const local = findFunctionDefinitionRecordInText(currentText, name, currentUri);
  if (local) return local;

  const currentPath = currentUri.startsWith('file:') ? URI.parse(currentUri).fsPath : currentUri;
  const seen = new Set<string>([path.normalize(currentPath)]);
  for (const filePath of collectLibraryFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const record = findFunctionDefinitionRecordInText(text, name, URI.file(filePath).toString());
      if (record) return record;
    } catch (error) {
      logError('[LSP] Error searching function definition record in library', filePath, error);
    }
  }
  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const record = findFunctionDefinitionRecordInText(text, name, URI.file(filePath).toString());
      if (record) {
        return record;
      }
    } catch (error) {
      logError('[LSP] Error searching function definition record in', filePath, error);
    }
  }

  return null;
}

interface CallContext {
  functionName: string;
  activeParameter: number;
}

type RenameTargetKind = 'function' | 'report';

interface RenameTarget {
  name: string;
  kind: RenameTargetKind;
  range: Range;
  definitionUri: string;
}

function getCallContext(text: string, offset: number): CallContext | null {
  if (offset < 0 || offset > text.length) return null;

  let depth = 0;
  let activeParameter = 0;
  let openParenIndex = -1;

  for (let index = offset - 1; index >= 0; index--) {
    const ch = text[index];
    if (ch === ')') {
      depth++;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) {
        openParenIndex = index;
        break;
      }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      activeParameter++;
    }
  }

  if (openParenIndex === -1) return null;

  let nameEnd = openParenIndex - 1;
  while (nameEnd >= 0 && /\s/.test(text[nameEnd])) {
    nameEnd--;
  }
  if (nameEnd < 0) return null;

  let nameStart = nameEnd;
  while (nameStart >= 0 && /[A-Za-z0-9_]/.test(text[nameStart])) {
    nameStart--;
  }
  nameStart++;

  const functionName = text.substring(nameStart, nameEnd + 1);
  if (!functionName) return null;

  return {
    functionName,
    activeParameter
  };
}

function buildSignatureHelp(signature: EnhancedFunctionSignature, activeParameter: number): SignatureHelp {
  const parameters = signature.allParameters.map(parameterName => ParameterInformation.create(parameterName));
  const label = `${signature.name}(${signature.allParameters.join(', ')})`;
  const safeActiveParameter = Math.max(0, Math.min(activeParameter, Math.max(parameters.length - 1, 0)));

  return {
    signatures: [SignatureInformation.create(label, undefined, ...parameters)],
    activeSignature: 0,
    activeParameter: parameters.length > 0 ? safeActiveParameter : 0
  };
}

function findFunctionDefinitionRangeInText(text: string, name: string): Range | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]);
    const match = line.match(REGEX_PATTERNS.FUNCTION);
    if (!match || match[1].toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    const start = line.toLowerCase().indexOf(match[1].toLowerCase());
    if (start >= 0) {
      return {
        start: { line: i, character: start },
        end: { line: i, character: start + match[1].length }
      };
    }
  }
  return null;
}

function findReportDefinitionRangeInText(text: string, name: string): Range | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]);
    const match = line.match(REGEX_PATTERNS.REPORT);
    if (!match || match[1].toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    const start = line.toLowerCase().indexOf(match[1].toLowerCase());
    if (start >= 0) {
      return {
        start: { line: i, character: start },
        end: { line: i, character: start + match[1].length }
      };
    }
  }
  return null;
}

function findSymbolDefinitionInText(text: string, name: string): { kind: RenameTargetKind; range: Range } | null {
  const functionRange = findFunctionDefinitionRangeInText(text, name);
  if (functionRange) {
    return { kind: 'function', range: functionRange };
  }
  const reportRange = findReportDefinitionRangeInText(text, name);
  if (reportRange) {
    return { kind: 'report', range: reportRange };
  }
  return null;
}

function readTextByUri(uri: string, currentUri: string, currentText: string): string | null {
  if (uri === currentUri) {
    return currentText;
  }
  if (!uri.startsWith('file:')) {
    return null;
  }
  try {
    return fs.readFileSync(URI.parse(uri).fsPath, 'utf8');
  } catch (error) {
    logError('[LSP] Error reading uri for rename', uri, error);
    return null;
  }
}

async function resolveRenameTarget(doc: TextDocument, offset: number): Promise<RenameTarget | null> {
  const fullText = doc.getText();
  const { word, start, end } = getWordAtPosition(fullText, offset);
  if (!word) return null;

  const localDefinition = findSymbolDefinitionInText(fullText, word);
  if (localDefinition) {
    return {
      name: word,
      kind: localDefinition.kind,
      range: {
        start: doc.positionAt(start),
        end: doc.positionAt(end)
      },
      definitionUri: doc.uri
    };
  }

  const definition = await findDefinition(word, doc.uri, fullText);
  if (!definition) return null;

  const definitionText = readTextByUri(definition.uri, doc.uri, fullText);
  if (!definitionText) return null;
  const resolved = findSymbolDefinitionInText(definitionText, word);
  if (!resolved) return null;

  return {
    name: word,
    kind: resolved.kind,
    range: {
      start: doc.positionAt(start),
      end: doc.positionAt(end)
    },
    definitionUri: definition.uri
  };
}

async function resolveFunctionTarget(doc: TextDocument, offset: number): Promise<RenameTarget | null> {
  const target = await resolveRenameTarget(doc, offset);
  if (!target || target.kind !== 'function') {
    return null;
  }
  return target;
}

function buildFunctionCallHierarchyItem(record: FunctionDefinitionRecord): CallHierarchyItem {
  const definitionRange = findFunctionDefinitionRangeInText(record.block.content, record.block.name) ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: record.block.name.length }
  };
  const selectionStartLine = record.block.startLine + definitionRange.start.line;
  const selectionEndLine = record.block.startLine + definitionRange.end.line;
  const selectionRange: Range = {
    start: { line: selectionStartLine, character: definitionRange.start.character },
    end: { line: selectionEndLine, character: definitionRange.end.character }
  };
  const range: Range = {
    start: { line: record.block.startLine, character: 0 },
    end: { line: record.block.endLine, character: Math.max(0, record.block.content.split(/\r?\n/).slice(-1)[0]?.length ?? 0) }
  };

  return {
    name: record.block.name,
    kind: SymbolKind.Function,
    uri: record.uri,
    range,
    selectionRange,
    detail: record.signature ? `FUNCTION(${record.signature.allParameters.join(', ')})` : 'FUNCTION'
  };
}

function collectFunctionCallLocationsInText(text: string, functionName: string, uri: string): Location[] {
  const locations: Location[] = [];
  const escapedName = escapeRegExp(functionName);
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();

  const push = (line: number, start: number, end: number) => {
    const key = `${line}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(Location.create(uri, {
      start: { line, character: start },
      end: { line, character: end }
    }));
  };

  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]);
    const callRegex = new RegExp(`\\b${escapedName}\\b(?=\\s*\\()`, 'ig');
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRegex.exec(line)) !== null) {
      push(i, callMatch.index, callMatch.index + callMatch[0].length);
    }

    const callCommandRegex = new RegExp(`\\bCALL\\s+(${escapedName})\\b`, 'ig');
    let commandMatch: RegExpExecArray | null;
    while ((commandMatch = callCommandRegex.exec(line)) !== null) {
      const start = commandMatch.index + commandMatch[0].length - commandMatch[1].length;
      push(i, start, start + commandMatch[1].length);
    }
  }

  return locations;
}

function collectCalledFunctionNames(block: FunctionBlock): Array<{ name: string; range: Range }> {
  const calls: Array<{ name: string; range: Range }> = [];
  const lines = block.content.split(/\r?\n/);
  const seen = new Set<string>();

  for (let localLine = 0; localLine < lines.length; localLine++) {
    const line = stripInlineComment(lines[localLine]);

    const push = (name: string, start: number, end: number) => {
      if (name.toLowerCase() === block.name.toLowerCase() && block.startLine + localLine === block.startLine) {
        return;
      }
      const key = `${block.startLine + localLine}:${start}:${end}:${name.toLowerCase()}`;
      if (seen.has(key) || REGEX_PATTERNS.FGL_KEYWORDS.test(name)) return;
      seen.add(key);
      calls.push({
        name,
        range: {
          start: { line: block.startLine + localLine, character: start },
          end: { line: block.startLine + localLine, character: end }
        }
      });
    };

    const callCommandRegex = /\bCALL\s+([A-Za-z_][A-Za-z0-9_]*)\b/ig;
    let commandMatch: RegExpExecArray | null;
    while ((commandMatch = callCommandRegex.exec(line)) !== null) {
      const start = commandMatch.index + commandMatch[0].length - commandMatch[1].length;
      push(commandMatch[1], start, start + commandMatch[1].length);
    }

    const parenRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*\()/ig;
    let parenMatch: RegExpExecArray | null;
    while ((parenMatch = parenRegex.exec(line)) !== null) {
      push(parenMatch[1], parenMatch.index, parenMatch.index + parenMatch[1].length);
    }
  }

  return calls;
}

function collectRenameRangesInText(text: string, target: RenameTarget): Range[] {
  return collectReferenceLocationsInText(text, target, 'file:///unused', true).map(location => location.range);
}

function collectReferenceLocationsInText(text: string, target: RenameTarget, uri: string, includeDeclaration: boolean): Location[] {
  const locations: Location[] = [];
  const ranges: Range[] = [];
  const seen = new Set<string>();
  const escapedName = escapeRegExp(target.name);
  const lines = text.split(/\r?\n/);

  const pushRange = (line: number, start: number, end: number) => {
    const key = `${line}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({
      start: { line, character: start },
      end: { line, character: end }
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i]);

    if (target.kind === 'function') {
      const defMatch = line.match(REGEX_PATTERNS.FUNCTION);
      if (includeDeclaration && defMatch && defMatch[1].toLowerCase() === target.name.toLowerCase()) {
        const start = line.toLowerCase().indexOf(defMatch[1].toLowerCase());
        if (start >= 0) pushRange(i, start, start + defMatch[1].length);
      }

      const callRegex = new RegExp(`\\b${escapedName}\\b(?=\\s*\\()`, 'ig');
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(line)) !== null) {
        pushRange(i, callMatch.index, callMatch.index + callMatch[0].length);
      }

      const callCommandRegex = new RegExp(`\\bCALL\\s+(${escapedName})\\b`, 'ig');
      let commandMatch: RegExpExecArray | null;
      while ((commandMatch = callCommandRegex.exec(line)) !== null) {
        const start = commandMatch.index + commandMatch[0].length - commandMatch[1].length;
        pushRange(i, start, start + commandMatch[1].length);
      }
    }

    if (target.kind === 'report') {
      const defMatch = line.match(REGEX_PATTERNS.REPORT);
      if (includeDeclaration && defMatch && defMatch[1].toLowerCase() === target.name.toLowerCase()) {
        const start = line.toLowerCase().indexOf(defMatch[1].toLowerCase());
        if (start >= 0) pushRange(i, start, start + defMatch[1].length);
      }

      const reportRegex = new RegExp(`\\b(?:START\\s+)?REPORT\\s+(${escapedName})\\b`, 'ig');
      let reportMatch: RegExpExecArray | null;
      while ((reportMatch = reportRegex.exec(line)) !== null) {
        const start = reportMatch.index + reportMatch[0].length - reportMatch[1].length;
        pushRange(i, start, start + reportMatch[1].length);
      }
    }
  }

  for (const range of ranges) {
    locations.push(Location.create(uri, range));
  }

  return locations;
}

async function findReferences(target: RenameTarget, currentUri: string, currentText: string, includeDeclaration: boolean): Promise<Location[]> {
  const references: Location[] = [];
  const currentPath = currentUri.startsWith('file:') ? URI.parse(currentUri).fsPath : currentUri;
  const seen = new Set<string>([path.normalize(currentPath)]);

  references.push(...collectReferenceLocationsInText(currentText, target, currentUri, includeDeclaration));

  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      references.push(...collectReferenceLocationsInText(text, target, URI.file(filePath).toString(), includeDeclaration));
    } catch (error) {
      logError('[LSP] Error searching references in', filePath, error);
    }
  }

  return references;
}

function buildRenameWorkspaceEdit(target: RenameTarget, newName: string, currentUri: string, currentText: string): WorkspaceEdit {
  const changes: Record<string, TextEdit[]> = {};
  const currentPath = currentUri.startsWith('file:') ? URI.parse(currentUri).fsPath : currentUri;
  const seen = new Set<string>([path.normalize(currentPath)]);

  const pushFileEdits = (uri: string, text: string) => {
    const ranges = collectRenameRangesInText(text, target);
    if (ranges.length === 0) return;
    changes[uri] = ranges.map(range => TextEdit.replace(range, newName));
  };

  pushFileEdits(currentUri, currentText);

  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      pushFileEdits(URI.file(filePath).toString(), text);
    } catch (error) {
      logError('[LSP] Error building rename edits for', filePath, error);
    }
  }

  return { changes };
}

interface CallSite {
  functionName: string;
  argumentOffsets: number[];
}

function collectCallSitesInRange(text: string, startOffset: number, endOffset: number): CallSite[] {
  const callSites: CallSite[] = [];
  let index = Math.max(0, startOffset);

  while (index < Math.min(endOffset, text.length)) {
    const ch = text[index];
    if (ch !== '(') {
      index++;
      continue;
    }

    let nameEnd = index - 1;
    while (nameEnd >= startOffset && /\s/.test(text[nameEnd])) {
      nameEnd--;
    }
    if (nameEnd < startOffset) {
      index++;
      continue;
    }

    let nameStart = nameEnd;
    while (nameStart >= startOffset && /[A-Za-z0-9_]/.test(text[nameStart])) {
      nameStart--;
    }
    nameStart++;

    const functionName = text.substring(nameStart, nameEnd + 1);
    if (!functionName || REGEX_PATTERNS.FGL_KEYWORDS.test(functionName)) {
      index++;
      continue;
    }

    const argumentOffsets: number[] = [];
    let cursor = index + 1;
    let depth = 1;
    let inString = false;
    let hasCurrentArgument = false;

    while (cursor < text.length && depth > 0) {
      const current = text[cursor];
      const previous = cursor > 0 ? text[cursor - 1] : '';

      if (current === '"' && previous !== '\\') {
        inString = !inString;
        cursor++;
        continue;
      }

      if (inString) {
        cursor++;
        continue;
      }

      if (current === '(') {
        depth++;
        cursor++;
        continue;
      }

      if (current === ')') {
        depth--;
        if (depth === 0) {
          break;
        }
        cursor++;
        continue;
      }

      if (depth === 1 && current === ',') {
        hasCurrentArgument = false;
        cursor++;
        continue;
      }

      if (depth === 1 && !hasCurrentArgument && !/\s/.test(current)) {
        argumentOffsets.push(cursor);
        hasCurrentArgument = true;
      }

      cursor++;
    }

    callSites.push({ functionName, argumentOffsets });
    index = cursor + 1;
  }

  return callSites;
}

async function buildInlayHintsForRange(doc: TextDocument, startOffset: number, endOffset: number): Promise<InlayHint[]> {
  const hints: InlayHint[] = [];
  const text = doc.getText();
  const callSites = collectCallSitesInRange(text, startOffset, endOffset);
  const signatureCache = new Map<string, Promise<EnhancedFunctionSignature | null>>();

  for (const callSite of callSites) {
    const key = callSite.functionName.toLowerCase();
    let signaturePromise = signatureCache.get(key);
    if (!signaturePromise) {
      signaturePromise = findFunctionSignature(callSite.functionName, doc.uri, text);
      signatureCache.set(key, signaturePromise);
    }

    const signature = await signaturePromise;
    if (!signature || signature.allParameters.length === 0) {
      continue;
    }

    const count = Math.min(callSite.argumentOffsets.length, signature.allParameters.length);
    for (let i = 0; i < count; i++) {
      hints.push({
        position: doc.positionAt(callSite.argumentOffsets[i]),
        label: `${signature.allParameters[i]}: `,
        kind: InlayHintKind.Parameter,
        paddingRight: true
      });
    }
  }

  return hints;
}

function getWordAtPosition(text: string, offset: number): { word: string; start: number; end: number } {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) {
    start--;
  }
  while (end < text.length && /[A-Za-z0-9_]/.test(text.charAt(end))) {
    end++;
  }
  return { word: text.substring(start, end), start, end };
}

function getImportListFromDocument(text: string): ImportType[] {
  const importList: ImportType[] = [];
  let commentBlock = false;
  const endImports = new RegExp('^\\s*(public|private|define|type|constant|function|main|report|options|&define|&include)\\b', 'i');
  let commentPosition = -1;
  let importSection = '';

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    if (!line.length) {
      continue;
    }

    if (commentBlock) {
      commentPosition = line.search('}');
      if (commentPosition >= 0) {
        commentBlock = false;
        line = line.substring(commentPosition + 1).trim();
        if (!line.length) {
          continue;
        }
      }
    }

    commentPosition = line.search('(--|#)');
    if (commentPosition >= 0) {
      line = line.substring(0, commentPosition).trim();
      if (!line.length) {
        continue;
      }
    }

    commentPosition = line.search('{');
    if (commentPosition >= 0) {
      commentBlock = true;
      line = line.substring(0, commentPosition).trim();
      if (!line.length) {
        continue;
      }
    }

    const match = endImports.exec(line);
    if (match != null) {
      break;
    }

    importSection = `${importSection} ${line}`;
  }

  const imports: Array<string> = importSection.trim().split(new RegExp('\\bimport\\b', 'i'));

  imports.forEach(element => {
    element = element.trim();
    if (!element.length) {
      return;
    }
    const words: Array<string> = element.split(' ');
    if (words[0].toLowerCase() === 'fgl' || words[0].toLowerCase() === 'java') {
      importList.push({ type: words[0], name: words[1] });
    } else {
      importList.push({ name: words[0] });
    }
  });

  return importList;
}

function getChainInfoFromLine(line: string, positionChar: number) {
  const prefix = line.substring(0, positionChar);

  const trailingDotMatch = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\.$/.exec(prefix);
  if (trailingDotMatch) {
    const chain = trailingDotMatch[1];
    const parts = chain.split('.');
    return {
      parts,
      partial: '',
      start: positionChar,
      end: positionChar,
      trailingDot: true
    };
  }

  const match = /([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)$/.exec(prefix);
  if (!match) {
    return null;
  }

  const chain = match[1];
  const parts = chain.split('.');
  const last = parts[parts.length - 1] || '';
  const start = positionChar - last.length;
  return {
    parts,
    partial: last,
    start,
    end: positionChar,
    trailingDot: false
  };
}

function matchesPrefix(name: string, prefix: string) {
  if (!prefix) return true;
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}

function buildMethodDetail(className: string, method: Method): string {
  const params = (method.parameters || []).map(p => `${p.name}: ${p.type}`).join(', ');
  return `${className}.${method.name}(${params})`;
}

function getClassByName(pkg: Package, className: string): PackageClass | undefined {
  return pkg.classes.find(c => c.name.toLowerCase() === className.toLowerCase());
}

function collectMethods(klass: PackageClass): Method[] {
  const out: Method[] = [];
  if (klass.objectMethods) out.push(...klass.objectMethods);
  if (klass.classMethods) out.push(...klass.classMethods);
  return out;
}

function addCompletionItem(
  items: CompletionItem[],
  label: string,
  kind: CompletionItemKind,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  detail?: string,
  documentation?: string
) {
  items.push({
    label,
    kind,
    detail,
    documentation,
    textEdit: { range, newText: label }
  });
}

function importCompletionLsp(
  line: string,
  position: { line: number; character: number },
  imports: Package[]
): CompletionItem[] {
  const completions: CompletionItem[] = [];
  const chain = getChainInfoFromLine(line, position.character);
  if (!chain) return completions;

  const range = {
    start: { line: position.line, character: chain.start },
    end: { line: position.line, character: chain.end }
  };

  if (chain.parts.length === 1 && !chain.trailingDot) {
    const prefix = chain.partial;
    const seen = new Set<string>();
    for (const pkg of imports) {
      if (matchesPrefix(pkg.name, prefix) && !seen.has(`pkg:${pkg.name}`)) {
        addCompletionItem(completions, pkg.name, CompletionItemKind.Module, range, 'package');
        seen.add(`pkg:${pkg.name}`);
      }
      for (const klass of pkg.classes) {
        if (matchesPrefix(klass.name, prefix) && !seen.has(`class:${klass.name}`)) {
          addCompletionItem(completions, klass.name, CompletionItemKind.Class, range, pkg.name, klass.description);
          seen.add(`class:${klass.name}`);
        }
      }
    }
    return completions;
  }

  const packageName = chain.parts[0];
  const pkg = imports.find(p => p.name.toLowerCase() === packageName.toLowerCase());
  if (!pkg) return completions;

  if (chain.parts.length === 2 && !chain.trailingDot) {
    const prefix = chain.partial;
    for (const klass of pkg.classes) {
      if (matchesPrefix(klass.name, prefix)) {
        addCompletionItem(completions, klass.name, CompletionItemKind.Class, range, pkg.name, klass.description);
      }
    }
    return completions;
  }

  const className = chain.parts[1];
  const klass = getClassByName(pkg, className);
  if (!klass) return completions;

  const methodPrefix = chain.trailingDot ? '' : chain.partial;
  const methods = collectMethods(klass);
  for (const method of methods) {
    if (matchesPrefix(method.name, methodPrefix)) {
      addCompletionItem(
        completions,
        method.name,
        CompletionItemKind.Method,
        range,
        buildMethodDetail(className, method),
        method.description || method.documentation
      );
    }
  }

  return completions;
}

connection.onCompletion((params): CompletionItem[] => {
  try {
    logInfo('[LSP] ===== onCompletion CALLED =====', params.textDocument.uri, params.position);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      logWarn('[LSP] Document not found!');
      return [];
    }

    const offset = doc.offsetAt(params.position);
    const fullText = doc.getText();
    const { word, start, end } = getWordAtPosition(fullText, offset);
    const wordLower = word.toLowerCase();
    const wordRange = {
      start: doc.positionAt(start),
      end: doc.positionAt(end)
    };
    const lines = fullText.split(/\r?\n/);
    const lineText = lines[params.position.line] || '';

    logInfo('[LSP] Completion triggered - word:', word, 'wordLower:', wordLower, 'languageId:', doc.languageId);

    const keywords = getKeywords(doc.languageId);
    const items: CompletionItem[] = [];
    const seen = new Set<string>();

    for (const kw of keywords) {
      const nameLower = kw.name.toLowerCase();
      if (nameLower.startsWith(wordLower) || wordLower === '') {
        const key = `${kw.name}:${kw.type || 'keyword'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          label: kw.name,
          kind: mapCompletionKind(kw.type),
          detail: kw.type,
          documentation: kw.documentation,
          textEdit: { range: wordRange, newText: kw.name }
        });
      }
    }

    try {
      const importList = getImportListFromDocument(fullText);
      importList.push({ name: 'dataTypes' }, { name: 'base' }, { name: 'ui' });
      const importPackages = parsePackageClasses(importList);
      const packageItems = importCompletionLsp(lineText, params.position, importPackages);
      for (const item of packageItems) {
        const key = `${item.label}:${item.kind}`;
        if (!seen.has(key)) {
          seen.add(key);
          items.push(item);
        }
      }
    } catch (err) {
      logError('[LSP] Package completion failed', err);
    }

    logInfo('[LSP] Returning', items.length, 'completion items, first 3:', items.slice(0, 3).map(i => i.label));
    return items;
  } catch (err) {
    logError('[LSP] FATAL: onCompletion crashed:', err);
    return [];
  }
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const { word } = getWordAtPosition(doc.getText(), offset);
  if (!word) return null;
  return buildHoverMarkdown(doc.languageId, word);
});

connection.onDefinition(async (params): Promise<Location | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return null;
  const offset = doc.offsetAt(params.position);
  const { word } = getWordAtPosition(doc.getText(), offset);
  if (!word) return null;
  return findDefinition(word, doc.uri, doc.getText());
});

connection.onSignatureHelp(async (params): Promise<SignatureHelp | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return null;

  const offset = doc.offsetAt(params.position);
  const callContext = getCallContext(doc.getText(), offset);
  if (!callContext) return null;

  const signature = await findFunctionSignature(callContext.functionName, doc.uri, doc.getText());
  if (!signature) return null;

  return buildSignatureHelp(signature, callContext.activeParameter);
});

connection.languages.inlayHint.on(async (params): Promise<InlayHint[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return [];

  const startOffset = doc.offsetAt(params.range.start);
  const endOffset = doc.offsetAt(params.range.end);
  return buildInlayHintsForRange(doc, startOffset, endOffset);
});

connection.onPrepareRename(async (params): Promise<Range | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return null;

  const offset = doc.offsetAt(params.position);
  const target = await resolveRenameTarget(doc, offset);
  return target?.range ?? null;
});

connection.onRenameRequest(async (params): Promise<WorkspaceEdit | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return null;

  const offset = doc.offsetAt(params.position);
  const target = await resolveRenameTarget(doc, offset);
  if (!target) return null;
  if (!params.newName || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(params.newName)) {
    return null;
  }

  return buildRenameWorkspaceEdit(target, params.newName, doc.uri, doc.getText());
});

connection.onReferences(async (params): Promise<Location[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return [];

  const offset = doc.offsetAt(params.position);
  const target = await resolveRenameTarget(doc, offset);
  if (!target) return [];

  return findReferences(target, doc.uri, doc.getText(), params.context.includeDeclaration === true);
});

connection.languages.semanticTokens.on((params): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') {
    return { data: [] };
  }
  return buildSemanticTokens(doc.getText());
});

connection.languages.callHierarchy.onPrepare(async (params): Promise<CallHierarchyItem[] | null> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || doc.languageId !== '4gl') return null;

  const offset = doc.offsetAt(params.position);
  const target = await resolveFunctionTarget(doc, offset);
  if (!target) return null;

  const record = await findFunctionDefinitionRecord(target.name, doc.uri, doc.getText());
  if (!record) return null;

  return [buildFunctionCallHierarchyItem(record)];
});

connection.languages.callHierarchy.onIncomingCalls(async (params): Promise<CallHierarchyIncomingCall[]> => {
  const text = readTextByUri(params.item.uri, '', '') ?? readTextByUri(params.item.uri, params.item.uri, documents.get(params.item.uri)?.getText() ?? '');
  const definitionRecord = text ? findFunctionDefinitionRecordInText(text, params.item.name, params.item.uri) : null;
  if (!definitionRecord) return [];

  const references = await findReferences({
    name: definitionRecord.block.name,
    kind: 'function',
    range: params.item.selectionRange,
    definitionUri: params.item.uri
  }, params.item.uri, text ?? '', false);

  const grouped = new Map<string, CallHierarchyIncomingCall>();
  for (const reference of references) {
    const referenceText = readTextByUri(reference.uri, params.item.uri, text ?? '');
    if (!referenceText) continue;
    const callerBlock = findFunctionBlockAtLine(referenceText, reference.range.start.line);
    if (!callerBlock) continue;
    const callerRecord: FunctionDefinitionRecord = {
      uri: reference.uri,
      block: callerBlock,
      signature: parseEnhancedFunctionSignature(callerBlock.content)
    };
    const key = `${reference.uri}:${callerBlock.name}:${callerBlock.startLine}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.fromRanges.push(reference.range);
      continue;
    }
    grouped.set(key, {
      from: buildFunctionCallHierarchyItem(callerRecord),
      fromRanges: [reference.range]
    });
  }

  return Array.from(grouped.values());
});

connection.languages.callHierarchy.onOutgoingCalls(async (params): Promise<CallHierarchyOutgoingCall[]> => {
  const text = readTextByUri(params.item.uri, params.item.uri, documents.get(params.item.uri)?.getText() ?? '');
  if (!text) return [];

  const definitionRecord = findFunctionDefinitionRecordInText(text, params.item.name, params.item.uri);
  if (!definitionRecord) return [];

  const grouped = new Map<string, CallHierarchyOutgoingCall>();
  for (const call of collectCalledFunctionNames(definitionRecord.block)) {
    const calleeRecord = await findFunctionDefinitionRecord(call.name, params.item.uri, text);
    if (!calleeRecord) continue;
    const key = `${calleeRecord.uri}:${calleeRecord.block.name}:${calleeRecord.block.startLine}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.fromRanges.push(call.range);
      continue;
    }
    grouped.set(key, {
      to: buildFunctionCallHierarchyItem(calleeRecord),
      fromRanges: [call.range]
    });
  }

  return Array.from(grouped.values());
});

function mapCompletionKind(type?: string): CompletionItemKind {
  switch ((type || '').toLowerCase()) {
    case 'keyword':
      return CompletionItemKind.Keyword;
    case 'color':
      return CompletionItemKind.Color;
    case 'constant':
      return CompletionItemKind.Constant;
    case 'variable':
      return CompletionItemKind.Variable;
    case 'operator':
      return CompletionItemKind.Operator;
    case 'method':
      return CompletionItemKind.Method;
    case 'function':
      return CompletionItemKind.Function;
    default:
      return CompletionItemKind.Text;
  }
}

documents.listen(connection);
connection.listen();

logInfo('[LSP Server] Now listening for requests...');
