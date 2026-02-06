import * as vscode from 'vscode';
import { KEYWORDS_4GL, KEYWORDS_PER } from './keywords';

export class HoverProvider implements vscode.HoverProvider {
  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
    if (!range) return null;

    const word = document.getText(range);
    const isPerFile = document.languageId === 'per' || document.fileName.endsWith('.per');
    const keywords = isPerFile ? KEYWORDS_PER : KEYWORDS_4GL;

    const keyword = keywords.find((k) => k.name.toLowerCase() === word.toLowerCase());
    if (!keyword) return null;

    const markdown = new vscode.MarkdownString();
    markdown.appendCodeblock(keyword.name, 'genero 4gl');

    if (keyword.description) {
      markdown.appendMarkdown('\n\n');
      markdown.appendMarkdown(keyword.description);
    }

    if (keyword.documentation) {
      markdown.appendMarkdown('\n\n');
      markdown.appendMarkdown(keyword.documentation);
    }

    if (keyword.type) {
      markdown.appendMarkdown(`\n\n**Type**: ${keyword.type}`);
    }

    return new vscode.Hover(markdown);
  }
}
