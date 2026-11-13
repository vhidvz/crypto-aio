import createDebug from 'debug';
import { redactDeep, redactText } from '../secret/redact';

/** A log entry's severity. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** A log entry's structured fields. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Where the library logs (`AioOptions.logger`). A port you may implement: it never gains a
 * required member in a 1.x release. `createLogger` builds one that redacts before writing;
 * one of your own should redact too, since fields can carry endpoint URLs.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger for a sub-namespace, such as `transport`. */
  child(namespace: string): Logger;
}

/**
 * Writes one redacted entry, for `createLogger`. A port you may implement: it never gains
 * a required parameter in a 1.x release.
 */
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

/**
 * Structured logger; fields are always redacted before they reach the writer. The default
 * writer logs through `debug` under `<namespace>:<level>`.
 */
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

/** A logger that drops everything. */
export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => noopLogger,
};
