---
title: Explore
nav_order: 7
has_children: true
has_toc: false
description: Internals and extension points: the source map, adding networks and chain families, writing durable stores, and the design records.
---

# Explore

For readers who want to go below the API: to read the source, extend the library with new
networks or chain families, or implement the stores a production deployment needs. The
[Developer tour](../tour/index.md) is the best preparation for these pages.

| Page | For when you want to… |
| --- | --- |
| [Source map](./source-map.md) | Find your way around the repository, and know which file to read first |
| [Add networks to a family](./custom-networks.md) | Serve your own EVM chain with the built-in driver |
| [Write a chain family plugin](./plugins.md) | Add a blockchain family of your own: the plugin data and the driver contract |
| [Write a durable store](./stores.md) | Implement the four store ports on your database, and prove them with the contract suites |
| [Design records](./design-records.md) | Read the specification and plans behind the design |

## Contributing

Issues and pull requests are welcome at
[github.com/vhidvz/crypto-aio](https://github.com/vhidvz/crypto-aio). Before you send a change, run
`pnpm check` (lint, typecheck and tests); the [Source map](./source-map.md#the-tests) lists the
other commands. These pages live in `docs/`: every page is Markdown, and `docs/README.md` explains
how to preview the site locally.
