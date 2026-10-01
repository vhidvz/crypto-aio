[crypto-aio](../../index.md) / [crypto-aio](../index.md) / AvalancheFeeDetails

# Interface: AvalancheFeeDetails

Defined in: [src/adapters/avalanche/types.ts:33](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L33)

`FeeEstimate.details` of the `avalanche` fee kind. The X-Chain burns a fixed fee per
transaction (`static`); the P-Chain prices gas since the Etna upgrade (`dynamic`). Amounts
are in nAVAX (9 decimals).

## Properties

<a id="change"></a>

### change

> `readonly` **change**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:45](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L45)

The change paid back to the sender; `0n` when there is none.

***

<a id="gas"></a>

### gas?

> `readonly` `optional` **gas?**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L40)

P-Chain: the gas the transaction uses (its complexity weighed by the network).

***

<a id="gasprice"></a>

### gasPrice?

> `readonly` `optional` **gasPrice?**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:38](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L38)

P-Chain: the gas price paid, in nAVAX per unit of gas.

***

<a id="inputs"></a>

### inputs

> `readonly` **inputs**: `number`

Defined in: [src/adapters/avalanche/types.ts:41](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L41)

***

<a id="model"></a>

### model

> `readonly` **model**: `"static"` \| `"dynamic"`

Defined in: [src/adapters/avalanche/types.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L34)

***

<a id="outputs"></a>

### outputs

> `readonly` **outputs**: `number`

Defined in: [src/adapters/avalanche/types.ts:43](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L43)

Outputs including change.

***

<a id="txfee"></a>

### txFee?

> `readonly` `optional` **txFee?**: `bigint`

Defined in: [src/adapters/avalanche/types.ts:36](https://github.com/vhidvz/crypto-aio/blob/main/src/adapters/avalanche/types.ts#L36)

X-Chain: the network's fixed fee per transaction.
