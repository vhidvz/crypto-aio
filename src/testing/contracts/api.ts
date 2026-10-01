import assert from 'node:assert/strict';

/** Minimal test-framework surface; pass wrappers around your framework's describe/it. */
export interface ContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}

export async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert.equal((error as { code?: unknown }).code, code);
    return;
  }
  assert.fail(`expected a rejection with code ${code}`);
}

/**
 * Everything an error carries as text (its message, its JSON form and its causes')
 * leaves out each of `secrets`. Store keys embed wallet addresses, and error messages
 * reach logs.
 */
export async function rejectsWithCodeKeepingOut(
  promise: Promise<unknown>,
  code: string,
  secrets: readonly string[],
): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    caught = error;
    rejected = true;
  }
  if (!rejected) assert.fail(`expected a rejection with code ${code}`);
  assert.equal((caught as { code?: unknown }).code, code);
  const text = textOf(caught);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `a ${code} error names a store key`);
  }
}

function textOf(error: unknown): string {
  const parts: string[] = [];
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current !== undefined && current !== null;
    depth += 1
  ) {
    if (current instanceof Error) parts.push(current.name, current.message);
    try {
      parts.push(
        JSON.stringify(current, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ) ?? '',
      );
    } catch {
      parts.push(String(current));
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join('\n');
}
