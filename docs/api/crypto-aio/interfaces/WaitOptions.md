[crypto-aio](../../index.md) / [crypto-aio](../index.md) / WaitOptions

# Interface: WaitOptions

Defined in: [src/core/lifecycle/monitor.ts:50](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L50)

How `bc.waitForConfirmation()` waits: for `confirmations` (or `finality`), at most
`timeoutMs`, reading every `pollIntervalMs`, until `signal` aborts.

## Properties

<a id="confirmations"></a>

### confirmations?

> `readonly` `optional` **confirmations?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:52](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L52)

Default: the handle's `confirmations`. Ignored when `finality: 'final'`.

***

<a id="finality"></a>

### finality?

> `readonly` `optional` **finality?**: `"included"` \| `"final"`

Defined in: [src/core/lifecycle/monitor.ts:53](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L53)

***

<a id="pollintervalms"></a>

### pollIntervalMs?

> `readonly` `optional` **pollIntervalMs?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:55](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L55)

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/lifecycle/monitor.ts:56](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L56)

***

<a id="timeoutms"></a>

### timeoutMs?

> `readonly` `optional` **timeoutMs?**: `number`

Defined in: [src/core/lifecycle/monitor.ts:54](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L54)
