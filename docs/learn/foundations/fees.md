---
title: Fees and fee markets
description: Why transactions pay fees, how each family prices them, and how a stuck payment is unstuck with a higher fee.
---

# Fees and fee markets

> [!TIP]
> **The short version.** Every transaction pays a **fee** in the chain's native coin. Fees pay
> the block producers and stop anyone from flooding the network. Block space is limited, so
> when many transactions compete, the higher fees go first: a **fee market**. Each family
> prices fees differently: gas on EVM chains, bytes on Bitcoin, resources on Tron, compute
> units on Solana. A fee that is too low leaves a payment stuck until it is **replaced** with a
> higher one.

**Builds on:** [Transactions](./transactions.md) and
[Accounts, UTXOs and transaction order](./ordering.md).

## Why fees exist

Every node checks and stores every transaction, forever. If transactions were free, anyone
could send millions of them and bring the network to a halt. A fee makes every transaction
cost something, and it pays the block producers who do the work.

Fees are always paid in the **native coin**, even for a token payment. A wallet that holds
1,000 USDT and no ETH cannot send its USDT on Ethereum: it cannot pay the fee.

## The fee market

A block has room for a limited number of transactions. When more are waiting in the mempool
than fit, block producers pick the ones that pay the most. So the fee needed to be included
**soon** goes up and down with demand: low on a quiet night, high during a market rush. A
wallet estimates a fee from what recent blocks accepted, and usually offers a few speeds:
slower and cheaper, or faster and dearer.

## How each family prices a transaction

| Family | A transaction's fee is… | The unit of price |
| --- | --- | --- |
| EVM (EIP-1559 networks) | gas used × (base fee + priority tip), capped by a maximum fee per gas | wei per gas (often shown in gwei: 10^9 wei) |
| EVM (legacy networks, such as BNB Smart Chain) | gas used × gas price | wei per gas |
| Bitcoin | the transaction's size in virtual bytes × a fee rate | satoshis per virtual byte (sat/vB) |
| Tron | bandwidth (size) and energy (contract work), paid from staked resources or burned TRX | sun |
| Solana | a fixed fee per signature + compute units × a priority price | lamports; micro-lamports per compute unit |
| TON | gas and forwarding fees set by the network's configuration | nanograms |
| Avalanche X-Chain / P-Chain | a fixed fee / gas × a dynamic gas price | nAVAX |

A few ideas recur:

- **Gas** (EVM) measures computation. A plain ETH transfer costs 21,000 gas; a token transfer
  costs more, because it runs contract code. The sender sets a **gas limit**; if execution
  needs more, the transaction fails and still pays.
- **EIP-1559** (Ethereum and most EVM chains) splits the price in two. The **base fee** is set
  by the protocol from how full recent blocks were, and is burned. The **priority fee**, or
  tip, goes to the block producer. The sender also sets a **max fee per gas**, the most it will
  pay in total per gas, so a base-fee spike cannot drain it.
- **Size matters on Bitcoin.** The fee depends on bytes, not on the amount sent: every input
  makes a transaction bigger, so spending many small coins costs more than one large coin.

## Unsticking a payment

A transaction whose fee is too low for current demand may sit in the mempool for hours, or be
dropped. Lesson 7 showed why sending a second payment is wrong. The fix is to **replace** it:
a new transaction in the same slot (the same nonce, or the same coins), with a fee high enough
that block producers prefer it. Networks require a minimum bump, typically 10% more on EVM
chains, so that replacements cannot be used to spam.

Chains with an expiry (Tron, Solana) or a seqno and deadline (TON) have no replacement: a
transaction that does not land expires, and is then re-issued.

<details>
<summary>Under the hood: estimates are not prices</summary>

A fee estimate is a prediction made before the transaction runs. On Bitcoin, once the
transaction is built, its fee is exact. On EVM chains the estimate is an **upper bound**: the
sender commits to a maximum, and usually pays less. Some layer-2 chains (OP Stack chains such
as Optimism and Base) add a second fee for posting data to Ethereum, which moves with Ethereum's
own prices. And the estimate itself comes from a node: a buggy or malicious node can suggest an
absurd fee, so careful systems cap what they are willing to sign.

</details>

## Why a developer cares

- **Fees are real money,** and a hot wallet needs native coin for fees even when it only pays
  out tokens.
- **Too low gets stuck, too high is wasted,** and both happen. Your system needs a way to bump
  a stuck payment without paying twice.
- **Never let a node decide your fee unchecked.** Set your own ceiling, and refuse to sign
  above it.

## In crypto-aio

`bc.estimateFee(intent)` returns the fee as a list of **charges** (one per asset and purpose,
such as `network`, `priority` or `l1-data`) and a **bound** that says how much to trust it:
`exact`, `expected` or `upper`. A transfer's `fee` is a speed, `'slow'`, `'normal'` (the
default) or `'fast'`, or a family-specific override:

<!-- runnable -->
```ts
import { feeTotal } from 'crypto-aio';
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const to = env.stranger();
for (const fee of ['slow', 'normal', 'fast'] as const) {
  const estimate = await env.run(env.bc.estimateFee({ to, amount: '0.001', fee }));
  console.log(fee, feeTotal(estimate, 'fakechain:local/native')?.format(), estimate.bound);
}
// Prints:
// slow 0.00000001 FAKE exact
// normal 0.00000002 FAKE exact
// fast 0.00000003 FAKE exact
```

Every family bounds the fees it will sign with a handle option no endpoint can change, such
as `maxFeePerGas` on EVM chains and `maxFeeRate` on Bitcoin, and refuses a fee above it before
signing. A stuck payment is replaced with `bc.replace(operationId, { fee })` (or cancelled
with `bc.cancel`) where the chain supports it. [Send a transfer](../../build/send.md#fees)
documents every family's fee options and bounds, and
[Fix a stuck transfer](../../build/stalled.md) covers replacement.

## Check yourself

1. Your service pays out USDT on Tron. What must the hot wallet hold besides USDT?
2. Why does a Bitcoin transaction that spends 50 small coins cost more than one that spends a
   single large coin, for the same amount?
3. An EVM payment is stuck with a low tip. What do you send?
4. A node suggests a fee rate 100 times higher than usual. What should your code do?

<details>
<summary>Answers</summary>

1. TRX (or staked resources) to pay for bandwidth and energy: fees are paid in the native coin.
2. Bitcoin fees depend on size, and every input adds bytes.
3. A replacement: the same nonce, with the tip and the max fee each raised by at least the
   network's minimum bump (10% on most EVM chains).
4. Refuse to sign above its own ceiling. The library clamps or refuses fees above the handle's
   bound.

</details>

## Key terms

- **Fee:** what a transaction pays, in the native coin, to be included.
- **Fee market:** competition for block space that sets the fee needed to be included soon.
- **Gas, gas limit:** a unit of EVM computation; the most a transaction may use.
- **Base fee, priority fee (tip), max fee per gas:** the parts of an EIP-1559 fee.
- **Fee rate (sat/vB):** Bitcoin's price per virtual byte.
- **Bandwidth, energy:** Tron's resources for size and computation.
- **Compute units:** Solana's measure of work, priced by a priority fee.
- **Replacement (fee bump):** a new transaction in the same slot with a higher fee.

## What's next

Estimating a fee, broadcasting, reading a block: every one of these is a question your code
asks a server. Which server, and how? [Nodes, RPC and providers](./nodes.md).
