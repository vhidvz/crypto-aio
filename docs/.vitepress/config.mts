// The crypto-aio documentation site, built with VitePress from docs/ (docs/README.md says how
// to preview it). Every page is plain Markdown that also reads well on github.com: links
// between pages are relative `.md` links, diagrams are ```mermaid fences, callouts are GitHub
// alerts (`> [!NOTE]`), and heading ids are GitHub's, so the same `#anchor` works on both.
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme, type HeadConfig } from 'vitepress';
import { LEARNING_PATH, SIDEBAR, journeySteps, type Section } from './navigation';
import { slugify } from './slugify';

const DOCS = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = 'https://github.com/vhidvz/crypto-aio';
const SITE = 'https://vhidvz.github.io/crypto-aio/';
const BASE = new URL(SITE).pathname;
const PACKAGE = JSON.parse(readFileSync(join(DOCS, '../package.json'), 'utf8')) as {
  version: string;
};
const DESCRIPTION =
  'One TypeScript API for balances, transfers, confirmations and deposit scanning across ' +
  'EVM chains, Bitcoin, Tron, Solana, TON and Avalanche, built for exchanges, wallets and ' +
  'payment systems.';

/** Folders and files of docs/ that are not pages of the site. */
const NOT_PAGES = ['README.md', 'superpowers/**', 'api/**'];

/** A page's top-level front matter: its `key: value` lines, with quotes removed. */
function frontMatter(path: string): Record<string, string> {
  const text = readFileSync(join(DOCS, path), 'utf8');
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const fields: Record<string, string> = {};
  for (const [, key = '', value = ''] of block.matchAll(/^([A-Za-z_]+):(?: (.*))?$/gm)) {
    fields[key] = value.replace(/^(["'])(.*)\1$/, '$2');
  }
  return fields;
}

/** A page's title, from its front matter. */
function title(path: string): string {
  const text = frontMatter(path).title;
  if (!text) throw new Error(`docs/${path} has no title in its front matter`);
  return text;
}

/** The site path of a page: `x/index.md` is `x/`, `x.md` is `x.html`, as before the move. */
function pageUrl(path: string): string {
  return path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '.html');
}

/** A link to a page, for the sidebar, the nav and the pagers. */
function link(path: string): string {
  return `/${path.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '')}`;
}

/** A section of the sidebar: folded until the reader is on one of its pages. */
function sidebar(section: Section): DefaultTheme.SidebarItem {
  return {
    text: title(section.index),
    link: link(section.index),
    collapsed: true,
    items: section.pages.map((page) =>
      typeof page === 'string' ? { text: title(page), link: link(page) } : sidebar(page),
    ),
  };
}

/** Every page of the site, as a path under docs/. */
function pages(dir = ''): string[] {
  return readdirSync(join(DOCS, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      return /^[._]/.test(entry.name) || ['superpowers', 'api'].includes(entry.name)
        ? []
        : pages(path);
    }
    return entry.name.endsWith('.md') && path !== 'README.md' ? [path] : [];
  });
}

/** The site paths of the moved pages (guides/), which only redirect. */
const MOVED = new Set(
  pages()
    .filter((path) => frontMatter(path).redirect)
    .map(pageUrl),
);

const STEPS = journeySteps(LEARNING_PATH);

/** About how long a page takes to read, at 200 words a minute. */
function minutes(path: string): number {
  const text = readFileSync(join(DOCS, path), 'utf8').replace(
    /^---\n[\s\S]*?\n---\n/,
    '',
  );
  return Math.max(1, Math.floor(text.split(/\s+/).filter(Boolean).length / 200));
}

export default defineConfig({
  title: 'crypto-aio',
  description: DESCRIPTION,
  lang: 'en-US',
  base: BASE,
  // Pages keep the URLs they had: `start/quick-start.html`, `reference/networks/`.
  cleanUrls: false,
  srcExclude: NOT_PAGES,

  head: [
    ['meta', { name: 'theme-color', content: '#6f42c1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'crypto-aio' }],
  ],

  sitemap: {
    hostname: SITE,
    transformItems: (items) => items.filter((item) => !MOVED.has(item.url)),
  },

  // Mermaid's own chunks pass 500 kB; only a page with a diagram loads them, after it renders.
  vite: { build: { chunkSizeWarningLimit: 1000 } },

  markdown: {
    // GitHub's heading ids, so an `#anchor` works on the site and on github.com alike.
    anchor: { slugify },
    // As on GitHub, `{.class}` after a heading or a paragraph is text, not attributes.
    attrs: { disable: true },
    config(md) {
      // ```mermaid fences, which GitHub draws natively, become diagrams (theme/Mermaid.vue).
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]!;
        return token.info.trim() === 'mermaid'
          ? `<Mermaid code="${encodeURIComponent(token.content)}" />\n`
          : fence(tokens, idx, options, env, self);
      };
    },
  },

  transformPageData(pageData) {
    const path = pageData.relativePath;
    const front = pageData.frontmatter;
    const head: HeadConfig[] = (front.head ??= []);
    let canonical = new URL(pageUrl(path), SITE).href;

    // A moved page names its new page, relative to itself, and sends the reader there.
    if (typeof front.redirect === 'string') {
      const target = posix.join(posix.dirname(path), front.redirect);
      front.redirectLink = `/${pageUrl(target)}`;
      canonical = new URL(pageUrl(target), SITE).href;
      head.push(
        [
          'meta',
          { 'http-equiv': 'refresh', content: `0; url=${BASE}${pageUrl(target)}` },
        ],
        ['meta', { name: 'robots', content: 'noindex' }],
      );
    }

    head.push(
      ['link', { rel: 'canonical', href: canonical }],
      ['meta', { property: 'og:url', content: canonical }],
      ['meta', { property: 'og:title', content: pageData.title }],
      [
        'meta',
        { property: 'og:description', content: pageData.description || DESCRIPTION },
      ],
    );

    // A step of the learning path: its part, its place in the part, and the steps either side.
    const index = STEPS.findIndex((step) => step.path === path);
    if (index >= 0) {
      const part = STEPS.filter((step) => step.part === STEPS[index]!.part);
      front.lesson = {
        part: STEPS[index]!.part,
        unit: LEARNING_PATH.unit,
        step: part.findIndex((step) => step.path === path) + 1,
        steps: part.length,
        minutes: minutes(path),
      };
      const previous = STEPS[index - 1]?.path;
      const next = STEPS[index + 1]?.path ?? LEARNING_PATH.finish;
      front.prev = previous ? { text: title(previous), link: link(previous) } : false;
      front.next = { text: title(next), link: link(next) };
    }
  },

  themeConfig: {
    nav: [
      { text: 'Get started', link: '/start/', activeMatch: '^/start/' },
      { text: 'Learn', link: '/learn/', activeMatch: '^/(learn|tour)/' },
      { text: 'Build', link: '/build/', activeMatch: '^/build/' },
      { text: 'Reference', link: '/reference/', activeMatch: '^/reference/' },
      { text: 'Explore', link: '/explore/', activeMatch: '^/explore/' },
      {
        text: `v${PACKAGE.version}`,
        items: [
          { text: 'Changelog', link: `${REPOSITORY}/blob/main/CHANGELOG.md` },
          { text: 'Stability before 1.0', link: '/reference/stability' },
        ],
      },
    ],
    sidebar: SIDEBAR.map(sidebar),
    outline: { level: [2, 3], label: 'On this page' },
    search: { provider: 'local' },
    externalLinkIcon: true,
    editLink: {
      pattern: `${REPOSITORY}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },
    socialLinks: [
      { icon: 'github', link: REPOSITORY },
      { icon: 'npm', link: 'https://www.npmjs.com/package/crypto-aio' },
    ],
    footer: {
      message: `MIT licensed. These pages describe crypto-aio ${PACKAGE.version} and the unreleased changes on <code>main</code>.`,
    },
  },
});
