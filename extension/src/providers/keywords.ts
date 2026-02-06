/**
 * 關鍵字定義 - 用於補全和 Hover 功能（與 GeneroLSP 對齊）
 */

import * as fs from 'fs';
import * as path from 'path';

interface KeywordItem {
  name: string;
  type?: string;
  documentation?: string;
  description?: string;
}

function loadKeywords(fileName: string): KeywordItem[] {
  const candidates = [
    path.join(__dirname, '..', 'Resources', fileName),
    path.join(__dirname, '..', '..', 'Resources', fileName)
  ];

  const p = candidates.find(fp => fs.existsSync(fp));
  if (!p) return [];

  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as KeywordItem[];
    if (parsed && Array.isArray(parsed.keywords)) return parsed.keywords as KeywordItem[];
  } catch (err) {
    console.error('[Genero FGL] Failed to load keywords', fileName, err);
  }

  return [];
}

export const KEYWORDS_4GL: KeywordItem[] = loadKeywords('4GLKeywords.json');
export const KEYWORDS_PER: KeywordItem[] = loadKeywords('PERKeywords.json');
