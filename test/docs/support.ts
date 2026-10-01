// The pages of the documentation site, for the tests that check them.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '../..');
export const DOCS = join(ROOT, 'docs');

/**
 * Every Markdown file of docs/, docs/README.md included: not the site's own folder
 * (.vitepress) or the generated API reference (api).
 */
export function pages(dir = DOCS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/^[._]/.test(entry.name) || entry.name === 'api') return [];
      return pages(path);
    }
    return entry.name.endsWith('.md') ? [path] : [];
  });
}
