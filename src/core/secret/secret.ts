import { inspect } from 'node:util';

/** What a `Secret` and every redacted value render as. */
export const REDACTED = '[REDACTED]';

const values = new WeakMap<object, unknown>();

/** Wraps sensitive material so that it never renders in logs, JSON or inspection. */
export class Secret<T = string> {
  constructor(value: T) {
    values.set(this, value);
    Object.freeze(this);
  }

  reveal(): T {
    return values.get(this) as T;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}

/** Wraps `value` as a `Secret`; a `Secret` is returned as it is. */
export function secret<T>(value: T | Secret<T>): Secret<T> {
  return value instanceof Secret ? value : new Secret(value);
}

/** Whether `value` is a `Secret`. */
export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}

/** The value inside a `Secret`, or `value` itself when it is not one. */
export function reveal<T>(value: T | Secret<T>): T {
  return value instanceof Secret ? (value.reveal() as T) : value;
}
