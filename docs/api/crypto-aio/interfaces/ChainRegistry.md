[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ChainRegistry

# Interface: ChainRegistry

Defined in: [src/core/model/ids.ts:8](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/ids.ts#L8)

Type-level registries. Users and plugins augment them through the package entry, e.g.
`declare module 'crypto-aio' { interface ChainRegistry { ethereum: {...} } }`, and plugins
inside this package augment the entry module (`declare module '../index'`). Never augment
this file directly: an augmentation here and one through the entry are then merged in file
order, and a user's chains can be lost.

## Properties

<a id="arbitrum"></a>

### arbitrum

> **arbitrum**: `object`

Defined in: [src/adapters/evm/types.ts:16](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L16)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"sepolia"`

***

<a id="avalanche"></a>

### avalanche

> **avalanche**: `object`

Defined in: [src/adapters/evm/types.ts:15](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L15)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"fuji"`

***

<a id="avalanche-p"></a>

### avalanche-p

> **avalanche-p**: `object`

Defined in: [src/adapters/avalanche/types.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L14)

#### family

> **family**: `"avalanche"`

#### network

> **network**: `"mainnet"` \| `"fuji"`

***

<a id="avalanche-x"></a>

### avalanche-x

> **avalanche-x**: `object`

Defined in: [src/adapters/avalanche/types.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L13)

#### family

> **family**: `"avalanche"`

#### network

> **network**: `"mainnet"` \| `"fuji"`

***

<a id="base"></a>

### base

> **base**: `object`

Defined in: [src/adapters/evm/types.ts:18](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L18)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"sepolia"`

***

<a id="bitcoin"></a>

### bitcoin

> **bitcoin**: `object`

Defined in: [src/adapters/utxo/types.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/utxo/types.ts#L12)

#### family

> **family**: `"utxo"`

#### network

> **network**: `"mainnet"` \| `"testnet"` \| `"testnet4"` \| `"signet"` \| `"regtest"`

***

<a id="bsc"></a>

### bsc

> **bsc**: `object`

Defined in: [src/adapters/evm/types.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L13)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"testnet"`

***

<a id="ethereum"></a>

### ethereum

> **ethereum**: `object`

Defined in: [src/adapters/evm/types.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L12)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"sepolia"` \| `"hoodi"`

***

<a id="fakechain"></a>

### fakechain

> **fakechain**: `object`

Defined in: [src/testing/fake-plugin.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-plugin.ts#L11)

#### family

> **family**: `"fake"`

#### network

> **network**: `"local"`

***

<a id="fakeexpiry"></a>

### fakeexpiry

> **fakeexpiry**: `object`

Defined in: [src/testing/fake-plugin.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-plugin.ts#L12)

#### family

> **family**: `"fake"`

#### network

> **network**: `"local"`

***

<a id="fakeseqno"></a>

### fakeseqno

> **fakeseqno**: `object`

Defined in: [src/testing/fake-plugin.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/testing/fake-plugin.ts#L13)

#### family

> **family**: `"fake"`

#### network

> **network**: `"local"`

***

<a id="optimism"></a>

### optimism

> **optimism**: `object`

Defined in: [src/adapters/evm/types.ts:17](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L17)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"sepolia"`

***

<a id="polygon"></a>

### polygon

> **polygon**: `object`

Defined in: [src/adapters/evm/types.ts:14](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L14)

#### family

> **family**: `"evm"`

#### network

> **network**: `"mainnet"` \| `"amoy"`

***

<a id="solana"></a>

### solana

> **solana**: `object`

Defined in: [src/adapters/solana/types.ts:12](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/solana/types.ts#L12)

#### family

> **family**: `"solana"`

#### network

> **network**: `"mainnet"` \| `"testnet"` \| `"devnet"`

***

<a id="ton"></a>

### ton

> **ton**: `object`

Defined in: [src/adapters/ton/types.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L11)

#### family

> **family**: `"ton"`

#### network

> **network**: `"mainnet"` \| `"testnet"`

***

<a id="tron"></a>

### tron

> **tron**: `object`

Defined in: [src/adapters/tron/types.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/tron/types.ts#L13)

#### family

> **family**: `"tron"`

#### network

> **network**: `"mainnet"` \| `"shasta"` \| `"nile"`
