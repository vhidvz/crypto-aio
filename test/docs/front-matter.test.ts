// Every page of the documentation site has front matter the site can read: a `---` block of
// `key: value` lines with a title, where a plain value never holds `: ` or ` #` (which YAML
// would misread, silently dropping the page from its section). And every page laid out as a
// lesson is in _data/journeys.yml, which names only pages that exist.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const DOCS = join(__dirname, '../../docs');

/** Every Markdown page of docs/, without the theme's own folders, the design records and the README. */
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_') || ['superpowers', 'api'].includes(entry.name))
        return [];
      return pages(path);
    }
    return entry.name.endsWith('.md') && path !== join(DOCS, 'README.md') ? [path] : [];
  });
}

/** The front matter's top-level `key: value` pairs, or the problems found reading it. */
function frontMatter(text: string): { fields: Map<string, string>; problems: string[] } {
  const fields = new Map<string, string>();
  const problems: string[] = [];
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return { fields, problems: ['no front matter'] };
  for (const line of (match[1] as string).split('\n')) {
    const field = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (field === null) {
      if (!/^\s+\S/.test(line)) problems.push(`unreadable line: ${line}`);
      continue;
    }
    const [, key = '', value = ''] = field;
    const quoted = /^(".*"|'.*')$/.test(value);
    if (!quoted && /: | #/.test(value)) problems.push(`${key}: quote this value`);
    fields.set(key, quoted ? value.slice(1, -1) : value);
  }
  if (!fields.get('title')) problems.push('no title');
  return { fields, problems };
}

describe('documentation front matter', () => {
  const all = pages(DOCS);

  it.each(all.map((file) => [relative(DOCS, file), file]))(
    '%s can be read',
    (_name, file) => {
      expect(frontMatter(readFileSync(file, 'utf8')).problems).toEqual([]);
    },
  );

  it('lists every lesson page in _data/journeys.yml, and nothing else', () => {
    const data = readFileSync(join(DOCS, '_data/journeys.yml'), 'utf8');
    const listed = [...data.matchAll(/path: ([^\s}]+)/g)].map(
      ([, path]) => path as string,
    );
    const finish = [...data.matchAll(/finish: (\S+)/g)].map(([, path]) => path as string);
    for (const path of [...listed, ...finish])
      expect(existsSync(join(DOCS, path))).toBe(true);
    const lessons = all
      .filter(
        (file) =>
          frontMatter(readFileSync(file, 'utf8')).fields.get('layout') === 'lesson',
      )
      .map((file) => relative(DOCS, file));
    expect([...lessons].sort()).toEqual([...listed].sort());
  });
});
