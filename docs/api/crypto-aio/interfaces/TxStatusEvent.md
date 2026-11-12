[crypto-aio](../../index.md) / [crypto-aio](../index.md) / TxStatusEvent

# Interface: TxStatusEvent

Defined in: [src/core/lifecycle/monitor.ts:66](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L66)

One update `bc.watch()` yields: the status, and the Operation when one tracks the transaction.

## Properties

<a id="operation"></a>

### operation?

> `readonly` `optional` **operation?**: [`OperationView`](OperationView.md)

Defined in: [src/core/lifecycle/monitor.ts:68](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L68)

***

<a id="status"></a>

### status

> `readonly` **status**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/lifecycle/monitor.ts:67](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L67)
