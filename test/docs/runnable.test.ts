// Runs every code block of the README and the documentation site marked `<!-- runnable -->`,
// with the package's entry points taken from source, and checks what it prints: each
// `console.log(…); // expected` line must print the text of its comment, where `…` matches
// anything, and each `console.log` must run once. A `console.log` in a loop has no comment;
// its lines follow a `// Prints:` line instead, one `// line` per printed line. Every block
// must also type-check under strict settings, as a reader's own project would check it, and
// so must the blocks marked `<!-- typecheck -->`, which other tests run.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { format } from 'node:util';
import ts from 'typescript';
import * as library from '../../src';
import * as nativeEntry from '../../src/native';
import * as testing from '../../src/testing';
import { ROOT, pages } from './support';

/** Loads the other packages a block imports, such as `node:crypto` or `@scure/bip32`. */
const packages = createRequire(__filename);

const ENTRY_POINTS: Record<string, unknown> = {
  'crypto-aio': library,
  'crypto-aio/native': nativeEntry,
  'crypto-aio/testing': testing,
};

interface Block {
  readonly name: string;
  readonly code: string;
}

/** The `ts` blocks after a `<!-- runnable -->` (or `<!-- typecheck -->`) comment. */
function blocks(marker: 'runnable' | 'typecheck'): Block[] {
  const out: Block[] = [];
  for (const file of [join(ROOT, 'README.md'), ...pages()]) {
    const text = readFileSync(file, 'utf8');
    const marked = new RegExp(
      `<!-- ${marker} -->\\s*\\n\`\`\`ts\\n([\\s\\S]*?)^\`\`\`$`,
      'gm',
    );
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
  const fakeConsole = {
    ...console,
    log: (...parts: unknown[]) => printed.push(format(...parts)),
  };
  const load = (name: string): unknown => ENTRY_POINTS[name] ?? packages(name);
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

/** Type errors of every block, compiled together as strict ES modules against the source. */
function typeErrors(found: readonly Block[]): string[] {
  const files = new Map(
    found.map((block, i) => [join(ROOT, `__docs__/block-${i}.ts`), block]),
  );
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    baseUrl: ROOT,
    paths: {
      'crypto-aio': ['src/index.ts'],
      'crypto-aio/native': ['src/native.ts'],
      'crypto-aio/testing': ['src/testing/index.ts'],
      'crypto-aio/*': ['src/adapters/*/index.ts'],
    },
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (name) => files.has(name) || fileExists.call(host, name);
  host.readFile = (name) => files.get(name)?.code ?? readFile.call(host, name);
  host.getSourceFile = (name, language, onError, create) => {
    const block = files.get(name);
    return block === undefined
      ? getSourceFile.call(host, name, language, onError, create)
      : ts.createSourceFile(name, block.code, language);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  return [...files].flatMap(([name, block]) =>
    ts.getPreEmitDiagnostics(program, program.getSourceFile(name)).map((diagnostic) => {
      const { line } = diagnostic.file?.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      ) ?? {
        line: 0,
      };
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      return `${block.name} (block line ${line + 1}): ${message}`;
    }),
  );
}

describe('runnable documentation blocks', () => {
  const found = blocks('runnable');

  it('type-check under strict settings, with the blocks marked typecheck', () => {
    expect(typeErrors([...found, ...blocks('typecheck')])).toEqual([]);
  }, 60_000);

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
      if (!matches(got, want))
        expect({ line: i + 1, printed: got }).toEqual({ line: i + 1, printed: want });
    });
  });
});
