---
title: Wait for confirmation
description: waitForConfirmation, watch and getTransactionStatus, and how each family proves a verdict.
---

# Wait for confirmation

`transfer` returns as soon as the transaction is broadcast, long before the payment is done.
This guide shows the three ways to follow it (wait, watch, or read once), what each answer
means, and how each family reaches a final verdict. Why "final" needs proof is the subject of
[Evidence, proofs and finality](../tour/evidence.md).

```ts
const { status, operation } = await bc.waitForConfirmation(operationId, {
  finality: 'final', // or 'included'; or pass confirmations: n
  timeoutMs: 600_000,
});
for await (const { status } of bc.watch(operationId, { signal })) log(status.state);
const now = await bc.getTransactionStatus(operationId); // one read
```

- The `ref` is an Operation id, an Attempt ref (`sub.attempt.id`, the transaction hash) or
  a transaction hash the monitor has observed. An Attempt's own id (`attempts[i].id`) is not
  a ref. Any other id is an unmanaged transaction, whose finality is `observed` only.
- For an Operation, `waitForConfirmation` rejects with the stored failure: `TX_REVERTED`,
  `TX_EXPIRED` or `TX_REPLACED` on proven evidence, `TX_REJECTED` when every Attempt was
  rejected, or the code of a failure before signing. An abandoned Operation gives
  `INVALID_TRANSITION`. An unmanaged transaction rejects with `TX_REVERTED` on observed
  finality. On `TIMEOUT` (retryable), nothing changed. Wait again.
- `sub.wait(options)` is the same as `waitForConfirmation(sub.operationId, options)`.
- **EVM token verdicts.** An Operation's ERC-20 `transfer` counts as executed only if the
  token contract logged a `Transfer` from the sender to the recipient, of a positive amount
  (of any amount for a zero-amount transfer), as ERC-20 requires. The recipient and amount
  are read from the signed call. A fee-on-transfer token that delivers less than asked still
  counts. A token that returns `false` instead of reverting, logs its `Transfer` to another
  address or of nothing, or moves value without logging it, is reported failed
  (`TX_REVERTED`) **although its receipt succeeded, so value may have moved.** Before you
  pay again, check the chain: `bc.getTransaction(attempt.ref.id)` shows the receipt's own
  status (`status.state` is `included` when it succeeded, `failed` when it reverted), or
  read the recipient's token balance. Only your own Operations get this verdict;
  `getTransaction` and scans show the chain's view.
- **EVM proofs.** An Attempt whose transaction disappears is settled only once its nonce is
  proven used at a final height, read by block number (BSC's public nodes serve no state at
  the `finalized` tag). An endpoint without that state, such as a non-archive L2 node, makes
  the proof decide nothing (a retryable `PROVIDER_UNAVAILABLE`) until endpoints that serve it
  answer; so does any other JSON-RPC error on a proof read, since only a definitive answer
  proves "no". With one endpoint the proof quorum is 1, so configure two or more providers.
- **Tron token verdicts.** As on EVM, an Operation's TRC-20 `transfer` counts as executed
  only if its receipt succeeded and the token contract logged a `Transfer` from the sender
  to the recipient, of any positive amount (a fee-on-transfer token that delivers less still
  counts). A token whose receipt succeeded but logged no such `Transfer` is reported failed
  (`TX_REVERTED`, `status.reason` `token transfer not evidenced`) **although value may have
  moved**: check the chain (`bc.getTransaction(attempt.ref.id)`, or the recipient's token
  balance) before you pay again. A `Transfer` event from the token that does not decode
  leaves the Attempt undecided. A transfer that ran out of energy is failed (`out of
  energy`), and its fee is burned.
- **Tron proofs.** A Tron transaction that never landed is proven `expired` only once a
  solidified block passes its signed expiration, the reference block it names is attested,
  and every block between them (none more than a day before the expiration) is read by hash
  under the proof quorum without it. When the height stored for that block does not hold it,
  the proof reads every height whose block TaPoS could have matched; if none carries the
  signed reference, no block can hold the transaction, and absence is proven with no scan.
  An index that lags, or an endpoint that cannot serve those blocks, decides nothing. With one
  provider the proof quorum is 1, so configure two or more
  ([Tron networks](../reference/networks/tron.md)).
- **Run the monitor.** A node answers "not found" for every transaction outside its index
  window (geth keeps the last 2,350,000 blocks: weeks on fast chains, under a year on
  Ethereum), so a missing receipt proves nothing. A transaction older than your endpoints'
  index window is resolved by its nonce: the proof finds the final block that used the nonce
  and reads the sender's transaction there. `TX_REPLACED` needs another transaction there;
  your own is proven final with its receipt from that block. That lookup reads the nonce at
  past heights, and a standard full node keeps only about the last 128 blocks of state
  (about 1 minute on BSC, 25 minutes on Ethereum). Anything older needs an archive node.
  Without one, the Attempt stays undecided, and it is never failed. So an external
  replacement that the monitor first notices later than that stays undecided until an
  archive endpoint answers. A nonce consumed by an EIP-7702 authorization, rather than by a
  transaction from your address, also stays undecided and is never failed.
- **Solana verdicts and proofs.** A Solana verdict reads the finalized transaction under
  the proof quorum. A transaction that failed on chain is proven `failed` (`TX_REVERTED`,
  reason `transaction failed`), and its fee is paid. An SPL transfer counts as executed only
  when the token balances show tokens leaving the sender's account and reaching the
  recipient's. A transaction that never landed is proven `expired` only once the proof
  quorum attests the block of its blockhash, has finalized the block after its last valid
  height, and serves every block of its window without it. An index that shows nothing
  proves nothing, and an endpoint that lags, or no longer holds those blocks, decides
  nothing. With one provider the proof quorum is 1, so configure two or more, ideally three
  ([Solana networks](../reference/networks/solana.md)).
- **TON verdicts.** A TON Attempt's id is its external message's normalized hash, not a
  transaction hash (`canonical: false`); the status's `txHash` carries the transaction hash
  once the indexer has it. An Attempt is never decided from indexer lag: until the indexer
  has the transaction and its whole message trace, the Operation stays `submitted` or
  `included`. It is `final` only on masterchain inclusion and a completed trace in which the
  value moved: for a jetton, the recipient's jetton wallet, the one the master names for
  the recipient, received a positive amount from yours. Otherwise it is `failed`
  (`TX_REVERTED`) with a `status.reason`: `transfer bounced` (the value came back, less
  fees), `jetton transfer bounced` (the jettons did not arrive), `the wallet skipped a
  message` (the wallet could not send it when it ran, usually for lack of funds) or `the
  wallet transaction failed`; in these cases nothing was delivered. The one exception is
  `the jetton wallets are not the master’s`: the recipient's jetton wallet answered, and it
  is not the one the master names for the recipient, so the jettons left your wallet for
  another one; check the chain before you pay again. A jetton wallet that gives no answer
  (for example "no state" at that block) decides nothing: the transfer stays undecided until
  an endpoint answers.
- **TON proofs.** A TON transfer that never landed is proven absent (`expired`, or
  `replaced` when another request used its seqno) only once its lifetime has passed at a
  masterchain block the proof quorum attests, and only from authenticated chain data: the
  wallet's state at that block, and the wallet's own transactions, each checked against the
  hash that links it to the next, back to the build's recorded chain time less 5 minutes,
  the whole time the message could have run. The proof rests on those transactions; the
  indexer, under the proof quorum, only helps find a transfer that landed, and confirms
  that a wallet whose chain starts inside that time, or that has none, never ran its code
  before.
  A request that used the seqno counts only when the wallet ran it and it carries the
  wallet's own signature, relayed (gasless) v5r1 requests included, so a forged request that
  anyone can post never marks your transfer as replaced. A wallet can be reset: emptied and
  deleted, then deployed again by anyone with its seqno back at 0. So when those
  transactions show the wallet deleted or deployed again, when an earlier life of the
  wallet cannot be ruled out, or when the walk cannot reach back far enough within its
  limit (512 of the wallet's transactions), the Attempt stays undecided (a retryable
  `PROVIDER_UNAVAILABLE`, logged) instead of risking a second payment. The library never
  deletes a wallet, so only something else that holds the key (or years of unpaid storage
  on an emptied wallet) can reset it: never share the key. Proof endpoints should be
  archival ([TON networks](../reference/networks/ton.md)).

## Next steps

- [Fix a stuck transfer](./stalled.md): what to do when a transfer stops making progress.
- [Run workers and recover](./workers.md): let background workers finish every transfer.
- [Errors](../reference/errors.md): the failure codes `waitForConfirmation` can reject with.
