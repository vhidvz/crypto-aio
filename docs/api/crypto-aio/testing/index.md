[crypto-aio](../../index.md) / crypto-aio/testing

# crypto-aio/testing

`crypto-aio/testing`: a deterministic, network-free test kit (fake chain, fetch and clock,
a crash-injecting store, a ready-made environment) and the store contract suites that any
`OperationStore`, `LockManager`, `SequenceStore` or `CursorStore` implementation must pass.

## Classes

- [CrashError](classes/CrashError.md)
- [FakeChain](classes/FakeChain.md)
- [FakeClock](classes/FakeClock.md)
- [FakeFetch](classes/FakeFetch.md)
- [FaultyOperationStore](classes/FaultyOperationStore.md)

## Interfaces

- [ContractTestApi](interfaces/ContractTestApi.md)
- [CursorHarness](interfaces/CursorHarness.md)
- [FakeChainOptions](interfaces/FakeChainOptions.md)
- [FakeEndpointOptions](interfaces/FakeEndpointOptions.md)
- [FakeEnv](interfaces/FakeEnv.md)
- [FakeEnvelope](interfaces/FakeEnvelope.md)
- [FakeEnvOptions](interfaces/FakeEnvOptions.md)
- [FakeExt](interfaces/FakeExt.md)
- [FakeNativeClient](interfaces/FakeNativeClient.md)
- [FakeReceipt](interfaces/FakeReceipt.md)
- [FakeRequest](interfaces/FakeRequest.md)
- [FakeUnsigned](interfaces/FakeUnsigned.md)
- [FakeWireBlock](interfaces/FakeWireBlock.md)
- [FakeWireTx](interfaces/FakeWireTx.md)
- [FaultPoint](interfaces/FaultPoint.md)
- [LockHarness](interfaces/LockHarness.md)
- [OperationHarness](interfaces/OperationHarness.md)
- [RecordedCall](interfaces/RecordedCall.md)
- [SequenceHarness](interfaces/SequenceHarness.md)

## Type Aliases

- [FakeChainId](type-aliases/FakeChainId.md)
- [FakeHandler](type-aliases/FakeHandler.md)
- [FakeOrdering](type-aliases/FakeOrdering.md)
- [FakeReply](type-aliases/FakeReply.md)

## Variables

- [fakeManifest](variables/fakeManifest.md)
- [REVERT\_ADDRESS](variables/REVERT_ADDRESS.md)
- [SAMPLE\_ORDERINGS](variables/SAMPLE_ORDERINGS.md)

## Functions

- [createFakeEnv](functions/createFakeEnv.md)
- [decodeEnvelope](functions/decodeEnvelope.md)
- [describeCursorStoreContract](functions/describeCursorStoreContract.md)
- [describeLockManagerContract](functions/describeLockManagerContract.md)
- [describeOperationStoreContract](functions/describeOperationStoreContract.md)
- [describeSequenceStoreContract](functions/describeSequenceStoreContract.md)
- [drive](functions/drive.md)
- [encodeEnvelope](functions/encodeEnvelope.md)
- [fakeAddress](functions/fakeAddress.md)
- [fakeDigest](functions/fakeDigest.md)
- [fakePlugin](functions/fakePlugin.md)
- [fakeTxId](functions/fakeTxId.md)
- [hang](functions/hang.md)
- [isFakeAddress](functions/isFakeAddress.md)
- [rejectsWithCode](functions/rejectsWithCode.md)
- [rpcError](functions/rpcError.md)
- [rpcResult](functions/rpcResult.md)
- [sampleAttempt](functions/sampleAttempt.md)
- [sampleOperation](functions/sampleOperation.md)
- [settle](functions/settle.md)
- [signFake](functions/signFake.md)
