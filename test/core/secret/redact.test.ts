import { inspect } from 'node:util';
import {
  redactDeep,
  redactHeaders,
  redactText,
  redactUrl,
  sanitizeError,
} from '../../../src/core/secret/redact';
import { secret } from '../../../src/core/secret/secret';

describe('redaction', () => {
  it('redacts key-like path segments, query values and userinfo', () => {
    expect(
      redactUrl('https://eth.example.com/v2/AbCdEf0123456789XyZ?apikey=abc&x=1'),
    ).toBe('https://eth.example.com/v2/[REDACTED]?apikey=[REDACTED]&x=[REDACTED]');
    expect(redactUrl('https://user:pass@node.example.com/rpc')).toBe(
      'https://[REDACTED]@node.example.com/rpc',
    );
    expect(redactUrl('not a url')).toBe('[REDACTED]');
  });

  it('keeps only the origin of secret URLs', () => {
    expect(redactUrl(secret('https://go.getblock.io/0123abcd/'))).toBe(
      'https://go.getblock.io/[REDACTED]',
    );
  });

  it('redacts URLs inside free text', () => {
    expect(redactText('connect failed https://x.io/SECRETKEY1234567890abc now')).toBe(
      'connect failed https://x.io/[REDACTED] now',
    );
  });

  it('redacts sensitive headers and secret values', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer t',
        'X-Api-Key': 'k',
        Accept: 'json',
        X: secret('s'),
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      Accept: 'json',
      X: '[REDACTED]',
    });
  });

  it('redacts deeply with cycle protection', () => {
    const value: Record<string, unknown> = {
      apiKey: 'k',
      nested: { privateKey: 'p', ok: 'fine', n: 5n, bytes: new Uint8Array(3) },
      url: 'https://h.io/AbCdEf0123456789XyZ',
      s: secret('x'),
    };
    value.self = value;
    expect(redactDeep(value)).toEqual({
      apiKey: '[REDACTED]',
      nested: { privateKey: '[REDACTED]', ok: 'fine', n: '5', bytes: '[bytes:3]' },
      url: 'https://h.io/[REDACTED]',
      s: '[REDACTED]',
      self: '[Circular]',
    });
  });

  it('sanitizes errors without keeping the original cause chain', () => {
    const original = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED https://x.io/SECRETKEY1234567890abc'),
    });
    const clean = sanitizeError(original.cause);
    expect(clean.message).toBe('connect ECONNREFUSED https://x.io/[REDACTED]');
    expect(inspect(clean)).not.toContain('SECRETKEY');
  });

  it('redacts URLs with trailing punctuation', () => {
    expect(redactText('connect failed to https://x.io/SECRETKEY1234567890abc.')).toBe(
      'connect failed to https://x.io/[REDACTED].',
    );
    expect(redactText('see https://x.io/SECRETKEY1234567890abc, details')).toBe(
      'see https://x.io/[REDACTED], details',
    );
    expect(redactText('go to https://x.io/SECRETKEY1234567890abc;')).toBe(
      'go to https://x.io/[REDACTED];',
    );
    expect(redactText('found https://x.io/SECRETKEY1234567890abc! problem')).toBe(
      'found https://x.io/[REDACTED]! problem',
    );
    expect(redactText('ask https://x.io/SECRETKEY1234567890abc?')).toBe(
      'ask https://x.io/[REDACTED]?',
    );
  });

  it('redacts nested objects under sensitive keys', () => {
    expect(
      redactDeep({
        privateKey: { d: 'ff00aabbccddeeff' },
        keys: ['a', 'b'],
        ok: { nested: 'fine' },
        apiSecret: { token: 'xyz' },
      }),
    ).toEqual({
      privateKey: '[REDACTED]',
      keys: '[REDACTED]',
      ok: { nested: 'fine' },
      apiSecret: '[REDACTED]',
    });
  });

  it('sanitizes error messages ending with punctuation', () => {
    const err = new Error('connect ECONNREFUSED https://x.io/SECRETKEY1234567890abc.');
    const clean = sanitizeError(err);
    expect(clean.message).toBe('connect ECONNREFUSED https://x.io/[REDACTED].');
    expect(inspect(clean)).not.toContain('SECRETKEY');
  });

  it('passes null and undefined through sensitive keys unchanged', () => {
    expect(
      redactDeep({
        privateKey: null,
        apiSecret: undefined,
        ok: 'fine',
      }),
    ).toEqual({
      privateKey: null,
      apiSecret: undefined,
      ok: 'fine',
    });
  });

  it('redacts URLs followed by brackets', () => {
    expect(redactText('see https://x.io/SECRETKEY1234567890abc] end')).toBe(
      'see https://x.io/[REDACTED]] end',
    );
    expect(redactText('{"u":https://x.io/SECRETKEY1234567890abc}')).toBe(
      '{"u":https://x.io/[REDACTED]}',
    );
  });

  it('redacts URLs in parentheses with trailing punctuation', () => {
    expect(redactText('(see https://x.io/SECRETKEY1234567890abc).')).toBe(
      '(see https://x.io/[REDACTED]).',
    );
  });
});
