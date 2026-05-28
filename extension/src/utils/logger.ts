export type LogLevel = 'info' | 'warn' | 'error';

type BufferedLogEntry = {
  level: LogLevel;
  message: string;
};

type LogWriter = (level: LogLevel, message: string) => void;

let logWriter: LogWriter | undefined;
const pendingEntries: BufferedLogEntry[] = [];

function formatLogPart(part: unknown): string {
  if (part instanceof Error) {
    return part.stack || part.message;
  }

  if (typeof part === 'string') {
    return part;
  }

  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function emit(level: LogLevel, parts: unknown[]) {
  const message = parts.map(formatLogPart).join(' ');
  if (logWriter) {
    logWriter(level, message);
    return;
  }

  pendingEntries.push({ level, message });
}

export function setLogWriter(writer: LogWriter | undefined) {
  logWriter = writer;
  if (!logWriter) {
    return;
  }

  while (pendingEntries.length > 0) {
    const entry = pendingEntries.shift();
    if (!entry) {
      continue;
    }

    logWriter(entry.level, entry.message);
  }
}

export function logInfo(...parts: unknown[]) {
  emit('info', parts);
}

export function logWarn(...parts: unknown[]) {
  emit('warn', parts);
}

export function logError(...parts: unknown[]) {
  emit('error', parts);
}