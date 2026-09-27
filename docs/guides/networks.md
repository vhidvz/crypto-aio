---
summary: How chain families and networks are supported, how to write a family plugin and driver, how to test it, and what is stable before 1.0.
---

# Using any blockchain network

crypto-aio reaches a network through a **chain family plugin**. The plugin contributes data:
chains, networks, native assets, tokens and provider presets. It also contributes one
**adapter manifest** per SDK, whose `load()` pulls in the **driver**. The core holds no chain
data and imports no SDK. There are three ways a network becomes available.

## 1. Built-in families

| Family | Chains (networks) | Ordering | Status |
| --- | --- | --- | --- |
| fake | `fakechain`, `fakeexpiry`, `fakeseqno` (`local`) | nonce, expiry, seqno | **Works today**, from `crypto-aio/testing` (register `fakePlugin()`) |
| EVM (ethers, web3) | Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base | nonce | **Works today**, built in ([details](#evm-networks)) |
| UTXO (bitcoinjs-lib + Esplora) | Bitcoin mainnet, testnet, testnet4, signet, regtest | inputs | Planned, Plan 3 |
| Tron (tronweb) | mainnet, shasta, nile | expiry | Planned, Plan 4 |
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | Planned, Plan 5 |
| TON (@ton/ton) | mainnet, testnet | seqno + expiry | Planned, Plan 6 |

Plans 3 to 6 are the next roadmap milestones (see the [status](./index.md#status)); a planned
chain fails with `ConfigError` (`CONFIG_INVALID`, "unknown chain"). Built-in families, today
the EVM family, register in the package's composition root. Install only the SDK you use
(`npm install crypto-aio ethers`); a missing one fails with `DEPENDENCY_MISSING`.

### EVM networks

One EVM driver serves every chain below, with either library: `ethers` (v6, the default) or
`web3` (v4). ChainSafe sunset web3.js in 2025, and 4.16.0 is its last release, with no
further fixes. crypto-aio keeps it working and tested, but prefer `ethers` for new work.
[Sending and receiving](./transactions.md) covers EVM [fees](./transactions.md#fees),
replacements, [token verdicts and proofs](./transactions.md#waiting-and-watching) and
[scans](./transactions.md#receiving); [Keys, signers and secrets](./security.md) covers the
ethers and web3 clients.

| Chain | Networks (chain id) | Fees | Finality | Replace / cancel |
| --- | --- | --- | --- | --- |
| `ethereum` | `mainnet` (1), `sepolia` (11155111), `hoodi` (560048) | `evm-1559` | `finalized` tag | yes |
| `bsc` | `mainnet` (56), `testnet` (97) | `evm-legacy` (the base fee is always 0) | `finalized` tag | yes |
| `polygon` | `mainnet` (137), `amoy` (80002) | `evm-1559`; mainnet tips at least 25 gwei | `finalized` tag | yes |
| `avalanche` | `mainnet` (43114), `fuji` (43113) | `evm-1559` | the `latest` block is final | yes |
| `arbitrum` | `mainnet` (42161), `sepolia` (421614) | `evm-1559` | `finalized` tag | no: there is no mempool |
| `optimism`, `base` | `mainnet` (10, 8453), `sepolia` (11155420, 84532) | `evm-1559` plus an `l1-data` charge | `finalized` tag | yes |

- **Tokens.** ERC-20 only. USDT (Ethereum, Avalanche) and USDC (every built-in mainnet but
  BNB Smart Chain) resolve by alias on mainnet, where their issuers deploy them natively. Any
  other token resolves by contract, with its symbol and decimals read from the chain.
- **Presets.** `alchemy` and `infura` serve every network above; `ankr` the Ethereum, BNB
  Smart Chain, Avalanche, Arbitrum and Base mainnets; `public` the networks whose chain
  documents a public endpoint (not Ethereum). The public Base, Arbitrum and OP Sepolia
  endpoints may refuse Node's `fetch` (a Cloudflare 403, seen as `PROVIDER_UNAVAILABLE`).
- **Not in this release:** address history (it needs an indexer; `history()` throws
  `UNSUPPORTED_CAPABILITY`), contract calls other than ERC-20 `transfer`, and `ext.evm`
  beyond `getNonce`.

## 2. More networks of an existing family

A family driver is written once, and every chain and network it serves is data: a
`ChainInfo` with its `NetworkInfo` entries (identity, fee model, `FinalityPolicy`, default
confirmations, `reorgWindow`, replacement rules, explorer templates), plus provider presets
that map `(chain, network, apiKey)` to endpoints. So an EVM chain needs no new adapter.

`evmChainPlugin` from `crypto-aio/evm` serves your EVM chains with the built-in driver, for
both libraries. It checks the data when called, or throws `CONFIG_INVALID`: family `evm`,
nonce ordering, the `secp256k1-ecdsa` scheme, and per network the decimal chain id as
`identity`, an `evm-1559` or `evm-legacy` fee model, and `finalized`-tag or confirmation
finality. A network removes the capabilities it lacks: `finality-tag` without the tag,
`fee-market-1559` on `evm-legacy`, and `replace-fee` and `cancel` without a mempool.
Optional network `params` describe the chain further: `minPriorityFeePerGas` (a bigint tip
floor), `l1DataFee: 'op-stack'` (transactions also pay an OP Stack L1 data fee), and
`systemLogs: 'bor'` (a bor client's system logs on every receipt, as on Polygon PoS, which
a plain transfer then ignores).

```ts
import { CryptoAio, type ChainInfo } from 'crypto-aio';
import { evmChainPlugin } from 'crypto-aio/evm';

const acme: ChainInfo = {
  id: 'acmechain', family: 'evm', model: 'account', ordering: 'nonce', schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'ACME', decimals: 18 }, defaultNetwork: 'mainnet',
  networks: {
    mainnet: {
      id: 'mainnet', identity: '777', testnet: false, feeModel: 'evm-1559', // eth_chainId 777
      finality: { kind: 'confirmations', confirmations: 12 },
      capabilities: { remove: ['finality-tag'] }, // no `finalized` tag on this chain
      defaultConfirmations: 1, reorgWindow: 128, replacement: { minBumpPercent: 10 },
    },
  },
};
const aio = new CryptoAio({ plugins: [evmChainPlugin({ name: 'acme', chains: [acme] })] });
```

It registers as `evm:acme` and also takes `presets` and `assets`. Augment `ChainRegistry`
with `acmechain: { family: 'evm'; network: 'mainnet' }` to type the handle and `ext.evm`.

The registry rules that apply today already set the limits. A chain id registers once (a
second registration fails with `CONFIG_INVALID`, "already registered"), so nobody can add a
network to an existing chain id from outside. A plugin can add a new chain id, and it can add
presets, or adapters for another library, to chains that are already registered.

## 3. A new family: the plugin API

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

### The driver

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

## Testing an adapter or a store

The testing kit makes everything deterministic and network-free:

- `FakeFetch` scripts JSON-RPC and REST replies (`route`, `rpcResult`, `rpcError`, `hang`)
  and records calls. Pass `transport: { fetch: fake.fetch }` to a `CryptoAio`.
- `FakeClock` with `drive(clock, promise)` controls time: retries, timeouts and polling.
- `FaultyOperationStore` injects crashes at write boundaries, and `createFakeEnv().restart()`
  simulates a new process.

`createFakeEnv()` runs the fake family only. To test your own adapter, script its node with
`FakeFetch`, drive time with `FakeClock`, and register your plugin. The RPC method names
below are the acme driver's own:

```ts
import { CryptoAio } from 'crypto-aio';
import { FakeClock, FakeFetch, drive, rpcResult } from 'crypto-aio/testing';

it('reads a balance through the acme driver', async () => {
  const clock = new FakeClock();
  const node = new FakeFetch().route('https://acme.test', (request) => {
    const { method } = request.json<{ method: string }>();
    if (method === 'acme_chainId') return rpcResult(request, '0x2a'); // identity probe
    if (method === 'acme_blockNumber') return rpcResult(request, '0x10'); // height probe
    if (method === 'acme_getBalance') return rpcResult(request, '0x64');
    throw new Error(`unexpected ${method}`);
  });
  const aio = new CryptoAio({
    env: false,
    clock,
    plugins: [acmePlugin()],
    transport: { fetch: node.fetch },
    providers: { acme: { endpoints: [{ name: 'main', url: 'https://acme.test' }] } },
    chains: { acmechain: { provider: 'acme' } },
  });
  const bc = aio.blockchain({ chain: 'acmechain' });
  const balance = await drive(clock, bc.getBalance(someAcmeAddress));
  expect(balance.amount.base).toBe(100n);
  await aio.close();
});
```

Every store must pass the contract suites. They take your framework's `describe` and `it`,
so they run under Jest, Vitest or `node:test`. Each `create()` must return a fresh, empty
store, such as a new schema or key prefix per test:

```ts
import {
  describeCursorStoreContract, describeLockManagerContract,
  describeOperationStoreContract, describeSequenceStoreContract,
} from 'crypto-aio/testing';

const api = { describe, it };
describeOperationStoreContract(api, async () => ({ operations: await pgOperations(), advance: sleep }));
describeLockManagerContract(api, async () => ({ locks: await redisLocks(), advance: sleep }));
describeSequenceStoreContract(api, async () => ({ sequences: await redisSequences() }));
describeCursorStoreContract(api, async () => ({ cursors: await pgCursors() }));
```

`advance(ms)` moves the store's notion of time forward: a fake clock, or a real sleep. The
suites include stale-worker cases. A worker pauses, its lease expires, another takes over,
and the stale write must fail with `FENCING` or `VERSION_CONFLICT`. crypto-aio ships only the
store ports, the in-memory stores and these suites. Durable stores, such as Redis or
Postgres, are yours to write, and the suites define what they must do.

One expectation reaches beyond the suites, which test one store instance: `findByRef` is
read-your-writes consistent across every process that shares the store. It sees any
`appendAttempt` another instance committed before the call, so no read replica or
eventually consistent index may serve it. The guard that stops two Operations from
recording the same transaction relies on it. Its guarantee also assumes that `appendAttempt`
completes within `lifecycle.leaseMs`, since the ref lease is not renewed. A slower store
weakens it.

Never store a key set to `undefined` as a value, such as `NULL`, whether it is in an
`OperationStore` patch or in an observation:

- In an `update` or `appendAttempt` patch, the stored field keeps its value. Only `clear`
  removes a field.
- `putObservation` replaces the whole observation, so a field that is left out or set to
  `undefined` reads back `undefined` (never `null`). The core relies on this to clear a
  stale failure reason or an orphaned block.

## What is stable before 1.0

crypto-aio is pre-1.0 (`0.x`). Breaking changes can happen in a minor release, and they are
listed in the changelog. Recent changes are an example: `Transfer` became a union
with an unresolved-asset variant, `TERMINAL_STATES` became an array, and `Scanner` became a
type-only export (get a scanner from `bc.scanner()`).

| Surface | Expectation |
| --- | --- |
| Handle and container API, configuration shape, `Amount` / `Address` / asset model, error codes, event names and payloads, store ports and their contract suites | Intended to stay; changes only for real-adapter findings |
| Driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverContext` | **Likely to change** while real families are added. It changed recently (`ProofSource.blockHash`, `createNativeClient` returning `{ client, close? }`) and has open questions, such as how drivers get token decimals |
| Family `ext` APIs and fee override shapes | Defined by each family's adapter |
| `crypto-aio/testing` | Public and documented; the fake chain's wire protocol is not an API |
| `crypto-aio/native` | **Outside semver.** The SDK's API is the SDK's |
