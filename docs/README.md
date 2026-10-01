# The crypto-aio documentation

This directory is the documentation site, built with [VitePress](https://vitepress.dev/) and
published to GitHub Pages at **<https://vhidvz.github.io/crypto-aio/>**. Start reading at
[index.md](./index.md), or on the site. This file is for people who edit the pages; it is not
published.

## How the site is organized

| Directory | Section | Kind of page |
| --- | --- | --- |
| `start/` | Get started | The quick start, the 10-minute mental model, the hands-on tutorial |
| `learn/` | Learn | The learning path: blockchain foundations, then engineering for money |
| `tour/` | Developer tour | How crypto-aio works inside; the learning path's third part |
| `build/` | Build | Task guides and the examples cookbook |
| `reference/` | Reference | API, configuration, concepts, errors, capabilities, networks, glossary |
| `explore/` | Explore | Source map, plugins, stores, design records |
| `guides/` | | Redirects from the pre-site guide URLs; do not add pages here |
| `superpowers/` | | Design records of the 0.1.0 release; not published as pages |
| `.vitepress/` | | The site itself: its configuration, navigation and theme |

The files of the site:

| File | What it holds |
| --- | --- |
| `.vitepress/navigation.ts` | The sidebar: each section's pages, in reading order, and the learning path through three of them |
| `.vitepress/config.mts` | Everything else the site needs: the top bar, search, the learning path's step headers and pagers, redirects, the sitemap |
| `.vitepress/slugify.ts` | Heading ids, the same as GitHub's, so an `#anchor` works on both |
| `.vitepress/theme/` | VitePress's default theme, with the diagrams, the step header and the site's styles |

A new page goes into `.vitepress/navigation.ts`, under its section; a test fails until it does.
A page of the learning path gets its "step N of M" header and its previous and next links from
the order there.

## Writing a page

- **Plain Markdown that reads well on GitHub too.** Link to other pages with relative `.md` links
  (`[Errors](../reference/errors.md#what-to-do-about-each-error)`); the site turns them into site
  URLs, and its build fails on a link to a page that does not exist.
- **Front matter** holds the page's `title`, which is also its name in the sidebar, and a
  one-sentence `description` for search engines and link previews. Quote a value that holds
  `: ` or ` #`.
- **Callouts** are GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
  `> [!CAUTION]`. GitHub and the site both render them.
- **Diagrams** are ` ```mermaid ` fences, rendered by GitHub and by the site, in the reader's light
  or dark theme. Keep them small enough to read on a phone.
- **Folded detail** uses `<details>`, then `<summary>…</summary>` and a blank line, then Markdown,
  then a blank line and `</details>`.
- **Moved pages** keep only a note of where each part went, with `redirect: <the new page's .md
  path>` and `search: false` in their front matter: the site sends readers on to the new page.
- **Runnable examples.** A ` ```ts ` block right after a `<!-- runnable -->` comment is executed by
  `test/docs/runnable.test.ts`, with `crypto-aio` and `crypto-aio/testing` taken from source. Each
  `console.log(…); // text` must print exactly that text (`…` matches anything); a `console.log` in
  a loop lists its lines after a `// Prints:` comment instead. Use the fake chain
  (`createFakeEnv`), so the block needs no network.

## Tests that keep the pages honest

`pnpm test test/docs --coverage=false` runs them all:

| Test | Checks |
| --- | --- |
| `links.test.ts` | Every relative link in the README, the changelog and these pages resolves, anchors included |
| `front-matter.test.ts` | Every page has readable front matter, the sidebar lists every page once, and every redirect lands on a page |
| `runnable.test.ts` | Every runnable block runs and prints what its comments say |
| `quick-start.test.ts` | The quick start's program runs and prints what the page promises |
| `tutorial.test.ts`, `tutorial-sync.test.ts` | The tutorial's steps run, and match the page character for character |
| `api-reference.test.ts` | `reference/api.md` names every export and every handle and container member |
| `capabilities.test.ts` | The capability matrix matches the library, on every network |

## Previewing and publishing the site

From the repository root, after `pnpm install`:

```sh
pnpm docs:dev       # a live preview at http://localhost:5173/crypto-aio/
pnpm docs:build     # the site, into docs/.vitepress/dist/
pnpm docs:preview   # serves that build at http://localhost:4173/crypto-aio/
```

The `Documentation` workflow (`.github/workflows/docs.yml`) runs these tests and builds the site
for every pull request that changes it, and publishes it to GitHub Pages from `main`. The
type-level API reference is separate: `pnpm doc` generates it into `docs/api/`, which is not
committed.
