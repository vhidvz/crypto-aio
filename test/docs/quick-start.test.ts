// Runs the program of docs/start/quick-start.md ("Your first program") exactly as the page
// shows it, with `crypto-aio/testing` taken from source, and checks that it prints what the
// page's comments promise.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import * as testing from '../../src/testing';

const page = readFileSync(join(__dirname, '../../docs/start/quick-start.md'), 'utf8');

/** The `ts` block that follows "Save this as `first.ts`:". */
function program(): string {
  const after = page.slice(page.indexOf('Save this as `first.ts`:'));
  const block = /```ts\n([\s\S]*?)^```$/m.exec(after)?.[1];
  if (block === undefined) throw new Error('the quick start has no first.ts block');
  return block;
}

describe('docs/start/quick-start.md', () => {
  it('runs its first program and prints what the comments say', async () => {
    const source = program();
    // The program ends with `main().catch(...)`; keep that promise so the test can await it.
    expect(source).toContain('\nmain().catch(');
    const { outputText } = ts.transpileModule(
      source.replace('\nmain().catch(', '\nmodule.exports = main().catch('),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    );
    const lines: string[] = [];
    const errors: unknown[] = [];
    const fakeConsole = {
      log: (...parts: unknown[]) => lines.push(parts.map(String).join(' ')),
      error: (...parts: unknown[]) => errors.push(parts),
    };
    const fakeProcess = { exitCode: undefined as number | undefined };
    const load = (name: string): unknown => {
      if (name === 'crypto-aio/testing') return testing;
      throw new Error(`the quick start imports ${name}`);
    };
    const module = { exports: {} as unknown };
    new Function('require', 'module', 'exports', 'console', 'process', outputText)(
      load,
      module,
      module.exports,
      fakeConsole,
      fakeProcess,
    );
    await module.exports;

    expect(errors).toEqual([]);
    expect(fakeProcess.exitCode).toBeUndefined();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^fk1\S+ 0\.01 FAKE$/); // fk1… 0.01 FAKE
    expect(lines[1]).toMatch(/^submitted \S+$/); // submitted <transaction hash>
    expect(lines[2]).toBe('final proven');
    expect(lines[3]).toBe('final executed 1');
  });
});
