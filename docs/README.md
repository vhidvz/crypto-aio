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
| `api/` | API | The API reference, generated from the source's doc comments by `pnpm doc`; do not edit by hand |
| `guides/` | | Redirects from the pre-site guide URLs; do not add pages here |
| `.vitepress/` | | The site itself: its configuration, navigation and theme |
| `public/` | | Files served as they are, at the site's root: the logo, the icon and the favicon |

The files of the site:

| File | What it holds |
| --- | --- |
| `.vitepress/navigation.ts` | The sidebar: each section's pages, in reading order, and the learning path through three of them |
| `.vitepress/config.mts` | Everything else the site needs: the top bar, search, the API reference's sidebar, the learning path's step headers and pagers, redirects, the sitemap |
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

## The brand

The logo and the icon are in `public/`; the site serves them at its root, and the repository's
README shows the logo from `main`.

| File | What it is, and where it is used |
| --- | --- |
| `crypto-aio-logo.svg`, `crypto-aio-logo-dark.svg` | The mark and the wordmark, for light and dark backgrounds: the README's header |
| `crypto-aio-icon.svg`, `crypto-aio-icon-dark.svg` | The mark alone: the site's top bar and the home page |
| `favicon.svg` | The mark, in the reader's light or dark theme: the browser tab |

The wordmark is Inter Display Bold, outlined into paths, so it looks the same where Inter is not
installed: GitHub and npm show the logo as an image, without the site's fonts. The colors are ink
`#111827` (`#F3F4F6` on dark backgrounds), indigo `#5B5FEF` and teal `#16B8C4`. The site's link
and button colors, in `.vitepress/theme/style.css`, are shades of the indigo that keep text
readable in both themes.

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
pnpm doc            # only the API reference, into docs/api/
```

`docs:dev` and `docs:build` regenerate the API reference first, so the site always matches the
source. `docs/api/` is committed, so it can be read on GitHub too: commit it again with a change
to the public API or its doc comments. TypeDoc's settings are in `typedoc.json`; its
`typedoc-plugin-markdown` writes Markdown pages, with an HTML anchor on every member, and a
`navigation.json` that becomes the API reference's sidebar.

The `Documentation` workflow (`.github/workflows/docs.yml`) runs these tests and builds the site
for every pull request that changes it, and publishes it to GitHub Pages from `main`. Pages must
deploy from **GitHub Actions** (Settings → Pages → Build and deployment → Source): set to deploy
from a branch, GitHub builds this directory with Jekyll on every push to `main` and serves that
instead, without the site's styles and with broken links. The workflow fails its deploy job until
the source is right.
