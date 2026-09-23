import { inspect } from 'node:util';

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

export function secret<T>(value: T | Secret<T>): Secret<T> {
  return value instanceof Secret ? value : new Secret(value);
}

export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}

export function reveal<T>(value: T | Secret<T>): T {
  return value instanceof Secret ? (value.reveal() as T) : value;
}
