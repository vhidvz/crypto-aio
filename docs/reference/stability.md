---
title: Versioning and stability
description: What semantic versioning covers in crypto-aio, surface by surface, and the support policy for Node.js, TypeScript and the chain SDKs.
---

# Versioning and stability

crypto-aio follows [semantic versioning](https://semver.org/). From 1.0.0, a breaking change
to anything this page lists as covered comes only in a new major version; a minor release
adds, and a patch release fixes. Every release is listed, with what changed, in the
[changelog](https://github.com/vhidvz/crypto-aio/blob/main/CHANGELOG.md), and every change to
the public API is visible in the API reports the repository keeps (`etc/api/`), which CI
compares on every change.

Before 1.0 (the `0.x` releases), a minor release may break, and the changelog says how.

## What is covered

| Surface | Promise |
| --- | --- |
| The container and handle API (`CryptoAio`, `Blockchain`, `configure`), the configuration shape, the model (`Amount`, `Address`, assets, intents, statuses), signers, error classes and codes, event names and payloads, the store ports and their contract suites | Covered by semver |
| The driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverContext`, `BuildContext` | Covered by semver, under the rules for ports below |
| What a process stores: Operation records, observations, the store keys, the intent hash behind idempotency keys | Covered: every 1.x release reads what any earlier 1.x release (and 0.1.0) stored. See [the record format](../explore/stores.md#upgrades-and-the-record-format) |
| Family `ext` APIs and fee override shapes | Covered per family, as each family's network page describes them |
| `crypto-aio/testing` | Covered, except the fake chain's wire protocol, which is not an API |
| `crypto-aio/native` | **Not covered.** It hands you the SDK's own client; the SDK's API is the SDK's |
| Error and log message texts, `details` and `context` beyond what [Errors](./errors.md) documents, the order of events of different Operations | Not covered: match on codes, categories and documented fields |

## What a minor release may do

TypeScript makes some additions breaking for some code, so these are the rules:

- **Unions grow.** `ErrorCode`, `OperationState`, `TxState`, `TxFailure`, capability names,
  event names and other string unions may gain members in a minor release. Handle the
  unknown case in an exhaustive `switch` (a `default` branch), and match on documented
  codes rather than on their absence.
- **Results grow.** An object the library returns or emits may gain optional fields.
- **Inputs grow, optionally.** An options object may gain optional fields with defaults that
  keep today's behavior.
- **Ports you implement never gain a required member.** A store port, `Signer`, or a driver
  port may gain an optional method, or an optional field the core passes to you; never one
  you must implement. The contract suites may gain tests only for behavior the port's
  documentation already requires.
- **Safety fixes.** A fix for a security vulnerability or for a verdict that could pay twice
  may change behavior in a patch or minor release, and is called out as such in the
  changelog.

## Deprecation

A feature is deprecated in a minor release: its documentation and type declarations say so
(`@deprecated`), and using it warns once per process with a Node.js `DeprecationWarning`
whose code starts with `CRYPTO_AIO_`. It is removed no earlier than the next major release.

## Support policy

| Dependency | Supported |
| --- | --- |
| Node.js | 22.12 or later: every Node.js LTS line that has not reached its end of life. CI runs 22.12.0, 22, 24 and 26. A line that reaches its end of life may be dropped in a minor release, announced in the changelog beforehand |
| TypeScript | 5.3 or later for the declarations, and 7. The minimum may rise in a minor release, only to a version released at least two years before |
| Chain SDKs | The peer range each family declares in `package.json`, such as `@solana/web3.js` `^1.99.0 \|\| ^3.0.0`. Tests pin the oldest version of each range; a nightly run tests the newest. A new SDK major line may be added in a minor release; dropping one is a major release |
| Module systems | CommonJS, and ES modules through Node.js's CommonJS interop; `node16`/`nodenext` and `bundler` type resolution |

Security fixes go to the latest minor release of the latest major version
([security policy](https://github.com/vhidvz/crypto-aio/blob/main/SECURITY.md)).

## What crypto-aio does not do yet

The behaviors with limits worth knowing before production are in
[Known limitations](./limitations.md): none of them leaks a secret or makes the library pay
twice on its own.
