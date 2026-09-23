# Blockchain Adapter Layer — Design Spec

- **Date:** 2026-09-23
- **Status:** Approved in brainstorming (sections 1–4); pending written-spec review
- **Target release:** `crypto-aio@0.1.0` (breaking)
- **Runtime:** Node.js ≥ 20, backend only

## 1. Purpose

`crypto-aio` becomes a blockchain abstraction layer for exchanges, wallets, payment systems and infrastructure platforms. It offers one consistent, type-safe API over several chain families, SDKs, providers, wallets and signers. It keeps chain-specific behaviour explicit (capabilities, typed extensions) instead of flattening it into inaccurate generic APIs.

### Success criteria

1. `Blockchain.create({ chain, network, library, provider, wallet })` → `getBalance`, `transfer`, `waitForConfirmation` work identically in shape across EVM, Tron, Bitcoin, Solana and TON.
2. The core (`src/core/**`) imports no blockchain SDK; SDKs are optional peer dependencies loaded lazily.
3. Library, provider, wallet, signer, chain and network are independently selectable at runtime, globally, and per scope, with a documented precedence.
4. Transfers are idempotent, crash-safe (write-ahead of signed transactions) and safe under concurrent/distributed workers (leases + fencing).
5. Transaction lifecycle distinguishes pending / included / final / failed / dropped / replaced / expired / reorged, and survives process restarts.
6. The whole library is testable without network access; guarantees (fencing, crash recovery, reorgs) are covered by deterministic tests.
7. README is concise (~150 lines) and practical; depth lives in `docs/guide/`.

## 2. Integration matrix

Every library from the original candidate list has an explicit status.

| Candidate library | Status | Notes |
|---|---|---|
| `ethers` (v6) | **Supported** | EVM driver strategy (default for EVM) |
| `web3` (v4) | **Supported** | EVM driver strategy |
| `tronweb` (v6) | **Supported** | Tron driver |
| `bitcoinjs-lib` (v6/v7) | **Supported** | UTXO driver; network access via an Esplora-compatible indexer provider |
| `@solana/web3.js` (v1) | **Supported** | Solana driver. `@solana/kit` is a possible future second Solana library |
| `@tonconnect/sdk` | **Replaced** by `@ton/ton` + `@ton/core` | TonConnect is a dApp↔user-wallet connection protocol, not a node SDK. It could later be modelled as a remote **Signer**, not a driver |
| `@avalabs/avalanchejs` | **Deferred** | Only needed for Avalanche X/P chains. Avalanche **C-Chain is supported** via the EVM driver |
| `@bnb-chain/javascript-sdk` | **Unsupported** | Targets BNB Beacon Chain (sunset 2024). **BNB Smart Chain is supported** via the EVM driver |

A `Library` constant replaces the old `CurrencyLib` idea:

```ts
export const Library = {
  ETHERS: 'ethers', WEB3: 'web3', TRONWEB: 'tronweb', BITCOINJS_LIB: 'bitcoinjs-lib',
  SOLANA_WEB3_JS: '@solana/web3.js', TON: '@ton/ton',
} as const;
```

### Built-in chains and networks

| Chain id | Family | Networks | Native asset |
|---|---|---|---|
| `ethereum` | evm | mainnet (1), sepolia (11155111), hoodi (560048) | ETH |
| `bsc` | evm | mainnet (56), testnet (97) | BNB |
| `polygon` | evm | mainnet (137), amoy (80002) | POL |
| `avalanche` (C-Chain) | evm | mainnet (43114), fuji (43113) | AVAX |
| `arbitrum` | evm | mainnet (42161), sepolia (421614) | ETH |
| `optimism` | evm | mainnet (10), sepolia (11155420) | ETH |
| `base` | evm | mainnet (8453), sepolia (84532) | ETH |
| `tron` | tron | mainnet, shasta, nile | TRX |
| `bitcoin` | utxo | mainnet, testnet, testnet4, signet, regtest | BTC |
| `solana` | solana | mainnet, devnet, testnet | SOL |
| `ton` | ton | mainnet, testnet | TON |

EVM chains share one driver, but each network keeps its own registry identity: chain id, native asset, fee model (EIP-1559 vs legacy), finality support (`finalized` tag or confirmations), default confirmations, explorer URL templates, capability overrides, and replacement constraints. No chain gets its own adapter just because it has a different name.

## 3. Current state and migration

The current `v0.0.3` code has `CryptoAio` → `Ethereum` / `Tronix` with `account` / `contract` / `transact` sub-objects, `instanceof`-based switching between web3 and ethers, env-var config (`CRYPTO_AIO_[ENV_]<NET>_<KEY>`), `debug` logging and an `EventEmitter`. Most write paths throw "not implemented". `EthereumContract.estimateGas` is broken. `account.create` emits private keys through the emitter. Tests hit live Sepolia only.

What is kept: the `CryptoAio` name (now the container), the env-var profile idea (`CRYPTO_AIO_ENV`), lazy construction, `debug`-based default logging, and the events concept (now typed, and without secrets).

What is removed: `Ethereum`, `Tronix`, `*Account`, `*Contract`, `*Transact`, `src/tool/*`, `src/type/*`. `CHANGELOG.md` gets a migration note.

## 4. Architecture

### Layers and dependency rule

```
src/
  index.ts          composition root: public API, built-in manifests, family typing
  native.ts         `crypto-aio/native` escape hatch
  core/             NO SDK imports, NO imports from adapters/ or testing/
    model/          Chain/Network/Asset/Amount/Address/Fee/Transaction/Status/Capability
    registry/       chains, networks, assets, adapter manifests, provider presets, signature schemes
    config/         config types, env source, resolution/precedence, validation
    container/      CryptoAio, scopes, default container, configure()
    blockchain/     immutable Blockchain handle (facade)
    driver/         ChainDriver ports, AdapterManifest, DriverContext, retry classes
    transport/      Transport, endpoint pool, retry, rate limit, circuit breaker, health, SDK bridges
    signing/        Signer port, scheme registry, local signer, HD, orchestrator, verification
    lifecycle/      Operation engine, records, state machines, recovery, monitor
    ordering/       sequence coordination (locks, fencing), UTXO reservation
    observe/        scanner, cursor, address history
    store/          store ports + in-memory implementations
    errors/ events/ secret/ util/
  adapters/         one directory per family; each may import its SDK (lazily loaded)
    evm/ tron/ utxo/ solana/ ton/
  testing/          FakeChain, fake driver manifest, FakeRpcTransport, store contract suites
```

- `src/core/**` must not import `src/adapters/**` or `src/testing/**`, or any SDK. An ESLint `no-restricted-imports` rule and a test enforce this.
- Adapters depend on core ports only. The composition root (`src/index.ts`) registers built-in **manifests**. A manifest is static metadata plus `load()`. Only `load()` pulls in the adapter module and, with it, the SDK.

### Patterns

| Pattern | Where |
|---|---|
| Adapter | Drivers translate SDK behaviour into core ports |
| Strategy | EVM `EvmClient` (ethers vs web3); coin selection; fee speed policies |
| Registry | chains, networks, assets, manifests, provider presets, signature schemes |
| Factory | `CryptoAio.blockchain()` / `Blockchain.create()` build handles from resolved config |
| DI / composition root | `CryptoAio` container owns stores, signers, wallets, hooks and the driver pool |
| Flyweight | driver/transport pool shared by identical (chain, network, library, provider) keys |
| State machine | Operation and Attempt lifecycles |

## 5. Public API

### 5.1 Container and handles

```ts
import { Blockchain, configure, CryptoAio, localSigner, secret } from 'crypto-aio';

configure({                                            // default container
  providers: { alchemy: { apiKey: secret(process.env.ALCHEMY_KEY!) } },
  signers:   { 'hot-1': localSigner({ secp256k1: secret(process.env.HOT_KEY!) }) },
  wallets:   { 'wallet-main': { signer: 'hot-1', tier: 'hot' } },
});

const eth = Blockchain.create({ chain: 'ethereum', network: 'mainnet', library: 'ethers',
                                provider: 'alchemy', wallet: 'wallet-main' });

const tenant = new CryptoAio({ namespace: 'tenant-a', providers: {...}, signers: {...}, wallets: {...},
                               stores: {...}, hooks: {...} });
const eu  = tenant.scope({ providers: {...} });        // child container; inherits, overrides
const btc = eu.blockchain({ chain: 'bitcoin' });
const w3  = eth.with({ library: 'web3' });             // NEW immutable handle; `eth` unchanged
```

- `Blockchain.create(cfg)` is `defaultContainer.blockchain(cfg)`. `configure()` mutates only the default container.
- `new CryptoAio()` is isolated. It gets its own driver pool, stores, signers, wallets and hooks, and does **not** inherit from the default container. It only shares built-in registry data and non-secret env config. This is the recommended form for multi-tenant deployments.
- `container.scope(overrides)` creates a child. Config merges over the parent's, and the child shares the parent's driver pool and stores unless it overrides them.
- `namespace` prefixes every store key (idempotency keys, locks, cursors), so tenants can share one database without collisions.
- A `Blockchain` handle is immutable. `with(partial)` returns a new handle. Operations capture a frozen `ExecutionContext` at creation. Later `with()` calls or config changes never affect them.
- `await bc.ready()` loads the adapter eagerly and validates providers. Otherwise loading happens lazily on first use. `container.close()` releases the pool.

### 5.2 Handle methods

All methods are async unless noted.

| Area | Methods |
|---|---|
| Introspection (sync) | `chain`, `network`, `library`, `config` (frozen, redacted), `supports(cap)`, `capabilities` |
| Addresses | `validateAddress(a)`, `normalizeAddress(a)` → `Address`, `addressFromPublicKey(pk, opts?)`, `deriveAddress(wallet, index)` (`hd-public-derivation`), `generateAccount()` → `{ address, publicKey, privateKey: Secret }` |
| Assets | `resolveAsset(ref)` → `AssetInfo`, `getBalance(address, asset?)` → `Balance`, `getBalances(address, assets)` |
| Fees | `estimateFee(intent)` → `FeeEstimate` |
| Write | `transfer(intent, opts?)` → `Submission`, `prepareTransfer(intent, opts?)` → `PreparedOperation`, `submitSignatures(opId, sigs)`, `abandon(opId)` (only before `signed`), `broadcast(raw)` (bare broadcast with no Operation), `replace(opId, {fee})`, `cancel(opId)`, `retry(opId)`, `getOperation(opId)` |
| Tx / status | `getTransaction(id)` → `Transaction \| null`, `getTransactionStatus(id)` → `TxStatus`, `waitForConfirmation(ref, opts?)`, `watch(ref)` → `AsyncIterable<TxStatusEvent>` |
| Chain | `getBlockHeight()`, `getBlock(ref)`, `getNetworkStatus()` (heights, finalized height, endpoint health) |
| Observation (capability) | `scanner(opts)` (`block-scan`), `history(address, opts)` (`address-history`) |
| Extensions | `ext` — typed per family, e.g. `ext.evm`, `ext.utxo`, `ext.tron`, `ext.solana`, `ext.ton` |

On the container: `operations.recover()`, `operations.list(filter)`, `monitor.start({ signal, workerId })`, `on(event, handler)`, `use(plugin)`, `close()`.

### 5.3 Transfer intent and amounts

```ts
type TransferIntent = {
  to?: string; amount?: AmountInput;                 // shorthand for a single output
  outputs?: { to: string; amount: AmountInput }[];   // >1 needs 'batch-transfer' (UTXO has it)
  asset?: AssetRef | string;                         // default 'native'; string = alias in this chain/network
  from?: string;                                     // default: wallet address
  memo?: string;                                     // requires 'memo'
  fee?: 'slow' | 'normal' | 'fast' | FeeOverride;    // FeeOverride is family-typed
};
type AmountInput = bigint /* base units */ | string /* decimal display units */ | Amount;
```

- `bigint` always means base units. A `string` is always a decimal in display units, parsed **after** asset resolution using that asset's decimals. A JS `number` throws `InvalidAmountError`.
- If a string has more fractional digits than the asset's decimals, `InvalidAmountError` is thrown. Nothing is ever rounded or truncated.
- Passing an `Amount` whose asset differs from the intent's asset throws.
- Token decimals come from the asset registry. If they aren't there, an on-chain lookup runs and the result is cached per (chain, network, contract). They are never assumed.
- `transfer` options: `{ idempotencyKey?, wallet?, signer?, confirmations? }`. If `idempotencyKey` is omitted, a random one is generated. The container option `requireIdempotencyKey: true` makes it mandatory, which is the recommended setting for exchanges.

`Submission = { operationId, idempotencyKey, attempt: AttemptRef, state, wait(opts?) }` where
`AttemptRef = { id, idKind: 'tx-hash' | 'txid' | 'signature' | 'message-hash', canonical: boolean }`.
`canonical: false` means the id is not the final protocol transaction hash. This happens on TON, where the id is the external message hash. Once included, the resolved canonical hash appears in the Attempt's observation (`txHash`). `waitForConfirmation` and `getTransactionStatus` accept either form.

### 5.4 Configuration and precedence

From most specific to least:

1. Per-call options (`{ confirmations: 12 }`)
2. Handle options (`Blockchain.create` / `container.blockchain` / `with`)
3. Scope chain (child → parent → …)
4. Container config (`configure()` for the default container)
5. Environment (non-secret only). Env is read once per container at creation:
   `CRYPTO_AIO_ENV` selects a profile.
   `CRYPTO_AIO_[PROFILE_]<CHAIN>_{NETWORK|LIBRARY|PROVIDER|RPC_URL|INDEXER_URL}`, with `<CHAIN>` in upper snake case (e.g. `ETHEREUM`).
   Env never supplies private keys or mnemonics. Signers are always explicit code.
6. Built-in registry defaults (network `mainnet`, library = the family default).

Merge rules: plain objects merge per key. Arrays are replaced whole. `undefined` is ignored. Resolution happens when the handle is created and yields a frozen `ResolvedConfig`.

Validation uses static manifests only, so no SDK is loaded:
- Unknown chain, network, library, provider, wallet or signer → `ConfigError`.
- An incompatible pair (e.g. `tronweb` × `ethereum`) → `ConfigError` with the supported alternatives listed.
- A wallet whose signer lacks the schemes the chain needs → `ConfigError`.

Calling an operation the resolved handle does not support throws `UnsupportedCapabilityError` (category `unsupported`). It can never be confused with a `ConfigError`.

### 5.5 Capabilities, extensions, escape hatch

- `Capability` is a string-literal union that plugins can extend: `tokens`, `memo`, `batch-transfer`, `replace-fee`, `cancel`, `block-scan`, `address-history`, `finality-tag`, `hd-public-derivation`, `contract-read`, `fee-market-1559`, `expiry`.
- Capabilities are computed from the manifest, the network registry and the **resolved providers**. For example, EVM has no `address-history` unless an indexer provider is configured.
- `ext.<family>` holds a small, stable, capability-gated API for real needs: `ext.evm.readContract`, `ext.evm.erc20(address)`, `ext.evm.getNonce`; `ext.utxo.listUnspent`, `ext.utxo.coinSelection`; `ext.tron.getResources`; `ext.solana.getTokenAccounts`; `ext.ton.getSeqno`, `ext.ton.jettonWallet`. `ext` is not meant to mirror the SDKs.
- Escape hatch: `import { native } from 'crypto-aio/native'; native(bc, 'ethers')`. It returns the SDK client typed through the augmentable `NativeClientMap`, which each adapter subpath populates. It throws if the handle uses another library. It is documented as outside semver guarantees and never reachable from the handle itself.

### 5.6 Typing

```ts
export interface ChainRegistry {          // augmentable by plugins (declaration merging)
  ethereum: { family: 'evm'; network: 'mainnet' | 'sepolia' | 'hoodi' };
  bitcoin:  { family: 'utxo'; network: 'mainnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest' };
  // …
}
export interface FamilyRegistry {         // populated in the composition root with SDK-free types
  evm:  { library: 'ethers' | 'web3'; ext: EvmExt; fee: EvmFeeDetails };
  utxo: { library: 'bitcoinjs-lib'; ext: UtxoExt; fee: UtxoFeeDetails };
  // …
}
Blockchain.create<C extends ChainId>(cfg: HandleConfig<C>): Blockchain<C>;
// HandleConfig<C> narrows `network` and `library` to what C supports; bc.ext is typed by family.
```

Ext and fee detail types contain no SDK types, so they are always available. SDK types appear only in `NativeClientMap` augmentations inside adapter subpaths.

## 6. Domain model (core, SDK-free)

### 6.1 Registries

- `ChainInfo { id, family, model: 'account' | 'utxo', nativeAsset, ordering: OrderingModel, schemes: SignatureSchemeId[], networks }`
- `NetworkInfo { id, chainId?, genesisHash?, testnet, feeModel, finality: FinalityPolicy, defaultConfirmations, explorer?: { tx, address }, replacement?: { minBumpPercent }, capabilities?: { add?, remove? } }`
- `FinalityPolicy = { kind: 'confirmations', n } | { kind: 'tag', tag: 'finalized', fallbackConfirmations } | { kind: 'solidified' } | { kind: 'commitment', level: 'finalized' } | { kind: 'masterchain' }`
- `AdapterManifest { family, library, chains: ChainId[], capabilities, requiresIndexer?: boolean, peerDependencies: { name, range }[], load(): Promise<DriverFactory> }`

### 6.2 Assets

- **Identity** (authoritative): `AssetId`, a canonical string bound to one chain and network:
  `ethereum:mainnet/native`, `ethereum:mainnet/erc20:0xdAC17F…` (checksummed), `tron:mainnet/trc20:TR7N…`, `solana:mainnet/spl:<mint>`, `ton:mainnet/jetton:<master raw address>`.
- **Metadata** (display only): `{ symbol, decimals, name? }`.
- `AssetInfo = { id: AssetId, ref: AssetRef, metadata }`. `AssetRef = 'native' | { standard: 'erc20'|'trc20'|'spl'|'jetton', contract }`.
- Aliases (`'USDT'`) resolve only within the handle's (chain, network). Registering a duplicate alias throws. An ambiguous or unknown alias throws `AssetResolutionError`. Nothing resolves across chains.
- Built-in registry: native assets plus well-known USDT/USDC on mainnets, with contracts verified during implementation. Users call `container.assets.register(...)`.

### 6.3 Amount

`Amount { base: bigint; asset: AssetInfo }`, immutable, with `format()`, `toDecimalString()`, arithmetic only between identical `AssetId`s, and `compare`. Pure bigint math, never floating point.

### 6.4 Address

`Address { canonical: string; display: string; chain: ChainId; variant?: Record<string, unknown> }`. Equality uses `canonical`. `format(options?)` renders the variants.

| Family | canonical | variants |
|---|---|---|
| EVM | EIP-55 checksum | — |
| Tron | base58 `T…` | `hex` (41-prefixed) |
| UTXO | address string (bech32 lowercase / base58) | `type`: p2pkh / p2sh / p2wpkh / p2wsh / p2tr |
| Solana | base58 public key | — |
| TON | raw `0:<hex>` | `bounceable`, `testOnly`, `urlSafe`; friendly form preserved in `display` |

For TON, the intent's `to` variant decides bounce behaviour. The driver never silently changes it.

### 6.5 Fees

```ts
type FeeEstimate = {
  kind: 'evm-1559' | 'evm-legacy' | 'utxo' | 'tron' | 'solana' | 'ton' | string;
  speed: 'slow' | 'normal' | 'fast' | 'custom';
  charges: { amount: Amount; label: 'network' | 'rent' | 'attached' | 'priority' | string }[];
  bound: 'exact' | 'expected' | 'upper';
  payer?: Address;
  details: FamilyFeeDetails;   // e.g. { maxFeePerGas, maxPriorityFeePerGas, gasLimit } / { satPerVByte, vsize }
};
```

Each charge names its asset, and a charge may be zero (e.g. Tron with staked energy). There is no single "native gas" number. The `total(assetId)` helper sums charges per asset.

### 6.6 Transactions and transfers

Three different facts are kept apart and never collapsed into one mutable object:

- **Raw**: `RawTx { encoding: 'hex' | 'base64' | 'json'; data: string }`. Protocol bytes or protocol JSON (e.g. a PSBT, or a JSON-RPC receipt), never SDK objects.
- **Identity**: `AttemptRef` (§5.3), deterministic from the signed payload.
- **Observation**: canonical inclusion facts (`txHash`, `blockHash`, `blockHeight`, `confirmations`, `finality`), which can change under reorgs.

```ts
type Transaction = {
  id: string; chain; network;
  status: TxStatus;
  block?: { height: bigint; hash: string; timestamp?: number };
  fee?: Amount[];
  transfers: Transfer[];
  decoding: 'complete' | 'partial' | 'none';
  raw?: RawTx;
  details: FamilyTxDetails;   // e.g. EVM nonce/gasUsed/revertReason; UTXO vin/vout; TON trace info
};
type Transfer = {
  id: string;                 // deterministic: `${txId}:${locator}`
  from: Address[];            // account chains: 1 entry; UTXO: input addresses (may be empty for coinbase)
  to: Address; asset: AssetInfo; amount: Amount;
  source: 'native' | 'token-event' | 'internal';
  memo?: string;
};
```

Locators: EVM `native` or `log:<logIndex>`; UTXO `vout:<n>`; Tron `native` or `log:<i>`; Solana `ix:<outer>[.<inner>]`; TON `msg:<index>`.

`decoding: 'partial'` means value movement may exist that was not decoded. Examples: an EVM transaction that executed contract code, where internal ETH transfers need traces; a Solana transaction where parsed transfers don't reconcile with balance deltas; a TON transaction whose message trace hasn't been followed to completion.

### 6.7 Status and finality

```ts
type TxState = 'unknown' | 'pending' | 'mempool' | 'included' | 'final'
             | 'failed' | 'dropped' | 'replaced' | 'expired'
             | 'rejected';   // Attempts only: every broadcast target definitively refused it
type TxStatus = { state: TxState; confirmations: number; blockHash?: string; blockHeight?: bigint;
                  finality: 'none' | 'probabilistic' | 'final'; reason?: string; replacedBy?: string };
```

`reorged` is an **event** (`tx.reorged`), not a terminal state. A reorged transaction returns to `mempool` or `pending`.

## 7. Adapter contract

```ts
interface DriverFactory { create(ctx: DriverContext): Promise<ChainDriver> }
interface DriverContext {
  chain: ChainInfo; network: NetworkInfo; library: LibraryId;
  transport: Transport;              // core-owned, policy-wrapped
  indexer?: Transport;               // present when an indexer provider is configured
  assets: AssetResolver; clock: Clock; log: Logger; config: FamilyConfig;
}
interface ChainDriver {
  readonly ordering: OrderingModel;          // see §8.5
  readonly capabilities: ReadonlySet<Capability>;
  address: AddressCodec;                     // validate, normalize, fromPublicKey(pk, opts)
  reader: ChainReader;                       // balance, height, block, transaction, status, tokenMetadata
  builder: TxBuilder;                        // estimateFee, build(intent, ctx) → UnsignedTx,
                                             // assemble(unsigned, signatures) → SignedTx { raw, ref }
  broadcaster: Broadcaster;                  // broadcast(signed) → { accepted | alreadyKnown | rejected(reason) }
  sequence?: SequenceSource;                 // pending nonce / seqno (nonce & seqno models)
  replacement?: ReplacementPolicy;           // buildReplacement / buildCancel; absent ⇒ not supported
  scanner?: BlockSource;                     // 'block-scan'
  history?: AddressHistorySource;            // 'address-history'
  ext: unknown;                              // family ext implementation (typed via FamilyRegistry)
  native(): unknown;                         // SDK client for crypto-aio/native only
  close?(): Promise<void>;
}
type UnsignedTx = {
  payload: RawTx;                            // serializable (EVM unsigned RLP, PSBT, Tron raw_data, Solana message, TON cell BOC)
  signingRequests: SigningRequest[];
  ordering: OrderingData;                    // nonce / seqno / inputs / expiry
  fee: FeeEstimate; summary: IntentSummary;  // decoded outputs for signing context
};
```

Drivers never hold keys and never sign. Drivers are shared across tenants, so they hold no wallet, tenant or operation state. The only exception is caches of immutable chain data such as token metadata and genesis hashes.

### Retry classes

Every port method is tagged, and the transport and Operation engine honour the tag:

| Class | Methods | Behaviour |
|---|---|---|
| `safe` | reads; rebroadcast of stored raw | retried with backoff; failover allowed |
| `ambiguous-on-failure` | first broadcast of an Attempt | transport failure ⇒ the outcome is **ambiguous**; the Attempt is treated as possibly sent; never rebuilt |
| `never-auto` | build+sign a new Attempt, replace, cancel, retry | never retried automatically; only an explicit API call triggers it |

## 8. Transaction lifecycle

### 8.1 Records

```ts
type OperationState = 'created' | 'prepared' | 'awaiting-signature' | 'signed' | 'submitted'
                    | 'included' | 'final' | 'failed' | 'expired';
type OperationRecord = {
  id; namespace; idempotencyKey; intentHash;        // sha256 of the canonicalized intent
  context: ExecutionContext;                        // frozen: chain, network, library, providerSetId,
                                                    //   wallet, signerId, configHash
  kind: 'transfer';
  state: OperationState; outcome?: 'executed' | 'cancelled';
  unsigned?: UnsignedTx;                            // persisted at 'prepared' / 'awaiting-signature'
  attempts: AttemptRecord[];                        // append-only
  activeAttemptId?: string;
  version: number; claim?: { workerId; token: bigint; until: number };
  error?: SerializedError; createdAt; updatedAt; nextCheckAt?;
};
type AttemptRecord = {                              // IMMUTABLE after insertion
  id; ref: AttemptRef; raw: RawTx; ordering: OrderingData; fee: FeeEstimate;
  purpose: 'original' | 'replacement' | 'cancel' | 'rebuild'; supersedes?: string; createdAt;
};
type AttemptObservation = {                         // mutable, versioned, stored separately per attempt
  attemptId; state: TxState; txHash?; blockHash?; blockHeight?; confirmations; lastSeenAt; version;
};
```

### 8.2 Operation state machine

```
created ─▶ prepared ─▶ awaiting-signature ─▶ signed ─▶ submitted ─▶ included ─▶ final (outcome)
   │           │                │              │           │            │
   └──▶ failed (definitive rejection before any Attempt exists)        └─▶ (reorg) submitted
submitted/included ─▶ failed (reverted, proven) | expired (proven) | final(outcome=cancelled)
```

| Transition | Persisted atomically | Crash here ⇒ recovery does |
|---|---|---|
| → `created` | create-if-absent on (namespace, idempotencyKey) | resume from `created` |
| → `prepared` | `unsigned` payload | rebuild is allowed (nothing signed yet) |
| → `awaiting-signature` | `unsigned` + pending signer ticket | wait for `submitSignatures` |
| → `signed` | `appendAttempt(op, attempt, {state: signed})` (single write) | **rebroadcast stored raw**; never re-sign |
| → `submitted` | state only, after broadcast accepted / alreadyKnown / ambiguous | poll status; rebroadcast if absent |
| → `included` / `final` | observation + state | continue monitoring |

Invariants:
- Signed bytes are persisted before any broadcast. An Attempt is never re-signed.
- A terminal state requires proof. Timeouts and "not found" are never terminal. Proof means one of:
  - a reverted receipt or on-chain failure
  - provable expiry
  - a finality threshold
  - a definitive rejection before any Attempt exists
  - a **safe broadcast rejection** (below)
- A **safe broadcast rejection** means every broadcast target definitively refused the Attempt, and a follow-up lookup of its `AttemptRef` finds it neither in the mempool nor on-chain. Only then is the Attempt marked `rejected` and its ordering slot released (§8.5), so any future transaction is mutually exclusive with it. The Operation then becomes `failed`, and its raw is never broadcast again.
  - "Nonce too low" / "already spent" are **not** treated as rejections until the lookup rules out that this very Attempt was already accepted, which is possible after recovery or with fan-out.
- Operation state and Attempt observations recover independently. Recovery reconstructs the Operation's state from its Attempts' observations.

### 8.3 `transfer()` algorithm

1. Resolve the asset, validate addresses and amounts, compute `intentHash`.
2. `store.create(op)`. If the key already exists: same `intentHash` → return the existing Operation's `Submission` (kicking a rebroadcast if an Attempt is non-terminal); different hash → `IdempotencyConflictError`.
3. If the ordering model needs coordination, acquire the lease for `(namespace, chain, network, from)` and **allocate** an ordering slot (§8.5).
4. Estimate the fee, then `builder.build(intent, { from, ordering, fee })` → `UnsignedTx`. Persist `prepared`. The unsigned payload records the reserved slot.
5. Run the `beforeSign` hooks (veto point). A veto → `failed` (`POLICY_REJECTED`) and the slot is released. Call the signer(s) (§9). If the result is `pending`, persist `awaiting-signature` (the reservation stays with the Operation), release the lease, and return.
6. Verify every signature against its expected public key. Call `builder.assemble` → `SignedTx { raw, ref }`.
7. `appendAttempt` → `signed` (atomic, fenced).
8. Broadcast (`ambiguous-on-failure`).
   - Accepted or `alreadyKnown` → `submitted`.
   - Ambiguous → `submitted` with the `ambiguous` flag set; the returned error has `ambiguous: true`.
   - Definitive refusal → apply the safe-broadcast-rejection check (§8.2). If it passes → Attempt `rejected`, slot released, Operation `failed` with the mapped code (`INSUFFICIENT_FUNDS`, `FEE_TOO_LOW`, `NONCE_CONFLICT`, …). If it does not pass → `submitted` (it was ours all along).
9. Release the lease. Return the `Submission`.

### 8.4 Idempotency

- The key is unique per container namespace. The canonical intent hash covers the chain, network, asset id, outputs, memo, from and fee policy.
- A repeated call returns the same Operation, whatever state it is in.
- A broadcast of stored raw bytes may be repeated safely at any time. "Already known", "duplicate" or "transaction already in chain" responses are success.

### 8.5 Ordering models and coordination

`OrderingModel` is chain-specific. The core only uses it for two questions: does this need the address lease, and is a new Attempt mutually exclusive with the earlier ones.

| Model | Chains | Lease | Exclusivity of a new Attempt |
|---|---|---|---|
| `nonce` | EVM | yes | same nonce |
| `seqno` + expiry | TON | yes | same seqno, or all prior `valid_until` passed |
| `inputs` | UTXO | yes (serializes coin selection) | spends ≥ 1 same input (RBF) |
| `expiry` | Tron (`expiration`), Solana (`lastValidBlockHeight`) | no | all prior Attempts provably expired and not found |

Ports:

```ts
interface LockManager {
  acquire(key: string, owner: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<Lease | null>;
  release(lease: Lease): Promise<void>;
}                                              // Lease { key, owner, token: bigint /* strictly increasing per key */, expiresAt }
type SequenceState = { next: bigint; released: bigint[]; fence: bigint; version: number };
interface SequenceStore {
  get(key: string): Promise<SequenceState | null>;
  put(key: string, state: Omit<SequenceState, 'version'>, expectedVersion: number | null): Promise<void>;
  // rejects when state.fence < stored fence, or on version mismatch
}
```

Nonce procedure (EVM), run under the lease. The core implements it as a `SequenceCoordinator` over the two ports:
- **allocate:** `chainPending = sequence.pending(address)`. Drop released values below `chainPending`, since those were consumed. Pick the smallest remaining released value if there is one, else `max(next, chainPending)`, and advance `next` past it. Persist with the lease token. A reservation is thereby committed as soon as the unsigned payload is prepared. This keeps async (`awaiting-signature`) Operations from colliding with later ones.
- **release(n):** add `n` to `released` (fenced). This happens on veto, on safe broadcast rejection, or on `abandon(opId)`, which is allowed only before `signed`.
- A released nonce below outstanding ones leaves later transactions stuck. The monitor detects this gap (chain pending nonce < lowest outstanding reservation) and emits `nonce.gap`. The next allocation for that address fills it with that transfer. The library never invents a filler transaction.

Seqno procedure (TON): an external message is valid only for the wallet's *current* seqno, so messages for the next seqno can't be pre-signed. Allocation succeeds only when no earlier Attempt of the wallet is still pending (it is included, rejected or expired). Otherwise it throws `SEQUENCE_BUSY` (retryable, category `state`). Throughput scales with batching (`batch-transfer`: v4r2 up to 4 outputs, v5r1 up to 255) or with more wallets.

Stale-worker protection: every store write that affects ordering or Operation state carries the lease or claim token. When a paused worker resumes after its lease expired and another worker took over, its writes fail with `FencingError`. The contract suites verify this.

UTXO reservation: coin selection excludes inputs referenced by non-terminal Operations of the same wallet, meaning their unsigned payloads or non-terminal Attempts (read from the `OperationStore`). Combined with the lease, this prevents concurrent double selection. Inputs of a `rejected` Attempt or an abandoned Operation become selectable again.

### 8.6 Replace, cancel, retry

- `replace(opId, { fee })` and `cancel(opId)` require the `replace-fee` or `cancel` capability respectively (`driver.replacement`). Unsupported families throw `UnsupportedCapabilityError`.
- EVM: replacement uses the same nonce with higher fees. `NetworkInfo.replacement.minBumpPercent` is a configurable default (10, matching common txpool rules) and is **not** a universal EVM rule. Cancel is a *conflicting* zero-value self-transfer with the same nonce. The Operation ends `final` with `outcome: 'cancelled'` only if the cancel Attempt finalizes. If the original lands instead, the outcome is `executed`.
- UTXO: replacement is BIP125 RBF over the same inputs with a higher fee. Cancel is an RBF back to the wallet's own change address, with the same outcome semantics. Attempts signal RBF by default (configurable).
- Tron, Solana, TON: there is no replace or cancel. When an Attempt provably expires, the Operation becomes `expired`. `retry(opId)` creates a `rebuild` Attempt only after re-verifying expiry. The library never retries on its own; that decision is application policy.
- When one Attempt of an Operation finalizes, all sibling Attempts are marked `replaced` (`replacedBy`).

### 8.7 Recovery

`container.operations.recover({ signal })` claims non-terminal Operations and acts per §8.2: rebroadcast stored raw, poll status, resolve TON message hashes, re-check expiry. Recovery uses the Operation's frozen `ExecutionContext`. If the referenced provider set is gone, the current handle config for that chain and network is used for reads and broadcasts (these are safe). If the signer is needed and missing, the Operation stays put and an event is emitted.

### 8.8 Monitoring, reorgs, drops

- `waitForConfirmation(ref, { confirmations?, finality?: 'included' | 'final', timeoutMs?, signal? })` polls in-process. It writes observations when the ref belongs to an Operation. The default target is the network's `defaultConfirmations`. On timeout it throws `TimeoutError` (`ambiguous: false`, `retryable: true`); the transaction state is unchanged.
- `container.monitor.start({ workerId, signal, pollIntervalMs })` runs a background loop over `OperationStore.claimDue(workerId, now, leaseMs, limit)`. Several stateless workers can share the work. Claims are fenced by token.
- **Reorgs:** an observation stores the `blockHash` of inclusion. If a later poll finds a different `blockHash`, or the transaction is missing while the chain height has moved past the inclusion height, the monitor emits `tx.reorged` and resets the observation to `mempool`/`pending`.
- **Dropped:** a transaction not found after `droppedGracePeriodMs` **and** whose ordering slot is still free (nonce/seqno not consumed, inputs unspent) is marked `dropped`. The monitor then rebroadcasts the stored raw (`safe`). If the ordering slot was consumed by another transaction, the Attempt is `replaced` (external replacement), and the Operation is examined for which Attempt, if any, won.
- **Height-monotonic guard:** observations come from endpoints whose height is ≥ the last observed height minus the tolerance. A lagging endpoint can never produce a false reorg, drop or expiry.
- **Finality** follows the network's `FinalityPolicy`. `final` is reached only when the policy is satisfied. Exchanges should credit on `final`.

## 9. Signing

```ts
interface Signer {
  readonly id: string;
  readonly schemes: readonly SignatureSchemeId[];
  getPublicKey(scheme: SignatureSchemeId, keyRef?: KeyRef): Promise<Uint8Array>;
  sign(requests: SigningRequest[], ctx: SigningContext): Promise<SigningResult>;
}
type SigningRequest = { id: string; scheme: SignatureSchemeId; payload: Uint8Array;
                        payloadKind: 'digest' | 'message'; publicKey: Uint8Array; keyRef?: KeyRef;
                        params?: { tweak?: Uint8Array } };
type SigningResult = { status: 'signed'; signatures: { requestId: string; bytes: Uint8Array; recovery?: number }[] }
                   | { status: 'pending'; ticket?: string };
type SigningContext = { operationId; namespace; chain; network; wallet; tier?; summary: IntentSummary;
                        fee: FeeEstimate; unsignedHash: string };      // never secrets, never SDK objects
```

- **Wallets:**
  ```ts
  type WalletConfig = { signer?: string; signers?: Record<string /* keyRef id */, string /* signer id */>;
    address?: string; xpub?: string; keyRef?: KeyRef; tier?: string; chains?: ChainId[];
    utxo?: { addressType?: 'p2wpkh' | 'p2sh-p2wpkh' | 'p2pkh' | 'p2tr'; changeAddress?: string };
    ton?: { version: 'v4r2' | 'v5r1'; workchain?: 0 | -1 } };
  ```
  A wallet without a signer is watch-only: `transfer` → `SIGNER_UNAVAILABLE`, while `prepareTransfer` and `submitSignatures` still work (cold and offline flows).
- **Scheme registry** (open, string ids): `secp256k1-ecdsa` (65-byte r‖s‖v), `secp256k1-schnorr` (BIP340, optional `tweak`), `ed25519`. Each scheme provides `verify()` and a public-key format. Drivers declare the schemes they need; signers declare the schemes they support; a mismatch is a `ConfigError`.
- **Built-in signers:**
  - `localSigner({ secp256k1?: Secret, ed25519?: Secret })`.
  - `localSigner.fromMnemonic(secret(phrase), opts)`. This uses BIP32 for secp256k1 and SLIP-10 for ed25519, via `@scure/bip32` / `@noble/hashes`. The derivation path comes from the wallet's `keyRef.path`, with chain defaults (60′, 195′, 84′, 501′, 607′).
  - `callbackSigner(fn)`, the base for remote, KMS, HSM and MPC integrations.
- **Multiple and partial signatures:** requests are batched per signer. When requests route to several signers (keyRef → signer mapping on the wallet), results are merged. `submitSignatures(opId, sigs)` accepts partial sets; the Operation moves to `signed` only when every request has been satisfied.
- **Verification:** the core verifies each signature against the request's public key before assembling. A mismatch throws `SigningError` (`code: SIGNATURE_MISMATCH`).
- **Policy hook:** `hooks.beforeSign(ctx)` can throw to veto. Wallet `tier` is metadata passed through to the context only, with no built-in behaviour. Withdrawal limits, approvals, treasury rules and accounting live in the application.
- **HD deposit addresses:** `wallet: { xpub }` together with `bc.deriveAddress(wallet, index)` covers the `hd-public-derivation` capability (secp256k1 families: EVM, Tron, UTXO). The ed25519 families (Solana, TON) require a signer that holds the seed.

## 10. Observation

These are three separate roles:

- **Provider**: endpoints only, each `kind: 'rpc' | 'indexer'`.
- **Reader**: point queries (`ChainReader`).
- **Scanner**: reorg-aware sequential sync (`BlockSource`). **Address history** (`AddressHistorySource`) is indexer-backed.

Scanning and finality are independent. A chain may support status lookups and finality without a linear block scanner; TON is the example.

```ts
const scanner = bc.scanner({ cursorKey: 'deposits', from: 'latest' | height,
                             mode: 'final' | 'head', filter?: { addresses?: string[]; assets?: AssetRef[] } });
for await (const ev of scanner) {           // at-least-once
  if (ev.type === 'block') handle(ev.block, ev.transactions);
  else /* 'rollback' */ revert(ev.to, ev.removed);
  await ev.ack();                           // commits the cursor
}
```

- `CursorStore` persists `{ height, hash, recent: {height, hash}[] }`, where `recent` holds the last *N* blocks and N is the network's finality depth. On restart the scanner re-validates `recent` against the canonical chain and emits `rollback` for any divergence. This does not depend on earlier in-memory delivery.
- `mode: 'final'` emits only finalized blocks, so no rollbacks happen. This is simplest for crediting. `mode: 'head'` emits unfinalized blocks and may roll back.
- Transfer ids are deterministic (§6.6), so consumers can dedupe on them under at-least-once delivery.

## 11. Providers and transport

- **Provider config:** a named preset (`public`, `alchemy`, `infura`, `ankr`, `trongrid`, `blockstream`, `mempool`, `toncenter`) plus credentials, or a custom `{ endpoints: [{ url: string | Secret<string>, kind, headers?, priority?, weight?, rateLimit?, timeoutMs? }] }`. A handle's `provider` may be a name, an inline config, or an array (failover order). URL templates for presets are verified during implementation. `public` endpoints log a warning and are not for production.
- **Transport** (`core/transport`) sits under every SDK:
  - per-request timeout (`AbortSignal`)
  - retry by retry class, with exponential backoff, full jitter and `Retry-After`
  - token-bucket rate limit per endpoint
  - circuit breaker per endpoint (closed → open → half-open probe)
  - endpoint selection by priority, then health score
  - broadcast fan-out option (`broadcast.fanout: n`, safe because the raw bytes are the same)
- **Semantic health:**
  - Each endpoint must pass an **identity check** before first use: EVM `eth_chainId`; UTXO genesis block hash; Solana `getGenesisHash`; Tron block 0 hash; TON config/global id. A mismatch disables the endpoint and emits `provider.misconfigured`.
  - Health also tracks error rate, latency and **height lag** relative to the best known height. An endpoint beyond `maxLagBlocks` is excluded from monitor and scanner reads.
- **SDK bridges.** SDKs never see real URLs or API keys; secrets stay in the transport.

| SDK | Hook |
|---|---|
| ethers | subclass `JsonRpcApiProvider`, override `_send(payload)` → transport (batches passed through) |
| web3 | EIP-1193 provider object `{ request({ method, params }) }` → transport |
| tronweb | `HttpProvider` subclass whose `request()` → transport (full node, solidity node, event server) |
| @solana/web3.js | `new Connection(placeholderUrl, { fetch })` → transport |
| @ton/ton | `new TonClient({ endpoint: placeholder, httpAdapter })` → transport |
| UTXO (Esplora) | direct REST via transport |

If a hook proves unusable for a given SDK version, the fallback is to wrap each driver operation with the same retry/timeout/failover policy. Behaviour stays the same; only the granularity changes.

## 12. Stores

All stores are ports with in-memory defaults (`core/store/memory`). Contracts:

| Port | Required guarantees |
|---|---|
| `OperationStore` | create-if-absent on (namespace, idempotencyKey); CAS `update(id, patch, expectedVersion, fence?)`; atomic `appendAttempt(id, attempt, patch, expectedVersion, fence?)`; `putObservation(attemptId, obs, expectedVersion)`; `claimDue(workerId, now, leaseMs, limit)` issues strictly increasing claim tokens; `findByAttemptRef`; `list(filter)` |
| `LockManager` | mutual exclusion per key while unexpired; strictly increasing `token` per key across acquisitions; `renew` fails after expiry or takeover |
| `SequenceStore` | `put` rejects when `fence` < stored fence or on version mismatch; `released` round-trips exactly |
| `CursorStore` | CAS on version |

`crypto-aio/testing` exports `describeOperationStoreContract(factory)`, `describeLockManagerContract(factory)`, `describeSequenceStoreContract(factory)` and `describeCursorStoreContract(factory)`. These are framework-agnostic test suites that take `describe`/`it`/`expect` adapters. They include stale-worker scenarios: a worker pauses, its lease expires, another worker takes over, and the stale write must fail. Redis and Postgres implementations are out of scope; the contracts define them.

## 13. Errors

`CryptoAioError extends Error { code; category; retryable; ambiguous; context; cause? }`

- `category`: `config | unsupported | validation | provider | chain | signing | state | timeout`.
- `context`: redacted `{ chain, network, library, endpointId, operationId, attemptId }`.

| Category | Codes (initial set) |
|---|---|
| config | `CONFIG_INVALID`, `DEPENDENCY_MISSING` (with an install hint), `INCOMPATIBLE_SELECTION` |
| unsupported | `UNSUPPORTED_CAPABILITY` |
| validation | `INVALID_ADDRESS`, `INVALID_AMOUNT`, `ASSET_RESOLUTION`, `INVALID_INTENT` |
| provider | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_MISCONFIGURED`, `RPC_ERROR` |
| chain | `INSUFFICIENT_FUNDS`, `NONCE_CONFLICT`, `FEE_TOO_LOW`, `TX_REJECTED`, `TX_REVERTED`, `TX_EXPIRED` |
| signing | `SIGNER_UNAVAILABLE`, `SIGNING_FAILED`, `SIGNATURE_MISMATCH`, `POLICY_REJECTED` |
| state | `IDEMPOTENCY_CONFLICT`, `FENCING`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, `SEQUENCE_BUSY` |
| timeout | `TIMEOUT` |

Drivers map SDK and RPC errors to these codes and keep the original as `cause`. `ambiguous: true` means the outcome is unknown; the caller retries with the **same** idempotency key.

## 14. Observability and secrets

- **Typed events** via `container.on(...)`: `rpc.request`, `rpc.response`, `rpc.error` (method, endpoint id, latency, byte size; **no params or results**), `provider.health`, `provider.misconfigured`, `operation.state`, `attempt.state`, `tx.reorged`, `nonce.allocated`, `signer.requested`, `signer.completed`, `scanner.block`, `scanner.rollback`.
  - Every event carries `namespace`, `operationId` / `attemptId` where applicable, and a timestamp.
  - Raw signed transactions, signatures and signing payloads are never emitted.
- **Logger:** `Logger` port with a default `debug('crypto-aio:*')` implementation. OpenTelemetry integration goes through hooks, so there is no OTel dependency.
- **`Secret<T>`:**
  - `secret(value)` returns an object whose `toString`, `toJSON` and `util.inspect.custom` produce `[REDACTED]`.
  - `reveal()` is explicit.
  - Provider URLs and headers containing secrets are redacted in errors, config snapshots and events via `redact()`.
  - Private keys exist only inside `localSigner` closures. `generateAccount()` returns the key wrapped in `Secret`.

## 15. Family specifics

| | EVM (ethers \| web3) | UTXO / Bitcoin (bitcoinjs-lib + Esplora) | Tron (tronweb) | Solana (@solana/web3.js v1) | TON (@ton/ton) |
|---|---|---|---|---|---|
| Model / ordering | account / `nonce` | utxo / `inputs` | account / `expiry` | account / `expiry` | account / `seqno` + expiry |
| Fee kind | `evm-1559` or `evm-legacy` per network; bound `upper` (max) with `expected` detail | `utxo` sat/vB × vsize; `exact` once built | `tron` bandwidth/energy; charge may be 0 TRX; `feeLimit` bounds TRC-20 | `solana` base + priority; **ATA rent** as a separate charge | `ton` forward+gas; jetton `attached` value with refunded excess → `upper` |
| Signing requests | 1 × `secp256k1-ecdsa`, keccak digest | 1 per input: ecdsa (BIP143) or schnorr + tweak (p2tr); payload is a **PSBT** | 1 × `secp256k1-ecdsa` over txID | 1 per required signer, `ed25519` over message | 1 × `ed25519` over signing cell hash |
| AttemptRef | `tx-hash` after signing (canonical) | `txid` before signing for segwit inputs (canonical) | `tx-hash` (txID) before signing (canonical) | `signature` after signing (canonical) | `message-hash` after signing (**not canonical**; tx hash resolved later) |
| Finality | `finalized` tag where supported, else N confirmations | N confirmations (probabilistic) | solidified block | `finalized` commitment | masterchain inclusion **and** completed message trace |
| Replace / cancel | yes / yes | yes / yes (RBF) | no / no | no / no | no / no |
| Block scan | yes (native + ERC-20 logs); contract execution ⇒ `partial` | yes (Esplora block txs) | yes | yes (by slot; skipped slots handled) | **no** (sharded) |
| Address history | only with indexer provider | yes (Esplora) | yes (TronGrid) | yes (`getSignaturesForAddress`) | yes (toncenter) |
| Tokens | ERC-20 | — | TRC-20 | SPL classic (Token-2022 ⇒ `UNSUPPORTED_CAPABILITY`) | Jetton |
| Memo | — | — (OP_RETURN deferred) | yes (`raw_data.data`) | yes (Memo program) | yes (text comment) |

Per-family notes:

- **EVM.** `EvmDriver` holds all EVM logic: intent → tx request, fee policy, ERC-20 encoding, receipt/log decoding, status mapping. It calls a narrow `EvmClient` strategy (`call`, `estimateGas`, `feeHistory`/`gasPrice`, `getTransactionCount`, `sendRawTransaction`, `getBlock`, `getTransaction`, `getReceipt`, `getLogs`, `serializeUnsigned`, `unsignedHash`, `serializeSigned`). `EthersClient` and `Web3Client` implement it, so both libraries share every behaviour and are tested with the same fixtures.
- **UTXO.** Address types: p2wpkh (default), p2sh-p2wpkh, p2pkh, p2tr. Coin selection strategies: `accumulative` (default) and `all` (sweep); pluggable. Change goes to the wallet's change address (configurable). The ECC backend for bitcoinjs-lib is implemented over `@noble/curves` (no WASM). `prepareTransfer` exposes the PSBT (base64) for cold or hardware signing, and `submitSignatures` also accepts a signed PSBT. The indexer provider is **required**.
- **Tron.** The default expiration is 60 s, configurable. Energy for TRC-20 is estimated via `triggerConstantContract`. Finality compares the transaction's block with the latest solidified block. A TronGrid API key goes in the transport headers (Secret).
- **Solana.** Transfers use SystemProgram and SPL `transferChecked`. `createAssociatedTokenAccountIdempotent` is added when the recipient's ATA is missing, and its rent is shown as a charge. These instructions are built without `@solana/spl-token`. Decoding uses `jsonParsed` including inner instructions, and the result is checked against pre/post balances: a mismatch ⇒ `partial`.
- **TON.** Wallet contract version (`v4r2` | `v5r1`) and workchain are wallet config, because they determine the address. The first send from an uninitialized wallet includes `stateInit`. The Attempt id is the TEP-467 normalized external message hash. The canonical transaction hash is resolved through the indexer (message → transaction) and stored in the observation. Jetton transfers are `final` only when the trace completes without bounce; a bounce ⇒ `failed` with the reason.

## 16. Packaging and build

- One package, `crypto-aio`. `exports`: `.`, `./evm`, `./utxo`, `./tron`, `./solana`, `./ton`, `./testing`, `./native` (CJS + `.d.ts`; `typesVersions` for older resolvers).
- Hard `dependencies`: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `debug`.
- Optional `peerDependencies` (`peerDependenciesMeta.*.optional = true`): `ethers@^6`, `web3@^4`, `tronweb@^6`, `bitcoinjs-lib@^6 || ^7`, `@solana/web3.js@^1.98`, `@ton/ton@^15`, `@ton/core`. Exact ranges are settled during implementation against current releases. All of them are also `devDependencies` for tests.
- If a lazy load fails because the SDK is missing ⇒ `DEPENDENCY_MISSING` with the exact install command.
- Build: `tsc` → CommonJS (the existing setup), `target` raised to ES2020 (bigint), `engines.node >= 20`. Typedoc output moves from `docs/` to `docs/api/`, so it no longer wipes `docs/guide` or `docs/superpowers`.

## 17. Testing

- **Framework:** Jest + ts-jest (existing). The 1 h global timeout and `dotenv` auto-loading in `jest.setup.js` are removed. Unit tests make no network calls; a guard fails any test that tries.
- **Core unit tests:**
  - config precedence and conflicts
  - amount and asset rules
  - address value objects
  - redaction (including `util.inspect` and JSON)
  - error mapping
  - transport (retry classes, backoff with a fake clock, `Retry-After`, circuit breaker, rate limiting, failover, identity mismatch, height-lag exclusion)
  - Operation engine with **crash injection** at every persistence boundary in §8.2, asserting recovery never re-signs and never loses a signed transaction
  - idempotency conflict and replay
  - fencing, including the **stale worker** case
  - the monitor with a fake chain: reorg, drop → rebroadcast, external replacement, expiry, finality policies
  - scanner restart and rollback reconstruction from persisted cursor state
- **Testing kit** (`crypto-aio/testing`): `FakeChain`, a deterministic account and UTXO simulator with mempool, blocks, fork/reorg injection and endpoint lag; a `fake` driver manifest; `FakeRpcTransport` (scripted JSON-RPC/REST); the store contract suites.
- **Adapter tests:** the real SDKs run against `FakeRpcTransport` fixtures.
  - **Deterministic vectors:** a known key and intent produce known unsigned payloads, signing digests and signed raw bytes. They are cross-checked against each SDK's native signing where available.
  - `EthersClient` and `Web3Client` pass the same EVM suite.
- **Integration (opt-in):** `CRYPTO_AIO_INTEGRATION=1` runs read-only testnet checks. `CRYPTO_AIO_INTEGRATION_WRITE=1` additionally enables funded transfer tests.
- **CI:** a new workflow on push and PR runs install → lint → typecheck → unit tests (no network). The release workflow keeps publish, runs the same checks, and no longer depends on `.env`.

## 18. Documentation

- **`README.md`** (~150 lines):
  - what it solves (3 lines)
  - install: core plus **only the SDK you need**, e.g. `npm i crypto-aio ethers`
  - quick start
  - global, scoped and runtime config (`configure`, `new CryptoAio`, `with`)
  - a multi-chain example
  - the integration matrix (supported / replaced / deferred / unsupported)
  - extending: a short example each for an adapter, provider preset and signer
  - links to the guides
- **`docs/guide/`:** `architecture.md`, `configuration.md`, `transactions.md` (Operations, Attempts, idempotency, ids per chain, replace/cancel semantics), `exchange-operations.md` (deposits, scanning, finality, reconciliation, multi-process), `stores.md` (contracts), `writing-adapters.md`, `security.md`.
- **Typedoc** for the API reference (`docs/api/`).
- **`CHANGELOG.md`** with 0.1.0 migration notes.

## 19. Security cleanup

- `.env` is tracked and pushed to the public repository with testnet private keys, mnemonics and a provider token. The following are done as part of this work: `git rm --cached .env`, add `.env` to `.gitignore`, add `.env.example` (new variable names, no values).
- **Owner actions (not done by this work):** rotate the provider tokens; treat the keys and mnemonics as compromised; decide on a history rewrite. There will be no force-push.

## 20. Out of scope

- Avalanche X/P chains (`@avalabs/avalanchejs`), BNB Beacon Chain, TonConnect-as-driver
- Solana durable nonces, Token-2022 extensions, `@solana/kit` driver
- EVM traces (internal transfers); ERC-4337 / sponsored transactions (the fee model allows them later)
- Bitcoin OP_RETURN memo, multisig wallets, Litecoin/Dogecoin networks (the UTXO family allows them later)
- Concrete Redis/Postgres/KMS/HSM/MPC implementations (ports and contracts only)
- Automatic fee-bump or retry policies; withdrawal limits, approvals, treasury and accounting

## 21. Risks and assumptions

- **SDK hook stability.** The bridges in §11 rely on documented or semi-internal extension points (ethers `_send`, the TronWeb `HttpProvider` subclass). The mitigation is the operation-level wrapping fallback in §11, with each bridge covered by adapter tests.
- **SDK APIs** are validated against the installed versions during implementation. Ranges in §16 may be adjusted.
- **Provider preset URL templates and built-in token contract addresses** must be verified from official sources during implementation. Anything unverified is left out rather than guessed.
- **TON transaction resolution and trace completion** depend on indexer (toncenter v3) capabilities. Without an indexer, TON Attempts stay at `submitted`/`included` without a trace-based `final`, and the documentation says so.
