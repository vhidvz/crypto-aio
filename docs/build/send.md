---
title: Send a transfer
parent: Build
nav_order: 3
description: "transfer(), outputs, assets, memos and fees: build withdrawals into a service."
---

# Send a transfer

This guide builds withdrawals, payouts and other outgoing payments into a service. The
examples run on the fake chain (`bc = env.bc`; wrap awaited calls in `env.run(...)`, as in the
[tutorial](../start/tutorial.md)). They work the same way on every built-in family, apart from
the family notes below. Terms are defined in [Core concepts](../reference/concepts.md), and
[The life of a transfer](../tour/transfer.md) explains what happens inside each call.

> [!IMPORTANT]
> Take the idempotency key from your own durable record, such as the withdrawal's id, and
> store that record **before** you call `transfer`. Then any retry, after a timeout, a crash
> or a lost reply, reuses the key and can never pay twice. Set
> `lifecycle.requireIdempotencyKey: true` so that a missing key is an error.

## `transfer`: build, sign and broadcast in one call

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
  Tokens need the `tokens` capability: the EVM chains (ERC-20), Tron (TRC-20), Solana (SPL)
  and TON (jettons) have it; Bitcoin, the Avalanche X-Chain and P-Chain, and the fake chain
  do not ([Capabilities](../reference/capabilities.md)).
- `memo` needs the `memo` capability, which Tron, Solana, TON and the Avalanche X-Chain have
  and the EVM networks lack. A memo is public forever; a Tron memo also costs a fee
  ([Tron networks](../reference/networks/tron.md)).
- `options.signal` aborts the call. An abort after a possible broadcast is reported as
  ambiguous.
- On TON a transfer has exactly one output: batches are not supported yet, because a TON
  batch lands output by output, and a partly delivered one has no safe single verdict.
  Tokens are jettons, and `memo` is a text comment of at most 1,024 UTF-8 bytes
  ([TON networks](../reference/networks/ton.md)).

## Fees

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
[EVM networks](../reference/networks/evm.md).

On Bitcoin, `slow`, `normal` and `fast` take Esplora's estimate for 144, 6 or 2 blocks, and
a built transaction's `network` charge is `exact`. A fee above the handle's absurd-fee
limits, or an estimate above its cap, is refused before anything is signed; see
[Bitcoin networks](../reference/networks/bitcoin.md).

On Tron, `slow`, `normal` and `fast` give the same estimate, since Tron has no fee market.
The `tron` fee has `bandwidth`, `energy`, `activation` and `memo` charges, all in TRX, as an
`upper` bound; `bandwidth` and `energy` may be 0 when staked or free resources cover them. A
TRC-20 transfer's `feeLimit` covers its simulated energy plus a margin, up to the network's
maximum fee limit and the handle's `maxFeeLimit` option (100 TRX by default); `{ feeLimit }`
may raise it to the lower of the two but never set it below the estimate.
[Tron networks](../reference/networks/tron.md) explains the charges and the ceiling.

On Solana, the `solana` fee has a `network` charge (the signature fee), a `priority` charge
(the compute-unit price times the compute-unit limit) and, when the transfer creates the
recipient's token account, a `rent` charge; the bound is `exact`, or `upper` with `rent`.
`slow`, `normal` and `fast` take the 25th, 50th or 75th percentile of the node's recent
prioritization fees, at most the handle's `maxComputeUnitPrice` option (10,000,000
micro-lamports per compute unit by default, so at most 0.014 SOL of priority fee per
transfer), and the limit is a simulation plus 20% and 1,000 units. The override is
`{ computeUnitPrice, computeUnitLimit? }` (`SolanaFeeOverride`), in micro-lamports per
compute unit and compute units, as bigints only; a price above `maxComputeUnitPrice` is
refused before signing. [Solana networks](../reference/networks/solana.md) explains the
charges, the limit, the bound and how each build varies it.

On TON, `slow`, `normal` and `fast` give the same estimate: the network config sets every
price. A Gram transfer's `ton` fee is one `network` charge with an `expected` bound; a
jetton transfer adds an `attached` charge, the Gram sent along to its jetton wallet (0.05
GRAM by default, the unspent part refunded), and its bound is `upper`. The only override is
`{ attached }` in nanograms, as a bigint (`TonFeeOverride`), on jetton transfers. On TON
`estimateFee` needs the handle's wallet, and it can throw `INSUFFICIENT_FUNDS` when the
wallet cannot pay; its `details.required` is then a lower bound, with only the least gas a
wallet run can cost.
[TON networks](../reference/networks/ton.md) covers the charges and the fee ceiling.

**No endpoint can raise a fee above your bound.** Every family's prices come from a node,
so every family bounds them by a handle option that no endpoint can change: EVM
`maxFeePerGas`, Bitcoin `maxFeeRate`, `maxFee` and `maxEstimatedFeeRate`, Tron
`maxFeeLimit`, Solana `maxComputeUnitPrice`, and TON `maxNetworkFee` (on the estimate; TON
signs no fee). A node's suggestion above the bound is clamped to it or not trusted, an
explicit fee above it is refused before signing, and the build checks it again. Set each
bound to your fee policy; the defaults stop an absurd fee, not an expensive one.

## Next steps

- [Wait for confirmation](./confirmations.md): when a payment is really done.
- [Fix a stuck transfer](./stalled.md): `stalled`, rebroadcast, replace, cancel and rebuild.
- [Cold and asynchronous signing](./cold-signing.md): when the key is not in the process.
- [Errors](../reference/errors.md): every code, and the safe action for each.
