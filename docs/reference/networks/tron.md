---
title: Tron networks
parent: Networks
grand_parent: Reference
description: "Tron: bandwidth and energy, fee limits, expiry, memos, TronGrid and proofs."
nav_order: 3
---

# Tron networks

The Tron family serves the `tron` chain on `mainnet`, `shasta` and `nile` with tronweb 6
(`npm install tronweb`). A transfer moves TRX or one TRC-20 token to one recipient, with an
optional memo. The [Build guides](../../build/index.md) cover what else differs on Tron:
[refused transfers](../errors.md#what-to-do-about-each-error),
[token verdicts and proofs](../../build/confirmations.md) and
[scans](../../build/receive.md).

- **Addresses.** Base58check `T…` is canonical; `address.format({ hex: true })` gives the
  `41…` hex form, and both are accepted as input. Derive keys at `m/44'/195'/0'/0/<i>`
  (SLIP-44 coin type 195) through the wallet's `keyRef.path`. A TRX transfer to its own
  sender is refused (`INVALID_INTENT`); a TRC-20 one is valid on chain and allowed. A TRX
  transfer to a contract is refused before signing only on a network whose
  `getForbidTransferToContract` parameter is 1, as java-tron would refuse it there; it is 0 on
  mainnet, Shasta and Nile today, where such a transfer is valid.
- **Fees (`tron`).** Every charge is in TRX, and `bandwidth` and `energy` may be 0 when staked
  or free resources cover them (`activation` and `memo` are chain fees that no resource
  covers): `bandwidth` (the signed transaction's size plus 64 bytes, at the chain's price per
  byte), `energy` (TRC-20 only), `activation` (a TRX transfer to an address that was never
  activated: 1 TRX today, and its bandwidth is then a flat 0.1 TRX unless staked bandwidth
  covers it, since free bandwidth never applies) and `memo` (1 TRX today). Prices come from
  the chain's parameters on every estimate, and the charges are an `upper` bound;
  `fee.details` (`TronFeeDetails`) shows the bandwidth, the energy, their prices and the fee
  limit. `slow`, `normal` and `fast` give the same estimate: Tron has no fee market. Before
  signing, the sender needs TRX for every charge, plus the amount of a TRX transfer or the
  tokens of a TRC-20 one, and an account that was never activated cannot send
  (`INSUFFICIENT_FUNDS`).
- **Energy and the fee limit.** TRC-20 energy is simulated on the node and gets a 20% margin
  (`chains.tron.options.energyMarginPercent`, an integer from 0 to 1,000). The transaction's
  `feeLimit` covers all of it, because Tron caps a call's energy by `feeLimit` even when
  staked TRX pays for it; the `energy` charge is the fee limit less what your staked energy
  covers. The node reports the simulated energy, the energy price and the network's maximum
  fee limit (`getMaxFeeLimit`, 15,000 TRX today), and a call that fails on chain can burn its
  whole fee limit. So the fee limit is also bounded by your own
  `chains.tron.options.maxFeeLimit`, which no endpoint can raise: sun as a bigint, from 1 to
  2^53 − 1, and 100 TRX by default (`DEFAULT_MAX_FEE_LIMIT`, enough for a transfer to a new
  holder, about 130,000 energy, at 420 sun per energy with the margin). The fee limit is the
  estimate plus its margin, at most the network's maximum and at most `maxFeeLimit`. A
  transfer whose simulated energy alone needs more is refused with `INVALID_INTENT` before
  signing; when `maxFeeLimit` is the bound, the message names it and `error.details` carries
  `required` and `maxFeeLimit` (sun, as decimal strings), so raise it for a costlier token.
  The only override is `{ feeLimit }` in sun, as a bigint (`TronFeeOverride`), on TRC-20
  transfers, from the estimate up to both bounds: a lower cap fails on chain
  (`OUT_OF_ENERGY`) and still pays. A token's energy use can rise after the estimate (dynamic
  energy); when the margin, or a bound that cut it, is not enough, the transfer is proven
  failed (`TX_REVERTED`, reason `out of energy`) and its fee is burned. For a tighter policy
  per transfer, compare `ctx.fee` in your `beforeSign` hook
  ([Keys, signers and secrets](../../build/keys.md)) with your own limit.
- **Expiry, not replacement.** A transaction expires about `expirationMs` after its
  reference block, the head it was built on (or after the local clock, if that is earlier):
  60 s by default, from 10 s to 5 minutes (`chains.tron.options.expirationMs`). A build
  refuses a head more than half that window older than the local clock, and one dated more
  than half the window ahead of it (a retryable `PROVIDER_UNAVAILABLE`), so keep the server
  clock in sync (NTP): a clock running ahead of the chain sees every head as too old, and
  one running behind would build transactions that expire at birth, so both refuse builds.
  Tron has no replace and no cancel (`UNSUPPORTED_CAPABILITY`). A transaction that never
  lands is proven `expired` once a solidified block passes its expiration and a scan of
  every block that could hold it shows it absent, about a minute after the expiration; then
  `bc.rebuild(id)` re-issues it. With `prepareTransfer` or a `pending` signer, submit the
  signatures within the window. `rebuild` signs on the spot, so it needs a synchronous
  signer.
- **Finality.** `final` is the solidified block, about 19 blocks (a minute) below the head.
  `waitForConfirmation` waits for inclusion by default; credit deposits on `final`.
- **Tokens.** TRC-20. USDT is registered by alias on mainnet; any other token resolves by
  contract (`{ standard: 'trc20', contract: 'T…' }`), with its symbol and decimals read from
  the chain under the proof quorum and cached for the container's life. A token transfer
  counts as executed only with its `Transfer` event from the token contract
  ([token verdicts](../../build/confirmations.md)). TRC-10 tokens are not
  supported, and TRC-10 transfers are not decoded.
- **Memos** are UTF-8 text of at most 256 bytes (`MAX_MEMO_BYTES`), public forever, and each
  costs the memo fee. A deposit's memo arrives as `transfer.memo`.
- **Scanning and history.** Blocks carry TRX transfers and TRC-20 `Transfer` events; any
  contract call is `decoding: 'partial'`. Address history comes from TronGrid's `/v1` API:
  name the `trongrid` or `public` preset as the handle's `indexer` (without one, `history()`
  throws `UNSUPPORTED_CAPABILITY`). It lists solidified entries only, at most 200 per page,
  and reads each one back through the handle's `provider`. It pages through TronGrid's
  `/transactions` first: the account's own transactions, TRX sent to it and, for a contract
  account, other accounts' calls to it. Then `/transactions/trc20`: every TRC-20 transfer
  from or to the account (a spender's `transferFrom` out of it included), less the account's
  own calls, listed already. A wallet's incoming TRC-20 transfer comes once, in the second
  part (TronGrid, checked on Nile in September 2026), but a call to a contract account that
  moves its own tokens comes in both parts, so dedupe on `transfer.id`, as for scans.
- **Presets and endpoints.** `trongrid` requires a key and sends it in the
  `TRON-PRO-API-KEY` header, as a `Secret`. `public` is TronGrid without a key, for trying
  things out on Shasta and Nile, not for production; a `tron` handle with no provider falls
  back to it, with a logged warning. **Mainnet needs `trongrid` with a key, or another
  provider:** keyless TronGrid answers most mainnet requests with HTTP 429. An endpoint
  that rate-limits a health check keeps its last good height and is checked again after its
  `Retry-After`, but one that has never answered a check is never confirmed, and the handle
  then finds no healthy endpoint. TronGrid publishes no rate limit, so neither preset sets `rateLimit`; to
  pace a busy service, configure the endpoint yourself with a `rateLimit` (a 429 answer is
  retried with backoff). An endpoint of your own must serve `/wallet`, `/walletsolidity` and
  `/jsonrpc` under one base URL, as TronGrid does: its identity check reads block 0 from all
  three. A bare java-tron node serves them on separate ports, so put a reverse proxy in front
  of it. A custom `indexer` endpoint must serve TronGrid's `/v1` API, and also answer
  `/wallet/getblockbynum` and `/wallet/getblock` (its health checks).
- **Proven verdicts need independent providers.** `trongrid` and `public` are one endpoint
  each, on the same TronGrid backend, so either alone gives a proof quorum of 1: a lagging
  backend decides nothing, but a wrong one is trusted, for verdicts, for a token's decimals,
  and for "not included", which would let `rebuild` pay twice. For proven verdicts on
  mainnet, configure independent providers, for example `provider: ['tron', 'own-node']`.
  With exactly two, both must answer while both are up, but once one has been down for about
  three health intervals (45 s by default) it leaves the proof count and the other decides
  alone. So use three for production proofs: two tolerate an outage, not a liar during one.
  If you set a `rateLimit` on an endpoint that serves proofs, give it `burst: 2` or more
  (the default is the rate rounded up): with a burst of 1, an endpoint that recovers from an
  outage may never rejoin the proof quorum.
- **A refusal is not a failure.** A node's refusal leaves the Operation `stalled` with
  `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS`, and the transaction may still land:
  never pay again with a new key ([what to do](../errors.md#what-to-do-about-each-error)). A
  node that caches transaction ids answers "duplicate" to bytes it refused before, which the
  library reads as sent. So after a top-up, `rebroadcast` may not reach that node's pool;
  the Operation then ends at its proven expiry, and `rebuild` sends the transfer again. Set
  `lifecycle.broadcastFanout` to 2 or more to send each broadcast to that many endpoints, so
  one refusing or id-caching node does not keep a transfer out of the others' pools.
- **Identical payouts.** Tron has no nonce. Each build gets a unique timestamp and
  expiration, so two identical transfers built in the same millisecond still differ.
- **Very large transfers.** Balances and deposits of any size are read exactly. A single TRX
  transfer above 2^53 − 1 sun (about 9 billion TRX) is refused with `INVALID_AMOUNT` before
  signing; split it.
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unchanged, `refBlockHash` included: the expiry proof relies on it
  ([why](../../explore/stores.md)).
- **Types.** `crypto-aio/tron` names tronweb's types, so a project with
  `skipLibCheck: false` needs tronweb installed to import it.
- **Integration tests.** The opt-in suite (`CRYPTO_AIO_INTEGRATION=1`) reads Nile through
  `public` by default. `CRYPTO_AIO_IT_TRON_NETWORK` picks the network, and
  `CRYPTO_AIO_IT_TRON_URL` an endpoint base URL, which mainnet needs.

```ts
import { Blockchain, configure, localSigner, secret, type TronFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/tron'; // types native(tron, 'tronweb')

configure({
  providers: {
    tron: { preset: 'trongrid', apiKey: secret(process.env.TRONGRID_API_KEY ?? '') },
    // An independent second provider: your node behind a proxy that serves /wallet,
    // /walletsolidity and /jsonrpc under one base URL.
    'own-node': {
      endpoints: [{ name: 'node', url: secret(process.env.TRON_NODE_URL ?? '') }],
    },
  },
  signers: { hot: localSigner({ secp256k1: secret(process.env.TRON_HOT_KEY ?? '') }) },
  wallets: { 'tron-hot': { signer: 'hot' } },
  chains: {
    tron: {
      network: 'mainnet',
      provider: ['tron', 'own-node'], // proofs cross-check both while both answer; use three
      indexer: 'tron', // address history (TronGrid /v1)
      wallet: 'tron-hot',
      // expirationMs: default 60_000, from 10_000 to 300_000; maxFeeLimit: sun, default 100 TRX
      options: { expirationMs: 120_000, maxFeeLimit: 50_000_000n },
    },
  },
});
const tron = Blockchain.create({ chain: 'tron' });
await tron.ready(); // loads tronweb; every endpoint must serve mainnet's block 0
const fee = await tron.estimateFee({ asset: 'USDT', to, amount: '25' });
// `fee.details` holds the `TronFeeDetails` fields but is typed as a plain record: cast each
const feeLimit = fee.details.feeLimit as bigint | undefined;
const sub = await tron.transfer(
  { asset: 'USDT', to, amount: '25', memo: 'order 7' },
  { idempotencyKey: 'withdrawal-42' },
);
await sub.wait({ finality: 'final' }); // the solidified block
const cap: TronFeeOverride = { feeLimit: 30_000_000n }; // as `fee`: sun, estimate to maxFeeLimit
const { energy } = await tron.ext.tron.getResources(to);
const client = await native(tron, 'tronweb'); // a TronWeb on the same transport
```
