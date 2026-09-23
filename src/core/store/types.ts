import type { SerializedError } from '../errors/error';
import type { FeeEstimateDraft } from '../model/fee';
import type { StoredIntent } from '../model/intent';
import type { OrderingData } from '../model/ordering';
import type {
  AttemptRef,
  Evidence,
  RawTx,
  TxState,
  UnsignedTx,
} from '../model/transaction';
import type { SignatureBundle } from '../signing/types';

export type OperationState =
  | 'created'
  | 'prepared'
  | 'awaiting-signature'
  | 'signed'
  | 'submitted'
  | 'stalled'
  | 'included'
  | 'final'
  | 'failed'
  | 'expired'
  | 'abandoned';

export const TERMINAL_STATES: ReadonlySet<OperationState> = new Set<OperationState>([
  'final',
  'failed',
  'expired',
  'abandoned',
]);

export const NON_TERMINAL_STATES: readonly OperationState[] = [
  'created',
  'prepared',
  'awaiting-signature',
  'signed',
  'submitted',
  'stalled',
  'included',
];

export function isTerminal(state: OperationState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Frozen at Operation creation; later handle or config changes never affect it. */
export interface ExecutionContext {
  readonly chain: string;
  readonly network: string;
  readonly library: string;
  /** Provider names, or `inline:<hash>` for inline configs (never secrets). */
  readonly providers: readonly string[];
  readonly indexers: readonly string[];
  readonly wallet: string;
  readonly signer?: string;
  readonly configHash: string;
}

export type AttemptPurpose = 'original' | 'replacement' | 'cancel' | 'rebuild';

/** One concrete signed transaction. Immutable after insertion. */
export interface AttemptRecord {
  readonly id: string;
  readonly ref: AttemptRef;
  readonly raw: RawTx;
  readonly ordering: OrderingData;
  readonly fee: FeeEstimateDraft;
  readonly unsigned: UnsignedTx;
  readonly purpose: AttemptPurpose;
  readonly supersedes?: string;
  readonly createdAt: number;
}

/** Mutable, versioned view of what the chain says about an Attempt. */
export interface AttemptObservation {
  readonly attemptId: string;
  readonly operationId: string;
  readonly state: TxState;
  readonly evidence: Evidence;
  readonly txHash?: string;
  readonly blockHash?: string;
  readonly blockHeight?: bigint;
  readonly confirmations: number;
  readonly firstSeenAt?: number;
  readonly lastSeenAt?: number;
  readonly lastBroadcastAt?: number;
  readonly reason?: string;
  readonly replacedBy?: string;
  readonly version: number;
}

export interface OperationClaim {
  readonly workerId: string;
  /** Strictly increasing per store (decimal string of a bigint). */
  readonly token: string;
  readonly until: number;
}

export interface OperationRecord {
  readonly id: string;
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
  readonly context: ExecutionContext;
  readonly kind: 'transfer';
  readonly state: OperationState;
  readonly outcome?: 'executed' | 'cancelled';
  readonly intent: StoredIntent;
  readonly unsigned?: UnsignedTx;
  readonly reservation?: OrderingData;
  readonly signerTicket?: string;
  readonly partialSignatures?: readonly SignatureBundle[];
  readonly attempts: readonly AttemptRecord[];
  readonly activeAttemptId?: string;
  readonly ambiguous?: boolean;
  readonly version: number;
  readonly claim?: OperationClaim;
  readonly error?: SerializedError;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nextCheckAt?: number;
}

export type NewOperation = Omit<
  OperationRecord,
  'version' | 'createdAt' | 'updatedAt' | 'claim'
>;

export type ClearableField =
  | 'outcome'
  | 'unsigned'
  | 'reservation'
  | 'signerTicket'
  | 'partialSignatures'
  | 'activeAttemptId'
  | 'ambiguous'
  | 'error'
  | 'nextCheckAt';

export interface OperationPatch {
  readonly state?: OperationState;
  readonly outcome?: 'executed' | 'cancelled';
  readonly unsigned?: UnsignedTx;
  readonly reservation?: OrderingData;
  readonly signerTicket?: string;
  readonly partialSignatures?: readonly SignatureBundle[];
  readonly activeAttemptId?: string;
  readonly ambiguous?: boolean;
  readonly error?: SerializedError;
  readonly nextCheckAt?: number;
  /** Fields to delete; applied after the values above. */
  readonly clear?: readonly ClearableField[];
}

export interface Fence {
  readonly claimToken: string;
}

export interface OperationFilter {
  readonly namespace: string;
  readonly chain?: string;
  readonly network?: string;
  readonly from?: string;
  readonly states?: readonly OperationState[];
  readonly limit?: number;
}

export interface CreateResult {
  readonly created: boolean;
  readonly record: OperationRecord;
}

/**
 * Durable Operation storage. Required guarantees (verified by the contract suite):
 * create-if-absent on (namespace, idempotencyKey); version-checked updates; atomic
 * appendAttempt; claim tokens strictly increasing; fenced writes rejected after takeover.
 */
export interface OperationStore {
  create(operation: NewOperation): Promise<CreateResult>;
  get(namespace: string, id: string): Promise<OperationRecord | null>;
  getByKey(namespace: string, idempotencyKey: string): Promise<OperationRecord | null>;
  /** Finds by an Attempt ref id or by an observed canonical tx hash. */
  findByRef(namespace: string, refOrTxHash: string): Promise<OperationRecord | null>;
  update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord>;
  appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord>;
  getObservation(attemptId: string): Promise<AttemptObservation | null>;
  putObservation(
    observation: Omit<AttemptObservation, 'version'>,
    expectedVersion: number | null,
  ): Promise<AttemptObservation>;
  /** Claims non-terminal operations whose `nextCheckAt` is set and <= now (unscheduled ones are never due). */
  claimDue(
    namespace: string,
    workerId: string,
    now: number,
    leaseMs: number,
    limit: number,
  ): Promise<OperationRecord[]>;
  releaseClaim(namespace: string, id: string, fence: Fence): Promise<void>;
  list(filter: OperationFilter): Promise<OperationRecord[]>;
  purge?(filter: OperationFilter): Promise<number>;
}

export interface Lease {
  readonly key: string;
  readonly owner: string;
  /** Strictly increasing per key across all acquisitions. */
  readonly token: bigint;
  readonly expiresAt: number;
}

export interface LockManager {
  acquire(key: string, owner: string, ttlMs: number): Promise<Lease | null>;
  renew(lease: Lease, ttlMs: number): Promise<Lease | null>;
  release(lease: Lease): Promise<void>;
}

export interface SequenceState {
  readonly next: bigint;
  readonly released: readonly bigint[];
  readonly fence: bigint;
  readonly version: number;
}

export interface SequenceStore {
  get(key: string): Promise<SequenceState | null>;
  /** Rejects on version mismatch (`VERSION_CONFLICT`) or when `fence` < stored fence (`FENCING`). */
  put(
    key: string,
    state: Omit<SequenceState, 'version'>,
    expectedVersion: number | null,
  ): Promise<void>;
}

export interface ScanCursor {
  readonly height: bigint;
  readonly hash: string;
  readonly recent: readonly { readonly height: bigint; readonly hash: string }[];
}

export interface StoredCursor {
  readonly cursor: ScanCursor;
  readonly version: number;
}

export interface CursorStore {
  get(key: string): Promise<StoredCursor | null>;
  /** Returns the new version. */
  put(key: string, cursor: ScanCursor, expectedVersion: number | null): Promise<number>;
}

export interface Stores {
  readonly operations: OperationStore;
  readonly locks: LockManager;
  readonly sequences: SequenceStore;
  readonly cursors: CursorStore;
}

export type DataClass =
  'secret' | 'sensitive' | 'sensitive-until-broadcast' | 'operational';

/** Field classification so backing stores can apply encryption and retention per field. */
export const DATA_CLASSIFICATION: {
  readonly operation: Readonly<Record<keyof OperationRecord, DataClass>>;
  readonly attempt: Readonly<Record<keyof AttemptRecord, DataClass>>;
  readonly observation: Readonly<Record<keyof AttemptObservation, DataClass>>;
} = {
  operation: {
    id: 'operational',
    namespace: 'operational',
    idempotencyKey: 'sensitive',
    intentHash: 'operational',
    context: 'sensitive',
    kind: 'operational',
    state: 'operational',
    outcome: 'operational',
    intent: 'sensitive',
    unsigned: 'sensitive',
    reservation: 'sensitive',
    signerTicket: 'sensitive',
    partialSignatures: 'sensitive',
    attempts: 'sensitive-until-broadcast',
    activeAttemptId: 'operational',
    ambiguous: 'operational',
    version: 'operational',
    claim: 'operational',
    error: 'sensitive',
    createdAt: 'operational',
    updatedAt: 'operational',
    nextCheckAt: 'operational',
  },
  attempt: {
    id: 'operational',
    ref: 'sensitive-until-broadcast',
    raw: 'sensitive-until-broadcast',
    ordering: 'sensitive',
    fee: 'sensitive',
    unsigned: 'sensitive',
    purpose: 'operational',
    supersedes: 'operational',
    createdAt: 'operational',
  },
  observation: {
    attemptId: 'operational',
    operationId: 'operational',
    state: 'operational',
    evidence: 'operational',
    txHash: 'operational',
    blockHash: 'operational',
    blockHeight: 'operational',
    confirmations: 'operational',
    firstSeenAt: 'operational',
    lastSeenAt: 'operational',
    lastBroadcastAt: 'operational',
    reason: 'operational',
    replacedBy: 'operational',
    version: 'operational',
  },
};
