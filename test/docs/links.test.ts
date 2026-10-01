// Plan 7: every relative link in the README, the changelog and the documentation site
// resolves to a tracked file, and every `#anchor` to a heading of its target (GitHub's heading
// ids, which the site gives its headings too: docs/.vitepress/slugify.ts). Links to the
// published site (https://vhidvz.github.io/crypto-aio/…) must name a page of docs/ the same way.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { slugify } from '../../docs/.vitepress/slugify';
import { DOCS, ROOT, pages } from './support';

const SITE = 'https://vhidvz.github.io/crypto-aio/';

const FILES = [join(ROOT, 'README.md'), join(ROOT, 'CHANGELOG.md'), ...pages()];

/** The lines of a Markdown file outside fenced code blocks. */
function prose(text: string): string[] {
  let fenced = false;
  return text.split('\n').filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** GitHub's heading ids, with -1, -2 … for repeats. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slugify(heading);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

/** The docs/ page a published site URL names: `x/` is `x/index.md`, `x.html` is `x.md`. */
function sitePage(url: string): string {
  const [path = '', anchor] = url.slice(SITE.length).split('#');
  const page =
    path === '' || path.endsWith('/')
      ? `${path}index.md`
      : path.replace(/\.html$/, '.md');
  return relative(ROOT, join(DOCS, page)) + (anchor === undefined ? '' : `#${anchor}`);
}

/**
 * Link targets outside code: `[text](target)`, never `http(s):` or `mailto:`, except links to
 * the published site, returned as the docs/ page they name, relative to the repository root.
 */
function links(file: string): { target: string; base: string }[] {
  const out: { target: string; base: string }[] = [];
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const text = line.replace(/`[^`]*`/g, '');
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] as string;
      if (target.startsWith(SITE)) out.push({ target: sitePage(target), base: ROOT });
      else if (!/^(https?:|mailto:)/.test(target))
        out.push({ target, base: dirname(file) });
    }
  }
  return out;
}

describe('documentation links', () => {
  it.each(FILES.map((file) => [relative(ROOT, file), file]))(
    'every relative link in %s resolves',
    (_name, file) => {
      const broken: string[] = [];
      for (const { target, base } of links(file)) {
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const resolved = path === '' ? file : join(base, path);
        if (!existsSync(resolved)) broken.push(`${target} (no such file)`);
        else if (anchor !== undefined && resolved.endsWith('.md')) {
          if (!anchors(resolved).has(anchor)) broken.push(`${target} (no such heading)`);
        }
      }
      expect(broken).toEqual([]);
    },
  );
});
