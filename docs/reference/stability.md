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

The 0.x releases and the 1.0.0 release candidates came before this promise: they could
break, and the changelog says how.

## What is covered

| Surface | Promise |
| --- | --- |
| The container and handle API (`CryptoAio`, `Blockchain`, `configure`), the configuration shape, the model (`Amount`, `Address`, assets, intents, statuses), signers, error classes and codes, the error fields [Errors](./errors.md#error-fields) lists, event names and payloads, the store ports and their contract suites | Covered by semver |
| The family entry points (`crypto-aio/evm`, `/utxo`, `/tron`, `/solana`, `/ton`, `/avalanche`): their plugin functions and options, their constants (`DEFAULT_…`, `MIN_…`, `MAX_…`, `…_CAPABILITIES`, `…_INDEXER_CAPABILITIES`, `…_PEER_DEPENDENCIES`), and the types of each family's `ext` results, fee overrides, fee details and options | Covered: the API reports in `etc/api/` name them, and each family's [network page](./networks/index.md) describes them |
| The driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverFactory`, `DriverContext`, `BuildContext`, `ChainInfo`, `NetworkInfo`, `ProviderPreset` | Covered by semver, under the rules for ports below |
| The registries you augment: `ChainRegistry`, `FamilyRegistry`, `NativeClientMap` | Covered: a minor release may add an entry, never change or remove one |
| What a process stores: Operation records, observations, the store keys, the intent hash behind idempotency keys | Covered: every 1.x release reads what any earlier 1.x release, 0.2.0 and 0.1.0 stored. See [the record format](../explore/stores.md#upgrades-and-the-record-format) |
| `crypto-aio/testing` | Covered, `FakeFetch`, `FakeRequest` and `FakeReply` included, except the fake chain's wire protocol (`FakeWireBlock`, `FakeWireTx`, `FakeEnvelope`, `encodeEnvelope`, `decodeEnvelope`), which is not an API |
| `crypto-aio/native`, and the types that mirror an SDK: `AvalancheNativeClient`, `AvalancheSdk` and the `Sdk…` interfaces of `crypto-aio/avalanche`, and `UtxoNativeClient` | **Not covered.** They hand you, or describe, the SDK's own client; the SDK's API is the SDK's, and a new major line of it may change them in a minor release |
| Error and log message texts, an observation's `reason` text, `details` and `context` fields that [Errors](./errors.md#error-fields) does not list, the order of events of different Operations | Not covered: match on codes, categories, an observation's `failure` and the documented fields |

`FeeOverride`, `FeeEstimate.details`, `HandleOptions.options` and `WalletConfig.ton` and
`.utxo` stay plain records through 1.x. The family types (`EvmFeeOverride`,
`TronFeeDetails`, `UtxoWalletOptions`, `TonWalletIdentity`, …) name the shape each family
accepts or returns, and they are covered; typing the core fields per chain would break code
that passes them today, so it waits for 2.0.

## What a minor release may do

TypeScript makes some additions breaking for some code, so these are the rules:

- **Unions grow.** `ErrorCode`, `OperationState`, `TxState`, `TxFailure`, capability names,
  event names and other string unions may gain members in a minor release. Handle the
  unknown case in an exhaustive `switch` (a `default` branch), and match on documented
  codes rather than on their absence. `OperationState` gains non-terminal states only:
  `TERMINAL_STATES` is fixed through 1.x, so a durable store may build an index on it.
- **Results grow.** An object the library returns or emits may gain optional fields, and a
  list may come to include assets a family does not read yet, such as Solana's Token-2022
  accounts, which `ext.solana.getTokenAccounts` leaves out today.
- **Inputs grow, optionally.** An options object may gain optional fields with defaults that
  keep today's behavior.
- **Ports you implement never gain a required member.** A store port, `Signer`, a driver
  port, `Logger`, `LogWriter` or `Clock` may gain an optional method, or an optional
  argument or field the core passes to you; never one you must implement. The contract
  suites may gain tests only for behavior the port's documentation already requires.
- **Aliases keep their contracts.** A built-in token alias (`USDT`, `USDC`, …) names the
  same contract through 1.x. The intent hash covers the resolved asset id, so moving an
  alias would turn a repeated idempotency key into `IDEMPOTENCY_CONFLICT`: it waits for a
  major release, and you send to an upgraded contract by its address meanwhile.
- **Safety fixes.** A fix for a security vulnerability or for a verdict that could pay twice
  may change behavior in a patch or minor release, and is called out as such in the
  changelog.

## Deprecation

A feature is deprecated in a minor release: its documentation and type declarations say so
(`@deprecated`), and using it warns once per process with a Node.js `DeprecationWarning`
whose code starts with `CRYPTO_AIO_`. It is removed no earlier than the next major release.

`library: 'web3'` is deprecated this way (`CRYPTO_AIO_WEB3`): web3.js is no longer
maintained. It keeps working, and tested, through 1.x, unless a security issue in web3.js
itself forces its removal, which would come as a safety fix, announced in the changelog.
Use `ethers`.

## Support policy

| Dependency | Supported |
| --- | --- |
| Node.js | 22.12 or later: every Node.js LTS line that has not reached its end of life. CI runs 22.12.0, 22, 24 and 26. A line that reaches its end of life may be dropped in a minor release, announced in the changelog beforehand |
| TypeScript | 5.3 or later for the declarations, and 7. The minimum may rise in a minor release, only to a version released at least two years before |
| Chain SDKs | The peer range each family declares in `package.json`, such as `@solana/web3.js` `^1.99.0 \|\| ^3.2.1`. Tests pin the oldest version of each range; a nightly run tests the newest. A new SDK major line may be added in a minor release; dropping one is a major release |
| Module systems | CommonJS (also under Jest's CommonJS loader, so no runtime dependency is an ES module only), and ES modules through Node.js's CommonJS interop; `node16`/`nodenext` and `bundler` type resolution |

Security fixes go to the latest minor release of the latest major version, and to 0.2.x for
six months after 1.0.0's release
([security policy](https://github.com/vhidvz/crypto-aio/blob/main/SECURITY.md)).

## What crypto-aio does not do yet

The behaviors with limits worth knowing before production are in
[Known limitations](./limitations.md): none of them leaks a secret or makes the library pay
twice on its own.
