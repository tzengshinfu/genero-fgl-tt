import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseSymbols, Sym } from '../parser';
import { getPrioritizedFiles } from '../utils/searchUtils';
import { logError } from '../utils/logger';

/**
 * WorkspaceSymbolProvider - 在整個工作區中搜索符號（函數、報表、RECORD、TYPE）
 * 允許使用 Ctrl+T 快速定位跨文件的符號
 */
export class WorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  /**
   * 提供工作區符號搜索
   * @param query 搜索查詢字符串（函數名、報表名等）
   */
  public async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    const symbols: vscode.SymbolInformation[] = [];

    try {
      // 1. 獲取優先搜尋的庫文件
      const prioritizedFiles = await getPrioritizedFiles(token, ['.4gl', '.per']);

      // 2. 搜尋其餘工作區文件
      const workspaceFiles = await vscode.workspace.findFiles('**/*.{4gl,per}');

      // 3. 合併並去重
      const files = this.mergeUniqueFiles(prioritizedFiles, workspaceFiles);

      for (const fileUri of files) {
        if (token.isCancellationRequested) break;

        try {
          const document = await vscode.workspace.openTextDocument(fileUri);
          const fileSymbols = await this.extractSymbolsFromFile(
            document,
            query
          );
          symbols.push(...fileSymbols);
        } catch (err) {
          logError(`[Genero FGL] Error parsing file ${fileUri.fsPath}:`, err);
        }
      }
    } catch (err) {
      logError('[Genero FGL] Error in workspace symbol search:', err);
    }

    return symbols;
  }

  private mergeUniqueFiles(
    prioritizedFiles: vscode.Uri[],
    workspaceFiles: vscode.Uri[]
  ): vscode.Uri[] {
    const seen = new Set<string>();
    const result: vscode.Uri[] = [];

    // 先加入優先文件
    for (const uri of prioritizedFiles) {
      const key = uri.fsPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(uri);
    }

    // 再加入工作區其他文件
    for (const uri of workspaceFiles) {
      const key = uri.fsPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(uri);
    }

    return result;
  }

  /**
   * 從單個文件中提取符號
   */
  private async extractSymbolsFromFile(
    document: vscode.TextDocument,
    query: string
  ): Promise<vscode.SymbolInformation[]> {
    const symbols: vscode.SymbolInformation[] = [];
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    // 解析文檔符號
    try {
      const parsed = parseSymbols(text);
      this.collectSymbols(parsed, symbols, document.uri, query);
    } catch (err) {
      logError(`[Genero FGL] Symbol parsing error for ${document.uri.fsPath}:`, err);
    }

    // 備用：簡單的正則表達式搜索（如果解析失敗）
    if (symbols.length === 0) {
      const functionRegex = /^\s*(?:PUBLIC|PRIVATE|STATIC)?\s*FUNCTION\s+([A-Za-z0-9_]+)/im;
      const reportRegex = /^\s*REPORT\s+([A-Za-z0-9_]+)/im;
      const typeRegex = /^\s*TYPE\s+([A-Za-z0-9_]+)/im;
      const recordRegex = /^\s*(?:.*?)\s+([A-Za-z0-9_]+)\s+(?:DYNAMIC\s+ARRAY\s+OF\s+)?RECORD\b/im;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 搜索函數
        let match = functionRegex.exec(line);
        if (match && this.matchesQuery(match[1], query)) {
          symbols.push(
            new vscode.SymbolInformation(
              match[1],
              vscode.SymbolKind.Function,
              '',
              new vscode.Location(document.uri, new vscode.Position(i, 0))
            )
          );
          functionRegex.lastIndex = 0;
        }

        // 搜索報表
        match = reportRegex.exec(line);
        if (match && this.matchesQuery(match[1], query)) {
          symbols.push(
            new vscode.SymbolInformation(
              match[1],
              vscode.SymbolKind.Function,
              '',
              new vscode.Location(document.uri, new vscode.Position(i, 0))
            )
          );
          reportRegex.lastIndex = 0;
        }

        // 搜索 TYPE
        match = typeRegex.exec(line);
        if (match && this.matchesQuery(match[1], query)) {
          symbols.push(
            new vscode.SymbolInformation(
              match[1],
              vscode.SymbolKind.Struct,
              '',
              new vscode.Location(document.uri, new vscode.Position(i, 0))
            )
          );
          typeRegex.lastIndex = 0;
        }

        // 搜索 RECORD
        match = recordRegex.exec(line);
        if (match && this.matchesQuery(match[1], query)) {
          symbols.push(
            new vscode.SymbolInformation(
              match[1],
              vscode.SymbolKind.Struct,
              '',
              new vscode.Location(document.uri, new vscode.Position(i, 0))
            )
          );
          recordRegex.lastIndex = 0;
        }
      }
    }

    return symbols;
  }

  /**
   * 遞迴收集符號
   */
  private collectSymbols(
    syms: Sym[],
    result: vscode.SymbolInformation[],
    uri: vscode.Uri,
    query: string
  ): void {
    for (const sym of syms) {
      if (!sym.name) continue;

      // 檢查是否匹配查詢
      if (this.matchesQuery(sym.name, query)) {
        let kind: vscode.SymbolKind = vscode.SymbolKind.Variable;
        const symKind = (sym.kind || 'Variable') as string;
        switch (symKind) {
          case 'Function':
            kind = vscode.SymbolKind.Function;
            break;
          case 'Report':
            kind = vscode.SymbolKind.Function;
            break;
          case 'Record':
            kind = vscode.SymbolKind.Struct;
            break;
          case 'Type':
            kind = vscode.SymbolKind.Struct;
            break;
          case 'Main':
            kind = vscode.SymbolKind.Namespace;
            break;
          case 'Globals':
            kind = vscode.SymbolKind.Namespace;
            break;
          case 'Variable':
          case 'ModuleVariable':
            kind = vscode.SymbolKind.Variable;
            break;
        }

        result.push(
          new vscode.SymbolInformation(
            sym.name,
            kind,
            sym.detail || '',
            new vscode.Location(uri, new vscode.Position(sym.start, 0))
          )
        );
      }

      // 遞迴搜索子符號
      if (sym.children && sym.children.length > 0) {
        this.collectSymbols(sym.children, result, uri, query);
      }
    }
  }

  /**
   * 檢查符號名是否匹配查詢
   * 支持模糊匹配和前綴匹配
   */
  private matchesQuery(name: string, query: string): boolean {
    if (!query || query.length === 0) return true;

    const lowerName = name.toLowerCase();
    const lowerQuery = query.toLowerCase();

    // 完全匹配
    if (lowerName === lowerQuery) return true;

    // 前綴匹配
    if (lowerName.startsWith(lowerQuery)) return true;

    // 包含匹配（任意位置）
    if (lowerName.includes(lowerQuery)) return true;

    // 模糊匹配：查詢的每個字符都在名稱中按順序出現
    let nameIndex = 0;
    for (const char of lowerQuery) {
      nameIndex = lowerName.indexOf(char, nameIndex);
      if (nameIndex === -1) return false;
      nameIndex++;
    }

    return true;
  }
}
