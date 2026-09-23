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
