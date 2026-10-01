# The crypto-aio documentation

This directory is the documentation site, published by GitHub Pages at
**<https://vhidvz.github.io/crypto-aio/>**. Start reading at [index.md](./index.md), or on the site.
This file is for people who edit the pages; it is not published.

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

The learning path's reading order, and so each lesson's "step N of M" header and its previous and
next links, comes from `_data/journeys.yml`. A page joins it with `layout: lesson` and
`journey: learn` in its front matter.

## Writing a page

- **Plain Markdown that reads well on GitHub too.** Link to other pages with relative `.md` links
  (`[Errors](../reference/errors.md#what-to-do-about-each-error)`); the site turns them into site
  URLs.
- **Front matter** sets the navigation: `title`, `parent` (and `grand_parent` for a third level),
  `nav_order`, and a one-sentence `description`.
- **Callouts** are GitHub alerts: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`,
  `> [!CAUTION]`. GitHub renders them natively, and the site styles them.
- **Diagrams** are ` ```mermaid ` fences, rendered by GitHub and by the site. Keep them small enough
  to read on a phone.
- **Folded detail** uses `<details markdown="1"><summary>…</summary> … </details>`.
- **Runnable examples.** A ` ```ts ` block right after a `<!-- runnable -->` comment is executed by
  `test/docs/runnable.test.ts`, with `crypto-aio` and `crypto-aio/testing` taken from source. Each
  `console.log(…); // text` must print exactly that text (`…` matches anything); a `console.log` in
  a loop lists its lines after a `// Prints:` comment instead. Use the fake chain
  (`createFakeEnv`), so the block needs no network.

## Tests that keep the pages honest

`pnpm test test/docs` runs them all:

| Test | Checks |
| --- | --- |
| `links.test.ts` | Every relative link in the README, the changelog and these pages resolves, anchors included |
| `runnable.test.ts` | Every runnable block runs and prints what its comments say |
| `quick-start.test.ts` | The quick start's program runs and prints what the page promises |
| `tutorial.test.ts`, `tutorial-sync.test.ts` | The tutorial's steps run, and match the page character for character |
| `api-reference.test.ts` | `reference/api.md` names every export and every handle and container member |
| `capabilities.test.ts` | The capability matrix matches the library, on every network |

## Previewing the site

The site is built by GitHub Pages from this directory, with the
[Just the Docs](https://just-the-docs.com/) theme. To preview it locally, with Ruby 3 and Bundler:

```sh
cd docs
bundle install
bundle exec jekyll serve
```

Then open <http://localhost:4000/crypto-aio/>. The type-level API reference is separate:
`pnpm doc` generates it into `docs/api/`, which is not committed.
