[crypto-aio](../../index.md) / [crypto-aio](../index.md) / FamilyRegistry

# Interface: FamilyRegistry

Defined in: [src/core/model/ids.ts:9](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ids.ts#L9)

## Properties

<a id="avalanche"></a>

### avalanche

> **avalanche**: `object`

Defined in: [src/adapters/avalanche/types.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L16)

#### ext

> **ext**: [`AvalancheExt`](AvalancheExt.md)

#### fee

> **fee**: [`AvalancheFeeDetails`](AvalancheFeeDetails.md)

#### library

> **library**: `"@avalabs/avalanchejs"`

***

<a id="evm"></a>

### evm

> **evm**: `object`

Defined in: [src/adapters/evm/types.ts:21](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L21)

#### ext

> **ext**: [`EvmExt`](EvmExt.md)

#### fee

> **fee**: [`EvmFeeDetails`](EvmFeeDetails.md)

#### library

> **library**: `"ethers"` \| `"web3"`

***

<a id="fake"></a>

### fake

> **fake**: `object`

Defined in: [src/testing/fake-plugin.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-plugin.ts#L16)

#### ext

> **ext**: [`FakeExt`](../testing/interfaces/FakeExt.md)

#### library

> **library**: `"fake-sdk"`

***

<a id="solana"></a>

### solana

> **solana**: `object`

Defined in: [src/adapters/solana/types.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L15)

#### ext

> **ext**: [`SolanaExt`](SolanaExt.md)

#### fee

> **fee**: [`SolanaFeeDetails`](SolanaFeeDetails.md)

#### library

> **library**: `"@solana/web3.js"`

***

<a id="ton"></a>

### ton

> **ton**: `object`

Defined in: [src/adapters/ton/types.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L14)

#### ext

> **ext**: [`TonExt`](TonExt.md)

#### fee

> **fee**: [`TonFeeDetails`](TonFeeDetails.md)

#### library

> **library**: `"@ton/ton"`

***

<a id="tron"></a>

### tron

> **tron**: `object`

Defined in: [src/adapters/tron/types.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L16)

#### ext

> **ext**: [`TronExt`](TronExt.md)

#### fee

> **fee**: [`TronFeeDetails`](TronFeeDetails.md)

#### library

> **library**: `"tronweb"`

***

<a id="utxo"></a>

### utxo

> **utxo**: `object`

Defined in: [src/adapters/utxo/types.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L18)

#### ext

> **ext**: [`UtxoExt`](UtxoExt.md)

#### fee

> **fee**: [`UtxoFeeDetails`](UtxoFeeDetails.md)

#### library

> **library**: `"bitcoinjs-lib"`
