[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ConfirmationResult

# Interface: ConfirmationResult

Defined in: [src/core/lifecycle/monitor.ts:60](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L60)

What `bc.waitForConfirmation()` resolves to: the status, and the Operation when one tracks the transaction.

## Properties

<a id="operation"></a>

### operation?

> `readonly` `optional` **operation?**: [`OperationView`](OperationView.md)

Defined in: [src/core/lifecycle/monitor.ts:62](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L62)

***

<a id="status"></a>

### status

> `readonly` **status**: [`TxStatus`](TxStatus.md)

Defined in: [src/core/lifecycle/monitor.ts:61](https://github.com/vhidvz/crypto-aio/blob/main/src/core/lifecycle/monitor.ts#L61)
