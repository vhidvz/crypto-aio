---
title: Write a chain family plugin
description: The Plugin and AdapterManifest data, and the driver contract every family follows.
---

# Write a chain family plugin

A new blockchain family, one whose transactions, addresses or proofs differ from every built-in
family, is a plugin: data that describes its chains, plus a driver that speaks to its nodes.
The core does the rest: idempotency, write-ahead signing, leases, workers, scanning, proofs
under quorum, redaction. [Chains, families and drivers](../tour/families.md) explains how the
pieces fit; this page is the contract.

> [!NOTE]
> From 1.0 the driver port follows semver ([Versioning](../reference/stability.md)): a
> minor release may add an optional method or an optional field the core passes, and
> never a required one. Read the two reference implementations next to this page: the
> fake family (`src/testing/fake-plugin.ts` and `fake-driver.ts`) and the EVM family
> (`src/adapters/evm/`).

## The plugin

A `Plugin` is plain, SDK-free data plus lazy loaders. You register it on a root container.

```ts
import type { AdapterManifest, ChainInfo, DriverFactory, Plugin, ProviderPreset } from 'crypto-aio';
import { reveal, secret } from 'crypto-aio';

const acmechain: ChainInfo = {
  id: 'acmechain',
  family: 'acme',
  model: 'account',
  ordering: 'nonce', // 'nonce' | 'seqno' | 'inputs' | 'expiry'
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'ACME', decimals: 18 },
  defaultNetwork: 'mainnet',
  networks: {
    mainnet: {
      id: 'mainnet',
      identity: '0x2a', // what the driver's identity probe must return
      testnet: false,
      feeModel: 'acme',
      finality: { kind: 'confirmations', confirmations: 12 },
      defaultConfirmations: 12,
      reorgWindow: 64,
      replacement: { minBumpPercent: 10 },
    },
  },
};

const acmeManifest: AdapterManifest = {
  family: 'acme',
  library: 'acme-sdk',
  chains: ['acmechain'],
  capabilities: ['block-scan', 'replace-fee', 'cancel', 'memo'],
  peerDependencies: [{ name: 'acme-sdk', range: '^3.0.0' }],
  // The only place the SDK is loaded. `require`, so it works under CommonJS and Jest.
  load: async (): Promise<DriverFactory> => require('./acme-driver').acmeDriverFactory,
};

const acmeCloud: ProviderPreset = {
  name: 'acmecloud',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (chain, network) => chain === 'acmechain' && network === 'mainnet',
  endpoints: ({ apiKey }) => [
    { name: 'main', url: secret(`https://rpc.acme.example/v1/${reveal(apiKey ?? '')}`) },
  ],
};

export function acmePlugin(): Plugin {
  return { name: 'acme', chains: [acmechain], adapters: [acmeManifest], presets: [acmeCloud] };
}

// Required: without the ChainRegistry entry, `ChainId` does not include 'acmechain', and
// `aio.blockchain({ chain: 'acmechain' })` does not compile. FamilyRegistry types
// `bc.ext.acme` and the library; NativeClientMap types `native()`. AcmeExt and AcmeClient
// are your own types.
declare module 'crypto-aio' {
  interface ChainRegistry { acmechain: { family: 'acme'; network: 'mainnet' } }
  interface FamilyRegistry { acme: { library: 'acme-sdk'; ext: AcmeExt } }
  interface NativeClientMap { 'acme-sdk': AcmeClient }
}
```

Register it with `new CryptoAio({ plugins: [acmePlugin()] })` or `aio.use(acmePlugin())`.
Plugins go on a root container only. Registering the same plugin again does nothing, so
`use()` is safe to repeat, and so does a fresh `acmePlugin()` that builds the same data around
the same functions. Define `load` and every other function once, at module level, as above: a
plugin whose functions are rebuilt on each call, or capture other values, is a different
plugin. A different plugin under a name already registered throws `CONFIG_INVALID`, so give
each plugin a unique name (custom EVM chains register as `evm:<name>`). A plugin may also
bring `assets` (tokens with aliases, per chain and network) and `schemes`. The built-in
schemes are `secp256k1-ecdsa`, `secp256k1-schnorr` and `ed25519`; a scheme of your own is a
`SignatureScheme`: an `id`, the `publicKeyLength` its public keys have, and a `verify` that
checks a signature over a request's message and never throws.

A `ProviderPreset` with `production: false` marks free public endpoints: `bc.config` reports
a provider built from it with `production: false`. `ChainInfo.xpubNetworkClass` says whether the chain's
extended public keys carry their network class (`xpub` on mainnet, `tpub` on test networks),
so `deriveAddress` refuses a key of the other class; it defaults to `true` for `utxo`-model
chains and `false` for account-model ones.

## The manifest

An `AdapterManifest` is what the core knows about a driver before it loads the SDK:

| Field | Meaning |
| --- | --- |
| `family`, `library` | The registration key `family/library`: registering the same pair twice throws `CONFIG_INVALID`. Custom EVM chains register their manifests under the family `evm:<name>` |
| `chains` | The chains the driver serves. For a chain, the first manifest registered that lists it is its default library, which a handle without `library` uses |
| `capabilities` | What every handle of this driver supports |
| `indexerCapabilities` | Added only when the handle has an `indexer` provider (Tron and TON add `address-history` this way) |
| `requiresIndexer` | A handle without an `indexer` falls back to the `public` preset, and fails with `CONFIG_INVALID` when there is none |
| `peerDependencies` | The SDKs `load()` needs: when it fails, the handle fails with `DEPENDENCY_MISSING`, `details.packages` naming them |
| `load` | Loads the driver module, and with it the SDK, on first use |

A handle's capabilities are the manifest's, plus its `indexerCapabilities` when an indexer is
configured, adjusted per network by `NetworkInfo.capabilities` (`add`, `remove`).
`bc.supports()` and every gate below read that set, so the driver must implement each
capability it holds: when a handle first loads the driver, the core closes and refuses, with
`CONFIG_INVALID`, a driver whose `ChainDriver.capabilities` lacks one (`details.missing`
names them) or whose `ordering` is not its chain's `ChainInfo.ordering` (`details.ordering`
is the driver's, with `missing` empty).

| Capability | What the core does with it | What the driver implements |
| --- | --- | --- |
| `tokens` | Resolves tokens that are not registered by reading them from the chain | `reader.getTokenMetadata`, and `reader.normalizeTokenRef` when a contract has several spellings (EVM's EIP-55) |
| `memo` | Accepts an intent's `memo` | The builder writes it into the transaction |
| `batch-transfer` | Accepts more than one output | The builder pays every output; `limits(wallet).maxOutputs` caps them |
| `replace-fee` | `bc.replace()` | `replacement.replace` and `buildReplacement` |
| `cancel` | `bc.cancel()` | `replacement.cancel` and `buildCancel` |
| `block-scan` | `bc.scanner()` | `blocks` |
| `address-history` | `bc.history()` | `history` |
| `hd-public-derivation` | `bc.deriveAddress()` from a wallet's `xpub` | `address.fromPublicKey` with the wallet's `hd` options |
| `expiry` | Descriptive: a signed transaction expires | `proofs.expired`, which the core asks for `expiry` and `seqno` orderings |
| `finality-tag`, `fee-market-1559` | Descriptive: the network has a `finalized` tag, and EIP-1559 fees (the EVM family checks them against the network's finality and fee model) | Nothing more |
| `contract-read` | Reserved: no built-in family declares it, and the core gates nothing on it | Nothing |

**Reference implementations:** the fake family (`src/testing/fake-plugin.ts` and
`fake-driver.ts`) and the EVM family (`src/adapters/evm/`). Read them next to this section.

## The driver

`DriverFactory.create(ctx)` receives a `DriverContext`: `chain`, `network`, `library`,
`transport`, an optional `indexer` transport, `clock`, `log` and handle `options`. It returns
a `ChainDriver` that implements the ports in `src/core/driver/types.ts`:

| Port | Job |
| --- | --- |
| `ordering`, `capabilities` | Required: `'nonce'`, `'seqno'`, `'inputs'` or `'expiry'`, the chain's own; and every capability the handle can hold ([the manifest](#the-manifest)) |
| `address` | `validate`, `normalize` (throw `INVALID_ADDRESS`), `fromPublicKey` |
| `reader` | balance, block height, `getFinalizedHeight` (the highest block that meets the network's finality policy), blocks, transactions, `observe(ref)`; `getTokenMetadata?` and `normalizeTokenRef?` for `tokens` |
| `builder` | `estimateFee`, `checkFunds`, `build` (an `UnsignedTx` with signing requests), `assemble`, `signaturesFrom?` |
| `broadcaster` | `broadcast` → `accepted`, `already-known`, `refused` (may still land) or `rejected` (never valid) |
| `proofs` | finalized-state checks behind `proven` verdicts: `finalizedHead()`, `includedFinal(ref, ordering, from)`, `slotConsumed(ordering, from, level)`, `expired(ordering)` and `blockHash(height, level)` |
| `sequence?` | pending and latest nonce or seqno (`nonce` and `seqno` ordering) |
| `replacement?` | the `replace` and `cancel` booleans, `buildReplacement`, `buildCancel` (capabilities `replace-fee`, `cancel`) |
| `blocks?`, `history?` | block source for the scanner (`block-scan`), indexer history (`address-history`) |
| `ext?`, `limits?`, `createNativeClient?`, `close?` | family extras (`bc.ext.<family>.<method>()`: the core only checks that the method exists, so a method that needs a capability checks it itself), output limits, the native client, cleanup |
| `signingSchemes?` | the schemes a wallet's options make it sign with, when they narrow the chain's (Bitcoin `p2tr`: `secp256k1-schnorr`) |

The JSDoc of `ChainDriver` holds the **per-method contract table**: the request purpose, the
retry class, the quorum and the throw rules for each method. Follow it exactly. The core
relies on these rules most:

- **No keys, no per-scope state.** Drivers never sign. One driver serves every scope and
  handle of a root container that shares its chain, network, library, providers and
  options, whatever their wallets. Cache only immutable chain data, such as token metadata.
- **All I/O goes through `ctx.transport`** (`rpc`, `rpcRaw`, `http`, or `createFetch` for an
  SDK, which only sees `PLACEHOLDER_ORIGIN`). Call `transport.setProbes(...)` exactly once in
  `create()`, before any traffic, on every transport you receive. Set an identity probe that
  matches `network.identity`, and a height probe. Besides these, a driver may read
  `status()`, `highestHeight()` and `maxLagBlocks`, and call `ensureFreshHealth()` before a
  read that must not rest on stale health; `refreshHealth()` is the core's.
- **Tag reads.** Heights, `observe`, `sequence` and block sources use `purpose: 'monitor'`.
  The `proofs` methods use `purpose: 'proof'` and `quorum: 'proof'`; the table names the one
  exception. When endpoints disagree, the transport throws a retryable
  `PROVIDER_INCONSISTENT`, and the core decides nothing.
- **A proof says "no" only on a definitive negative.** On a proof path (`proofs.*`), only a
  definitive negative proof may answer "no" (`included: false`, a slot not consumed, a
  `null` block hash). Every other RPC error, including state or history not available,
  pruned data, an index still being built, or an endpoint's non-definitive error, must throw
  a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides nothing.
- **Broadcast is `ambiguous-on-failure`.** Classify a node's answer only when the error is
  not ambiguous. Rethrow an ambiguous `RPC_ERROR` unclassified, even if it reads like "nonce
  too low". Keep refusal reasons short and address-free.
- **`rejected` is a proof.** The core records one endpoint's `rejected` answer, for bytes
  that were never seen live, as a `proven` verdict: the Operation fails with `TX_REJECTED`,
  and a caller may pay again. Return `rejected` only after checking the node's reason
  against your own bytes (a nonce below the account's latest nonce, an input already spent
  on chain, an expiry already past, a signature that does not verify); when you cannot
  check it, return `refused`, which may still land and decides nothing.
- **Block sources.** Heights are dense (use block height, not a slot number). Serve headers
  at least about 2 × `reorgWindow` below the head. `filter.addresses: []` means no filter.
  `filter.assets` is only a hint.
- **Replacements.** Honour `buildCancel`'s `fee`. Never set or read `fee.details.requestedFee`,
  which the core reserves.
- **Native client.** `createNativeClient()` returns `{ client, close? }`, with a **fresh** SDK
  instance on every call. `CryptoAio.close()` calls `close`.
- **Base units and decimals.** Amounts reach drivers in base units only; the core scales
  them with the asset's registered metadata, or what `getTokenMetadata` read from the
  chain. `BuildContext.decimals` says which decimals it used. A driver whose transaction
  signs the decimals (Solana's `transferChecked`) reads them from the chain under the
  proof quorum and refuses a mismatch with `BuildContext.decimals` (`ASSET_RESOLUTION`):
  the amounts were then scaled wrong.
- **Replacement prices.** A driver with `replacement` may give `comparePrice(a, b)`, the
  order a node uses to decide whether one transaction of a slot may replace another. A
  repeat cancel bumps from the highest earlier cancel by it; without it, the core compares
  total charges, which a gas limit can skew.
- **Wallet options.** `BuildContext.wallet`, `limits(wallet)`, `signingSchemes(wallet)` and
  `address.fromPublicKey`'s `options` (when the core resolves a wallet or derives from its
  `xpub`) carry the wallet's `options`, its family settings (`utxo`, `ton`) and, when it has
  an `xpub`, `hd: { xpub, xpubPath?, xpubVersions? }` (`WalletHdOptions`, always a readable
  public extended key). `hd` is always the core's: neither a wallet's own `options.hd` nor
  the `options` a caller passes to `Blockchain.addressFromPublicKey` bring an `hd` to a
  driver. The core does not check `hd` against the network class when it resolves the
  wallet: a UTXO driver passes `{ testnet }` to `deriveXpubChild` when it derives from it.
- **Signing schemes.** When a wallet's options narrow the schemes its requests use, as a
  Bitcoin `p2tr` wallet signs with `secp256k1-schnorr` only, return them from the optional
  `signingSchemes(wallet)`, with no I/O. The core then refuses a wallet whose signer does
  not declare each of them, with `CONFIG_INVALID` when it resolves the wallet, instead of
  building and reserving a transfer that fails at signing. Without it, a signer needs only
  one of the chain's `schemes`.
- **Exact integers.** Pass `exactIntegers: true` on a read whose JSON answer carries amounts
  as numbers: integers beyond 2^53 − 1 then arrive as `bigint`, and a quorum compares them
  exactly.
- **Endpoint limits.** Pass `endpointLimit` on a read without a quorum when one endpoint may
  refuse a request for its own limit (an indexer that will not scan a busy address): a
  definitive refusal it returns `true` for makes the read ask the endpoints it has not
  asked, and stands only when every one refuses.
- **Times.** A `DriverBlock`'s and a `DriverTransaction`'s `timestamp` are Unix seconds,
  whatever unit the chain uses (Tron's milliseconds are converted).
- **Output variants.** `DriverIntent.outputs[i].variant` is the recipient address's
  `variant` (for example TON's bounce flag) when it has one; it is part of the intent hash.
  Your codec's `normalize` must return a variant of JSON scalars only (strings, finite
  numbers, booleans, `null`) under string keys: anything else fails the transfer with
  `INVALID_ADDRESS`.
- **Failure reasons.** With `success: false`, `observe` and `includedFinal` may return a
  short fixed `reason` (no addresses or amounts); the core shows it as `TxStatus.reason`.
  They also say what failed, as `failure`: leave it out (or `'reverted'`) when execution
  failed, and set `'unevidenced'` when the transaction executed but shows no transfer to
  the recipient, so value may have moved; the Operation then fails with `TX_UNEVIDENCED`,
  not `TX_REVERTED`.
- **Signed payloads.** The optional `builder.signaturesFrom(unsigned, signed)` lets
  `submitSignatures` take a whole transaction signed elsewhere. Return only its signatures,
  with no I/O, and throw `INVALID_INTENT` when it is not the prepared transaction.

## What the core trusts the driver for

The core checks a driver's answers against each other and against the quorum, but some
facts it can only take from the driver. Get these wrong and the core's guarantees fail:

- **The summary is the payload.** `UnsignedTx.summary` (the asset id, each output's `to` and
  base-unit `amount` as a decimal string, the `memo`) must describe exactly what `payload`
  pays. `beforeSign` hooks and spending policies read the summary, never the payload, so a
  summary that differs lets a transfer past the caller's policy.
- **The ordering is complete.** `UnsignedTx.ordering` names the slot the transaction
  consumes: for `inputs`, every input the payload spends. Leases, reservations and the
  double-spend checks rest on it.
- **The ref is the chain's id.** `SignedTx.ref` is the id the chain reports for the
  transaction (`canonical: false` when it is not the final protocol hash, as TON's message
  hash). `UnsignedTx.expectedRef` is set only when the id is fixed before signing (Tron, and
  UTXO transactions whose inputs are all witness inputs), and then equals the signed ref.
- **Locators are stable.** A deposit's id is `<txId>:<locator>`, and callers credit
  deposits by it. A `DriverTransfer.locator` must be the same for the same transfer from
  the scanner, `getTransaction` and `history`, from every provider, and across your
  driver's releases: a locator that changes credits a deposit twice.
- **What you stored stays readable.** The core stores what your driver returned, an
  `UnsignedTx` and its `OrderingData`, and hands it back after an upgrade: to `assemble`,
  `buildReplacement`, `buildCancel` and the `proofs` methods. Every release of your driver
  must read what its earlier releases returned. `normalize()` must also keep returning the
  same canonical address and `variant` for the same input: they feed the intent hash
  behind idempotency keys and the keys of nonce leases, so a change makes a repeated key
  fail with `IDEMPOTENCY_CONFLICT` and gives one address two leases.
