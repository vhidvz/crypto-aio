---
title: Coins, tokens and exact amounts
description: Native coins and tokens, decimals and base units, and why money must never be a floating-point number.
---

# Coins, tokens and exact amounts

> [!TIP]
> **The short version.** Each chain has one **native coin** (ETH, BTC, SOL, …) that also pays
> its fees. **Tokens** (USDT, USDC, …) are balances kept by programs on the chain. Every amount
> is really a whole number of the asset's smallest unit, its **base unit**, and the asset's
> **decimals** say where the decimal point goes. Count money in whole base units, as big
> integers, and never in floating-point numbers.

**Builds on:** [Wallets, keys and addresses](./wallets.md).

## Native coins

Every chain has a coin built into its own rules: the **native coin**. It is what the chain's
ledger counts directly, and it is what you pay fees in (lesson 8).

| Chain | Native coin | Decimals | Base unit |
| --- | --- | --- | --- |
| Bitcoin | BTC | 8 | satoshi (sat) |
| Ethereum | ETH | 18 | wei |
| BNB Smart Chain, Polygon | BNB, POL | 18 | wei |
| Tron | TRX | 6 | sun |
| Solana | SOL | 9 | lamport |
| TON | Gram (formerly Toncoin) | 9 | nanogram |
| Avalanche X-Chain and P-Chain | AVAX | 9 | nAVAX |
| Avalanche C-Chain (EVM) | AVAX | 18 | wei |

## Tokens: a ledger inside the ledger

Most blockchains can run programs, called **smart contracts**. A **token** is a contract that
keeps its own little ledger: a table of addresses and balances, plus rules for moving them. A
stablecoin such as USDC is such a contract, deployed by its issuer. Sending a token means
calling that contract and asking it to move a balance, signed by the owner.

Each family has its own token standard, so that wallets and exchanges can talk to every
token the same way:

| Family | Token standard | How a token is identified |
| --- | --- | --- |
| EVM | ERC-20 | The contract's address |
| Tron | TRC-20 | The contract's address |
| Solana | SPL | The token's mint address |
| TON | Jettons | The jetton master contract; each holder has a separate jetton wallet |

A token is identified by its **contract**, never by its name. Anyone can deploy a contract
called "USDC", and many people do, to trick careless code. The same issuer's token is also a
different contract on every chain: USDC on Ethereum and USDC on Polygon are two separate
assets that cannot be mixed.

## Decimals and base units

Blockchains count in whole numbers. One bitcoin is really 100,000,000 satoshis; the ledger
stores the integer `100000000`, and "1.00000000 BTC" is only how it is shown. The asset's
**decimals** (8 for BTC) say how many digits sit after the point. So every amount has two
forms:

| You write | Decimals | The chain stores (base units) |
| --- | --- | --- |
| 0.5 BTC | 8 | 50,000,000 |
| 0.01 ETH | 18 | 10,000,000,000,000,000 |
| 25 USDC (Ethereum) | 6 | 25,000,000 |
| 25 USDT (BNB Smart Chain) | 18 | 25,000,000,000,000,000,000 |

The last two rows show a trap: the "same" dollar token has 6 decimals on one chain and 18 on
another. Read the decimals from the asset, every time.

## Never use floating-point numbers for money

JavaScript's `number` is a binary floating-point value. It cannot represent most decimal
fractions exactly, and above 2^53 it cannot even represent every integer. Both break money:

<!-- runnable -->
```ts
console.log(0.1 + 0.2); // 0.30000000000000004
console.log(2 ** 53 + 1); // 9007199254740992
console.log(10n ** 18n + 1n); // 1000000000000000001n
```

The first line is a rounding error in the cents. The second is worse: 2^53 + 1 cannot exist as
a `number`, and the result is silently off by one. One ETH is 10^18 wei, far beyond 2^53, so
an ETH amount in wei held in a `number` is already wrong. JavaScript's `bigint` (the `n`
suffix in the last line) holds any integer exactly. Money is counted in base units, as
`bigint`, and converted to and from decimal text only at the edges: user input and display.

## Why a developer cares

- **Rounding loses money,** and on a blockchain nobody gives it back. Amounts must be exact
  from input to signature.
- **Decimals differ per asset and per chain.** Hard-coding 18, or 6, eventually sends a
  million times too much, or too little.
- **Token names prove nothing.** A deposit of "USDT" from an unknown contract is worthless.
  Check the contract, not the symbol.

## In crypto-aio

An **asset** in crypto-aio has an id bound to one chain and network, such as
`ethereum:mainnet/erc20:0xdAC17F…` or `fakechain:local/native`, and its metadata (`symbol`,
`decimals`) is for display only. An **`Amount`** is an exact, non-negative quantity of one
asset, held in base units as a `bigint`. When you pass an amount to the library, its type
says which form you mean:

- a `bigint` means **base units**: `100_000n`;
- a `string` means **decimal units**, parsed with the asset's decimals and never rounded:
  `'0.001'`;
- a JavaScript `number` is **rejected** with `INVALID_AMOUNT`.

<!-- runnable -->
```ts
import { Amount } from 'crypto-aio';
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const fake = await env.run(env.bc.resolveAsset('native')); // the fake chain's coin
console.log(fake.id, fake.metadata.decimals); // fakechain:local/native 8
console.log(Amount.parse('0.001', fake).base); // 100000n
console.log(Amount.from(100_000n, fake).format()); // 0.001 FAKE

try {
  Amount.parse('0.000000001', fake); // 9 decimals, but FAKE has 8
} catch (error) {
  console.log((error as { code: string }).code); // INVALID_AMOUNT
}
```

`bc.resolveAsset('USDC')` resolves an alias on the handle's own chain and network only, so
USDC on Ethereum can never be confused with USDC on Polygon. A deposit of a token whose asset
cannot be resolved, such as a spam token with unusable metadata, arrives marked
`unresolved` instead of being guessed at ([Receive deposits](../../build/receive.md)).
[Core concepts](../../reference/concepts.md#asset-and-amount) has the full rules.

## Check yourself

1. A user types `0.1` ETH. In what form should your code store and send it?
2. A token transfer says "USDT". What do you check before crediting it?
3. You send `amount: 5n` of a token with 6 decimals. How much is that?

<details>
<summary>Answers</summary>

1. As base units in a `bigint`: 100,000,000,000,000,000 wei, or keep the decimal string
   `'0.1'` and let the library parse it with the asset's decimals. Never as the `number` 0.1.
2. The token's contract (its asset id) on the right chain and network, never its symbol.
3. 5 base units: 0.000005 tokens. `'5'`, a string, would be 5 tokens.

</details>

## Key terms

- **Native coin:** the coin a chain's own rules count, which also pays its fees.
- **Smart contract:** a program stored and run on a blockchain.
- **Token:** a balance kept by a smart contract; ERC-20, TRC-20, SPL and jettons are standards.
- **Decimals:** how many digits of an amount sit after the decimal point.
- **Base unit:** an asset's smallest unit (satoshi, wei, lamport); amounts are integers of it.
- **`bigint`:** JavaScript's exact integer type, the only safe way to hold amounts.

## What's next

You can now name what moves (an asset), how much (an exact amount), and from where to where
(two addresses). The next lesson puts those together into the thing a blockchain actually
accepts: [Transactions](./transactions.md).
