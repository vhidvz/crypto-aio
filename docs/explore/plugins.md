---
title: Write a chain family plugin
parent: Explore
nav_order: 3
description: The Plugin and AdapterManifest data, and the driver contract every family follows.
---

# Write a chain family plugin

A new blockchain family, one whose transactions, addresses or proofs differ from every built-in
family, is a plugin: data that describes its chains, plus a driver that speaks to its nodes.
The core does the rest: idempotency, write-ahead signing, leases, workers, scanning, proofs
under quorum, redaction. [Chains, families and drivers](../tour/families.md) explains how the
pieces fit; this page is the contract.

> [!NOTE]
> The driver port is the part of the API most likely to change before 1.0
> ([Stability](../reference/stability.md)). Read the two reference implementations next to
> this page: the fake family (`src/testing/fake-plugin.ts` and `fake-driver.ts`) and the EVM
> family (`src/adapters/evm/`).

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
each plugin a unique name (custom EVM chains register as `evm:<name>`). A plugin may also bring `assets` (tokens
with aliases, per chain and network) and `schemes`. The built-in schemes are
`secp256k1-ecdsa`, `secp256k1-schnorr` and `ed25519`.

**Reference implementations:** the fake family (`src/testing/fake-plugin.ts` and
`fake-driver.ts`) and the EVM family (`src/adapters/evm/`). Read them next to this section.

## The driver

`DriverFactory.create(ctx)` receives a `DriverContext`: `chain`, `network`, `library`,
`transport`, an optional `indexer` transport, `clock`, `log` and handle `options`. It returns
a `ChainDriver` that implements the ports in `src/core/driver/types.ts`:

| Port | Job |
| --- | --- |
| `ordering`, `capabilities` | Required: `'nonce'`, `'seqno'`, `'inputs'` or `'expiry'`, and the capabilities the driver really has |
| `address` | `validate`, `normalize` (throw `INVALID_ADDRESS`), `fromPublicKey` |
| `reader` | balance, block height, finalized height, blocks, transactions, `observe(ref)` |
| `builder` | `estimateFee`, `checkFunds`, `build` (an `UnsignedTx` with signing requests), `assemble` |
| `broadcaster` | `broadcast` → `accepted`, `already-known`, `refused` (may still land) or `rejected` (never valid) |
| `proofs` | finalized-state checks behind `proven` verdicts, including `blockHash(height, level)` |
| `sequence?` | pending and latest nonce or seqno (`nonce` and `seqno` ordering) |
| `replacement?` | the `replace` and `cancel` booleans, `buildReplacement`, `buildCancel` (capabilities `replace-fee`, `cancel`) |
| `blocks?`, `history?` | block source for the scanner (`block-scan`), indexer history (`address-history`) |
| `ext?`, `limits?`, `createNativeClient?`, `close?` | family extras, output limits, the native client, cleanup |

The JSDoc of `ChainDriver` holds the **per-method contract table**: the request purpose, the
retry class, the quorum and the throw rules for each method. Follow it exactly. The core
relies on these rules most:

- **No keys, no tenant state.** Drivers never sign and are shared across tenants. Cache only
  immutable chain data, such as token metadata.
- **All I/O goes through `ctx.transport`** (`rpc`, `rpcRaw`, `http`, or `createFetch` for an
  SDK, which only sees `PLACEHOLDER_ORIGIN`). Call `transport.setProbes(...)` exactly once in
  `create()`, before any traffic, on every transport you receive. Set an identity probe that
  matches `network.identity`, and a height probe.
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
- **Block sources.** Heights are dense (use block height, not a slot number). Serve headers
  at least about 2 × `reorgWindow` below the head. `filter.addresses: []` means no filter.
  `filter.assets` is only a hint.
- **Replacements.** Honour `buildCancel`'s `fee`. Never set or read `fee.details.requestedFee`,
  which the core reserves.
- **Native client.** `createNativeClient()` returns `{ client, close? }`, with a **fresh** SDK
  instance on every call. `CryptoAio.close()` calls `close`.
- Amounts reach drivers in base units only. `DriverContext` has no asset resolver, and
  `DriverIntent` carries no decimals. This is still open and may change.
- **Wallet options.** `BuildContext.wallet`, `limits(wallet)` and `address.fromPublicKey`'s
  `options` (when the core resolves a wallet or derives from its `xpub`) carry the wallet's
  `options`, its family settings (`utxo`, `ton`) and, when it has an `xpub`,
  `hd: { xpub, xpubPath?, xpubVersions? }` (`WalletHdOptions`, always a readable public
  extended key). `hd` is always the core's: neither a wallet's own `options.hd` nor the
  `options` a caller passes to `Blockchain.addressFromPublicKey` bring an `hd` to a
  driver. The core does not check `hd` against the network class when it resolves the
  wallet: a UTXO driver passes `{ testnet }` to `deriveXpubChild` when it derives from it.
- **Exact integers.** Pass `exactIntegers: true` on a read whose JSON answer carries amounts
  as numbers: integers beyond 2^53 − 1 then arrive as `bigint`, and a quorum compares them
  exactly.
- **Output variants.** `DriverIntent.outputs[i].variant` is the recipient address's
  `variant` (for example TON's bounce flag) when it has one; it is part of the intent hash.
  Your codec's `normalize` must return a variant of JSON scalars only (strings, finite
  numbers, booleans, `null`) under string keys: anything else fails the transfer with
  `INVALID_ADDRESS`.
- **Failure reasons.** With `success: false`, `observe` and `includedFinal` may return a
  short fixed `reason` (no addresses or amounts); the core shows it as `TxStatus.reason`.
- **Signed payloads.** The optional `builder.signaturesFrom(unsigned, signed)` lets
  `submitSignatures` take a whole transaction signed elsewhere. Return only its signatures,
  with no I/O, and throw `INVALID_INTENT` when it is not the prepared transaction.
