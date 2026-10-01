[crypto-aio](../../../index.md) / [crypto-aio/evm](../index.md) / DEFAULT\_MAX\_FEE\_PER\_GAS

# Variable: DEFAULT\_MAX\_FEE\_PER\_GAS

> `const` **DEFAULT\_MAX\_FEE\_PER\_GAS**: `1000000000000n` = `1_000_000_000_000n`

Defined in: [src/adapters/evm/fees.ts:107](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/fees.ts#L107)

The default `maxFeePerGas`, the highest price per gas an EVM transaction signs, 1,000
gwei. It bounds a plain transfer at 0.021 and a 65,000-gas token transfer at 0.065 of
the native coin, however an endpoint prices the fee. A network whose base fee rises
above the ceiling stalls its transfers as `FEE_TOO_LOW` until the fee falls or the
option is raised.
