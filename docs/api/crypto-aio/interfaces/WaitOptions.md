[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WaitOptions

# Interface: WaitOptions

Defined in: [src/core/lifecycle/monitor.ts:46](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L46)

## Properties

<a id="confirmations"></a>

### confirmations?

> `readonly` `optional` **confirmations?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:48](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L48)

Default: the handle's `confirmations`. Ignored when `finality: 'final'`.

***

<a id="finality"></a>

### finality?

> `readonly` `optional` **finality?**: `"included"` \| `"final"`

Defined in: [src/core/lifecycle/monitor.ts:49](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L49)

***

<a id="pollintervalms"></a>

### pollIntervalMs?

> `readonly` `optional` **pollIntervalMs?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:51](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L51)

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/monitor.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L52)

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L50)
