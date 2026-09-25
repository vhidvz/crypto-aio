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
| EVM (ethers, web3) | Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base | nonce | Planned, Plan 2 |
| UTXO (bitcoinjs-lib + Esplora) | Bitcoin mainnet, testnet, testnet4, signet, regtest | inputs | Planned, Plan 3 |
| Tron (tronweb) | mainnet, shasta, nile | expiry | Planned, Plan 4 |
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | Planned, Plan 5 |
| TON (@ton/ton) | mainnet, testnet | seqno + expiry | Planned, Plan 6 |

Plans 2 to 6 are the next roadmap milestones (see the [status](./index.md#status)). Planned
families will register themselves in the package's composition root. You will install only
the SDK you use, for example `npm install crypto-aio ethers`. A missing SDK then fails with
`DEPENDENCY_MISSING` and the install command. Today, the list of built-in plugins is empty.
Asking for a planned chain fails with `ConfigError` (`CONFIG_INVALID`, "unknown chain").

## 2. More networks of an existing family (planned with the EVM adapter)

A family driver is written once, and every chain and network it serves is data: a
`ChainInfo` with its `NetworkInfo` entries. That data holds the chain id or genesis identity,
the fee model, the `FinalityPolicy`, the default confirmations, `reorgWindow`, replacement
rules and explorer templates. Provider presets map `(chain, network, apiKey)` to endpoints.
An EVM-compatible chain therefore needs no new adapter. It needs chain and network data, a
manifest entry that lists the chain for the EVM libraries, and presets.

> **Shape of the API once the adapter ships (planned).** The EVM adapter's release decides
> how you point the built-in EVM driver at a chain of your own, for example by exposing its driver factory or
> a chain builder.

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
Plugins go on a root container only. A second plugin with a name already registered is
ignored silently, so give each plugin a unique name. A plugin may also
bring `assets` (tokens with aliases, per chain and network) and `schemes`. The built-in
schemes are `secp256k1-ecdsa`, `secp256k1-schnorr` and `ed25519`.

**The reference implementation is the fake family**: `src/testing/fake-plugin.ts` (plugin and
manifest) and `src/testing/fake-driver.ts` (the driver). Read them next to this section.

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
  exception. When
  endpoints disagree, the transport throws a retryable `PROVIDER_INCONSISTENT`, and the core
  decides nothing.
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
