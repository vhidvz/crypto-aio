[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / DEFAULT\_MAX\_FEE\_PER\_GAS

# Variable: DEFAULT\_MAX\_FEE\_PER\_GAS

> `const` **DEFAULT\_MAX\_FEE\_PER\_GAS**: `1000000000000n` = `1_000_000_000_000n`

Defined in: [src/adapters/evm/fees.ts:105](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/fees.ts#L105)

Plan 7 D6 (F4-R28's shape): the default `maxFeePerGas`, the highest price per gas an EVM
transaction signs, 1,000 gwei. It bounds a plain transfer at 0.021 and a 65,000-gas token
transfer at 0.065 of the native coin, however an endpoint prices the fee.
