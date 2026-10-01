---
title: TON networks
description: "TON: wallets, jettons, message traces, seqnos, resends and proofs."
---

# TON networks

The TON family serves the `ton` chain on `mainnet` (the default) and `testnet` through
`@ton/ton` 16, which needs `@ton/core` 0.63 and `@ton/crypto` 3 next to it (`npm install
@ton/ton @ton/core @ton/crypto`). The coin is Gram (ticker `GRAM`, formerly Toncoin), with 9
decimals: a `bigint` amount is in nanograms, and `asset: 'GRAM'` and its alias `'TON'` both
name it. A transfer moves Gram or one jetton to one recipient, with an optional text memo.
The [Build guides](../../build/index.md) cover what else differs on TON:
[verdicts and proofs](../../build/confirmations.md),
[refusals](../errors.md#what-to-do-about-each-error) and
[receiving](../../build/receive.md).

| Network | Global id (identity) | Explorer |
| --- | --- | --- |
| `mainnet` (default) | -239 | tonviewer.com |
| `testnet` | -3 | testnet.tonviewer.com |

- **A provider and an indexer.** `provider` is toncenter's API v2, a liteserver proxy
  (account state, get-methods, fee emulation, sending), and `indexer` is its API v3 (which
  transaction a message became, message traces, history). The indexer is required: without
  it no transfer could ever be proven `final`. A handle without a `provider`, or without an
  `indexer`, falls back to the keyless `public` preset for it, with a logged warning, so
  name both. Every endpoint's health check reads the network's global id, so an endpoint of
  the other network is refused (`PROVIDER_MISCONFIGURED`). A custom pair is any
  toncenter-compatible v2 and v3: `{ endpoints: [{ url: 'https://…/api/v2' }] }` and
  `{ endpoints: [{ url: 'https://…/api/v3', kind: 'indexer' }] }`.
- **Presets and rate limits.** `toncenter` needs an `apiKey`, which travels in the
  `X-API-Key` header as a `Secret`, never in a URL; named as a `provider` it is API v2, and
  as an `indexer` API v3. `public` is the same service without a key, for trying things out,
  not for production. toncenter allows one request per second per network without a key
  (per IP) and 10 with a free key (per key), shared by v2 and v3, so each preset endpoint
  takes half: 0.5 requests per second keyless, 5 with a key, each with a burst of 1. Health
  checks take their tokens from the same buckets, and a 429 answer is a retryable
  `RATE_LIMITED`. A paid key allows more: configure it as a custom pair with your own
  `rateLimit`, half of your plan's limit on each (on testnet, `testnet.toncenter.com`):

  ```ts
  const headers = { 'X-API-Key': secret(process.env.TONCENTER_KEY ?? '') };
  const rateLimit = { rps: 12.5, burst: 2 }; // half of your plan's limit (25 per second here)
  const providers = {
    'tc-v2': { endpoints: [{ url: 'https://toncenter.com/api/v2', headers, rateLimit }] },
    'tc-v3': {
      endpoints: [{ url: 'https://toncenter.com/api/v3', kind: 'indexer' as const, headers, rateLimit }],
    },
  };
  ```

  A rate limit belongs to a transport, and every container, and every handle whose
  `options` or `maxLagBlocks` differ from another's, gets its own driver and transport. So
  several of them in one process can together exceed toncenter's limit for your IP or key:
  keep one configuration per network, set once in `chains.ton`.
- **Proof endpoints and their burst.** The presets' burst of 1 keeps them near toncenter's
  limit, and costs liveness: a proof read first refreshes a recovering
  endpoint's health, which spends a burst-1 endpoint's only token, so the endpoint may skip
  the trial request that would let it rejoin the proof quorum, for as long as proof reads
  keep it busy. On endpoints you configure for proofs, set `burst: 2` or more where your
  plan allows it.
- **Two or three independent providers.** `toncenter` and `public` are one service:
  configured together they count as two endpoints, yet they are one source, so toncenter
  alone then decides finality, bounces, a jetton's decimals and whether a transfer is
  proven absent, which `rebuild` acts on. Proofs read the provider and the indexer under the
  proof quorum, so configure two or more independent toncenter-compatible pairs, ideally
  three, for example toncenter and your own: with three, a quorum of two survives one
  outage. With two, once one has failed its health checks for about three refreshes, the
  other decides alone until the first recovers.
- **Archival endpoints for proofs.** Proofs walk a wallet's transactions back through a
  message's lifetime and run jetton get-methods at a transfer's own block, and history runs
  those get-methods at each jetton deposit's block. A node that has pruned a block answers
  "not ready", or "no state" (exit code -13) for the jetton wallet asked; neither decides
  anything: the proof, or the history read that holds the deposit, waits until an endpoint
  that has the block answers. Run archival nodes behind the endpoints you configure.
  toncenter answered for old blocks on both networks when this was written.
- **Wallets.** `wallets.<name>.ton` names the wallet contract, and every field decides the
  address: `{ version: 'v4r2', workchain?, subwalletId? }` (default `698983191` plus the
  workchain) or `{ version: 'v5r1', workchain?, subwalletNumber?, networkGlobalId? }`
  (default subwallet 0; the network id defaults to the network's and may only equal it, so
  a v5r1 wallet has another address on each network). `workchain` is 0 (the default) or -1.
  `bc.walletAddress()` shows the address as wallet apps do (`UQ…`, or `0Q…` on testnet):
  compare it with your wallet app before you fund it. An undeployed wallet can receive, and
  its first transfer deploys it. A watch-only wallet needs its `ton` settings too:
  `{ publicKey: '<hex>', ton: { version: 'v5r1' } }`. `Blockchain.estimateFee` needs the
  handle's wallet, since the fee is emulated with its code: without one it fails with
  `INVALID_INTENT`, or with `CONFIG_INVALID` when the intent names a `from`.
  For keys, see [Local signers](../../build/keys.md#local-signers).
- **One output per transfer.** A TON wallet delivers each output of a batch in its own
  transaction, so a batch can partly land: one output can bounce while the others are
  credited, and a single verdict for the whole transfer would either invite a resend that
  pays the landed outputs twice or hide a failed one. So in this release a TON transfer
  carries exactly one output: `batch-transfer` is not a TON capability, `bc.limits()`
  answers `{ maxOutputs: 1 }`, and more than one output fails with `UNSUPPORTED_CAPABILITY`
  before anything is built. Batch payouts are not supported yet.
- **Addresses and bounce.** Canonical addresses are raw (`0:<hex>`, lower case); `display`
  keeps the form you wrote, and `address.format({ raw: true })` gives the raw one. The form
  decides bounce: `UQ…` and `0Q…` never bounce, while `EQ…`, `kQ…` and raw addresses do. To
  pay a fresh (undeployed) wallet, use its `UQ…` form: a bounceable message to it comes
  back, less fees, and the transfer fails with `transfer bounced`. Some wallet apps switch a
  non-bounceable address to bounceable when the recipient is an active contract; the
  library never changes the flag: it sends what you wrote. Mainnet refuses the testnet-only
  forms `kQ…` and `0Q…` (`INVALID_ADDRESS`).
- **Address forms and idempotency.** The bounce flag is part of the intent, so the same
  recipient written as `UQ…` and as `EQ…` (or raw) is two intents: reusing an idempotency
  key with the other form fails with `IDEMPOTENCY_CONFLICT`. The testnet flag and the base64
  alphabet only change how an address is shown: every spelling with the same bounce flag is
  the same intent.
- **Transfer ids.** An Attempt's id is the normalized hash (TEP-467) of its external message,
  in hex (`idKind: 'message-hash'`, `canonical: false`). Once the indexer has the
  transaction, its hash appears as `txHash` in the status. `getTransaction` takes either.
- **Seqno and expiry.** A wallet sends one transfer at a time: another transfer from it
  fails with `SEQUENCE_BUSY` (retryable, with `context.blockingOperationId`) until the first
  is `included` or has ended. For more throughput, send from several wallets: another
  subwallet id or number gives the same key another address. A message lives 60 seconds of
  chain time from its build (`validForSeconds`, fixed in this release). A build refuses an
  endpoint whose chain time is more than 5 minutes from your server's clock (a retryable
  `PROVIDER_INCONSISTENT`), so keep the clock in sync: builds refused for chain-time skew
  mean fix the clock, not the endpoint. An endpoint and a clock both more than 5 minutes
  ahead at a build could let a later proof miss a wallet reset, the one case this check
  cannot catch. A message that never lands is proven
  `expired` about a minute after its build, and `bc.rebuild(id)` then signs it again at the
  wallet's next seqno. `rebuild` signs on the spot, so it needs a synchronous signer; with
  `prepareTransfer` or a `pending` signer, sign within that minute. TON has no replace and
  no cancel (`UNSUPPORTED_CAPABILITY`).
- **Refusals.** toncenter answers every refused message with HTTP 500, which the library
  treats as "maybe sent": the transfer surfaces as ambiguous, and a node that answers "not
  ready" or "busy" is treated the same way. Another v2-compatible endpoint's definitive
  refusal leaves the Operation `stalled` (`NONCE_CONFLICT`, `TX_EXPIRED`, `TX_REFUSED` or
  `INSUFFICIENT_FUNDS`). Either way the message may still land within its lifetime, and the
  Operation ends only on proof: `final` or `failed` if it landed, or `expired`, after which
  `rebuild` sends it again. Only bytes that are no TON message at all are `rejected`, and
  the library never builds those. Never pay again with a new key while the Operation lives.
- **Resends.** A wallet reset (emptied and deleted, then re-funded or deployed again with
  its seqno back at 0) makes a message that already ran runnable again. So before the TON
  driver sends signed bytes again (a caller's retry with the same key, a rebroadcast of a
  dropped transfer, `bc.rebroadcast`, `recover()`, or `bc.broadcast` of a wallet message),
  it checks the wallet's chain: from the newest state an endpoint serves, linked to the
  state the proof quorum attests, back to the message's build time (for bytes this process
  did not build, the longest lifetime a message can have, a day). A message that already
  ran is not sent again (`already-known`). While a deletion or a new deployment cannot be
  ruled out, or the check cannot finish (a rate limit, an indexer that is behind), nothing
  is sent: the call fails with a retryable, ambiguous `PROVIDER_UNAVAILABLE`, and the proof
  decides later. The first send of bytes built in the same process, and any send once the
  wallet's seqno is past the message's, go out without the check. That first send skips it
  only within 2 seconds of assembling the signed bytes, so a later one (after a slow store
  write or a paused process) is checked too: several processes sharing one store are
  covered only through that bound. The check costs a few quorum reads, plus one per 32
  wallet transactions it has not read before; on the keyless preset allow several seconds.
  It protects only the library's own sends: after a reset under a shared key, anyone who
  saw the message can send it again while it is valid, and no client can prevent that.
- **Replaced.** TON never reports an observed `replaced` for your own message: masterchain
  state is final, so a transfer that landed but is not indexed yet stays `submitted` or
  `included` until the indexer catches up. A proven `replaced` (`TX_REPLACED`) means that a
  request signed with the wallet's key, not this transfer, used its seqno: something else
  is sending from the wallet. Never share a wallet's key with other software
  ([why](../../build/keys.md#local-signers)).
- **Fees (`ton`).** `slow`, `normal` and `fast` give the same estimate: the network config
  sets every price. A Gram transfer's fee is one `network` charge, with an `expected` bound:
  the import, gas and storage fees from the endpoint's emulation, plus the forward fee,
  never below the config's own formula (one more request per estimate). `fee.details`
  (`TonFeeDetails`) splits it and says whether the transfer deploys the wallet. A jetton
  transfer adds an `attached` charge, the Gram sent along to your jetton wallet (0.05 GRAM
  by default, the unspent part refunded), and its bound is `upper`. The only override is
  `{ attached }` in nanograms, as a bigint (`TonFeeOverride`), on jetton transfers; it must
  exceed the 1-nanogram forward amount. An estimate whose `network` charge exceeds 1 GRAM
  (a basechain wallet) or 100 GRAM (a masterchain wallet) is not trusted: it is a retryable
  `PROVIDER_INCONSISTENT`, so one endpoint cannot fail a transfer for good with an inflated
  fee. TON signs no fee, so the chain charges its own prices either way. Set the ceiling in
  nanograms with the `maxNetworkFee` option, `{ basechain?, masterchain? }` as bigints, in
  `chains.ton.options` or a handle's `options` (a network of a plugin may also set it in its
  `params`); for each workchain the option wins, then the network's value, then the
  default. It is the TON driver's only option: any other key is refused with
  `CONFIG_INVALID`. Set it once per chain rather than per handle: handles with different
  options get their own transports, so two keyless handles make twice the requests
  toncenter allows one address.
- **Funds.** Before signing, the wallet needs Gram for the fee and the amount, or for the
  fee and the attached value plus the jettons (`INSUFFICIENT_FUNDS`). A wallet that cannot
  pay can already fail the estimate with `INSUFFICIENT_FUNDS`; its `details.required` is
  then a lower bound: the amount (or the attached value), the forward fee, and the flat gas
  price every wallet run pays (config param 21, or 20 for a masterchain wallet). Leave
  room for the rest of the gas: a wallet that covers
  that bound but not the whole run gets a retryable `PROVIDER_INCONSISTENT` from the
  estimate instead, so a transfer of nearly the whole balance keeps failing with it. Right after a wallet's first transfer deploys it, an
  endpoint that lags can answer that way too until it catches up.
- **Finality.** `final` needs masterchain inclusion and a completed message trace in which
  the value moved. A masterchain block is final once it exists, so `getFinalizedHeight()` is
  the masterchain head, while proofs attest a block 10 below it. An endpoint more than 150
  masterchain blocks (about a minute) behind the best is lagging.
- **Jettons.** `asset: { standard: 'jetton', contract: <master> }`, or the alias `USDT` on
  mainnet (Tether's master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, 6 decimals);
  testnet has no catalog tokens. A transfer goes through your jetton wallet, the one the
  master names for your wallet under the proof quorum (`bc.ext.ton.jettonWallet(owner,
  master)` shows it). It forwards 1 nanogram so the recipient gets a notification, which
  carries the memo, and the excess comes back to you. A jetton transfer ignores the
  recipient address's bounce flag: the jetton standard (TEP-74) decides bouncing on the
  jetton wallets' own messages. It is `final` only when the recipient's jetton wallet, the
  one the master names for the recipient, received a positive amount from yours.
- **Jetton decimals.** A jetton's symbol and decimals are read under the proof quorum and
  cached for the container's life. Metadata kept wholly on chain states them, or means 9
  decimals (TEP-64's default). Metadata that links to an off-chain document takes them from
  the indexer's copy of that document, never from a default: while it states no decimals,
  or the indexer has not fetched it, the jetton stays unresolved, and that is never cached,
  so a later read resolves it once the indexer has it. A history page or `getTransaction`
  that holds a transfer of it still reads: the transfer arrives unresolved, with its raw
  amount in base units and the code `PROVIDER_UNAVAILABLE`
  ([unresolved assets](../../build/receive.md)), and never counts as a deposit
  until you know its decimals. Anyone can send such a jetton to your address. A call that
  needs the decimals, such as a transfer of the jetton, fails with a non-retryable
  `PROVIDER_UNAVAILABLE` before anything is signed. That refusal records nothing, not even
  an Operation under the idempotency key, so the same call can simply be repeated later,
  once the indexer has the metadata. Register the decimals of a jetton you use yourself,
  from its issuer, with a plugin of your own; the library then trusts them as you wrote
  them:

  ```ts
  aio.use({
    name: 'my-jettons',
    assets: [{
      chain: 'ton', network: 'mainnet', aliases: ['XYZ'],
      ref: { standard: 'jetton', contract: '0:<master, raw, lower case>' },
      metadata: { symbol: 'XYZ', decimals: 9 },
    }],
  });
  ```

  A jetton you register this way is never read from the chain, so never register one you
  do not accept: leave it unresolved, and never credit it.
- **Memos** are text comments of at most 1,024 UTF-8 bytes, public forever. A deposit's memo
  arrives as `transfer.memo`: a Gram deposit's from its message, a jetton deposit's from the
  forward payload its arrival carries (the notification repeats it).
- **Receiving.** There is no block scanner (TON is sharded): `bc.scanner()` throws
  `UNSUPPORTED_CAPABILITY`. `bc.history(address, { cursor?, limit? })` lists the address's
  transactions from the indexer, newest first, at most 1,000 per page, and only those the
  indexer reports final. A Gram deposit is the `msg:in` transfer of the transaction that
  received it; a bounce that brings your own value back is `source: 'internal'`, a refund,
  not a deposit. A jetton deposit is decoded only from a jetton wallet that the master itself
  names for the owner, since anyone can deploy a contract that claims a master. **Credit a
  jetton deposit only from its arrival**: the `msg:in:jetton` transfer in the history of
  the owner's jetton wallet (`bc.ext.ton.jettonWallet(owner, master)`), whose `to` is the
  owner. Every jetton transfer arrives there, one sent with no forward amount included. The
  owner's own history shows the same movement a second time, from the notification the
  jetton wallet sends on (also `msg:in:jetton`, with another transfer id and the same
  `details.traceId`): never credit that one, or one deposit counts twice. One trace (one
  external request) may carry several genuine transfers to the same owner, so a trace id
  is not a dedupe key; dedupe on the arrival's transfer id.
- **Crediting deposits.** History entries are reads of one provider and one indexer, so
  their evidence is `observed` (with `finality: 'final'`), never `proven`, as every family's
  deposits are ([Crediting deposits](../../build/receive.md#crediting-deposits)), and a jetton
  deposit's genuineness also rests on the provider's get-methods. So before you credit any deposit automatically (or any above your risk
  threshold), read it again through an independent provider **and** indexer pair, for
  example `bc.with({ provider: 'own-v2', indexer: 'own-v3' }).getTransaction(tx.id)`, and
  credit it only when both reads are final and agree on the transaction hash, the
  recipient, the asset, the amount and the memo.
- **Extras and types.** `bc.ext.ton.getSeqno(address)` reads a wallet's seqno (0 while it
  is undeployed), and `bc.ext.ton.jettonWallet(owner, master)` the jetton wallet the master
  names for an owner. `crypto-aio/ton` exports `TON_CAPABILITIES`,
  `TON_INDEXER_CAPABILITIES` and `TON_PEER_DEPENDENCIES`, and importing it types
  `native(bc, '@ton/ton')` as a `TonClient` ([Keys, signers and secrets](../../build/keys.md));
  the root entry exports the `Ton*` types, and both entries export `TonSeqnoOrdering`, an
  Attempt's TON ordering, for store authors (below).
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unchanged, every property included. On TON it is a `TonSeqnoOrdering`,
  `{ kind: 'seqno', seqno, validUntil, validFrom }`: the seqno as a `bigint`; `validUntil`,
  the chain time in seconds at which the message expires; and `validFrom`, the chain time
  the build ran at. The proofs read all three from the store, not from the signed bytes. A
  changed seqno, or a `validUntil` changed or rounded down, can prove a transfer that landed
  `expired` or `replaced`. A `validFrom` that is lost only costs time (the proof then reads
  back through the longest lifetime a message can have), but one moved later hides a wallet
  reset that happened before it: a false "not included", and `rebuild` then pays twice.
  The contract suites do not check this yet ([stores](../../explore/stores.md)).
- **Live checks (this repository).** `CRYPTO_AIO_INTEGRATION=1` runs the read-only checks in
  `test/integration/ton.test.ts` against testnet (`CRYPTO_AIO_IT_TON_NETWORK=mainnet` for
  mainnet) through the keyless `public` preset. `CRYPTO_AIO_IT_TON_RPC_URL` and
  `CRYPTO_AIO_IT_TON_INDEXER_URL` point them at other v2 and v3 endpoints: use them for
  keyed or self-hosted endpoints. The suite gives each such endpoint the keyless preset's
  rate limit, `rateLimit: { rps: 0.5 }`; set one on any keyless toncenter endpoint you
  configure yourself, since without it toncenter answers a burst with HTTP 429.
