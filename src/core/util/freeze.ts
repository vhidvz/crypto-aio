/**
 * Freezes plain data all the way down: every array and every plain object reachable
 * from `value`, so data that handles share (chain tables, presets, resolved config) cannot
 * be changed through any of them. Class instances (a `Signer`, a `Secret`, a `Uint8Array`)
 * and functions keep their identity and are never frozen. A reference cycle is
 * walked once, so it freezes instead of overflowing the stack.
 */
export function deepFreeze<T>(value: T): T {
  freezeOnce(value, new WeakSet<object>());
  return value;
}

function freezeOnce(value: unknown, seen: WeakSet<object>): void {
  if (!isPlainData(value) || seen.has(value)) return;
  seen.add(value);
  for (const item of Object.values(value)) freezeOnce(item, seen);
  Object.freeze(value);
}

function isPlainData(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
