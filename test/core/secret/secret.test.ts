import { inspect } from 'node:util';
import {
  REDACTED,
  Secret,
  isSecret,
  reveal,
  secret,
} from '../../../src/core/secret/secret';

describe('Secret', () => {
  const s = secret('sk_live_123');

  it('never renders its value', () => {
    expect(String(s)).toBe(REDACTED);
    expect(`${s}`).toBe(REDACTED);
    expect(JSON.stringify({ key: s })).toBe('{"key":"[REDACTED]"}');
    expect(inspect({ key: s })).not.toContain('sk_live_123');
    expect(Object.keys(s)).toEqual([]);
    expect(JSON.stringify(structuredClone(s))).not.toContain('sk_live_123');
  });

  it('reveals only on request', () => {
    expect(s.reveal()).toBe('sk_live_123');
    expect(reveal(s)).toBe('sk_live_123');
    expect(reveal('plain')).toBe('plain');
  });

  it('is idempotent and detectable', () => {
    expect(secret(s)).toBe(s);
    expect(isSecret(s)).toBe(true);
    expect(isSecret('x')).toBe(false);
    expect(s).toBeInstanceOf(Secret);
  });
});
