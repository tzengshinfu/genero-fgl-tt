import * as vscode from 'vscode';
import { KEYWORDS_4GL, KEYWORDS_PER } from './keywords';
import { getImportList, importCompletion } from '../Handlers/importHandler';
import { parsePackageClasses } from '../Handlers/packageHandler';

export class CompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const line = document.lineAt(position.line).text;
    const linePrefix = line.substring(0, position.character);

    // 檢測語言
    const isPerFile = document.languageId === 'per' || document.fileName.endsWith('.per');
    const keywords = isPerFile ? KEYWORDS_PER : KEYWORDS_4GL;

    // 提取當前輸入的單詞 - 從末尾向後查找
    let wordStart = position.character - 1;
    while (wordStart >= 0 && /[A-Za-z0-9_]/.test(line[wordStart])) {
      wordStart--;
    }
    wordStart++;

    const word = line.substring(wordStart, position.character);
    const wordLower = word.toLowerCase();

    // 計算單詞的 Range
    const wordRange = new vscode.Range(position.line, wordStart, position.line, position.character);

    // 過濾匹配用戶輸入的補全項
    const completions: vscode.CompletionItem[] = [];

    keywords.forEach((kw) => {
      // 如果關鍵字以用戶輸入開頭，則包含在補全列表中
      if (kw.name.toLowerCase().startsWith(wordLower)) {
        const item = new vscode.CompletionItem(
          kw.name,
          this.mapCompletionKind(kw.type)
        );
        item.filterText = kw.name.toLowerCase();
        item.sortText = kw.name.toLowerCase();
        item.insertText = kw.name;
        item.range = wordRange;
        if (kw.documentation) {
          item.documentation = new vscode.MarkdownString(kw.documentation);
        }
        completions.push(item);
      }
    });

    // 套件/類別補全（匯入分析）
    try {
      const importList = getImportList(document);
      importList.push({ name: 'dataTypes' }, { name: 'base' }, { name: 'ui' });
      const importPackages = parsePackageClasses(importList);
      const packageCompletions = importCompletion(document, position, importPackages);
      for (const item of packageCompletions) {
        const key = `${item.label}:${item.kind}`;
        if (!completions.some(c => `${c.label}:${c.kind}` === key)) {
          completions.push(item);
        }
      }
    } catch (err) {
      console.error('[Genero FGL] completion package analysis failed', err);
    }

    return completions;
  }

  private mapCompletionKind(type?: string): vscode.CompletionItemKind {
    switch ((type || '').toLowerCase()) {
      case 'keyword':
        return vscode.CompletionItemKind.Keyword;
      case 'color':
        return vscode.CompletionItemKind.Color;
      case 'constant':
        return vscode.CompletionItemKind.Constant;
      case 'variable':
        return vscode.CompletionItemKind.Variable;
      case 'operator':
        return vscode.CompletionItemKind.Operator;
      case 'method':
        return vscode.CompletionItemKind.Method;
      case 'function':
        return vscode.CompletionItemKind.Function;
      default:
        return vscode.CompletionItemKind.Text;
    }
  }
}
