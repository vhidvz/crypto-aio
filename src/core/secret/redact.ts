import { REDACTED, isSecret, type Secret } from './secret';

const SENSITIVE_KEY =
  /(key|secret|token|password|passphrase|mnemonic|private|seed|authorization|cookie)/i;
const SENSITIVE_HEADER = /(authorization|api[-_]?key|token|secret|cookie)/i;
const KEYLIKE_SEGMENT = /^[A-Za-z0-9_-]{16,}$/;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi;

export function redactUrl(url: string | Secret<string>): string {
  const isSecretUrl = isSecret(url);
  const raw = isSecretUrl ? (url as Secret<string>).reveal() : (url as string);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return REDACTED;
  }
  if (isSecretUrl) return `${parsed.protocol}//${parsed.host}/${REDACTED}`;
  const path = parsed.pathname
    .split('/')
    .map((segment) => (KEYLIKE_SEGMENT.test(segment) ? REDACTED : segment))
    .join('/');
  const keys = [...new Set(parsed.searchParams.keys())];
  const query = keys.length
    ? `?${keys.map((k) => `${encodeURIComponent(k)}=${REDACTED}`).join('&')}`
    : '';
  const auth = parsed.username || parsed.password ? `${REDACTED}@` : '';
  return `${parsed.protocol}//${auth}${parsed.host}${path}${query}`;
}

export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = match.match(/[.,;:!?]+$/);
    const trailingStr = trailing ? trailing[0] : '';
    const url = trailing ? match.slice(0, -trailingStr.length) : match;
    return redactUrl(url) + trailingStr;
  });
}

export function redactHeaders(
  headers: Readonly<Record<string, string | Secret<string>>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] =
      isSecret(value) || SENSITIVE_HEADER.test(name) ? REDACTED : (value as string);
  }
  return out;
}

export function redactDeep(value: unknown, depth = 8): unknown {
  return walk(value, depth, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isSecret(value)) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return `[bytes:${value.length}]`;
  if (value instanceof Error)
    return { name: value.name, message: redactText(value.message) };
  if (seen.has(value)) return '[Circular]';
  if (depth <= 0) return '[Truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, depth - 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // Redact if key is sensitive and value is not a primitive (bool, number)
    const isPrimitive = typeof item === 'boolean' || typeof item === 'number';
    const sensitive = SENSITIVE_KEY.test(key) && !isPrimitive;
    out[key] = sensitive ? REDACTED : walk(item, depth - 1, seen);
  }
  return out;
}

/** Copies an error's name/message/code with URLs redacted and without its cause chain. */
export function sanitizeError(error: unknown): Error {
  if (error instanceof Error) {
    const clean = new Error(redactText(error.message));
    clean.name = error.name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') (clean as Error & { code?: string }).code = code;
    clean.stack = `${clean.name}: ${clean.message}`;
    return clean;
  }
  return new Error(redactText(String(error)));
}
