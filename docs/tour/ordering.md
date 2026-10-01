---
title: Nonces, leases and many processes
parent: Developer tour
nav_order: 5
layout: lesson
journey: learn
description: How crypto-aio reserves ordering slots under an address lease, when a slot is released, how gaps and coin conflicts are handled, and how fencing protects shared stores.
---

# Nonces, leases and many processes

> [!TIP]
> **The short version.** Every Operation reserves its wallet's next **ordering slot** (a nonce,
> a seqno, a set of coins, or an expiry) while holding a short **address lease**, so concurrent
> transfers, from any number of processes sharing the stores, get distinct, consecutive slots. A
> slot is given back only while no signed bytes for it can exist; after signing, it belongs to
> its Operation for good. Every write that could race carries a **fencing token** or a
> **version**, so a paused process can never overwrite newer work.

**Builds on:** [Accounts, UTXOs and transaction order](../learn/foundations/ordering.md),
[Concurrency: locks, leases and fencing](../learn/engineering/concurrency.md) and
[The life of a transfer](./transfer.md).

## One wallet, many senders

A real service sends from the same hot wallet from several API processes at once, while worker
processes resend and replace in the background. Lesson 7 showed what each ordering model needs,
and lesson 13 what goes wrong without coordination. Here is how the library coordinates, model
by model:

| Ordering | Families | The lease serializes | A new Attempt excludes the earlier ones when | An Attempt is proven dead when |
| --- | --- | --- | --- | --- |
| `nonce` | EVM | Nonce allocation | It uses the same nonce | Another transaction used the nonce in a final block |
| `inputs` | Bitcoin, Avalanche X and P | Coin selection | It spends at least one of the same coins | Another transaction spent one of its coins, at final depth |
| `expiry` | Tron, Solana | Nothing (no slot to share) | Only after the earlier ones are proven dead | Its expiry passed in finalized state, and it is in no block |
| `seqno` | TON | Seqno allocation | It uses the same seqno | Its deadline passed unincluded, or another message used the seqno |

## The address lease

The lease is a `LockManager` lease on one sending address, per namespace, chain and network. The
engine takes it to choose a slot and keeps it, renewing it, until the Attempt is signed and
stored, so that "read the next nonce" and "record that I used it" cannot interleave with another
sender.

```mermaid
sequenceDiagram
  participant A as Process A
  participant L as LockManager
  participant Q as SequenceStore
  participant B as Process B
  A->>L: acquire(address)
  L-->>A: lease, token 41
  B->>L: acquire(address)
  L-->>B: busy: wait and retry
  A->>Q: next nonce? → 7; store next = 8 (token 41)
  A->>A: build, sign, store the Attempt with nonce 7
  A->>L: release
  B->>L: acquire(address)
  L-->>B: lease, token 42
  B->>Q: next nonce? → 8; store next = 9 (token 42)
```

Two processes that share the stores behave exactly like this. The testing kit can run two
"processes" on one set of stores:

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const a = await createFakeEnv();
const b = await a.restart(); // a second process: the same stores and chain
const nonces: string[] = [];
for (const env of [a, b]) env.aio.on('nonce.allocated', (event) => nonces.push(event.value));

const sends = [a, b, a, b].map((env, i) =>
  env.bc.transfer({ to: env.stranger(), amount: BigInt(i + 1) }, { idempotencyKey: `w-${i}` }),
);
await a.run(Promise.all(sends), 10);
console.log([...nonces].sort().join(', ')); // 0, 1, 2, 3
a.chain.mine();
console.log(a.chain.nonce(a.address)); // 4n
```

## When a slot goes back

Reusing a slot is safe only if no valid signed transaction can exist for it. So the rule is
strict:

- **Before signing**, a slot returns to the pool when the Operation fails (funds, policy veto),
  is abandoned, or when every Attempt holding it was rejected as never valid.
- **After signing**, the slot belongs to its Operation permanently. The only ways forward are
  the Operation's own: resend the same bytes, replace or cancel in the same slot, or prove the
  Attempt dead.

A slot is never freed because a transaction "disappeared" from a mempool. Absence is not proof,
and handing a signed nonce to a different payment is how two payments end up competing for it.

## Gaps, conflicts and busy wallets

- **Nonce gaps.** A `stalled` Operation can hold a nonce that later transactions queue behind. The
  monitor notices when the chain's pending nonce sits below the lowest outstanding reservation
  and emits `nonce.gap` with the blocking Operation's id. Resolving it is your decision:
  rebroadcast after a top-up, replace, or cancel. The library never invents a filler
  transaction.
- **Leaked nonces.** A crash between allocating a nonce and storing it leaves a hole. `recover()`
  returns such nonces for reuse, and so does the next transfer from that wallet, so a quiet
  wallet never stays blocked.
- **Coins.** On UTXO chains, coin selection skips every coin held by a live Operation of the
  wallet: its reservation, its unsigned payload or its Attempts. Coins return only when the
  Operation is abandoned, failed before signing, or entirely rejected.
- **Seqnos.** A TON wallet can run one message per seqno, so the next transfer waits until the
  previous one is included or ended: meanwhile, `transfer` throws `SEQUENCE_BUSY`, which is
  retryable. Throughput comes from more wallets.

## Fencing everywhere

Leases expire, so every write that could race carries proof of who may write:

- `SequenceStore.put` carries the lease's fencing token, and a version.
- Operation writes carry the version the writer read, and a worker's writes carry its claim's
  token.
- A store refuses an older token (`FENCING`) or a stale version (`VERSION_CONFLICT`).

That is what makes the stores the coordination point, and why custom stores must pass the
contract suites, which include "a paused worker wakes up after its lease was taken over" cases
([Write a durable store](../explore/stores.md)).

## Where it lives

| Path | What is there |
| --- | --- |
| `src/core/ordering/sequence.ts` | The sequence coordinator: allocation and release under the lease |
| `src/core/ordering/reservations.ts` | Coin reservations for UTXO chains |
| `src/core/model/ordering.ts` | `OrderingKind`, `OrderingData`, `mutuallyExclusive` |
| `src/core/store/memory.ts` | The in-memory stores, a reference for fencing and versions |
| `src/testing/contracts/` | The store contract suites |

## Check yourself

1. Why is the lease held until the signed Attempt is stored, and not just while reading the
   nonce?
2. An Ethereum transaction with nonce 12 vanished from every mempool. May the library give
   nonce 12 to the next transfer?
3. Two TON transfers from one wallet arrive together. What happens to the second?

<details markdown="1">
<summary>Answers</summary>

1. Otherwise another sender could read the same "next" value between reading and recording it.
2. No. Its signed bytes exist and may still land; the nonce stays with its Operation until it is
   resent, replaced, cancelled, or proven dead.
3. It fails with `SEQUENCE_BUSY` (retryable) until the first is included or ended.

</details>

## What's next

The library decides a payment is final only on proof. What counts as proof, and how is it read?
[Evidence, proofs and finality](./evidence.md).
