import type { Evidence, TxState } from '../model/transaction';
import type { OperationState } from '../store/types';

/**
 * Every event and its payload. Every payload is operational-class data only (no addresses,
 * amounts, raw txs or URLs). A minor release may add events and optional payload fields.
 */
export interface AioEvents {
  /** A request is about to go to an endpoint; `method` is an RPC method or a route template. */
  'rpc.request': {
    transportId: string;
    endpointId: string;
    method: string;
    attempt: number;
  };
  /** An endpoint answered. */
  'rpc.response': {
    transportId: string;
    endpointId: string;
    method: string;
    latencyMs: number;
    bytes: number;
  };
  /** A request to an endpoint failed. */
  'rpc.error': {
    transportId: string;
    endpointId: string;
    method: string;
    latencyMs: number;
    code: string;
    retryable: boolean;
  };
  /**
   * After every completed health refresh, once per endpoint, with its state: a periodic
   * gauge, not a change event. Never emitted for an endpoint whose state is `unknown` or
   * `half-open`.
   */
  'provider.health': {
    transportId: string;
    endpointId: string;
    state: 'healthy' | 'lagging' | 'open' | 'disabled';
    height?: string;
    lag?: string;
  };
  /** An endpoint answered another network's identity than expected; it is disabled. */
  'provider.misconfigured': {
    transportId: string;
    endpointId: string;
    expected: string;
    actual: string;
  };
  /** Endpoints of a quorum read disagreed; the read decided nothing. */
  'provider.inconsistent': {
    transportId: string;
    method: string;
    endpointIds: readonly string[];
  };
  /** An Operation moved from one state to another (`from` is `null` when it was created). */
  'operation.state': {
    namespace: string;
    operationId: string;
    chain: string;
    network: string;
    from: OperationState | null;
    to: OperationState;
    code?: string;
  };
  /** An Operation stalled and waits for its caller's remedy; `code` says why. */
  'operation.stalled': { namespace: string; operationId: string; code: string };
  /** An Attempt's observed state or evidence changed. */
  'attempt.state': {
    namespace: string;
    operationId: string;
    attemptId: string;
    state: TxState;
    evidence: Evidence;
  };
  /** A block that held a transfer's transaction left the chain. */
  'tx.reorged': {
    namespace: string;
    operationId?: string;
    attemptId?: string;
    previousBlockHash: string;
  };
  /** A nonce or seqno was reserved for an Operation. */
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
  /** A signer was asked for `requests` signatures. */
  'signer.requested': {
    namespace: string;
    operationId: string;
    signerId: string;
    requests: number;
  };
  /** A signer answered: signed, pending (with a ticket), or with an error. */
  'signer.completed': {
    namespace: string;
    operationId: string;
    signerId: string;
    status: 'signed' | 'pending' | 'error';
    latencyMs: number;
  };
  /** A scanner delivered a block. */
  'scanner.block': { namespace: string; cursorKey: string; height: string };
  /** A scanner rolled back to `toHeight` after a reorg, removing `removed` blocks. */
  'scanner.rollback': {
    namespace: string;
    cursorKey: string;
    toHeight: string;
    removed: number;
  };
  /** `recover()` left an Operation that needs its caller; `reason` is a code. */
  'recovery.skipped': {
    namespace: string;
    operationId: string;
    state: OperationState;
    reason: string;
  };
}

/** The name of an event. */
export type AioEventName = keyof AioEvents;

/** An event as a listener gets it: its payload, with its `type` and the time `at` it fired. */
export type AioEvent<E extends AioEventName = AioEventName> = {
  [K in E]: AioEvents[K] & { readonly type: K; readonly at: number };
}[E];
