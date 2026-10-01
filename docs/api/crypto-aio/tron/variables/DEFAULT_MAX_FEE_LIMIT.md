[crypto-aio](../../../index.md) / [crypto-aio/tron](../index.md) / DEFAULT\_MAX\_FEE\_LIMIT

# Variable: DEFAULT\_MAX\_FEE\_LIMIT

> `const` **DEFAULT\_MAX\_FEE\_LIMIT**: `100000000n` = `100_000_000n`

Defined in: [src/adapters/tron/network.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/network.ts#L48)

The largest fee limit a TRC-20 transfer carries unless the handle's `maxFeeLimit` option
allows more: 100 TRX, in sun (F4-R28). The network's own maximum (`getMaxFeeLimit`, 15,000
TRX on mainnet), the energy price and the simulated energy all come from one endpoint's
answer, and a call that fails through an INVALID opcode (a Solidity `assert`) burns its
whole fee limit, so this operator bound is the only one no node can raise. It covers a
TRC-20 transfer to a new holder (about 130,000 energy) at 420 sun per energy, margin
included.
