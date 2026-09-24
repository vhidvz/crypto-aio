import type { SerializedError } from '../errors/error';
import type { FeeEstimate } from '../model/fee';
import type { AttemptRef, RawTx, TxStatus } from '../model/transaction';
import type { SigningRequest } from '../signing/types';
import type {
  AttemptObservation,
  AttemptPurpose,
  OperationRecord,
  OperationState,
} from '../store/types';

export interface AttemptView {
  readonly id: string;
  readonly ref: AttemptRef;
  readonly purpose: AttemptPurpose;
  readonly supersedes?: string;
  readonly createdAt: number;
  readonly status?: TxStatus;
}

/** Public view of an Operation: ids and states only (no payloads, raw transactions or intents). */
export interface OperationView {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly chain: string;
  readonly network: string;
  readonly state: OperationState;
  readonly outcome?: 'executed' | 'cancelled';
  readonly ambiguous: boolean;
  readonly attempts: readonly AttemptView[];
  readonly activeAttempt?: AttemptRef;
  readonly error?: SerializedError;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PreparedOperation {
  readonly operation: OperationView;
  /** Present while the Operation awaits signatures (offline, cold or asynchronous signers). */
  readonly unsigned?: {
    readonly payload: RawTx;
    readonly signingRequests: readonly SigningRequest[];
    readonly expectedRef?: AttemptRef;
    readonly fee: FeeEstimate;
  };
}

export function statusOf(observation: AttemptObservation): TxStatus {
  const finality =
    observation.state === 'final' ||
    (observation.state === 'failed' && observation.evidence === 'proven')
      ? 'final'
      : observation.state === 'included' || observation.state === 'failed'
        ? 'probabilistic'
        : 'none';
  return {
    state: observation.state,
    evidence: observation.evidence,
    confirmations: observation.confirmations,
    finality,
    ...(observation.txHash !== undefined ? { txHash: observation.txHash } : {}),
    ...(observation.blockHash !== undefined ? { blockHash: observation.blockHash } : {}),
    ...(observation.blockHeight !== undefined
      ? { blockHeight: observation.blockHeight }
      : {}),
    ...(observation.reason !== undefined ? { reason: observation.reason } : {}),
    ...(observation.replacedBy !== undefined
      ? { replacedBy: observation.replacedBy }
      : {}),
  };
}

export function toView(
  record: OperationRecord,
  observations: ReadonlyMap<string, AttemptObservation>,
): OperationView {
  const active = record.attempts.find((a) => a.id === record.activeAttemptId);
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    chain: record.context.chain,
    network: record.context.network,
    state: record.state,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ambiguous: record.ambiguous ?? false,
    attempts: record.attempts.map((attempt) => {
      const observation = observations.get(attempt.id);
      return {
        id: attempt.id,
        ref: attempt.ref,
        purpose: attempt.purpose,
        ...(attempt.supersedes !== undefined ? { supersedes: attempt.supersedes } : {}),
        createdAt: attempt.createdAt,
        ...(observation ? { status: statusOf(observation) } : {}),
      };
    }),
    ...(active ? { activeAttempt: active.ref } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
