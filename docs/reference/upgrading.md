---
title: Upgrade to 1.0
description: What changes from crypto-aio 0.2.0 and from 0.1.0 to 1.0, and what to change in your code, your stores and your configuration.
---

# Upgrade to 1.0

crypto-aio 1.0 keeps the API that 0.2.0 settled, and from 1.0.0 on,
[semver](./stability.md) applies. From 1.0.0-rc.1, only the chain SDKs move: install
`bitcoinjs-lib` 7.0.5 or later, `tronweb` 6.5.2 or later (on Node.js 22.23.4, 24.22.1 or
26.12.1 or later) and, on the 3.x line, `@solana/web3.js` 3.2.1 or later. From 0.2.0, read
[From 0.2.0](#from-020); from 0.1.0, read both sections. Every change is also in the
[changelog](https://github.com/vhidvz/crypto-aio/blob/main/CHANGELOG.md).

Operations that 0.1.0 and 0.2.0 stored are read as they are: no data migration is needed,
and an idempotency key repeated after the upgrade finds its Operation (with one exception,
[below](#if-you-send-evm-or-tron-tokens)).

Upgrade every process that shares your stores before you rely on what the new version
stores, and never run a 0.1.0 process beside a newer one. 0.1.0 has no record-format check,
and it reads a token transfer that a newer version found unevidenced as `TX_REVERTED`, the
code your application may treat as safe to pay again.

## From 0.2.0

- **Newer chain SDKs.** The peer ranges start at the newest releases: `bitcoinjs-lib`
  7.0.5, `tronweb` 6.5.2 (which asks for Node.js 22.23.4, 24.22.1 or 26.12.1 or later) and,
  on the 3.x line, `@solana/web3.js` 3.2.1. Upgrade the ones you install.
- **Tron block times are Unix seconds.** `Block.timestamp` and a transaction's
  `block.timestamp` are Unix seconds on every family; Tron reported milliseconds. Multiply
  by 1,000 where your code relied on them.
- **Bitcoin indexers fail over on per-address limits.** When an indexer refuses an address
  for its own limits (HTTP 400, "too many" or "too large"), the balance, unspent-output or
  history read asks the handle's next `indexer` endpoint; it fails with `RPC_ERROR` only
  when every one refuses. Configure a second indexer to benefit.
- **Plugin drivers must implement what they declare.** A driver whose `capabilities` lack
  one that its manifest and network grant, or whose `ordering` is not its chain's, is
  refused with `CONFIG_INVALID` (`details.missing`, `details.ordering`) when its handle
  first loads it. Declare in `capabilities` every capability your manifest lists.
- **Durable stores on `stringifyTagged`.** It now throws a `TypeError` for a plain object
  whose only key is `$bigint` or `$bytes` (with a string value), which would read back
  changed. The core never stores one, and the stored format is unchanged.
- **Rolling upgrades.** `aio.operations.list()` and `recover()` leave out an Operation a
  newer version stored, with a logged warning, instead of throwing
  `RECORD_FORMAT_UNSUPPORTED`; a read by id, key or ref still throws.
- **`Scanner`.** Its constructor is private; scanners come from `bc.scanner()`, as before.
- **Store authors:** `findByRef` may return any one of several Operations that hold a ref
  (which the core never writes). Run the contract suites again; nothing else changed.

## From 0.1.0 (changed in 0.2.0)

### Everyone

- **Node.js 22.12 or later.** Earlier 22.x releases are no longer supported (Solana already
  needed 22.12).
- **`TX_UNEVIDENCED`.** A transfer whose transaction executed but shows no transfer to the
  recipient now fails with `TX_UNEVIDENCED`, not `TX_REVERTED`: an EVM or Tron token that
  logged no `Transfer` to the recipient, or TON jettons sent to a wallet the master does not
  name. **Value may have moved**, so treat it like an unknown outcome: check the chain before
  paying again. If your code handles `TX_REVERTED` as "safe to pay again", it no longer sees
  these cases there, which is the point; add a branch for `TX_UNEVIDENCED` that routes to a
  person ([Errors](./errors.md#what-to-do-about-each-error)).
- **Proofs wait for every configured endpoint's share.** A proof needs `proofQuorum`
  endpoints (2) capped by the endpoints you configured, even while some are down: with two
  endpoints and one down, `final` waits for it. Configure three or more endpoints, from
  independent providers, so one outage leaves enough. To keep 0.1.0's behavior, where the
  one endpoint left proves alone, set `transport: { degradedProofs: true }`.
- **Endpoint health reads `unknown` until its height is known.** `getNetworkStatus()` and
  `bc.ready()` no longer count an endpoint as `healthy` from its identity alone: `ready()`
  now fails with `PROVIDER_UNAVAILABLE` when no endpoint has answered its height probe.

### If you send EVM or Tron tokens

- **Deprecated Tether-style tokens are refused.** A token whose contract answers
  `deprecated()` with `true` fails before signing with `ASSET_RESOLUTION`: send to the
  upgraded contract instead, by its address or a registered asset.
- **Tokens registered with a lower-case contract.** `evmChainPlugin` registers a token under
  its EIP-55 (checksummed) contract. An Operation that 0.1.0 sent by such a token's alias
  has another intent hash now, so repeating its idempotency key fails with
  `IDEMPOTENCY_CONFLICT`, the safe direction: read the Operation by id instead.
- **A gas-limit bound.** EVM transfers, replacements and cancels refuse a gas limit above
  `maxGasLimit` (2^24 by default) with `INVALID_INTENT`. Raise it in the chain's or the
  handle's `options` if you send to contracts that need more.
- **`library: 'web3'` is deprecated** and warns once per process; switch to `ethers` before
  2.0.

### If you scan Bitcoin

The scanner reads each block's raw bytes (`GET /block/:hash/raw`) and the previous
transactions of its inputs (`GET /tx/:txid/hex`), so your Esplora service must serve both
(Blockstream's and mempool.space's do). Scan with `filter.addresses`: an unfiltered scan reads
one previous transaction per distinct parent outside the block, thousands for a full mainnet
block. `details.vout[].type` is named from the script, as Blockstream electrs names it.

### If you sign Bitcoin `p2tr` with a custody signer

A wallet whose signer does not declare the scheme its address type signs with is refused
with `CONFIG_INVALID` when it resolves, not at signing: a `p2tr` wallet needs a signer that
declares `secp256k1-schnorr`, and the other address types `secp256k1-ecdsa`.

### If you read `RecoveryReport`

`aio.operations.recover()` reports `unresent`: Operations whose wallet no longer resolves are
now checked on chain, and counted there rather than in `failed`. Restore the wallet and
recover again to resend them.

### If your idempotency keys are unusual text

An idempotency key or a scanner's `cursorKey` with U+0000 or a lone surrogate (half of a
UTF-16 pair) is now refused. Keys made of ordinary text are unaffected. An Operation that
0.1.0 stored under such a key can now be read only by its id.

### If you write a durable store

Run the contract suites from `crypto-aio/testing` again: they now check two more fields.

- Operation records carry `format` (`OPERATION_FORMAT`, 1). Store it like every other field.
  A record without one, as 0.1.0 wrote them, reads as format 1, so existing rows need no
  migration.
- Observations carry `failure` (`'reverted'` or `'unevidenced'`) on a failed Attempt.
  Store it, and clear it when an observation is replaced without it, as you do `reason`.

During a rolling upgrade, a process of 0.2.0 or later never reads a record of a newer
format: a read of one throws `RECORD_FORMAT_UNSUPPORTED`, and its workers leave such records
to newer processes ([upgrades](../explore/stores.md#upgrades-and-the-record-format)). 0.1.0
has no such check, so upgrade every 0.1.0 process before a newer one writes.

### If you construct handles or containers yourself

- `Blockchain`'s constructor is private, and its internal `protected` methods are gone from
  the type declarations: create handles with `aio.blockchain()` or `Blockchain.create()`.
  Subclassing a handle was never supported.
- `CryptoAio`'s constructor has one signature, `new CryptoAio(options?)`.

### If you write a chain family plugin

The driver port is final for 1.0 ([Write a chain family plugin](../explore/plugins.md)):

- `observe` and `includedFinal` report what failed with `failure`: set `'unevidenced'` when
  a transaction executed but shows no transfer to the recipient.
- `BuildContext.decimals` gives the decimals the core scaled the amounts with. A driver whose
  transaction signs decimals must refuse a mismatch with what the chain says.
- `ReplacementPolicy.comparePrice` (optional) ranks two transactions of one slot by price,
  for repeat cancels.
