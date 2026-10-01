// Every page of the documentation site has front matter the site can read: a `---` block of
// `key: value` lines with a title, where a plain value never holds `: ` or ` #` (which YAML
// would misread). And the site's navigation (docs/.vitepress/navigation.ts) lists every page
// once, and only pages that exist, so a new page cannot be left out of the sidebar.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  LEARNING_PATH,
  SIDEBAR,
  journeySteps,
  sectionPages,
} from '../../docs/.vitepress/navigation';
import { DOCS, pages } from './support';

/** The front matter's top-level `key: value` pairs, or the problems found reading it. */
function frontMatter(text: string): { fields: Map<string, string>; problems: string[] } {
  const fields = new Map<string, string>();
  const problems: string[] = [];
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) return { fields, problems: ['no front matter'] };
  for (const line of (match[1] as string).split('\n')) {
    const field = /^([A-Za-z_]+):(?: (.*))?$/.exec(line);
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
  const all = pages().filter((file) => file !== join(DOCS, 'README.md'));
  const fields = new Map(
    all.map((file) => [
      relative(DOCS, file),
      frontMatter(readFileSync(file, 'utf8')).fields,
    ]),
  );
  const moved = [...fields].filter(([, page]) => page.has('redirect'));

  it.each(all.map((file) => [relative(DOCS, file), file]))(
    '%s can be read',
    (_name, file) => {
      expect(frontMatter(readFileSync(file, 'utf8')).problems).toEqual([]);
    },
  );

  it('lists every page in the sidebar once, but the home page and the moved pages', () => {
    const listed = SIDEBAR.flatMap(sectionPages);
    expect(new Set(listed).size).toBe(listed.length);
    const expected = [...fields.keys()].filter(
      (page) => page !== 'index.md' && !fields.get(page)?.has('redirect'),
    );
    expect([...listed].sort()).toEqual(expected.sort());
  });

  it('walks the learning path through sidebar pages, to a page that exists', () => {
    const steps = journeySteps(LEARNING_PATH).map((step) => step.path);
    const listed = new Set(SIDEBAR.flatMap(sectionPages));
    expect(steps.filter((step) => !listed.has(step))).toEqual([]);
    expect(listed.has(LEARNING_PATH.finish)).toBe(true);
  });

  it.each(moved)(
    '%s redirects to a page that exists, and is left out of search',
    (page, front) => {
      const target = join(DOCS, dirname(page), front.get('redirect') ?? '');
      expect(target.endsWith('.md') && existsSync(target)).toBe(true);
      expect(front.get('search')).toBe('false');
    },
  );
});
