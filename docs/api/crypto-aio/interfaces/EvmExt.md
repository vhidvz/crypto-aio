[crypto-aio](../../index.md) / [crypto-aio](../index.md) / EvmExt

# Interface: EvmExt

Defined in: [src/adapters/evm/types.ts:26](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L26)

`bc.ext.evm`: the EVM family extension (spec §5.5).

## Properties

<a id="evm"></a>

### evm

> `readonly` **evm**: `object`

Defined in: [src/adapters/evm/types.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/evm/types.ts#L27)

#### getNonce()

> **getNonce**(`address`, `block?`): `Promise`\<`bigint`\>

The account nonce at `latest` (default) or including the mempool (`pending`).

##### Parameters

###### address

`string`

###### block?

`"pending"` \| `"latest"`

##### Returns

`Promise`\<`bigint`\>
