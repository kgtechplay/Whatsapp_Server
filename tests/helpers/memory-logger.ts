import type { AppLogger, LogFields } from '../../src/config/logger.js';

export interface LogEntry {
  level: string;
  fields: LogFields;
  message?: string;
}

export interface MemoryLogger extends AppLogger {
  entries: LogEntry[];
  text(): string;
}

export function createMemoryLogger(): MemoryLogger {
  const entries: LogEntry[] = [];
  const write = (level: string) => (fields: LogFields, message?: string): void => {
    entries.push({ level, fields, ...(message === undefined ? {} : { message }) });
  };

  return {
    entries,
    text: () => JSON.stringify(entries),
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    fatal: write('fatal'),
  };
}
