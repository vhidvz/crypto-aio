import type { Evidence, TxState } from '../model/transaction';
import type { OperationState } from '../store/types';

/** Every payload is operational-class data only (no addresses, amounts, raw txs or URLs). */
export interface AioEvents {
  'rpc.request': {
    transportId: string;
    endpointId: string;
    method: string;
    attempt: number;
  };
  'rpc.response': {
    transportId: string;
    endpointId: string;
    method: string;
    latencyMs: number;
    bytes: number;
  };
  'rpc.error': {
    transportId: string;
    endpointId: string;
    method: string;
    latencyMs: number;
    code: string;
    retryable: boolean;
  };
  'provider.health': {
    transportId: string;
    endpointId: string;
    state: 'healthy' | 'lagging' | 'open' | 'disabled';
    height?: string;
    lag?: string;
  };
  'provider.misconfigured': {
    transportId: string;
    endpointId: string;
    expected: string;
    actual: string;
  };
  'provider.inconsistent': {
    transportId: string;
    method: string;
    endpointIds: readonly string[];
  };
  'operation.state': {
    namespace: string;
    operationId: string;
    chain: string;
    network: string;
    from: OperationState | null;
    to: OperationState;
    code?: string;
  };
  'operation.stalled': { namespace: string; operationId: string; code: string };
  'attempt.state': {
    namespace: string;
    operationId: string;
    attemptId: string;
    state: TxState;
    evidence: Evidence;
  };
  'tx.reorged': {
    namespace: string;
    operationId?: string;
    attemptId?: string;
    previousBlockHash: string;
  };
  'nonce.allocated': {
    namespace: string;
    chain: string;
    network: string;
    operationId: string;
    /** The nonce or seqno: an operational identifier, never UTXO inputs. */
    value: string;
  };
  /**
   * A submitted Operation has waited past the grace period while the chain's pending nonce
   * (`expected`) is below its own. At-least-once: a monitor reports each (Operation,
   * expected) once, but that memory is per process and bounded, so the same gap is reported
   * again after a restart, by another process, or once it was forgotten.
   */
  'nonce.gap': {
    namespace: string;
    chain: string;
    network: string;
    operationId: string;
    /** The chain's pending nonce: an operational identifier. */
    expected: string;
    blockingOperationId?: string;
  };
  'signer.requested': {
    namespace: string;
    operationId: string;
    signerId: string;
    requests: number;
  };
  'signer.completed': {
    namespace: string;
    operationId: string;
    signerId: string;
    status: 'signed' | 'pending' | 'error';
    latencyMs: number;
  };
  'scanner.block': { namespace: string; cursorKey: string; height: string };
  'scanner.rollback': {
    namespace: string;
    cursorKey: string;
    toHeight: string;
    removed: number;
  };
  'recovery.skipped': {
    namespace: string;
    operationId: string;
    state: OperationState;
    reason: string;
  };
}

export type AioEventName = keyof AioEvents;

export type AioEvent<E extends AioEventName = AioEventName> = {
  [K in E]: AioEvents[K] & { readonly type: K; readonly at: number };
}[E];
