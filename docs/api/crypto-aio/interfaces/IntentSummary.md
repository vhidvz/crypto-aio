[crypto-aio](../../index.md) / [crypto-aio](../index.md) / IntentSummary

# Interface: IntentSummary

Defined in: [src/core/model/intent.ts:74](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L74)

What a transaction pays, for signers and `beforeSign` policies: the asset, each output
with its canonical address and its base-unit amount as a decimal string, and the memo.

## Properties

<a id="asset"></a>

### asset

> `readonly` **asset**: `string`

Defined in: [src/core/model/intent.ts:75](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L75)

***

<a id="memo"></a>

### memo?

> `readonly` `optional` **memo?**: `string`

Defined in: [src/core/model/intent.ts:77](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L77)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: readonly `object`[]

Defined in: [src/core/model/intent.ts:76](https://github.com/vhidvz/crypto-aio/blob/main/src/core/model/intent.ts#L76)
