[crypto-aio](../../index.md) / [crypto-aio](../index.md) / ScannerOptions

# Interface: ScannerOptions

Defined in: [src/core/observe/scanner.ts:11](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L11)

## Properties

<a id="cursorkey"></a>

### cursorKey

> `readonly` **cursorKey**: `string`

Defined in: [src/core/observe/scanner.ts:13](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L13)

Durable name of this consumer's position (namespaced per container, chain and network).

***

<a id="filter"></a>

### filter?

> `readonly` `optional` **filter?**: `object`

Defined in: [src/core/observe/scanner.ts:29](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L29)

Passed to the driver's block source; each entry is resolved on this chain and network.

#### addresses?

> `readonly` `optional` **addresses?**: readonly `string`[]

#### assets?

> `readonly` `optional` **assets?**: readonly (`string` \| \{ `contract`: `string`; `standard`: `string`; \})[]

***

<a id="from"></a>

### from?

> `readonly` `optional` **from?**: `bigint` \| `"latest"`

Defined in: [src/core/observe/scanner.ts:20](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L20)

Where a NEW cursor starts; ignored when a stored cursor exists. Default `'latest'`. The
new cursor also retains the `reorgWindow` blocks below the start, so a rollback within
the first window can name blocks that were never delivered, and the replay that follows
can start below `from`.

***

<a id="mode"></a>

### mode?

> `readonly` `optional` **mode?**: `"final"` \| `"head"`

Defined in: [src/core/observe/scanner.ts:27](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L27)

`'final'` emits finalized blocks only; a rollback can then still come from a provider
inconsistency (spec §10). `'head'` follows the tip and may roll back within the window.
Default `'head'`. The mode is not stored with the cursor: resuming a head-mode cursor in
final mode keeps the unfinalized blocks it already delivered.

***

<a id="pollintervalms"></a>

### pollIntervalMs?

> `readonly` `optional` **pollIntervalMs?**: `number`

Defined in: [src/core/observe/scanner.ts:35](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L35)

***

<a id="reorgwindow"></a>

### reorgWindow?

> `readonly` `optional` **reorgWindow?**: `number`

Defined in: [src/core/observe/scanner.ts:34](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L34)

Blocks retained for rollback detection (default: the network's reorgWindow).

***

<a id="signal"></a>

### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Defined in: [src/core/observe/scanner.ts:40](https://github.com/vhidvz/crypto-aio/blob/main/src/core/observe/scanner.ts#L40)

Stops the scan, also while it waits for new blocks. `iterator.return()` only takes effect
once a pending `next()` settles, so an idle scanner is stopped with this signal.
