[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TonExt

# Interface: TonExt

Defined in: [src/adapters/ton/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L41)

`bc.ext.ton`: the TON family extension (spec §5.5).

## Properties

<a id="ton"></a>

### ton

> `readonly` **ton**: `object`

Defined in: [src/adapters/ton/types.ts:42](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/ton/types.ts#L42)

#### getSeqno()

> **getSeqno**(`address`): `Promise`\<`bigint`\>

The wallet's seqno at the latest masterchain block; 0 while it is not deployed.

##### Parameters

###### address

`string`

##### Returns

`Promise`\<`bigint`\>

#### jettonWallet()

> **jettonWallet**(`owner`, `master`): `Promise`\<`string`\>

The jetton wallet that `owner` holds for the jetton `master` (raw form).

##### Parameters

###### owner

`string`

###### master

`string`

##### Returns

`Promise`\<`string`\>
