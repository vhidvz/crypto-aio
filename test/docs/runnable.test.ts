// Runs every code block of the documentation site marked `<!-- runnable -->`, with the
// package's entry points taken from source, and checks what it prints: each
// `console.log(…); // expected` line must print the text of its comment, where `…` matches
// anything, and each `console.log` must run once. A `console.log` in a loop has no comment;
// its lines follow a `// Prints:` line instead, one `// line` per printed line.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { format } from 'node:util';
import ts from 'typescript';
import * as library from '../../src';
import * as nativeEntry from '../../src/native';
import * as testing from '../../src/testing';

const ROOT = join(__dirname, '../..');

const ENTRY_POINTS: Record<string, unknown> = {
  'crypto-aio': library,
  'crypto-aio/native': nativeEntry,
  'crypto-aio/testing': testing,
};

/** Every Markdown page of docs/, without the theme's own folders and the design records. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_') || ['superpowers', 'api'].includes(entry.name)) return [];
      return pages(path);
    }
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

interface Block {
  readonly name: string;
  readonly code: string;
}

function blocks(): Block[] {
  const out: Block[] = [];
  for (const file of pages(join(ROOT, 'docs'))) {
    const text = readFileSync(file, 'utf8');
    const marked = /<!-- runnable -->\s*\n```ts\n([\s\S]*?)^```$/gm;
    for (const match of text.matchAll(marked)) {
      const line = text.slice(0, match.index).split('\n').length;
      out.push({ name: `${relative(ROOT, file)}:${line}`, code: match[1] as string });
    }
  }
  return out;
}

/**
 * The expected printed lines, in order: the comment of each `console.log(…); // expected`
 * line, and the comment lines after each `// Prints:` line (for a `console.log` in a loop,
 * which then has no comment of its own). In a block without `// Prints:`, a `console.log`
 * without a comment may print anything.
 */
function expectations(code: string): (string | undefined)[] {
  const lines = code.split('\n');
  const listed = lines.some((line) => line.trim() === '// Prints:');
  const out: (string | undefined)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '// Prints:') {
      while (i + 1 < lines.length && /^\s*\/\//.test(lines[i + 1] as string)) {
        out.push((lines[++i] as string).replace(/^\s*\/\/ ?/, '').trim());
      }
    } else if (/\bconsole\.log\(/.test(line)) {
      const comment = /\/\/ (.*)$/.exec(line)?.[1]?.trim();
      if (comment !== undefined || !listed) out.push(comment);
    }
  }
  return out;
}

function matches(printed: string, expected: string): boolean {
  const pattern = expected
    .split('…')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`, 's').test(printed);
}

async function run(code: string): Promise<string[]> {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const printed: string[] = [];
  const fakeConsole = { ...console, log: (...parts: unknown[]) => printed.push(format(...parts)) };
  const load = (name: string): unknown => ENTRY_POINTS[name] ?? require(name);
  const module = { exports: {} };
  const body = `return (async () => {\n${outputText}\n})();`;
  await new Function('require', 'module', 'exports', 'console', body)(
    load,
    module,
    module.exports,
    fakeConsole,
  );
  return printed;
}

describe('runnable documentation blocks', () => {
  const found = blocks();

  it('finds the runnable blocks', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found.map((block) => [block.name, block]))('%s', async (_name, block) => {
    const printed = await run(block.code);
    const expected = expectations(block.code);
    expect(printed).toHaveLength(expected.length);
    expected.forEach((want, i) => {
      if (want === undefined) return;
      const got = printed[i] as string;
      if (!matches(got, want)) expect({ line: i + 1, printed: got }).toEqual({ line: i + 1, printed: want });
    });
  });
});
