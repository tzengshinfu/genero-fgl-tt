export type FoldingRangeKindName = 'comment' | 'region';

export interface SimpleFoldingRange {
  start: number;
  end: number;
  kind?: FoldingRangeKindName;
}

type FoldingBlockKind =
  | 'function'
  | 'main'
  | 'report'
  | 'if'
  | 'while'
  | 'for'
  | 'foreach'
  | 'record'
  | 'interface'
  | 'construct'
  | 'select'
  | 'loop'
  | 'display'
  | 'input'
  | 'case';

function stripInlineComment(line: string): string {
  if (!line) return line;
  return line.replace(/#.*/g, '').replace(/--.*$/, '');
}

function getFoldingBlockStartKind(trimmed: string): FoldingBlockKind | null {
  if (/^(?:PUBLIC|PRIVATE|STATIC\s+)?FUNCTION\b/i.test(trimmed)) return 'function';
  if (/^MAIN\b/i.test(trimmed)) return 'main';
  if (/^REPORT\b/i.test(trimmed)) return 'report';
  if (/^IF\b/i.test(trimmed)) return 'if';
  if (/^WHILE\b/i.test(trimmed)) return 'while';
  if (/^FOR\b/i.test(trimmed)) return 'for';
  if (/^FOREACH\b/i.test(trimmed)) return 'foreach';
  if (/^DISPLAY\s+ARRAY\b/i.test(trimmed)) return 'display';
  if (/^INPUT\b/i.test(trimmed)) return 'input';
  if (/^INTERFACE\b/i.test(trimmed)) return 'interface';
  if (/^CONSTRUCT\b/i.test(trimmed)) return 'construct';
  if (/^SELECT\b/i.test(trimmed)) return 'select';
  if (/^LOOP\b/i.test(trimmed)) return 'loop';
  if (/^CASE\b/i.test(trimmed)) return 'case';
  if (/^TYPE\b.*\bRECORD\b/i.test(trimmed)) return 'record';
  if (/^(?:DEFINE\b.*\b)?(?:DYNAMIC\s+ARRAY\s+OF\s+)?RECORD\b/i.test(trimmed)) return 'record';
  return null;
}

function getFoldingBlockEndKind(trimmed: string): FoldingBlockKind | null {
  if (/^END\s+FUNCTION\b/i.test(trimmed)) return 'function';
  if (/^END\s+MAIN\b/i.test(trimmed)) return 'main';
  if (/^END\s+REPORT\b/i.test(trimmed)) return 'report';
  if (/^END\s+IF\b/i.test(trimmed)) return 'if';
  if (/^END\s+WHILE\b/i.test(trimmed)) return 'while';
  if (/^END\s+FOR\b/i.test(trimmed)) return 'for';
  if (/^END\s+FOREACH\b/i.test(trimmed)) return 'foreach';
  if (/^END\s+DISPLAY\b/i.test(trimmed)) return 'display';
  if (/^END\s+INPUT\b/i.test(trimmed)) return 'input';
  if (/^END\s+RECORD\b/i.test(trimmed)) return 'record';
  if (/^END\s+INTERFACE\b/i.test(trimmed)) return 'interface';
  if (/^END\s+CONSTRUCT\b/i.test(trimmed)) return 'construct';
  if (/^END\s+SELECT\b/i.test(trimmed)) return 'select';
  if (/^END\s+LOOP\b/i.test(trimmed)) return 'loop';
  if (/^END\s+CASE\b/i.test(trimmed)) return 'case';
  return null;
}

export function computeFoldingRanges(lines: string[]): SimpleFoldingRange[] {
  const ranges: SimpleFoldingRange[] = [];
  const lineCount = lines.length;
  let commentStart = -1;
  let commentType: 'hash' | 'dash' | null = null;
  let blockCommentStart = -1;
  const blockStack: Array<{ kind: FoldingBlockKind; line: number }> = [];
  const regionStack: number[] = [];
  const structuralLines = new Set<number>();

  function getIndent(line: string): number {
    const m = line.match(/^(\s*)/);
    if (!m) return 0;
    let indent = 0;
    for (const ch of m[1]) {
      indent += ch === '\t' ? 4 : 1;
    }
    return indent;
  }

  const flushCommentRange = (endLine: number) => {
    if (commentStart >= 0 && endLine > commentStart) {
      ranges.push({ start: commentStart, end: endLine, kind: 'comment' });
    }
    commentStart = -1;
    commentType = null;
  };

  const closeBlock = (kind: FoldingBlockKind, endLine: number) => {
    for (let index = blockStack.length - 1; index >= 0; index--) {
      if (blockStack[index].kind !== kind) continue;
      const [block] = blockStack.splice(index, 1);
      structuralLines.add(block.line);
      structuralLines.add(endLine);
      if (endLine - 1 > block.line) {
        ranges.push({ start: block.line, end: endLine - 1 });
      }
      return;
    }
  };

  for (let i = 0; i < lineCount; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    const isRegionMarker = /^\s*--\s*#(region|endregion)\b/i.test(text);
    const codeTrimmed = stripInlineComment(text).trim();

    if (/^\s*--\s*#region\b/i.test(text)) {
      flushCommentRange(i - 1);
      structuralLines.add(i);
      regionStack.push(i);
      continue;
    }

    if (/^\s*--\s*#endregion\b/i.test(text)) {
      flushCommentRange(i - 1);
      structuralLines.add(i);
      const regionStart = regionStack.pop();
      if (typeof regionStart === 'number' && i > regionStart) {
        ranges.push({ start: regionStart, end: i, kind: 'region' });
      }
      continue;
    }

    if (blockCommentStart >= 0) {
      structuralLines.add(i);
      if (/^\s*}/.test(text)) {
        if (i > blockCommentStart) {
          ranges.push({ start: blockCommentStart, end: i, kind: 'comment' });
        }
        blockCommentStart = -1;
      }
      continue;
    }

    if (/^\s*{/.test(text) && !/^\s*{[^}]*}/.test(text)) {
      flushCommentRange(i - 1);
      structuralLines.add(i);
      blockCommentStart = i;
      continue;
    }

    const endKind = getFoldingBlockEndKind(codeTrimmed);
    if (endKind) {
      flushCommentRange(i - 1);
      closeBlock(endKind, i);
    }

    let currentCommentType: 'hash' | 'dash' | null = null;
    if (/^\s*#/.test(text)) {
      currentCommentType = 'hash';
    } else if (/^\s*--/.test(text) && !isRegionMarker) {
      currentCommentType = 'dash';
    }

    if (currentCommentType === null || trimmed.length === 0) {
      flushCommentRange(i - 1);
      const startKind = getFoldingBlockStartKind(codeTrimmed);
      if (startKind) {
        structuralLines.add(i);
        blockStack.push({ kind: startKind, line: i });
      }
      continue;
    }

    if (commentStart < 0) {
      commentStart = i;
      commentType = currentCommentType;
      continue;
    }

    if (commentType !== currentCommentType) {
      flushCommentRange(i - 1);
      commentStart = i;
      commentType = currentCommentType;
    }
  }

  flushCommentRange(lineCount - 1);

  const indentRanges: SimpleFoldingRange[] = [];
  const indentStack: Array<{ indent: number; start: number }> = [];

  const closeIndentBlocks = (endLine: number, minimumIndent = -1) => {
    while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent > minimumIndent) {
      const last = indentStack.pop();
      if (last && endLine > last.start) {
        indentRanges.push({ start: last.start, end: endLine });
      }
    }
  };

  let previousContentLine = -1;
  let previousContentIndent = 0;

  for (let i = 0; i < lineCount; i++) {
    const text = lines[i];
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const indent = getIndent(text);
    const isStructuralLine = structuralLines.has(i);

    if (previousContentLine >= 0 && !structuralLines.has(previousContentLine) && indent > previousContentIndent) {
      indentStack.push({ indent, start: previousContentLine });
    }

    if (indentStack.length > 0 && indent < indentStack[indentStack.length - 1].indent) {
      closeIndentBlocks(i - 1, indent);
    }

    if (isStructuralLine) {
      previousContentLine = -1;
      previousContentIndent = 0;
      continue;
    }

    previousContentLine = i;
    previousContentIndent = indent;
  }

  closeIndentBlocks(lineCount - 1);

  return ranges.concat(indentRanges);
}