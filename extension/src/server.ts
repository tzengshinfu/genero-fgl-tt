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
  DiagnosticTag
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { KEYWORDS_4GL, KEYWORDS_PER } from './providers/keywords';
import { parsePackageClasses, Package, PackageClass, Method } from './Handlers/packageHandler';
import { ImportType } from './Handlers/importTypes';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const workspaceFolders = new Set<string>();

console.log('[LSP Server] Starting Genero FGL Language Server');

connection.onInitialize((params: InitializeParams): InitializeResult => {
  console.log('[LSP Server] onInitialize called');
  workspaceFolders.clear();
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
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'.split('')
      }
    }
  };
});

connection.onInitialized(() => {
  console.log('[LSP Server] onInitialized - server is ready');
});

documents.onDidOpen((event) => {
  console.log('[LSP Server] Document opened:', event.document.uri, 'languageId:', event.document.languageId);
  void validateDocument(event.document);
});

documents.onDidChangeContent((change) => {
  console.log('[LSP Server] Document changed:', change.document.uri);
  void validateDocument(change.document);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDidChangeConfiguration(() => {
  for (const document of documents.all()) {
    void validateDocument(document);
  }
});

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

async function isDiagnosticEnabled(): Promise<boolean> {
  try {
    const enabled = await connection.workspace.getConfiguration('GeneroFGL.4gl.diagnostic.enable');
    return enabled !== false;
  } catch {
    return true;
  }
}

async function validateDocument(document: TextDocument): Promise<void> {
  if (document.languageId !== '4gl') {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    return;
  }
  if (!await isDiagnosticEnabled()) {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    return;
  }
  try {
    connection.sendDiagnostics({ uri: document.uri, diagnostics: buildUnusedVariableDiagnostics(document.getText()) });
  } catch (error) {
    console.error('[LSP] validateDocument failed', error);
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
  for (const filePath of collectWorkspaceFiles(['.4gl'])) {
    const normalized = path.normalize(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const found = findDefinitionInText(text, name, URI.file(filePath).toString());
      if (found) return found;
    } catch (error) {
      console.error('[LSP] Error searching definition in', filePath, error);
    }
  }

  return null;
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
    console.log('[LSP] ===== onCompletion CALLED =====', params.textDocument.uri, params.position);
    const doc = documents.get(params.textDocument.uri);
    if (!doc) {
      console.log('[LSP] Document not found!');
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

    console.log('[LSP] Completion triggered - word:', word, 'wordLower:', wordLower, 'languageId:', doc.languageId);

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
      console.error('[LSP] Package completion failed', err);
    }

    console.log('[LSP] Returning', items.length, 'completion items, first 3:', items.slice(0, 3).map(i => i.label));
    return items;
  } catch (err) {
    console.error('[LSP] FATAL: onCompletion crashed:', err);
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

console.log('[LSP Server] Now listening for requests...');
