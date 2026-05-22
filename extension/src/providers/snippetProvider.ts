import * as vscode from 'vscode';

export interface FglSnippetDefinition {
  prefix: string;
  description?: string;
  body: string[];
  enabled?: boolean;
}

export type FglSnippetMap = Record<string, FglSnippetDefinition>;

type CompletionResult = vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> | null | undefined;

function isSnippetDefinition(value: unknown): value is FglSnippetDefinition {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as FglSnippetDefinition;
  return typeof candidate.prefix === 'string'
    && Array.isArray(candidate.body)
    && candidate.body.every(line => typeof line === 'string');
}

function mergeSnippetMaps(...maps: Array<FglSnippetMap | undefined>): FglSnippetMap {
  const merged: FglSnippetMap = {};
  for (const map of maps) {
    if (!map || typeof map !== 'object') {
      continue;
    }
    for (const [key, value] of Object.entries(map)) {
      if (isSnippetDefinition(value)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

export function loadSnippets(config = vscode.workspace.getConfiguration('GeneroFGL')): FglSnippetMap {
  const inspected = config.inspect<FglSnippetMap>('4gl.snippets');
  return mergeSnippetMaps(
    inspected?.defaultValue,
    inspected?.globalValue,
    inspected?.workspaceValue,
    inspected?.workspaceFolderValue
  );
}

export function buildSnippetCompletions(
  document: vscode.TextDocument,
  position: vscode.Position,
  word: string,
  wordRange?: vscode.Range,
  snippets = loadSnippets()
): vscode.CompletionItem[] {
  const wordLower = word.toLowerCase();
  const range = wordRange ?? new vscode.Range(position.line, position.character - word.length, position.line, position.character);
  const completions: vscode.CompletionItem[] = [];

  for (const snippet of Object.values(snippets)) {
    if (snippet.enabled === false) {
      continue;
    }
    if (!snippet.prefix.toLowerCase().startsWith(wordLower)) {
      continue;
    }

    const item = new vscode.CompletionItem(snippet.prefix, vscode.CompletionItemKind.Snippet);
    item.detail = 'Genero FGL Snippet';
    item.documentation = snippet.description;
    item.filterText = snippet.prefix.toLowerCase();
    item.sortText = `0_${snippet.prefix.toLowerCase()}`;
    item.insertText = new vscode.SnippetString(snippet.body.join('\n'));
    item.range = range;
    completions.push(item);
  }

  return completions;
}

function buildCurrentWord(document: vscode.TextDocument, position: vscode.Position): { word: string; wordRange: vscode.Range } {
  const line = document.lineAt(position.line).text;
  let wordStart = position.character - 1;
  while (wordStart >= 0 && /[A-Za-z0-9_]/.test(line[wordStart])) {
    wordStart--;
  }
  wordStart++;

  return {
    word: line.substring(wordStart, position.character),
    wordRange: new vscode.Range(position.line, wordStart, position.line, position.character)
  };
}

export function mergeCompletionResultsWithSnippets(
  document: vscode.TextDocument,
  position: vscode.Position,
  result: CompletionResult,
  snippets = loadSnippets()
): CompletionResult {
  const { word, wordRange } = buildCurrentWord(document, position);
  const snippetItems = buildSnippetCompletions(document, position, word, wordRange, snippets);

  if (!result) {
    return snippetItems;
  }

  if (Array.isArray(result)) {
    return dedupeCompletionItems([...result, ...snippetItems]);
  }

  return new vscode.CompletionList(
    dedupeCompletionItems([...(result.items ?? []), ...snippetItems]),
    result.isIncomplete
  );
}

function dedupeCompletionItems(items: vscode.CompletionItem[]): vscode.CompletionItem[] {
  const seen = new Set<string>();
  const deduped: vscode.CompletionItem[] = [];

  for (const item of items) {
    const key = `${String(item.label)}:${item.kind ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export const __test__ = {
  mergeSnippetMaps
};