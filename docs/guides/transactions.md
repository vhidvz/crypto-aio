---
summary: Withdrawals, cold signing, confirmations, background workers, deposit scanning and error handling.
---

# Sending and receiving

This guide shows how to build withdrawals and deposits into a service. The examples run on
the fake chain (`bc = env.bc`; wrap awaited calls in `env.run(...)`, as in the
[tutorial](./tutorial.md)). They work the same way on every built-in family, apart from
the family notes below. Terms are defined in [Core concepts](./concepts.md).

## Sending

### `transfer`: build, sign and broadcast in one call

```ts
const sub = await bc.transfer(
  { to: 'fk1…', amount: '0.25', fee: 'fast', memo: 'invoice 381' },
  { idempotencyKey: withdrawal.id },
);
sub.operationId; // your handle on the Operation from now on
sub.attempt; // { id: <tx hash>, idKind: 'tx-hash', canonical: true }
```

`transfer` validates the intent, creates the Operation (or returns the existing one for this
key), reserves the ordering slot (the nonce), builds, runs the `beforeSign` hook, signs,
stores the signed Attempt, and broadcasts. It returns a `Submission`: the Operation view plus
`wait(options)`. A repeat with the same key resumes where the Operation stopped. It never
signs twice.

- `outputs: [{ to, amount }, …]` sends several outputs; it needs the `batch-transfer`
  capability. An EVM or Tron transfer has exactly one output.
- `asset` defaults to `'native'`. It also accepts a token ref, an asset id, or an alias
  registered for the handle's chain and network, such as `'USDC'` on `ethereum` mainnet.
  Tokens need the `tokens` capability: the EVM chains (ERC-20) and Tron (TRC-20) have it;
  the fake chain does not.
- `memo` needs the `memo` capability, which Tron has and EVM networks lack. A Tron memo is
  public forever and costs a fee ([Tron networks](./networks.md#tron-networks)).
- `options.signal` aborts the call. An abort after a possible broadcast is reported as
  ambiguous.
- On TON a transfer has exactly one output: batches are not supported yet, because a TON
  batch lands output by output, and a partly delivered one has no safe single verdict.
  Tokens are jettons, and `memo` is a text comment of at most 1,024 UTF-8 bytes
  ([TON networks](./networks.md#ton-networks)).

### Fees

`fee` is a speed (`'slow'`, `'normal'` (the default) or `'fast'`) or a family-specific
override object, whose fields each family's adapter defines. Override amounts must be
bigints or decimal strings, never numbers (`INVALID_INTENT`). The fake chain takes
`fee: { fee: 5n }`. EVM networks take `{ maxFeePerGas, maxPriorityFeePerGas, gasLimit? }`
(`evm-1559`) or `{ gasPrice, gasLimit? }` (`evm-legacy`) in wei (`EvmFeeOverride`), as
bigints only: a decimal string gives `INVALID_INTENT` there. Tron TRC-20 transfers take
`{ feeLimit }` in sun (`TronFeeOverride`), also as a bigint only. The fee is part of the
`intentHash`, and an override is hashed as written: `{ fee: 1n }` and `{ fee: '1' }` are
different intents. Retry in the same form, or you get `IDEMPOTENCY_CONFLICT`.

On Bitcoin, the override is `{ satPerVByte }`, as a `bigint` or a decimal string with up to
three decimals, in satoshis per virtual byte (`UtxoFeeOverride`), such as
`{ satPerVByte: '2.5' }`.

```ts
const estimate = await bc.estimateFee({ to, amount: '0.25', fee: 'fast' });
estimate.charges; // [{ amount: Amount, label: 'network' }]; a charge per asset and purpose
estimate.bound; // 'exact' | 'expected' | 'upper'
feeTotal(estimate, 'fakechain:local/native'); // Amount | undefined
```

On `evm-1559` networks, `slow`, `normal` and `fast` take the median, over the last 15
blocks, of the 10th, 25th or 50th percentile tip (at least the network's floor, 25 gwei on
Polygon mainnet), and the fee cap allows the base fee to double. On `evm-legacy` networks
they scale `eth_gasPrice` by 100%, 110% or 125%. The gas limit is the node's estimate,
plus 20% for anything but a plain transfer. The `network` charge is an `upper` bound, and
`details.expected` (`EvmFeeDetails`) the likely cost. On OP Stack chains the L1 data fee is a
separate `l1-data` charge, and the bound is `expected`, since that fee moves with L1 prices.
An override's `gasLimit` skips `eth_estimateGas`, the check that refuses a call that would
fail: any call that would revert or run out of gas, such as a token transfer or a payment
to a contract that refuses it, is then signed, broadcast, and burns its gas. The balance
check still runs. No EVM transaction signs a price per gas above the handle's `maxFeePerGas`
option (1,000 gwei by default): a speed's prices are clamped to it, and an override, or a
cancel's least bump, above it is refused with `INVALID_INTENT` before signing; see
[EVM networks](./networks.md#evm-networks).

On Bitcoin, `slow`, `normal` and `fast` take Esplora's estimate for 144, 6 or 2 blocks, and
a built transaction's `network` charge is `exact`. A fee above the handle's absurd-fee
limits, or an estimate above its cap, is refused before anything is signed; see
[Bitcoin networks](./networks.md#bitcoin-networks).

On Tron, `slow`, `normal` and `fast` give the same estimate, since Tron has no fee market.
The `tron` fee has `bandwidth`, `energy`, `activation` and `memo` charges, all in TRX, as an
`upper` bound; `bandwidth` and `energy` may be 0 when staked or free resources cover them. A
TRC-20 transfer's `feeLimit` covers its simulated energy plus a margin, up to the network's
maximum fee limit and the handle's `maxFeeLimit` option (100 TRX by default); `{ feeLimit }`
may raise it to the lower of the two but never set it below the estimate.
[Tron networks](./networks.md#tron-networks) explains the charges and the ceiling.

On Solana, the `solana` fee has a `network` charge (the signature fee), a `priority` charge
(the compute-unit price times the compute-unit limit) and, when the transfer creates the
recipient's token account, a `rent` charge; the bound is `exact`, or `upper` with `rent`.
`slow`, `normal` and `fast` take the 25th, 50th or 75th percentile of the node's recent
prioritization fees, at most the handle's `maxComputeUnitPrice` option (10,000,000
micro-lamports per compute unit by default, so at most 0.014 SOL of priority fee per
transfer), and the limit is a simulation plus 20% and 1,000 units. The override is
`{ computeUnitPrice, computeUnitLimit? }` (`SolanaFeeOverride`), in micro-lamports per
compute unit and compute units, as bigints only; a price above `maxComputeUnitPrice` is
refused before signing. [Solana networks](./networks.md#solana-networks) explains the
charges, the limit, the bound and how each build varies it.

On TON, `slow`, `normal` and `fast` give the same estimate: the network config sets every
price. A Gram transfer's `ton` fee is one `network` charge with an `expected` bound; a
jetton transfer adds an `attached` charge, the Gram sent along to its jetton wallet (0.05
GRAM by default, the unspent part refunded), and its bound is `upper`. The only override is
`{ attached }` in nanograms, as a bigint (`TonFeeOverride`), on jetton transfers. On TON
`estimateFee` needs the handle's wallet, and it can throw `INSUFFICIENT_FUNDS` when the
wallet cannot pay; its `details.required` is then a lower bound, with only the least gas a
wallet run can cost.
[TON networks](./networks.md#ton-networks) covers the charges and the fee ceiling.

**No endpoint can raise a fee above your bound.** Every family's prices come from a node,
so every family bounds them by a handle option that no endpoint can change: EVM
`maxFeePerGas`, Bitcoin `maxFeeRate`, `maxFee` and `maxEstimatedFeeRate`, Tron
`maxFeeLimit`, Solana `maxComputeUnitPrice`, and TON `maxNetworkFee` (on the estimate; TON
signs no fee). A node's suggestion above the bound is clamped to it or not trusted, an
explicit fee above it is refused before signing, and the build checks it again. Set each
bound to your fee policy; the defaults stop an absurd fee, not an expensive one.

### Cold, offline and asynchronous signing

A wallet without a signer, such as `{ publicKey: '<hex>' }`, is watch-only. `transfer` then
throws `SIGNER_UNAVAILABLE`, but `prepareTransfer` works. It builds and stores the unsigned
transaction and reserves the nonce. Then it returns the signing requests. You sign them
elsewhere and hand back the signatures:

```ts
const cold = aio.blockchain({ chain: 'fakechain', wallet: 'cold' }); // wallets.cold = { publicKey }
const prepared = await cold.prepareTransfer({ to, amount: 7n }, { idempotencyKey: 'cold-1' });
const requests = prepared.unsigned?.signingRequests ?? []; // { id, scheme, payload, publicKey }
const signatures = await offlineDevice.sign(requests); // SignatureBundle[]: { requestId, bytes, recovery? }
const sub = await cold.submitSignatures(prepared.operation.id, signatures);
```

The core verifies each signature against its request's public key (`SIGNATURE_MISMATCH`
otherwise). The Operation moves to `signed` only when every request is signed. You can submit
partial sets. A `callbackSigner` that answers `{ status: 'pending', ticket }` parks the
Operation in `awaiting-signature` in the same way. Finish it with `submitSignatures`, or call
`abandon(operationId)`. `abandon` works only before anything is signed. It releases the
nonce and cancels pending signer tickets.

Where the chain's driver can read one, `submitSignatures` also takes the whole transaction
signed elsewhere, for example a PSBT back from a hardware wallet:
`cold.submitSignatures(prepared.operation.id, { encoding: 'base64', data: signedPsbt })`. The
driver extracts the signatures, and only their bytes are used: the core verifies each one
against its stored request, exactly like a bundle. A payload that is not the prepared
transaction is refused: `INVALID_INTENT` when the driver tells it apart, otherwise
`SIGNATURE_MISMATCH` from the core's check. A chain whose driver cannot read one throws
`UNSUPPORTED_CAPABILITY` (submit bundles there). The Operation must belong to the handle's
chain, network and wallet, as for bundles.

On Bitcoin, the prepared payload is the PSBT, as base64, with one signing request per input.
Sign it with any PSBT signer and hand back the signed PSBT as base64. Only its signatures
are used, and each is verified like a bundle; a PSBT whose transaction differs from the
prepared one fails with `INVALID_INTENT`.

```ts
const prepared = await btc.prepareTransfer({ to, amount: '0.01' }, { idempotencyKey: 'cold-7' });
const psbt = prepared.unsigned?.payload.data; // base64: sign it on the hardware wallet
await btc.submitSignatures(prepared.operation.id, { encoding: 'base64', data: signedPsbt });
```

On Solana, the one signing request is an `ed25519` signature over the transaction's message
bytes (`payloadKind: 'message'`), and `submitSignatures` takes bundles only. The message
names a recent blockhash, valid for about a minute: sign within that time. Signatures that
come later give a transaction that nodes refuse (`blockhash not found`); it ends `expired`
once that is proven, and `rebuild` then needs a synchronous signer.

On TON, the one signing request is an `ed25519` signature over the 32-byte hash of the
wallet request (`payloadKind: 'message'`), and a watch-only wallet needs its `ton` settings
next to its `publicKey`. The request lives 60 seconds of chain time from its build: sign it
within that minute, or it ends `expired`, and `rebuild` then needs a synchronous signer.

## Lifecycle and `stalled`

```text
created -> prepared -> [awaiting-signature] -> signed -> submitted -> included -> final
   |           |                |                           |    ^
   +-----------+----------------+--> abandoned              v    |  (rebroadcast, replace,
   +-> failed (before signing: validation, funds, policy) stalled-+   cancel, proof)
submitted | stalled | included --> failed | expired | final   (only on proven evidence)
```

An Operation is **`stalled`** when a node refused its signed transaction for a reason that
can change, such as `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW` or `NONCE_TOO_HIGH`. `transfer`
throws that error, with `context.operationId`. The Operation keeps its nonce and its signed
bytes, because the transaction may still be valid later or may already be included.
Workers keep observing it, and `aio.on('operation.stalled', …)` tells you. What to do:

| Action | When | Capability |
| --- | --- | --- |
| `bc.rebroadcast(id)` | You fixed the cause (for example topped up the wallet); resends the same bytes | none |
| `bc.replace(id, { fee })` | The fee was too low; a new Attempt with the same nonce and a higher fee | `replace-fee`, synchronous signer |
| `bc.cancel(id, { fee? })` | You want to stop the payment; a conflicting self-transfer, `outcome: 'cancelled'` only if it wins at finality | `cancel`, synchronous signer |
| `bc.abandon(id)` | **Not** for `stalled`. Only for `created`, `prepared` or `awaiting-signature` | none |

`replace` is idempotent per fee spec: repeating the same `fee` returns the same replacement.
To bump again, pass a higher explicit override. A repeated `cancel` returns a pending cancel
unchanged. Only a cancel that a node refused or dropped is bumped, one step per call. Passing
`fee` builds a new cancel, but only while no cancel is on chain. `cancel` can lose the race:
if the original is already mined, it throws `NONCE_CONFLICT`, and the outcome stays
`executed`. Replace and cancel never happen automatically.

On EVM, a replacement or cancel reuses the nonce and must raise both the fee cap and the tip
(the gas price on `evm-legacy`) by the network's `replacement.minBumpPercent` (10), or it
throws `FEE_TOO_LOW`. A speed re-estimates the fee, which on a quiet network is often not
10% higher; on Polygon mainnet all three speeds often sit at the 25 gwei tip floor. So pass
an explicit override that raises each price by at least 10%. A cancel is a zero-value
transfer to yourself, at the smallest valid bump unless you pass `fee`. Arbitrum has no
mempool, so it supports neither (`UNSUPPORTED_CAPABILITY`).

A node's rejection is a claim, and every family checks it against the bytes it sent before
it ends anything: on EVM networks, "invalid sender", "invalid chain id", "rlp: …" and "tip
above fee cap" stand only when the signed bytes, read by the library itself, really carry a
bad signature, another chain id, a broken encoding or a tip above the cap. Otherwise the
answer is a refusal ("the node claimed the transaction is invalid"): the Operation stalls
instead of failing, so an endpoint that lies and relays the bytes later can never make you
pay twice. Retry a stalled transfer only with `rebroadcast` or the same idempotency key.

On Bitcoin, a replacement or cancel (BIP125) spends every input of the transaction it
replaces, and must pay the old fee plus 1 sat/vB of its own size, at a higher rate, or it
throws `FEE_TOO_LOW`. A cancel pays everything, minus its fee, back to the sending address.
When the original is already mined, a replacement or cancel throws `TX_REFUSED` (its inputs
are spent) until the workers see that block, and `INVALID_TRANSITION` once the Operation is
`included`; either way nothing new can land, and the outcome stays `executed`. A signed
transfer that a node refused stays `stalled` with its inputs held, and `abandon` refuses it,
because its bytes may already be relayed. Never retry it as a new transfer (a new
idempotency key): the new Operation spends other coins, and both can confirm. Repeat the
call with the same key, or `rebroadcast`, `replace` or `cancel` it; see
[Bitcoin networks](./networks.md#bitcoin-networks) for how it resolves.

On expiry- and seqno-based chains (Tron, Solana and TON today; `fakeexpiry` and
`fakeseqno` in the testing kit), `bc.rebuild(id)` re-issues an Operation after its expiry is
**proven** (`expired`, error `TX_EXPIRED`). It adds a `rebuild` Attempt and reopens the
Operation. Other chains throw `UNSUPPORTED_CAPABILITY`. Replace, cancel and rebuild sign a
new Attempt on the spot, so they need a synchronous signer: a signer that answers `pending`
fails them with `SIGNING_FAILED`.

**On Tron, a refusal means: do not pay again; the Operation is still live.** Tron has no
replace and no cancel (`UNSUPPORTED_CAPABILITY`). A Tron Operation is `stalled` with
`TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` when a node refused its signed bytes, and
those bytes may still land. `TX_REFUSED` also covers a node that claims the bytes can never
be valid when the library cannot confirm that claim from the bytes it sent: a lying or buggy
endpoint may have relayed them anyway, or may keep them to relay later. A liar and a genuine
refusal look the same, so repeat a call only with the **same** idempotency key, never a new
one. A `TX_EXPIRED` refusal is likewise one node's view at its own head, not proof. Fix the
cause and `bc.rebroadcast(id)` within the expiration window, or let the workers watch it:
the Operation ends `final` if the transaction lands, or `expired` once its expiry is proven,
and only then does `bc.rebuild(id)` sign a new Attempt.

**On Solana, a refusal means: do not pay again; the Operation is still live.** Solana has
no replace and no cancel (`UNSUPPORTED_CAPABILITY`). A Solana Operation is `stalled` with
`TX_REFUSED` or `INSUFFICIENT_FUNDS` when a node refused its signed bytes, and those bytes
may still land until the window of their blockhash has passed. The usual case is
`blockhash not found` on the first broadcast, from an endpoint that lags behind the one
that served the blockhash. `TX_REFUSED` also covers a node that claims the signature is
invalid when the library's own check of the bytes it sent finds every signature valid: a
lying endpoint may have relayed them anyway. The workers never resend a `stalled` transfer,
so after any refusal, even a false one, retry only with `bc.rebroadcast(id)` while the
blockhash is valid, or by repeating the call with the **same** idempotency key, never a new
one. The workers keep watching it: the Operation ends `final` if the transaction lands, or
`expired` once its expiry is proven, and only then does `bc.rebuild(id)` sign a new
Attempt. Proving the expiry reads every block of the window, which the `public` preset
does only slowly, over many passes ([Solana networks](./networks.md#solana-networks)).

**On TON, a refused or unanswered send means: do not pay again.** TON has no replace and no
cancel (`UNSUPPORTED_CAPABILITY`), and a wallet sends one transfer at a time: another one
fails with `SEQUENCE_BUSY` until the first is `included` or has ended. toncenter answers
every refused message with HTTP 500, which the library reads as "maybe sent", so the
transfer surfaces as ambiguous; another endpoint's definitive refusal leaves it `stalled`.
Either way the message may still land within its 60-second lifetime. The workers watch it
until it is proven `final` or `failed`, or `expired` once its lifetime has passed, and only
then does `bc.rebuild(id)` sign it again, at the wallet's next seqno.

## Waiting and watching

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
  ([Tron networks](./networks.md#tron-networks)).
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
  ([Solana networks](./networks.md#solana-networks)).
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
  archival ([TON networks](./networks.md#ton-networks)).

## Background workers and startup recovery

Nobody needs to wait on an Operation. Workers claim due Operations from the store, observe
them, rebroadcast dropped ones, report nonce gaps (`nonce.gap`), and apply proven verdicts.
Any number of processes can run workers on shared stores. Each claim carries a token, and a
worker whose claim expired and was taken over has its writes refused (`FENCING`).

```ts
const aio = new CryptoAio({ namespace: 'payments', stores, signers, wallets, chains, providers });
const report = await aio.operations.recover(); // at startup, before serving
// report: { rebroadcast, checked, skipped, failed, reconciled }
const stop = new AbortController();
const workers = aio.monitor.start({ workerId: `api-${process.pid}`, signal: stop.signal });
process.once('SIGTERM', () => stop.abort());
await workers;
await aio.close(); // closes native clients and pooled drivers
```

- `recover()` resends `signed` and ambiguously `submitted` Operations, checks the other
  signed ones on chain, and returns leaked nonces for reuse. `created`, `prepared`,
  `awaiting-signature` and `stalled` Operations need you, so it skips them with a
  `recovery.skipped` event.
- Workers and `recover()` **never sign and need no signer**. They read through the
  Operation's chain, network and library with the current configuration. A resend or a nonce
  reconciliation needs only the Operation's wallet, and a watch-only wallet is enough. You can
  rotate or remove a signer while Operations are in flight.
- A nonce that leaked in a crash (allocated, never stored) is also reclaimed by the next
  `transfer` or `prepareTransfer` from that wallet, so a quiet wallet never stays blocked.
- `aio.monitor.runOnce({ workerId, batch })` runs one pass and returns how many Operations it
  claimed. Use it from a scheduler.
- Call `close()` on the root container; a scope's `close()` does nothing. After it, handle
  methods and `native()` throw `StateError` (`INVALID_TRANSITION`). It also stops every
  `monitor.start()` loop, and a running `runOnce()` or `recover()` at its next check, so
  the closed container claims no more Operations; starting one afterwards throws
  `INVALID_TRANSITION` too.
- Tune timing with `lifecycle`: `pollIntervalMs`, `droppedGracePeriodMs`,
  `rebroadcastIntervalMs`, `leaseMs`, `claimLeaseMs`, `waitTimeoutMs` and `signTimeoutMs`.

## Receiving

### Scanner (`block-scan`)

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
  instead; [TON networks](./networks.md#ton-networks) shows how deposits appear there, that
  they are `observed` only, and why to read each one you credit again through an
  independent provider and indexer pair.

### Address history (`address-history`)

`bc.history(address, { cursor?, limit? })` returns `{ items: Transaction[], next? }`. Most
families read it from an indexer provider; Solana reads its RPC. The fake chain has none,
and the EVM family does not support one yet, so both throw `UNSUPPORTED_CAPABILITY`. Tron
serves it from TronGrid: name the `trongrid` or `public` preset as the handle's `indexer`. A
transaction can come more than once (on Tron, a call to a contract account that moves its
own tokens comes in both parts of the listing, [Tron networks](./networks.md#tron-networks)),
so dedupe on `transfer.id`, as for scans.
On Bitcoin it reads the Esplora indexer and lists confirmed transactions only, newest first.
Credit from it as from the scanner: skip a transfer whose `to` is among its `from`
addresses, which is the sender's change or a cancel's refund.

Solana needs no indexer: its RPC serves history (`getSignaturesForAddress`), newest first,
at most 1,000 per page, and each item is read back with two requests (the transaction, then
its block's header). An SPL deposit into an existing token account appears in that token
account's history, not the owner's; `bc.ext.solana.getTokenAccounts(owner)` lists an owner's
token accounts. History ends at the provider's retention
([Solana networks](./networks.md#solana-networks)).

TON reads it from its indexer (toncenter API v3); [TON networks](./networks.md#ton-networks)
shows how its deposits appear there and how to credit them.

### Crediting deposits

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
jetton wallet ([TON networks](./networks.md#ton-networks)). A scanner in `final` mode emits
a block only once the network's finality policy holds, and it decides a rollback only when
the proof quorum serves a different block hash, but the transfers in a block are what the one
endpoint that served it reported: a lying endpoint could add a transfer to a real block. The
second read through an independent provider catches that.

## Error handling

Find the Operation with `error.context.operationId`, then read its state with
`bc.getOperation(id)`. The rule: **never create a new transfer while the old one might
land.**

| Code | Meaning | Safe action |
| --- | --- | --- |
| `ambiguous: true` (any code) | Outcome unknown, for example a lost broadcast reply | Retry with the **same** key, or let workers resolve it |
| `INVALID_AMOUNT`, `INVALID_ADDRESS`, `INVALID_INTENT`, `ASSET_RESOLUTION` | Input refused; nothing stored | Fix the input |
| `IDEMPOTENCY_CONFLICT` | Key reused for a different intent | Treat it as a bug; inspect the existing Operation |
| `INSUFFICIENT_FUNDS`, `POLICY_REJECTED` with state `failed` | Failed before signing; nonce released | Fix the cause; retry with a **new** key |
| `POLICY_REJECTED` with state `prepared` | The `beforeSign` hook vetoed after the address lease was lost (a `prepareTransfer` hook that outlasted `lifecycle.leaseMs`), so nothing was written | Repeat with the **same** key; the hook runs again |
| `INSUFFICIENT_FUNDS`, `FEE_TOO_LOW`, `NONCE_TOO_HIGH`, `TX_REFUSED` with state `stalled` | Node refused signed bytes | `rebroadcast` after the fix, `replace` or `cancel`; never a new key |
| `NONCE_CONFLICT` | A cancel or replacement lost: the original is already mined | Wait for the original |
| `NONCE_CONFLICT` with `details.heldBy` | The signed transaction is identical to another Operation's, so it would pay once for both; nothing was sent. From `transfer` or `submitSignatures` the Operation is `failed`, or, if it is still `prepared` or `awaiting-signature` (a renew or version conflict), repeat with the **same** key (for `submitSignatures`, resubmit the signatures) so it is refused and failed. From `replace`, `cancel` or `rebuild` it is unchanged | `failed`: retry with a **new** key. `replace` or `cancel`: use another fee spec. `rebuild`: rebuild later. A later build (a new block, or the driver's build variant) gives different bytes |
| `SEQUENCE_BUSY`: "another operation is recording the same transaction; retry" | Another process is recording an identical transaction right now; nothing was recorded | Repeat the call (the **same** key, fee spec or signatures). For `submitSignatures`, resubmit the signatures |
| `TX_REVERTED`, `TX_EXPIRED`, `TX_REPLACED` with state `failed` or `expired` | Proven terminal failure. For `TX_REPLACED`, another transaction is final in the slot | Reconcile; a new transfer with a new key is safe, except for an EVM or Tron token `TX_REVERTED` whose receipt succeeded: value may have moved, so check the chain first ([token verdicts](#waiting-and-watching)) |
| `TX_REJECTED` | Nodes rejected every Attempt as never valid; nonce released | Fix the cause; retry with a **new** key |
| Tron: `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes, or claimed they are invalid; they may still land. A liar and a genuine refusal look the same | Never pay again: repeat only with the **same** key. `rebroadcast` after the fix; `rebuild` only once the Operation is `expired` (see "Lifecycle and `stalled`" above) |
| Tron: `TX_REVERTED` with reason `token transfer not evidenced` | The token call succeeded on chain but logged no `Transfer` to the recipient; value may have moved | Check the chain before you pay again ([Tron token verdicts](#waiting-and-watching)) |
| Solana: `TX_REFUSED` or `INSUFFICIENT_FUNDS` with state `stalled` | A node refused the signed bytes (often `blockhash not found`), or claimed a signature the library found valid is invalid; they may still land until their window has passed | Never pay again: `rebroadcast` while the blockhash is valid, or repeat only with the **same** key; the workers never resend it. `rebuild` only once the Operation is `expired` |
| TON: ambiguous, or `stalled` after a refusal | toncenter answers every refusal with HTTP 500 ("maybe sent"); the message may land until it expires | Never a new key. Wait for `final`, `failed` or `expired`; `rebuild` only once it is `expired` |
| TON: `TX_REVERTED` with reason `the jetton wallets are not the master’s` | The recipient's jetton wallet is not the one the master names for the recipient (a non-standard jetton); the jettons left your wallet | Check the chain before you pay again ([TON verdicts](#waiting-and-watching)) |
| TON: `TX_REPLACED` | A request signed with the wallet's key, not this transfer, used its seqno | Find what else holds the key and stop it; then a new key is safe |
| `TIMEOUT` | A wait ran out; state unchanged | Wait again |
| `SEQUENCE_BUSY` | A seqno wallet still has a message in flight | Retry later with the same key |
| `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_INCONSISTENT` (not ambiguous) | A read failed | Retry later |
| `PROVIDER_MISCONFIGURED` | The endpoint serves another network | Fix the configuration |
| `SIGNER_UNAVAILABLE` | Watch-only wallet or unknown signer | Use `prepareTransfer`, or fix the configuration |
| `INVALID_TRANSITION` | Not allowed in this state, or the container is closed | Read the state first |
| `UNSUPPORTED_CAPABILITY` | The handle cannot do this | Check `bc.supports(…)` |
| `SCANNER_REORG_TOO_DEEP` | Reorg deeper than the scanner window | Stop crediting; reset the cursor explicitly |
