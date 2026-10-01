---
title: Receive deposits
parent: Build
nav_order: 7
description: Scan blocks or read address history for deposits, handle reorgs, and credit deposits safely.
---

# Receive deposits

Money arriving at your addresses is read, not sent, so there is no Operation behind it. Two
reads find it: a **scanner** walks every block and hands you the transactions that touch your
addresses, and **address history** lists one address's transactions from an index. This guide
covers both, then how to credit a deposit safely. [How receiving works](../tour/receiving.md)
explains the design: cursors, at-least-once delivery and reorgs.

| Family | Scanner (`block-scan`) | Address history (`address-history`) |
| --- | --- | --- |
| EVM | Yes | Not yet (it needs an indexer) |
| Bitcoin | Yes | Yes, from the Esplora indexer |
| Tron | Yes | Yes, with a TronGrid `indexer` |
| Solana | Yes | Yes, from the RPC |
| TON | No: the chain is sharded | Yes, from the indexer |
| Avalanche X-Chain and P-Chain | Yes | Yes, from the Data API |

## Scanner (`block-scan`)

```ts
const scanner = bc.scanner({
  cursorKey: 'deposits', // durable position, per namespace, chain and network
  from: 'latest', // where a NEW cursor starts; ignored once one is stored
  mode: 'final', // only finalized blocks; the default 'head' follows the tip
  filter: { addresses: depositAddresses },
});
const mine = new Set(depositAddresses); // canonical strings (see bc.normalizeAddress)
for await (const event of scanner) {
  if (event.type === 'block') {
    for (const tx of event.transactions)
      for (const transfer of tx.transfers) {
        if (!mine.has(transfer.to.canonical)) continue; // the filter is a superset
        // Bitcoin: change, and a cancel's refund, go back to the sending address.
        if (transfer.from.some((a) => a.canonical === transfer.to.canonical)) continue;
        if (transfer.unresolved) await flagForReview(transfer.id, transfer.unresolved);
        else await creditOnce(transfer.id, transfer.asset, transfer.amount);
      }
  } else {
    await revertBlocks(event.removed); // 'rollback': back to event.to
  }
  await event.ack(); // commits the cursor; required before the next event
}
```

- **Credit only your own deposits.** `filter.addresses` returns every transaction with a
  transfer from **or** to one of those addresses, and it may carry other transfers too.
  Credit only transfers whose `to` is a deposit address, or your own sweeps look like deposits.
- **On Bitcoin, skip transfers back to the sender.** A transaction that spends from an
  address pays its change, and a cancel its refund, back to that address by default, so a
  sweep from a deposit address shows a transfer `to` it. Credit a Bitcoin transfer only when
  its `to` is not among its `from` addresses, as the loop above does. Never set a deposit
  address you scan as `wallet.utxo.changeAddress`: its change would look like a deposit.
  Do not skip every transfer with one of your addresses in `from`, though: a withdrawal from
  your hot wallet to another customer's deposit address is a real deposit.
- **At least once.** A block may be delivered again after a crash, so dedupe on
  `transfer.id` (`<txId>:<locator>`).
- **Rollback.** In `head` mode, a reorg within `reorgWindow` blocks produces a `rollback`
  event to the common ancestor, then the new branch. The scanner checks a stored cursor
  against the canonical chain on restart. It decides a rollback only when a quorum-served
  block hash confirms it, and never from a stale view. In `final` mode a rollback can still
  come from a provider inconsistency, so handle it there too. The mode is not stored with the
  cursor: a head-mode cursor resumed in `final` mode keeps the blocks it already delivered.
- **`SCANNER_REORG_TOO_DEEP`.** The chain diverged deeper than the window. The scanner stops
  instead of guessing. Stop crediting, investigate, then reset explicitly: scan under a new
  `cursorKey`, or `put` a checkpoint `{ height, hash, recent }` through your `CursorStore`.
  `recent` may be empty; the scanner refills it. The store key is currently
  `<namespace>:<chain>:<network>:<cursorKey>`.
- `filter.assets` is a hint to the driver, not a guarantee. Check `transfer.asset` yourself.
- **Unresolved assets.** A transfer whose asset cannot be resolved, such as a spam token
  with unusable metadata, does not stop the scanner. It arrives as an `UnresolvedTransfer`:
  `asset` and `amount` are `undefined`, and `unresolved` holds `{ asset, amount, code }`,
  meaning the raw `AssetRef`, the amount in base units as a bigint, and the reason (such as
  `ASSET_RESOLUTION`, or `PROVIDER_UNAVAILABLE` for a TON jetton whose metadata the indexer
  does not have). Its transaction has `decoding: 'partial'`. `getTransaction` and `history`
  return the same marker. A retryable failure still fails the read.
- Stop an idle scanner with `signal`. `iterator.return()` acts only after a pending `next()`.
- **EVM.** Blocks carry native transfers and ERC-20 `Transfer` logs. A transaction that ran
  contract code is `decoding: 'partial'`: internal transfers need traces, which are out of
  scope. A plain POL transfer on Polygon is `complete`, because bor's system logs are ignored
  for it. A scan, filtered or not, reads each block's receipts in one `eth_getBlockReceipts`
  call and takes token transfers from them, never from a log index that may lag. Without
  that method, an unfiltered scan reads one receipt per transaction, and a filtered one asks
  `eth_getLogs`. When that answers nothing but the block's bloom may hold a `Transfer`, the
  scan reads every receipt of the block before it trusts the empty answer. So for deposit
  scanning, prefer endpoints that serve `eth_getBlockReceipts`.
- **Bitcoin.** Each output with an address is a transfer (`<txid>:vout:<n>`) from the
  addresses of the transaction's inputs, change included; an output without one that
  carries value makes the transaction `decoding: 'partial'`. `filter.addresses` matches outputs to those
  addresses and inputs that spend from them. Blocks are read 25 transactions per request,
  filtered or not, so a full mainnet block takes over 100 requests: scan through your own
  Esplora rather than a public one.
- **Tron.** Blocks carry TRX transfers and TRC-20 `Transfer` events from any contract, so
  check `transfer.asset`: a copycat token has its own contract. A contract call is
  `decoding: 'partial'`, since TRX can move inside it without an event, and a TRC-10
  transfer is not decoded (`decoding: 'none'`). A memo arrives on each transfer as
  `transfer.memo` when it is UTF-8 text. Credit in `final` mode, on solidified blocks.
- **Solana.** Blocks carry SOL transfers, including those a program makes
  (`source: 'internal'`), and classic SPL transfers, reported with the token accounts'
  owners when the node gives them. `filter.addresses` may hold wallets and token accounts. A
  filtered scan returns a superset: every transaction that may move funds for a watched
  address, an SPL transfer into or out of a watched token account included, and one it
  cannot fully attribute arrives as `decoding: 'partial'` rather than being dropped. An SPL
  transfer's `to` is the owner wallet whenever the node reports it, not the token account,
  so with token accounts in the filter, put their owner wallets in `mine` in the example
  above too (and the token accounts, for the `partial` case where no owner was reported). A
  token transfer that creates the recipient's token account also shows its rent deposit as
  an internal SOL transfer to that account. Heights are block heights, so skipped slots
  leave no gap. The scan reads two `getBlock` calls per block, its header and then its
  transactions, and in `head` mode a few more lookups per block that is not final yet, so
  over the `public` preset it falls behind; scan through a keyed provider or your own node.
- **TON** has no block scan, since the chain is sharded: `bc.scanner()` throws
  `UNSUPPORTED_CAPABILITY`. Read deposits with `bc.history(address)` from the indexer
  instead; [TON networks](../reference/networks/ton.md) shows how deposits appear there, that
  they are `observed` only, and why to read each one you credit again through an
  independent provider and indexer pair.

## Address history (`address-history`)

`bc.history(address, { cursor?, limit? })` returns `{ items: Transaction[], next? }`. Most
families read it from an indexer provider; Solana reads its RPC. The fake chain has none,
and the EVM family does not support one yet, so both throw `UNSUPPORTED_CAPABILITY`. Tron
serves it from TronGrid: name the `trongrid` or `public` preset as the handle's `indexer`. A
transaction can come more than once (on Tron, a call to a contract account that moves its
own tokens comes in both parts of the listing, [Tron networks](../reference/networks/tron.md)),
so dedupe on `transfer.id`, as for scans.
On Bitcoin it reads the Esplora indexer and lists confirmed transactions only, newest first.
Credit from it as from the scanner: skip a transfer whose `to` is among its `from`
addresses, which is the sender's change or a cancel's refund.

Solana needs no indexer: its RPC serves history (`getSignaturesForAddress`), newest first,
at most 1,000 per page, and each item is read back with two requests (the transaction, then
its block's header). An SPL deposit into an existing token account appears in that token
account's history, not the owner's; `bc.ext.solana.getTokenAccounts(owner)` lists an owner's
token accounts. History ends at the provider's retention
([Solana networks](../reference/networks/solana.md)).

TON reads it from its indexer (toncenter API v3); [TON networks](../reference/networks/ton.md)
shows how its deposits appear there and how to credit them.

## Crediting deposits

A deposit is a transfer that none of your Operations made, so no proof backs it: every read
that returns one (`bc.scanner()`, `bc.history()` and `bc.getTransaction()`) reads one
endpoint, and its status carries `evidence: 'observed'` in every family. Its `finality` is
`'final'` once that endpoint reports the block at or below its finalized height. The library
has no proven deposit read yet, so credit a deposit this way:

1. Take it from a `final` read: a scanner in `mode: 'final'`, or a transaction whose
   `status.finality` is `'final'`.
2. Credit only transfers to your own deposit addresses, and dedupe on `transfer.id`: scans
   and history deliver at least once, and a history can list one transaction twice.
3. Before you credit automatically, or above your risk threshold, read the transaction again
   through an independent provider (and indexer, where the family reads one), for example
   `bc.with({ provider: 'second' }).getTransaction(tx.id)`, and credit it only when both
   reads are final and agree on the transaction hash, the recipient, the asset, the amount
   and the memo.
4. Leave a transfer whose asset did not resolve (`transfer.unresolved`) for review.

| Family | Deposit reads | What one read rests on |
| --- | --- | --- |
| EVM | `scanner()`: native transfers and ERC-20 `Transfer` logs from each block's receipts; no `history()` | the block and receipts one endpoint serves |
| Bitcoin | `scanner()`, and `history()` (confirmed only) | one Esplora endpoint's block pages or address history |
| Tron | `scanner()`, and `history()` from TronGrid, each entry read back from the `provider` | one endpoint's block, or one indexer's listing read back from one endpoint |
| Solana | `scanner()`, and `history()` from `getSignaturesForAddress`, each item read back | one endpoint's block or signature list |
| TON | `history()` only, from the indexer, with the provider's get-methods for jettons | one indexer endpoint and one provider endpoint |

Each family's own rules still apply: on Bitcoin skip a transfer whose `to` is among its
`from` addresses (change and cancel refunds); on Solana credit SPL deposits by the owner
wallet (`transfer.to`); on TON credit a jetton deposit only from its arrival in the owner's
jetton wallet ([TON networks](../reference/networks/ton.md)). A scanner in `final` mode emits
a block only once the network's finality policy holds, and it decides a rollback only when
the proof quorum serves a different block hash, but the transfers in a block are what the one
endpoint that served it reported: a lying endpoint could add a transfer to a real block. The
second read through an independent provider catches that.

## Next steps

- [Run workers and recover](./workers.md): run the scanner as a long-lived service.
- [Go to production](./production.md): the deposit rules in the production checklist.
- [Write a durable store](../explore/stores.md): a `CursorStore` that survives restarts.
