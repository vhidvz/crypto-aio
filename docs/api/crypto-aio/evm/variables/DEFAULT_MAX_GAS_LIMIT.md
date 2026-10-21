[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / DEFAULT\_MAX\_GAS\_LIMIT

# Variable: DEFAULT\_MAX\_GAS\_LIMIT

> `const` **DEFAULT\_MAX\_GAS\_LIMIT**: `16777216n` = `16_777_216n`

Defined in: [src/adapters/evm/fees.ts:153](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/fees.ts#L153)

The default `maxGasLimit`, the highest gas limit an EVM transaction signs: 16,777,216
(2^24), the per-transaction cap Ethereum enforces since Fusaka (EIP-7825), so no
transaction above it is included there. A transfer this driver builds needs a small
fraction of it (21,000 gas for a plain transfer, tens of thousands for a token's); an
Arbitrum estimate also counts the L1 data fee in L2 gas, so it grows with L1 prices.
Like `DEFAULT_MAX_FEE_PER_GAS`, it stops an absurd gas limit, from an endpoint's
estimate or an override, not an expensive one: set the option to your own policy.
