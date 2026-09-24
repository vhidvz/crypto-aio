/**
 * `crypto-aio/testing`: a deterministic, network-free test kit (fake chain, fetch and clock,
 * a crash-injecting store, a ready-made environment) and the store contract suites that any
 * `OperationStore`, `LockManager`, `SequenceStore` or `CursorStore` implementation must pass.
 */
export { FakeClock, drive, settle } from './fake-clock';
export { FakeFetch, hang, rpcError, rpcResult } from './fake-fetch';
export type { FakeHandler, FakeReply, FakeRequest, RecordedCall } from './fake-fetch';
export {
  FakeChain,
  REVERT_ADDRESS,
  decodeEnvelope,
  encodeEnvelope,
  fakeAddress,
  fakeDigest,
  fakeTxId,
  isFakeAddress,
  signFake,
} from './fake-chain';
export type {
  FakeChainOptions,
  FakeEndpointOptions,
  FakeEnvelope,
  FakeOrdering,
  FakeReceipt,
  FakeUnsigned,
  FakeWireBlock,
  FakeWireTx,
} from './fake-chain';
export { fakeManifest, fakePlugin } from './fake-plugin';
export type { FakeExt, FakeNativeClient } from './fake-driver';
export { createFakeEnv } from './env';
export type { FakeChainId, FakeEnv, FakeEnvOptions } from './env';
export { CrashError, FaultyOperationStore } from './faulty-store';
export type { FaultPoint } from './faulty-store';
export { rejectsWithCode } from './contracts/api';
export type { ContractTestApi } from './contracts/api';
export { describeLockManagerContract } from './contracts/locks';
export type { LockHarness } from './contracts/locks';
export { describeSequenceStoreContract } from './contracts/sequences';
export type { SequenceHarness } from './contracts/sequences';
export { describeCursorStoreContract } from './contracts/cursors';
export type { CursorHarness } from './contracts/cursors';
export {
  describeOperationStoreContract,
  sampleAttempt,
  sampleOperation,
} from './contracts/operations';
export type { OperationHarness } from './contracts/operations';
