import createDebug from 'debug';
import { redactDeep, redactText } from '../secret/redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(namespace: string): Logger;
}

export type LogWriter = (
  level: LogLevel,
  namespace: string,
  message: string,
  fields?: Record<string, unknown>,
) => void;

const debuggers = new Map<string, createDebug.Debugger>();

const debugWriter: LogWriter = (level, namespace, message, fields) => {
  const name = `${namespace}:${level}`;
  let log = debuggers.get(name);
  if (!log) {
    log = createDebug(name);
    debuggers.set(name, log);
  }
  if (fields && Object.keys(fields).length > 0) log('%s %o', message, fields);
  else log('%s', message);
};

/** Structured logger; fields are always redacted before they reach the writer. */
export function createLogger(
  namespace = 'crypto-aio',
  write: LogWriter = debugWriter,
): Logger {
  const emit = (level: LogLevel) => (message: string, fields?: LogFields) =>
    write(
      level,
      namespace,
      redactText(message),
      fields ? (redactDeep(fields) as Record<string, unknown>) : undefined,
    );
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (child) => createLogger(`${namespace}:${child}`, write),
  };
}

const noop = (): void => undefined;

export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
};
