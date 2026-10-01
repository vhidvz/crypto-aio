[crypto-aio](../../../index.md) / [crypto-aio/solana](../index.md) / DEFAULT\_MAX\_COMPUTE\_UNIT\_PRICE

# Variable: DEFAULT\_MAX\_COMPUTE\_UNIT\_PRICE

> `const` **DEFAULT\_MAX\_COMPUTE\_UNIT\_PRICE**: `10000000n` = `10_000_000n`

Defined in: [src/adapters/solana/network.ts:30](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/network.ts#L30)

The highest compute-unit price a transfer signs unless the handle's `maxComputeUnitPrice`
option allows more: 10,000,000 micro-lamports per compute unit. A speed's
price comes from one endpoint's `getRecentPrioritizationFees` and its limit from one
endpoint's simulation (up to 1,400,000 units), so this operator bound is the only one no
node can raise. At the largest limit it caps a transfer's priority fee at 14,000,000
lamports (0.014 SOL).
