import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  CompletionItem,
  CompletionItemKind,
  TextDocumentSyncKind
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { KEYWORDS_4GL, KEYWORDS_PER } from './providers/keywords';
import { parsePackageClasses, Package, PackageClass, Method } from './Handlers/packageHandler';
import { ImportType } from './Handlers/importTypes';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

console.log('[LSP Server] Starting Genero FGL Language Server');

connection.onInitialize((params: InitializeParams): InitializeResult => {
  console.log('[LSP Server] onInitialize called');
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
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
});

documents.onDidChangeContent((change) => {
  console.log('[LSP Server] Document changed:', change.document.uri);
});

function getKeywords(languageId: string): { name: string; type?: string; documentation?: string }[] {
  if (languageId === 'per') return KEYWORDS_PER;
  return KEYWORDS_4GL;
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
