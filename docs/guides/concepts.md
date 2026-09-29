---
summary: The vocabulary of crypto-aio, with a small example for each term.
---

# Core concepts

This page defines the terms the other guides use. The examples use a fake-chain handle
`bc = env.bc` from `createFakeEnv()`; wrap each awaited call in `env.run(...)`, as the
[tutorial](./tutorial.md) shows. Real-network examples use the EVM family.

## The layers

```text
 your application (exchange, wallet, payment system)
      |  bc.transfer()  bc.scanner()  aio.monitor  aio.on()
      v
 Blockchain handle ........ immutable: chain + network + library + provider + wallet
      |
      v
 engine / monitor / scanner ... Operations, Attempts, leases, evidence, scan cursors
      |       \---> signers (hold the keys) and stores (operations, locks, sequences, cursors)
      v
 driver ................... one per chain family and library, loaded lazily
      |
      v
 transport ................ timeouts, retries by class, rate limits, circuit breaker,
      |                     health and identity checks, proof quorum, redaction
      v
 provider endpoints (RPC and indexer URLs)
```

The **engine** runs a transfer: it prepares, signs, stores and broadcasts. The **monitor**
follows Operations after broadcast, and the **scanner** reads blocks for deposits. The core
never imports a blockchain SDK. Only drivers do, and they are loaded on first use.

## Chain, network and library

A **chain** is a blockchain id from the registry. A **network** is one of its deployments.
A **library** is the SDK the driver uses. A handle is bound to one of each. The built-in
chains are the EVM chains, such as `ethereum` with `mainnet` and `ethers`, plus `bitcoin`,
`tron` and `solana`; the fake chains come from `crypto-aio/testing`.

```ts
[bc.chain, bc.network, bc.library]; // ['fakechain', 'local', 'fake-sdk']
```

## Provider and transport

A **provider** is a named set of endpoints, or a preset name plus an API key. A handle may
list several providers for failover. The **transport** is the core-owned HTTP layer under
every driver. It applies timeouts, retries by retry class, rate limits, a circuit breaker per
endpoint, health and identity checks, and quorum reads for proofs. SDKs never see real URLs.
An endpoint more than `maxLagBlocks` behind the best known height is lagging, and the
monitor and scanner never decide anything from a view that far behind. The tolerance comes
from `chains.<id>.maxLagBlocks`, then the root `transport.maxLagBlocks`, then the network's
own value, then the built-in default of 5. The BSC, Arbitrum, OP and Base mainnets set about
60 s of blocks (134, 240, 30 and 30); set your own for fast testnets with several endpoints.

A proof read needs `proofQuorum` endpoints (2 by default) to agree. The quorum's size counts
every endpoint not proven to serve another network, including lagging ones, ones whose
identity is not yet confirmed and ones whose circuit breaker is open, so one endpoint never
proves a fact alone while the others are only briefly unavailable. That costs liveness:
proofs wait at startup, while an honest endpoint's breaker is briefly open, and for about
three health intervals (`healthIntervalMs`, 15 s by default) after an endpoint stops
answering its probes or its requests; then it stops counting. A recovering endpoint is tried
alongside the others and can only block a proof; once it answers, it rejoins at the next
health refresh, if its probes answer; the next proof read triggers that refresh. With two
endpoints both must answer, and once one stops counting the other proves alone, so use three
or more endpoints for production proofs.

```ts
const aio = new CryptoAio({
  providers: { node: { endpoints: [{ name: 'main', url: secret('https://node.example/KEY') }] } },
  transport: { timeoutMs: 15_000, maxAttempts: 3, proofQuorum: 2 }, // root container only
  chains: { fakechain: { provider: 'node', maxLagBlocks: 10 } },
});
```

## Wallet, signer and address

A **wallet** is named configuration that says which key sends. It can name a signer, give a
public key only (watch-only), or give an xpub for deposit addresses. A **signer** is the only
place private keys live (see [Keys, signers and secrets](./security.md)). An **`Address`** is
bound to one chain. Compare addresses with `canonical` or `equals()`, and show `display`.

```ts
const { signer } = localSigner.generate({ curves: ['secp256k1'], id: 'hot' });
const wallets = { main: { signer: 'hot', tier: 'hot' }, cold: { publicKey: '02ab…' } };
const me = await bc.walletAddress(); // an Address; me.canonical === 'fk1…'
```

`bc.deriveAddress(wallet, index)` derives deposit addresses from a wallet's `xpub` (with
`xpubPath`, default `0/{index}`, and `xpubVersions` for formats other than `xpub` and `tpub`).
On UTXO chains, a key whose version is a Bitcoin SLIP-0132 version (mainnet `xpub`/`ypub`/
`zpub`/`Ypub`/`Zpub`, test `tpub`/`upub`/`vpub`/`Upub`/`Vpub`) must match the network: a
mainnet key on a test network, or a test key on mainnet, is refused with `CONFIG_INVALID`.
Versions outside that table, including custom `xpubVersions` that are not in it, are not
checked. Account-model chains (EVM, Tron) accept an `xpub` on every network, as their wallets
export it. A private extended key (`xprv`, `tprv`, `zprv` and the rest) is refused with
`CONFIG_INVALID` as soon as the wallet is used, and the message never repeats it.

## Asset and Amount

An **asset** is identified by an `AssetId` string bound to one chain and network, such as
`fakechain:local/native`. Token ids look like `ethereum:mainnet/erc20:0xdAC17F…`. The
`metadata` (`symbol`, `decimals`) is for display only. An alias resolves only within the
handle's chain and network. An **`Amount`** is an exact, non-negative quantity of one asset, in base units, as a bigint.
When you pass an amount (`AmountInput`):

- a `bigint` means base units;
- a `string` means decimal units, parsed with the asset's decimals, never rounded;
- a JS `number` is rejected with `INVALID_AMOUNT`.

```ts
const fake = await bc.resolveAsset('native'); // FAKE has 8 decimals
Amount.parse('0.001', fake).base; // 100_000n
await bc.transfer({ to, amount: 100_000n }); // 0.001 FAKE
await bc.transfer({ to, amount: '0.001' }); // the same amount
```

## Capability

A **capability** is a named feature that a handle may support, such as `replace-fee`,
`block-scan`, `tokens` or `address-history`. It comes from the adapter, the network and the
configured providers. An unsupported call throws `UnsupportedCapabilityError`
(`UNSUPPORTED_CAPABILITY`). `KNOWN_CAPABILITIES` lists the built-in names. On fakechain,
`bc.supports('replace-fee')` is `true` and `bc.supports('tokens')` is `false`.

## Container, scope and handle

- The **container** (`CryptoAio`) owns configuration, stores, signers, hooks, plugins, the
  driver pool and the event bus. Separate `new CryptoAio()` instances share only the built-in
  registry data. Use one per tenant, each with its own `namespace`. `configure()` sets up
  the default container behind `Blockchain.create()`.
- A **scope** (`aio.scope(overrides)`) inherits the container's configuration and overrides
  parts of it. It shares the container's pool and stores, so it is not a tenant boundary.
- A **handle** (`Blockchain`) is frozen. `with()` returns a new handle. Each Operation also
  stores a frozen copy of its context, so later changes never affect it.

```ts
const tenant = new CryptoAio({ namespace: 'tenant-a', plugins: [fakePlugin()] /* … */ });
const eu = tenant.scope({ wallets: { payouts: { signer: 'hot' } } });
const bc = eu.blockchain({ chain: 'fakechain', wallet: 'payouts' }); // bc.with() copies it
```

## Configuration precedence

The most specific value wins: **call > handle > scope > root > env > built-ins**.

1. Call options, such as `waitForConfirmation(id, { confirmations: 12 })`.
2. Handle options: `aio.blockchain(…)`, `Blockchain.create(…)` or `with(…)`.
3. Scopes, the child before its parent.
4. The root container: `new CryptoAio(…)` or `configure(…)`.
5. The environment: `CRYPTO_AIO_[<PROFILE>_]<CHAIN>_<KEY>`, such as
   `CRYPTO_AIO_FAKECHAIN_RPC_URL`, with `CRYPTO_AIO_ENV` naming the profile. It carries
   routing only: network, library, provider name, and RPC or indexer URL (wrapped as a
   `Secret`). It never carries private keys, mnemonics or signers.
6. Built-in defaults: the chain's default network, its first library, and the network's
   default confirmations.

How layers merge: `chains.<id>` merges field by field, and its `options` merge deeply.
`lifecycle` and `hooks` merge key by key. A named entry in `providers`, `wallets` or
`signers` is **replaced whole**, and arrays, such as a provider list, are replaced too. Pass
`env: false` to a container to ignore the environment.

```ts
const aio = new CryptoAio({ wallets: { main: { signer: 'hot', tier: 'hot' } } /* , … */ });
const warm = aio.scope({ wallets: { main: { tier: 'warm' } } }); // main has no signer here
```

## Operation and Attempt

- An **Operation** is one business transfer. It is stored, survives restarts, and is unique
  per namespace and **idempotency key**. The key is your own id, such as a withdrawal id.
  Without a key, a random one is generated, so a retry would create a new transfer. Set
  `lifecycle.requireIdempotencyKey: true` in production.
- An **Attempt** is one signed transaction for that Operation. It never changes once stored.
  Replace, cancel and rebuild add more Attempts. One Attempt is the active one.
- The **`intentHash`** is a sha256 of the normalized intent: chain, network, asset id,
  outputs in base units, sender, memo and fee. The same key with the same hash returns the
  same Operation. The same key with another hash throws `IDEMPOTENCY_CONFLICT`.

```ts
const a = await bc.transfer({ to, amount: '0.001' }, { idempotencyKey: 'w-1' });
const b = await bc.transfer({ to, amount: 100_000n }, { idempotencyKey: 'w-1' });
// b.operationId === a.operationId: the same intent in another input form
```

## Ordering slot and address lease

An **ordering slot** is what orders a wallet's transactions on chain: a nonce (`nonce`
ordering), a seqno (TON), the inputs a transaction spends (UTXO) or an expiry (Tron, Solana).
The engine reserves one per Operation when it prepares it, and a replacement reuses it. An
**address lease** is a short, renewable lock on one sending address. It is held while a slot
is allocated and signed, so concurrent transfers from one wallet get distinct, consecutive
nonces ([tutorial step 6](./tutorial.md#step-6-five-concurrent-transfers-get-consecutive-nonces)).

## Stores

The container keeps its state in four stores, passed together as `stores`:

- `OperationStore`: Operations, Attempts, observations, and worker claims.
- `LockManager`: leases, each with a token that grows on every acquisition (a fencing token).
- `SequenceStore`: the next nonce per address, and nonces released for reuse. Seqno values
  are read from the chain, not stored.
- `CursorStore`: scanner positions.

A write with an older fencing token or version fails (`FENCING`, `VERSION_CONFLICT`), so a
paused process never overwrites newer work. Only in-memory stores ship (`createMemoryStores()`);
they work in one process and lose everything on restart.

## Operation states

| State | Meaning |
| --- | --- |
| `created` | Stored; nothing built yet |
| `prepared` | Unsigned transaction built and stored; ordering slot (nonce) reserved |
| `awaiting-signature` | Waiting for an asynchronous or offline signer (`submitSignatures`) |
| `signed` | Signed bytes stored, not broadcast yet |
| `submitted` | Broadcast (or possibly broadcast, when `ambiguous`) |
| `stalled` | A node refused it (for example insufficient funds); needs your action |
| `included` | In a block, not final yet |
| `final` | **Terminal.** Proven final; `outcome` is `executed` or `cancelled` |
| `failed` | **Terminal.** Failed before signing, or proven reverted, replaced or rejected |
| `expired` | **Terminal.** Expiry proven (expiry- and seqno-based chains) |
| `abandoned` | **Terminal.** Abandoned by you before anything was signed |

`TERMINAL_STATES`, `NON_TERMINAL_STATES` (frozen arrays) and `isTerminal(state)` expose it.

## Evidence and finality

Every status carries its **evidence**:

- `observed`: the current view of one endpoint. It can change (a reorg, a drop). After
  signing, observed data never makes an Operation terminal.
- `proven`: finalized chain data read with the proof quorum. Every terminal state after
  signing needs it, with one exception: when nodes reject every Attempt as never valid, the
  Operation fails with `TX_REJECTED` without chain proof, because those bytes can never land.
  Absence is never proof: `dropped` and `refused` are never terminal. A reorg verdict also
  needs the proof quorum to serve a different block hash.

`finality` is `none`, `probabilistic` (included) or `final`. Credit deposits and complete
withdrawals only on `final` with `proven` evidence.

```ts
const { status } = await bc.waitForConfirmation(operationId, { finality: 'final' });
// status: { state: 'final', evidence: 'proven', finality: 'final', … }
```

## Ambiguous errors

`error.ambiguous === true` means the outcome is unknown, for example because a broadcast
reply was lost. The transaction may still land. Retry with the **same** idempotency key. The
library then resends the stored bytes and never signs again. Never retry with a new key.

```ts
try {
  await bc.transfer(intent, { idempotencyKey: 'w-1' });
} catch (error) {
  if (isCryptoAioError(error) && error.ambiguous) scheduleRetry('w-1'); // same key
}
```

## Errors

Every error is a `CryptoAioError` with `code`, `category`, `retryable`, `ambiguous` and a
redacted `context` (ids such as `operationId`). `ERROR_CODES` maps each code to its
category and default `retryable` flag.

| Category | Class | Codes |
| --- | --- | --- |
| config | `ConfigError` | `CONFIG_INVALID`, `DEPENDENCY_MISSING`, `INCOMPATIBLE_SELECTION` |
| unsupported | `UnsupportedCapabilityError` | `UNSUPPORTED_CAPABILITY` |
| validation | `ValidationError` | `INVALID_ADDRESS`, `INVALID_AMOUNT`, `ASSET_RESOLUTION`, `INVALID_INTENT` |
| provider | `ProviderError` | `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_MISCONFIGURED`, `PROVIDER_INCONSISTENT`, `RPC_ERROR` |
| chain | `ChainError` | `INSUFFICIENT_FUNDS`, `NONCE_CONFLICT`, `NONCE_TOO_HIGH`, `FEE_TOO_LOW`, `TX_REFUSED`, `TX_REJECTED`, `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` |
| signing | `SigningError` | `SIGNER_UNAVAILABLE`, `SIGNING_FAILED`, `SIGNATURE_MISMATCH`, `POLICY_REJECTED`, `KEY_NOT_EXPORTABLE` |
| state | `StateError` | `IDEMPOTENCY_CONFLICT`, `FENCING`, `VERSION_CONFLICT`, `INVALID_TRANSITION`, `NOT_FOUND`, `SEQUENCE_BUSY`, `STATE_UNRECORDED`, `SCANNER_REORG_TOO_DEEP` |
| timeout | `TimeoutError` | `TIMEOUT` |

## Events and logging

`aio.on(type, handler)` and `aio.onAny(handler)` deliver typed events with a `type` and an
`at` timestamp: `rpc.request`, `rpc.response`, `rpc.error`, `provider.health`,
`provider.misconfigured`, `provider.inconsistent`, `operation.state`, `operation.stalled`,
`attempt.state`, `tx.reorged`, `nonce.allocated`, `nonce.gap`, `signer.requested`,
`signer.completed`, `scanner.block`, `scanner.rollback` and `recovery.skipped`.

Events and logs carry **operational data only**: ids, states, codes, heights, timings and
sizes. They never carry addresses, amounts, raw transactions, signatures or URLs. The default
logger writes through `debug` (`DEBUG=crypto-aio:*`). `createLogger(namespace, writer)`
redacts URLs in messages and sensitive fields before your writer sees them.

```ts
const aio = new CryptoAio({ logger: createLogger('payments', writer) /* , … */ });
aio.on('operation.state', (event) => metrics.increment(`operation.${event.to}`));
```
