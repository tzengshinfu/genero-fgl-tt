import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logError } from './logger';

const SUPPORTED_EXTENSIONS = new Set(['.4gl', '.per']);

function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

async function walkDirectoryForFiles(
  dirPath: string,
  token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (token.isCancellationRequested) break;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const childFiles = await walkDirectoryForFiles(fullPath, token);
        files.push(...childFiles);
      } else if (entry.isFile() && isSupportedFile(fullPath)) {
        files.push(vscode.Uri.file(fullPath));
      }
    }
  } catch (err) {
    logError(`[Genero FGL] Error scanning library directory ${dirPath}:`, err);
  }
  return files;
}

/**
 * 獲取優先搜尋的檔案列表
 * 根據 GeneroFGL.4gl.library.paths 設定
 */
export async function getPrioritizedFiles(
  token: vscode.CancellationToken,
  extensions?: string[]
): Promise<vscode.Uri[]> {
  const cfg = vscode.workspace.getConfiguration('GeneroFGL');
  const libraryPaths = cfg.get<string[]>('4gl.library.paths', []) || [];
  if (!Array.isArray(libraryPaths) || libraryPaths.length === 0) return [];

  const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) || [];
  const resolvedPaths: string[] = [];

  for (const raw of libraryPaths) {
    const p = (raw || '').trim();
    if (!p) continue;

    // 處理相對路徑與絕對路徑
    if (path.isAbsolute(p)) {
      resolvedPaths.push(p);
    } else {
      for (const root of workspaceRoots) {
        resolvedPaths.push(path.join(root, p));
      }
    }
  }

  // 如果有指定副檔名，暫時過濾掉集合
  const targetExts = extensions ? new Set(extensions.map(e => e.toLowerCase())) : SUPPORTED_EXTENSIONS;

  const files: vscode.Uri[] = [];
  const seenPaths = new Set<string>();

  for (const p of resolvedPaths) {
    if (token.isCancellationRequested) break;
    if (!fs.existsSync(p)) continue;

    try {
      const stat = fs.statSync(p);
      if (stat.isFile()) {
        const ext = path.extname(p).toLowerCase();
        if (targetExts.has(ext) && !seenPaths.has(p)) {
          files.push(vscode.Uri.file(p));
          seenPaths.add(p);
        }
      } else if (stat.isDirectory()) {
        const dirFiles = await walkDirectoryForFiles(p, token);
        for (const uri of dirFiles) {
          const ext = path.extname(uri.fsPath).toLowerCase();
          if (targetExts.has(ext) && !seenPaths.has(uri.fsPath)) {
            files.push(uri);
            seenPaths.add(uri.fsPath);
          }
        }
      }
    } catch (err) {
      logError(`[Genero FGL] Error reading library path ${p}:`, err);
    }
  }

  return files;
}
