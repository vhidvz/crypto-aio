# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** crypto-aio needs Node.js 22.12 or later (`engines.node` is `>=22.12`), the
  version every family already needed for Solana. `engines` no longer names an npm version,
  so npm 11 installs without an engine warning.
- `package.json` declares `"type": "commonjs"`.

### Added

- `SECURITY.md`: how to report a vulnerability privately, and what is in scope.
- Release tooling: a tag such as `1.0.0-rc.1` publishes under npm's `next` dist-tag, a
  release tag must match `package.json` and have a `CHANGELOG.md` section, which becomes the
  GitHub Release's notes, and a release runs every CI check before it publishes.
- CI runs on Node.js 22.12.0, 22, 24 and 26, audits the runtime dependencies, and checks the
  package's exports and types with `publint` and `@arethetypeswrong/cli`
  (`pnpm lint:package`). CodeQL and Dependabot are configured.

## [0.1.0] - 2026-10-01

### Added

- initial release 🎉​🎊​.

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/0.1.0...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/releases/tag/0.1.0
