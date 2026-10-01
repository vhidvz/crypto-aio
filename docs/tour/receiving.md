---
title: How receiving works
parent: Developer tour
nav_order: 7
layout: lesson
journey: learn
description: Scanners with durable cursors, at-least-once delivery, reorg rollbacks, deterministic transfer ids, and why deposits are observed and how to credit them.
---

# How receiving works

> [!TIP]
> **The short version.** Deposits are found by reading the chain: a **scanner** walks blocks and
> hands you each one, with the transactions that touch your addresses, and **history** lists one
> address's transactions. A scanner remembers its position in a durable **cursor** that moves only
> when you **ack** an event, so a block can arrive twice but is never skipped. When the chain
> reorganizes, the scanner emits a **rollback**. Every transfer has a deterministic id to
> deduplicate on. And because nobody proves a deposit for you, deposits are **observed**: credit
> them from final blocks, and confirm large ones through an independent provider.

**Builds on:** [Blocks, confirmations and finality](../learn/foundations/blocks.md),
[Idempotency](../learn/engineering/idempotency.md) and
[Evidence, proofs and finality](./evidence.md).

## Two ways to find a deposit

| | Scanner, `bc.scanner(options)` | History, `bc.history(address)` |
| --- | --- | --- |
| Reads | Every block, in order | One address's transactions, from an index |
| Good for | Many deposit addresses, continuously | Looking one address up; families without a block scan |
| Capability | `block-scan` | `address-history` |
| Position | A durable cursor | Your own `cursor` from the last page |

Both return the same `Transaction` objects, whose `transfers` say who paid whom, which asset and
how much. The families differ in what they support (TON has no block scan: it is sharded), so
[Receive deposits](../build/receive.md) has a table per family.

## The scanner's loop

```mermaid
sequenceDiagram
  participant App as Your deposit service
  participant Sc as Scanner
  participant C as CursorStore
  participant Ch as Chain (via the driver)
  Sc->>C: read the cursor (or start at `from`)
  loop for each block
    Sc->>Ch: next block after the cursor; check its parent hash
    Ch-->>Sc: block N
    Sc-->>App: { type: 'block', block, transactions, ack }
    App->>App: credit each new transfer once (dedupe on transfer.id)
    App->>Sc: await event.ack()
    Sc->>C: commit: the cursor is now block N
  end
  Note over Sc,Ch: the parent hash no longer matches: a reorg
  Sc-->>App: { type: 'rollback', to, removed, ack }
  App->>App: revert what came from the removed blocks
  App->>Sc: await event.ack()
```

Three properties make this safe:

- **Durable and explicit.** The cursor lives in your `CursorStore` under
  `<namespace>:<chain>:<network>:<cursorKey>`, and moves only on `ack()`. A crash before the ack
  means the block is delivered again after the restart: **at least once**, never skipped.
- **Deterministic ids.** Every transfer has an id, `<txId>:<locator>` (such as
  `…:native` or `…:vout:1`), that is the same on every delivery, so crediting once is a simple
  unique key in your database.
- **Reorg-aware.** The scanner keeps the recent block hashes it delivered. When a new block's
  parent does not match, it walks back to the common ancestor and emits a `rollback`, then
  replays the new branch. It decides a rollback only when a quorum-served block hash confirms
  it, never from one lagging endpoint, and it stops with `SCANNER_REORG_TOO_DEEP` rather than
  guess past its `reorgWindow`.

`mode: 'final'` delivers only finalized blocks, where rollbacks should not happen; the default
`'head'` follows the tip and rolls back when it must. Even in `final` mode, handle a rollback: a
provider inconsistency can still cause one.

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const customer = env.stranger(); // one of your deposit addresses
await env.run(env.bc.transfer({ to: customer, amount: 7n })); // someone pays it
env.chain.mine(3); // blocks 1 to 3; the deposit lands in block 1

const events = env.bc
  .scanner({ cursorKey: 'deposits', from: 1n, filter: { addresses: [customer] } })
  [Symbol.asyncIterator]();
const seen: string[] = [];
const take = async () => {
  const result = await env.run(events.next(), 500);
  if (result.done) throw new Error('the scanner stopped');
  const event = result.value;
  if (event.type === 'block') {
    const mine = event.transactions.flatMap((tx) => tx.transfers).filter((t) => t.to.canonical === customer);
    const found = mine.map((t) => `${t.id.split(':')[1]} ${t.amount?.format()}`).join(', ');
    seen.push(`block ${event.block.height}: ${found || 'nothing for us'}`);
  } else {
    seen.push(`rollback to block ${event.to.height}, removing ${event.removed.map((b) => b.height).join(' and ')}`);
  }
  await event.ack(); // commits the cursor
};
await take();
await take();
await take();
env.chain.reorg(2); // blocks 2 and 3 are replaced by a new branch
await take();
await take();
for (const line of seen) console.log(line);
// Prints:
// block 1: native 0.00000007 FAKE
// block 2: nothing for us
// block 3: nothing for us
// rollback to block 1, removing 3 and 2
// block 2: nothing for us
```

## Why deposits are observed

Your own transfers are proven, because the library knows exactly which bytes it sent and can ask
a quorum about them. A deposit is somebody else's transaction, read from one endpoint: a scanner
in `final` mode knows the **block** is final, but the transfers inside it are what the one
endpoint that served it reported. A dishonest endpoint could add a transfer to a real block. So
every family reports deposits with `evidence: 'observed'`, and crediting is your policy:

1. Take deposits from final blocks (`mode: 'final'`, or `status.finality === 'final'`).
2. Credit only transfers **to** your own deposit addresses, once per `transfer.id`.
3. Before an automatic credit, or one above your risk threshold, read the transaction again
   through an **independent** provider, `bc.with({ provider: 'second' }).getTransaction(id)`, and
   credit only when both reads are final and agree.
4. Leave transfers whose asset did not resolve (`transfer.unresolved`, such as a spam token) for
   review.

Each family adds its own rules: skip Bitcoin change that returns to the sender, credit Solana SPL
deposits by the owner wallet, and TON jettons by their arrival in the owner's jetton wallet.
[Receive deposits](../build/receive.md#crediting-deposits) has all of them.

## Where it lives

| Path | What is there |
| --- | --- |
| `src/core/observe/scanner.ts` | The scanner: cursors, delivery, ack, reorg detection and rollback |
| `src/core/store/types.ts` | `CursorStore`, `ScanCursor`, `StoredCursor` |
| `src/core/driver/types.ts` | The `BlockSource` and `AddressHistorySource` ports |
| `src/core/model/transaction.ts` | `Transaction`, `Transfer`, `UnresolvedTransfer`, `Decoding` |

## Check yourself

1. Your service crashed after crediting block 812 but before `ack()`. What happens next, and
   what keeps the customer from being credited twice?
2. Why does the scanner stop on a reorg deeper than its window instead of rolling back?
3. A scanner in `final` mode reports a deposit. Why is its evidence still `observed`?

<details markdown="1">
<summary>Answers</summary>

1. Block 812 is delivered again; your credit is keyed on `transfer.id`, so the second credit is a
   no-op.
2. It cannot know what it delivered from blocks it no longer remembers; guessing could credit or
   revert the wrong deposits. Stopping lets you investigate and reset explicitly.
3. The block's finality is checked, but the transfers in it come from one endpoint's report, so
   nothing proves them. A second, independent read is your proof.

</details>

## What's next

Everything so far assumed the signer would sign. Where keys live, and what stands between a
request and a signature: [Keys, signers and policy](./keys.md).
