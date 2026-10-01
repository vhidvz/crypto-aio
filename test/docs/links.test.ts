// Plan 7: every relative link in the README, the changelog and the documentation site
// resolves to a tracked file, and every `#anchor` to a heading of its target (GitHub's heading
// ids, which the site's GFM Markdown also uses).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const DOCS = join(ROOT, 'docs');

/** Every Markdown page of docs/, without the theme's own folders and the design records. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_') || ['superpowers', 'api'].includes(entry.name))
        return [];
      return pages(path);
    }
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

const FILES = [join(ROOT, 'README.md'), join(ROOT, 'CHANGELOG.md'), ...pages(DOCS)];

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

/** GitHub's heading ids (github-slugger), with -1, -2 … for repeats. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = heading
      .toLowerCase()
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

/** Relative link targets outside code: `[text](target)`, never `http(s):` or `mailto:`. */
function links(file: string): string[] {
  const out: string[] = [];
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const text = line.replace(/`[^`]*`/g, '');
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] as string;
      if (!/^(https?:|mailto:)/.test(target)) out.push(target);
    }
  }
  return out;
}

describe('documentation links', () => {
  it.each(FILES.map((file) => [relative(ROOT, file), file]))(
    'every relative link in %s resolves',
    (_name, file) => {
      const broken: string[] = [];
      for (const target of links(file)) {
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const resolved = path === '' ? file : join(dirname(file), path);
        if (!existsSync(resolved)) broken.push(`${target} (no such file)`);
        else if (anchor !== undefined && resolved.endsWith('.md')) {
          if (!anchors(resolved).has(anchor)) broken.push(`${target} (no such heading)`);
        }
      }
      expect(broken).toEqual([]);
    },
  );
});
