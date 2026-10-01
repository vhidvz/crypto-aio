---
title: Configuration
parent: Reference
nav_order: 2
description: Every container, chain, provider, wallet, lifecycle and transport option, with its default, plus environment variables and per-family handle options.
---

# Configuration

Every option crypto-aio reads, where it can be set, and its default. The ideas behind them are
in [The big picture](../tour/architecture.md#configuration-precedence) and
[Core concepts](./concepts.md#configuration-precedence); worked configurations for each family
are in [Connect to a real network](../build/connect.md).

## Where options come from

The most specific value wins: **call > handle > scope > root container > environment >
built-in defaults**.

| Layer | Set with |
| --- | --- |
| Call | Options of one call, such as `waitForConfirmation(id, { confirmations: 12 })` |
| Handle | `aio.blockchain({ … })`, `Blockchain.create({ … })`, `bc.with({ … })` |
| Scope | `aio.scope({ … })`, child before parent |
| Root container | `new CryptoAio({ … })`, or `configure({ … })` for the default container |
| Environment | `CRYPTO_AIO_…` variables ([below](#environment-variables)): routing only |
| Built-in | The chain's default network, its first library, the network's default confirmations |

How layers merge: `chains.<id>` merges field by field, and its `options` merge deeply;
`lifecycle` and `hooks` merge key by key. A named entry of `providers`, `wallets` or `signers` is
**replaced whole** by a more specific layer, and so are arrays, such as a provider list.

## Container options: `new CryptoAio(options)`

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `namespace` | `string` | `'default'` | Prefixes every store key; one per tenant |
| `chains` | `Record<chain, ChainDefaults>` | | Per-chain defaults ([below](#chain-defaults-chainsid)) |
| `providers` | `Record<name, ProviderConfig>` | | Named providers ([below](#providers)) |
| `signers` | `Record<name, Signer>` | | From `localSigner` or `callbackSigner` |
| `wallets` | `Record<name, WalletConfig>` | | Which key sends ([below](#wallets)) |
| `hooks` | `{ beforeSign? }` | | The signing policy seam ([Keys, signers and secrets](../build/keys.md#the-beforesign-policy-hook)) |
| `lifecycle` | `LifecycleOptions` | | Timing and safety ([below](#lifecycle-lifecycle)) |
| `transport` | `TransportOptions` | | Root only: shared by every scope ([below](#transport-transport)) |
| `stores` | `Partial<Stores>` | in-memory | `{ operations, locks, sequences, cursors }`; production needs durable ones |
| `plugins` | `Plugin[]` | | Root only: extra chain families or networks |
| `logger` | `Logger` | `debug`-based | `createLogger(namespace, writer)` redacts before writing |
| `env` | `Record<string, string> \| false` | `process.env` | The environment source; `false` ignores it |
| `profile` | `string` | `CRYPTO_AIO_ENV` | The environment profile to read |
| `clock` | `Clock` | the system clock | For tests (`FakeClock`) |

A scope, `aio.scope(overrides)`, takes `chains`, `providers`, `signers`, `wallets`, `hooks` and
`lifecycle`.

## Chain defaults: `chains.<id>`

The same fields, apart from `maxLagBlocks`, can be set on a handle (`aio.blockchain({ chain, …
})`):

| Field | Type | Notes |
| --- | --- | --- |
| `network` | `string` | Defaults to the chain's default network (usually `mainnet`) |
| `library` | `string` | The SDK, such as `'ethers'` or `'web3'`; defaults to the chain's first |
| `provider` | name, `ProviderConfig`, or an array of them | Several providers: failover and cross-checked proofs |
| `indexer` | the same | Bitcoin, Tron (history), TON and the Avalanche X and P chains read one |
| `wallet` | `string` | The wallet that sends |
| `signer` | `string` | Overrides the wallet's signer |
| `confirmations` | `number` | The default target of `waitForConfirmation` |
| `options` | `Record<string, unknown>` | The family's own options ([below](#family-options)); an unknown key is `CONFIG_INVALID` |
| `maxLagBlocks` | `number` | This chain's lag tolerance; wins over `transport.maxLagBlocks` |

With no provider configured, a handle falls back to the `public` preset where one serves the
network, with a logged warning. `public` is never for production.

## Providers

A provider is a preset with an API key, or your own endpoints:

```ts
providers: {
  alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
  own: {
    endpoints: [
      { name: 'main', url: secret(process.env.NODE_URL ?? ''), rateLimit: { rps: 20 } },
      { name: 'backup', url: secret(process.env.NODE_URL_2 ?? ''), priority: 1 },
    ],
  },
},
```

| Endpoint field | Type | Notes |
| --- | --- | --- |
| `url` | `string \| Secret<string>` | Wrap any URL that carries a key in `secret()` |
| `name` | `string` | The label errors and events use instead of the URL |
| `kind` | `'rpc' \| 'indexer'` | |
| `headers` | `Record<string, string \| Secret<string>>` | Header values that carry keys go in `secret()` |
| `priority` | `number` | Order among healthy endpoints: lower first (default `0`) |
| `rateLimit` | `{ rps, burst? }` | A client-side rate limit for this endpoint |
| `timeoutMs` | `number` | Overrides `transport.timeoutMs` for this endpoint |

The presets of each family are listed in [Networks](./networks/index.md#provider-presets).

## Wallets

| Field | Type | Notes |
| --- | --- | --- |
| `signer` | `string` | The signer holding the key; without one, the wallet is watch-only |
| `signers` | `Record<keyRef id, signer>` | Routes requests to several signers by `keyRef.id` (multi-party) |
| `publicKey` | hex `string` | A watch-only wallet that can still prepare transactions |
| `address` | `string` | A watch-only address |
| `xpub`, `xpubPath`, `xpubVersions` | | Deposit addresses with `deriveAddress`; the path template defaults to `0/{index}` |
| `keyRef` | `{ id?, path? }` | Which key of the signer: a derivation path for mnemonic signers |
| `tier` | `string` | Metadata for your `beforeSign` hook; no built-in meaning |
| `chains` | `string[]` | The chains this wallet may be used on |
| `utxo` | object | Bitcoin: `addressType`, `changeAddress`, `allowExternalChangeAddress` ([Bitcoin networks](./networks/bitcoin.md)) |
| `ton` | object | TON: `version` (`v4r2`, `v5r1`), `workchain`, `subwalletId`, `subwalletNumber` ([TON networks](./networks/ton.md)) |
| `options` | object | Family wallet options |

## Lifecycle: `lifecycle`

| Option | Default | What it controls |
| --- | --- | --- |
| `requireIdempotencyKey` | `false` | Set `true` in production: a transfer without a key is an error |
| `pollIntervalMs` | `5_000` | How often waits and workers observe an Operation |
| `droppedGracePeriodMs` | `120_000` | How long an unseen transaction waits before it counts as dropped and is resent |
| `rebroadcastIntervalMs` | `60_000` | The least time between resends of one Attempt |
| `leaseMs` | `30_000` | The address lease, held while a slot is reserved and signed |
| `claimLeaseMs` | `60_000` | A worker's claim on an Operation |
| `waitTimeoutMs` | `600_000` | The default timeout of `waitForConfirmation` |
| `signTimeoutMs` | `120_000` | The time allowed to `beforeSign` and the signers; on timeout, nothing is written |
| `broadcastFanout` | `1` | How many endpoints each broadcast goes to |

## Transport: `transport`

Root container only: every scope and handle of a container shares its transports.

| Option | Default | What it controls |
| --- | --- | --- |
| `timeoutMs` | `15_000` | One request's timeout |
| `maxAttempts` | `3` | Attempts per request, across endpoints |
| `baseDelayMs`, `maxDelayMs` | `200`, `5_000` | Exponential backoff between attempts |
| `proofQuorum` | `2` | Endpoints that must agree on a proof read |
| `maxLagBlocks` | `5` (some networks set more) | How far behind the best height an endpoint may be before it is lagging |
| `failureThreshold`, `openMs` | `5`, `30_000` | The circuit breaker: failures before an endpoint rests, and for how long |
| `healthIntervalMs` | `15_000` | How often endpoints' identity and height are probed |
| `maxResponseBytes` | 64 MiB | The largest answer accepted from one request |
| `fetch` | global `fetch` | For tests (`FakeFetch`) |

The lag tolerance comes from `chains.<id>.maxLagBlocks`, then `transport.maxLagBlocks`, then the
network's own value (the BSC, Arbitrum, OP and Base mainnets set about 60 seconds of blocks),
then 5.

## Family options

Set in `chains.<id>.options` or a handle's `options`. Each family refuses keys it does not know.

| Family | Option | Default | Bounds |
| --- | --- | --- | --- |
| EVM | `maxFeePerGas` | 1,000 gwei (`DEFAULT_MAX_FEE_PER_GAS`) | The highest price per gas any transaction signs |
| Bitcoin | `maxFeeRate` | 1,000 sat/vB | The highest fee rate signed |
| Bitcoin | `maxFee` | 0.1 BTC | The highest fee signed |
| Bitcoin | `maxEstimatedFeeRate` | 200 sat/vB | The highest estimate trusted from an endpoint |
| Bitcoin | `minInputConfirmations`, `coinSelection`, `rbf`, `nonWitnessUtxo` | `1`, `'accumulative'`, `true`, `true` | Coin selection and signing ([Bitcoin networks](./networks/bitcoin.md)) |
| Tron | `maxFeeLimit` | 100 TRX (`DEFAULT_MAX_FEE_LIMIT`) | The highest TRC-20 fee limit signed |
| Tron | `expirationMs` | 60 s | From 10 s to 5 minutes |
| Tron | `energyMarginPercent` | 20 | Margin over simulated energy, 0 to 1,000 |
| Solana | `maxComputeUnitPrice` | 10,000,000 micro-lamports (`DEFAULT_MAX_COMPUTE_UNIT_PRICE`) | The highest priority price signed |
| TON | `maxNetworkFee` | 1 GRAM (basechain), 100 GRAM (masterchain) | The highest network fee an estimate accepts |
| Avalanche X and P | `maxFee` | 0.1 AVAX | The highest fee signed |
| Avalanche P | `maxGasPrice` | 10,000 | The highest gas price signed |

The defaults stop an absurd fee, not an expensive one: set each bound to your fee policy.

## Environment variables

The environment carries **routing only**, never keys, mnemonics or signers:

```sh
CRYPTO_AIO_ETHEREUM_NETWORK=sepolia
CRYPTO_AIO_ETHEREUM_PROVIDER=alchemy            # a configured provider's name
CRYPTO_AIO_BITCOIN_RPC_URL=https://esplora.internal/api   # wrapped as a Secret
CRYPTO_AIO_BITCOIN_INDEXER_URL=https://esplora.internal/api
CRYPTO_AIO_STAGING_ETHEREUM_NETWORK=hoodi       # read when CRYPTO_AIO_ENV=staging
```

| Variable | Sets |
| --- | --- |
| `CRYPTO_AIO_<CHAIN>_NETWORK` | The network |
| `CRYPTO_AIO_<CHAIN>_LIBRARY` | The library |
| `CRYPTO_AIO_<CHAIN>_PROVIDER` | A provider by name; wins over `RPC_URL` |
| `CRYPTO_AIO_<CHAIN>_RPC_URL` | One RPC endpoint, as a `Secret` |
| `CRYPTO_AIO_<CHAIN>_INDEXER_URL` | One indexer endpoint, as a `Secret` |
| `CRYPTO_AIO_ENV` | The profile: `CRYPTO_AIO_<PROFILE>_<CHAIN>_…` wins over the unprofiled variable |

`<CHAIN>` is the chain id in upper case, with every other character as `_`:
`CRYPTO_AIO_AVALANCHE_X_RPC_URL`. Pass `env: false` to a container to ignore the environment.
