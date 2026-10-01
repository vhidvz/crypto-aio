// Keeps docs/start/tutorial.md and tutorial.test.ts in step: every `ts` code block of the
// guide must be the matching code of the test, character for character, apart from import
// lines. Import lines must bring in the same names from the matching entry points.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const guide = readFileSync(join(__dirname, '../../docs/start/tutorial.md'), 'utf8');
const source = readFileSync(join(__dirname, 'tutorial.test.ts'), 'utf8');

/** The test's source paths, as the guide names them. */
const ENTRY_POINTS: Record<string, string> = {
  '../../src': 'crypto-aio',
  '../../src/testing': 'crypto-aio/testing',
};

const IMPORT = /^import ([\s\S]*?) from '([^']+)';\n/gm;

/** Imported names per module, with test paths mapped to package names. */
function importsOf(code: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [, names = '', from = ''] of code.matchAll(IMPORT)) {
    const list = names
      .replace(/[{}]/g, '')
      .split(',')
      .map((name) => name.trim().replace(/\s+/g, ' '))
      .filter((name) => name.length > 0);
    out[ENTRY_POINTS[from] ?? from] = list.sort();
  }
  return out;
}

const withoutImports = (code: string): string => code.replace(IMPORT, '').trim();

/** The guide's `ts` blocks, keyed by the `## ` heading they follow. */
function guideBlocks(): { heading: string; code: string }[] {
  const blocks: { heading: string; code: string }[] = [];
  let heading = '';
  for (const part of guide.split(/^(## .*)$/m)) {
    if (part.startsWith('## ')) heading = part.slice(3).trim();
    for (const [, code = ''] of part.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
      blocks.push({ heading, code: code.replace(/\n$/, '') });
    }
  }
  return blocks;
}

/** The test's step bodies, dedented to the guide's indentation. */
function testSteps(): { name: string; body: string }[] {
  const steps = source.matchAll(
    /^ {2}it\('(step \d+: [^']*)', async \(\) => \{\n([\s\S]*?)\n {2}\}\);$/gm,
  );
  return [...steps].map(([, name = '', body = '']) => ({
    name,
    body: body.replace(/^ {4}/gm, ''),
  }));
}

/** The test's code before `describe`, without its imports and its own comments. */
function testPreamble(): string {
  const before = source.slice(0, source.indexOf('\ndescribe('));
  return withoutImports(before.replace(/^\/\/.*\n/gm, ''));
}

describe('docs/start/tutorial.md matches test/docs/tutorial.test.ts', () => {
  const blocks = guideBlocks();
  const steps = testSteps();

  it('has one guide step per test step, under the same title', () => {
    const headings = blocks
      .filter((b) => b.heading.startsWith('Step '))
      .map((b) => b.heading);
    expect(steps).toHaveLength(10);
    expect(headings.map((h) => h.toLowerCase())).toEqual(steps.map((s) => s.name));
  });

  it('opens with the test imports and helpers', () => {
    const [first] = blocks;
    expect(first?.heading).toBe('Before you start');
    expect(importsOf(first?.code ?? '')).toEqual(importsOf(source));
    expect(withoutImports(first?.code ?? '')).toBe(testPreamble());
  });

  it('shows each step body exactly as the test runs it', () => {
    for (const step of steps) {
      const block = blocks.find((b) => b.heading.toLowerCase() === step.name);
      expect({ step: step.name, code: block?.code }).toEqual({
        step: step.name,
        code: step.body,
      });
    }
  });
});
