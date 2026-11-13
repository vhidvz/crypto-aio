import type { SerializedError } from '../errors/error';
import type { FeeEstimateDraft } from '../model/fee';
import type { StoredIntent } from '../model/intent';
import type { OrderingData } from '../model/ordering';
import type {
  AttemptRef,
  Evidence,
  RawTx,
  TxFailure,
  TxState,
  UnsignedTx,
} from '../model/transaction';
import type { SignatureBundle, SignerTicket } from '../signing/types';

/**
 * Where an Operation is in its lifecycle. `TERMINAL_STATES` end it and are fixed through
 * 1.x; a minor release may add only non-terminal states, so a store may name the terminal
 * ones in a query or an index.
 */
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

// The exported tables in this module are frozen: they are shared by every caller.

/** The states an Operation never leaves: `final`, `failed`, `expired`, `abandoned`. */
export const TERMINAL_STATES: readonly OperationState[] = Object.freeze([
  'final',
  'failed',
  'expired',
  'abandoned',
]);

/** Every state an Operation can still leave; the complement of `TERMINAL_STATES`. */
export const NON_TERMINAL_STATES: readonly OperationState[] = Object.freeze([
  'created',
  'prepared',
  'awaiting-signature',
  'signed',
  'submitted',
  'stalled',
  'included',
]);

/** A private copy taken at load, so `isTerminal` never reads an exported value. */
const TERMINAL: ReadonlySet<OperationState> = new Set(TERMINAL_STATES);

/** Whether `state` is one of `TERMINAL_STATES`. */
export function isTerminal(state: OperationState): boolean {
  return TERMINAL.has(state);
}

/** Frozen at Operation creation; later handle or config changes never affect it. */
export interface ExecutionContext {
  /** The chain id, such as `ethereum`. */
  readonly chain: string;
  /** The network id, such as `mainnet`. */
  readonly network: string;
  /** The SDK library the driver used, such as `ethers`. */
  readonly library: string;
  /** Provider names, or `inline:<hash>` for inline configs (never secrets). */
  readonly providers: readonly string[];
  /** Indexer provider names, named as `providers` are. */
  readonly indexers: readonly string[];
  /** The configured wallet's name. */
  readonly wallet: string;
  /** The signer's id, when the wallet signs through a registered signer. */
  readonly signer?: string;
  /**
   * A hash of the handle's resolved selection (chain, network, library, provider and
   * indexer names, wallet, signer, options, confirmations): workers rebuild one handle per
   * hash to check the Operations created through it.
   */
  readonly configHash: string;
}

/**
 * Why an Attempt was signed: the first transaction of its Operation, a fee replacement, a
 * cancel (a transaction to the sender in the same slot) or a rebuild after an expiry.
 */
export type AttemptPurpose = 'original' | 'replacement' | 'cancel' | 'rebuild';

/** One concrete signed transaction. Immutable after insertion. */
export interface AttemptRecord {
  /** Random and unique across every Operation and namespace. */
  readonly id: string;
  /** The transaction's id as the chain will report it. */
  readonly ref: AttemptRef;
  /** The signed bytes, which recovery sends again exactly as stored. */
  readonly raw: RawTx;
  /** The slot the transaction occupies; a store keeps it whole (`SAMPLE_ORDERINGS`). */
  readonly ordering: OrderingData;
  /** The fee the transaction was built with. */
  readonly fee: FeeEstimateDraft;
  /** The unsigned transaction the signatures were made over. */
  readonly unsigned: UnsignedTx;
  readonly purpose: AttemptPurpose;
  /** The Attempt this one replaces or cancels. */
  readonly supersedes?: string;
  /** When the store appended it, by the store's clock. */
  readonly createdAt: number;
}

/** Mutable, versioned view of what the chain says about an Attempt. */
export interface AttemptObservation {
  readonly attemptId: string;
  readonly operationId: string;
  /** What the chain shows for the transaction. */
  readonly state: TxState;
  /** How the state was established: one endpoint's read, or a proof under the quorum. */
  readonly evidence: Evidence;
  /** The canonical transaction hash the chain reports, once seen. */
  readonly txHash?: string;
  readonly blockHash?: string;
  readonly blockHeight?: bigint;
  readonly confirmations: number;
  /** When the transaction was first and last seen, by the core's clock. */
  readonly firstSeenAt?: number;
  readonly lastSeenAt?: number;
  /** When the core last sent the bytes. */
  readonly lastBroadcastAt?: number;
  /** A node's refusal text or the driver's failure reason; free text, not covered by semver. */
  readonly reason?: string;
  /** With `state: 'failed'`: what failed (absent: `'reverted'`). */
  readonly failure?: TxFailure;
  /** The Attempt whose transaction took this one's slot. */
  readonly replacedBy?: string;
  /** Starts at 1 and grows by one on each `putObservation`. */
  readonly version: number;
}

/** A worker's claim on an Operation, held until `until` (the store's clock). */
export interface OperationClaim {
  readonly workerId: string;
  /** Strictly increasing per store (decimal string of a bigint). */
  readonly token: string;
  readonly until: number;
}

/** One transfer and everything the core stored about it. */
export interface OperationRecord {
  /** Unique within its namespace. */
  readonly id: string;
  /**
   * The record format the Operation was stored in (`OPERATION_FORMAT` when it was created).
   * A store keeps it as it keeps every other field. Records of 0.1.0 have none: format 1.
   */
  readonly format: number;
  readonly namespace: string;
  /** The caller's key; unique within the namespace. */
  readonly idempotencyKey: string;
  /** A hash of the normalized intent: a repeated key with another intent is a conflict. */
  readonly intentHash: string;
  readonly context: ExecutionContext;
  readonly kind: 'transfer';
  readonly state: OperationState;
  /** For a `final` Operation: whether its transfer or a cancel landed. */
  readonly outcome?: 'executed' | 'cancelled';
  readonly intent: StoredIntent;
  /** The unsigned transaction, from preparation until an Attempt holds it. */
  readonly unsigned?: UnsignedTx;
  /** The slot reserved for the transfer, such as a nonce or the inputs it spends. */
  readonly reservation?: OrderingData;
  /** Tickets of asynchronous signing requests in flight. */
  readonly signerTickets?: readonly SignerTicket[];
  /** Signatures collected so far for a transaction signed in parts. */
  readonly partialSignatures?: readonly SignatureBundle[];
  /** Every signed transaction, in the order appended; never rewritten. */
  readonly attempts: readonly AttemptRecord[];
  /** The Attempt the monitor follows; `appendAttempt` sets it to the Attempt it appends. */
  readonly activeAttemptId?: string;
  /** Whether a send may have reached the network without an answer saying so. */
  readonly ambiguous?: boolean;
  /** Starts at 1 and grows by one on every successful write to the record. */
  readonly version: number;
  /** Owned by the store: set by `claimDue`, removed by `releaseClaim`. */
  readonly claim?: OperationClaim;
  /** Why the Operation failed or stalled. */
  readonly error?: SerializedError;
  /** Stamped by the store's clock. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** When a worker should check it next; unset while a caller still builds or signs it. */
  readonly nextCheckAt?: number;
}

/**
 * What `create` takes: a record without the store-owned fields, which the store sets
 * (`version` 1, `createdAt` and `updatedAt`) or leaves unset (`claim`).
 */
export type NewOperation = Omit<
  OperationRecord,
  'version' | 'createdAt' | 'updatedAt' | 'claim'
>;

/** The fields an `OperationPatch` may name in `clear`. */
export const CLEARABLE_FIELDS = Object.freeze([
  'outcome',
  'unsigned',
  'reservation',
  'signerTickets',
  'partialSignatures',
  'activeAttemptId',
  'ambiguous',
  'error',
  'nextCheckAt',
] as const);

/** The only fields an `OperationPatch` may `clear`; never store-owned state or `state`. */
export type ClearableField = (typeof CLEARABLE_FIELDS)[number];

/**
 * A change to an Operation: each field given replaces the stored one (an explicit
 * `undefined` changes nothing), then `clear` removes fields. Only `OPERATION_PATCH_KEYS`
 * and `clear` may appear.
 */
export interface OperationPatch {
  readonly state?: OperationState;
  readonly outcome?: 'executed' | 'cancelled';
  readonly unsigned?: UnsignedTx;
  readonly reservation?: OrderingData;
  readonly signerTickets?: readonly SignerTicket[];
  readonly partialSignatures?: readonly SignatureBundle[];
  readonly activeAttemptId?: string;
  readonly ambiguous?: boolean;
  readonly error?: SerializedError;
  readonly nextCheckAt?: number;
  /** Fields to delete; applied after the values above. */
  readonly clear?: readonly ClearableField[];
}

/** Runtime whitelist of writable `OperationPatch` fields (everything but `clear`). */
export const OPERATION_PATCH_KEYS = Object.freeze([
  'state',
  'outcome',
  'unsigned',
  'reservation',
  'signerTickets',
  'partialSignatures',
  'activeAttemptId',
  'ambiguous',
  'error',
  'nextCheckAt',
] as const);

// Compile-time check, in both directions: OPERATION_PATCH_KEYS must list exactly the
// writable (non-'clear') fields of OperationPatch, so a future field added to one but
// not the other fails the build instead of silently opening a hole in `update`.
type PatchFieldKeys = Exclude<keyof OperationPatch, 'clear'>;
type ListedPatchKeys = (typeof OPERATION_PATCH_KEYS)[number];
type AssertNoMissingPatchKeys = PatchFieldKeys extends ListedPatchKeys ? true : never;
type AssertNoExtraPatchKeys = ListedPatchKeys extends PatchFieldKeys ? true : never;
const _assertNoMissingPatchKeys: AssertNoMissingPatchKeys = true;
const _assertNoExtraPatchKeys: AssertNoExtraPatchKeys = true;

// Compile-time check: every CLEARABLE_FIELDS entry must be a writable patch field
// other than 'state' (which is written but never cleared). Fails the build if
// 'attempts', 'claim', or any other non-writable field is ever added to
// CLEARABLE_FIELDS, since that would let `clear` reach into store-owned state.
type AssertClearableIsWritable =
  ClearableField extends Exclude<ListedPatchKeys, 'state'> ? true : never;
const _assertClearableIsWritable: AssertClearableIsWritable = true;

/** The claim token a write must still hold; a write after a takeover fails with `FENCING`. */
export interface Fence {
  readonly claimToken: string;
}

/** Which Operations `list` and `purge` match: every given field must match. */
export interface OperationFilter {
  readonly namespace: string;
  /** `context.chain`. */
  readonly chain?: string;
  /** `context.network`. */
  readonly network?: string;
  /** `intent.from`, the sending address. */
  readonly from?: string;
  readonly states?: readonly OperationState[];
  /** At most this many, the oldest first; 0 or less matches none. */
  readonly limit?: number;
}

/** The record under the key, and whether this call created it. */
export interface CreateResult {
  readonly created: boolean;
  readonly record: OperationRecord;
}

/**
 * Durable Operation storage. Required guarantees (verified by the contract suite),
 * binding on every implementation (memory, Redis, Postgres, ...):
 * - `create` is create-if-absent on `(namespace, idempotencyKey)`: a second `create`
 *   for an existing key returns the stored record unchanged, regardless of
 *   `intentHash` — this store never performs the idempotency-conflict check itself;
 *   the calling engine does.
 * - `update`/`appendAttempt` are version-checked (compare-and-set on
 *   `expectedVersion`) and optionally fenced by a claim token. Both are restricted to
 *   the same runtime patch whitelist (`OPERATION_PATCH_KEYS`), and `clear` may only
 *   name `CLEARABLE_FIELDS`; any other key anywhere in the patch rejects the whole
 *   call with `INVALID_TRANSITION` before any mutation. An explicit `undefined` value
 *   for a writable field is a no-op (the stored value survives); only `clear` removes
 *   a field.
 * - `appendAttempt` is atomic with its accompanying patch, never rewrites a
 *   previously stored `AttemptRecord`, and rejects a duplicate attempt id. Attempt ids
 *   are globally unique across every Operation and namespace: the core makes each one
 *   random, and observations are keyed by attempt id alone, so a store may also refuse
 *   (`INVALID_TRANSITION`) an id that another Operation holds.
 * - Time: `createdAt`, `updatedAt` and claim expiry are stamped with the store's clock,
 *   which the core compares with its own (`claimDue` gets the worker's `now`). Give a
 *   durable store the container's clock, or a wall clock the processes share, as the
 *   memory stores take theirs.
 * - `claimDue` and `list` are scoped by namespace: they never return a record of another
 *   namespace, even one with the same id.
 * - `claimDue` returns only non-terminal operations with `nextCheckAt` set and `<=
 *   now`, ordered by `(nextCheckAt, createdAt)` with a stable tie-break for equal
 *   values, and returns `[]` for `limit <= 0`. A claimed Operation is excluded until
 *   its `claim.until <= now`; then another worker may take it over. Claim tokens are
 *   strictly increasing per store; fenced writes are rejected after a takeover.
 * - `list` returns matches in creation order.
 * - `ClearableField` is restricted on purpose: `clear` can never remove store-owned or
 *   identity fields (`attempts`, `claim`, `version`, `id`, ...) or `state`. An
 *   implementation reads the caller's `clear` list once, so the list it validates is
 *   the list it applies.
 * - A key set to `undefined`, in an observation or a patch, is never persisted as a value
 *   such as `null`. In a patch, the stored field keeps its value. In an
 *   observation, which replaces the whole record, the field reads back `undefined` (never
 *   `null`).
 * - Every record and observation returned is a copy: mutating it, or the caller's input
 *   after a write, never changes what is stored. Values keep their types (`bigint`,
 *   `Uint8Array`), and orderings are kept whole.
 * - A refusal (`VERSION_CONFLICT`, `FENCING`, `INVALID_TRANSITION`) leaves the stored
 *   record unchanged, and no error names an idempotency key or an address.
 */
export interface OperationStore {
  /**
   * Stores `operation` unless its `(namespace, idempotencyKey)` is taken, in which case it
   * returns the stored record (`created: false`). The new record has version 1. Refuses
   * with `INVALID_TRANSITION`, storing nothing, an input carrying a store-owned field
   * (`version`, `createdAt`, `updatedAt`, `claim`) or an id another Operation of the
   * namespace holds.
   */
  create(operation: NewOperation): Promise<CreateResult>;
  /** The Operation with this id in the namespace, or `null`. */
  get(namespace: string, id: string): Promise<OperationRecord | null>;
  /** The Operation holding this idempotency key in the namespace, or `null`. */
  getByKey(namespace: string, idempotencyKey: string): Promise<OperationRecord | null>;
  /**
   * Finds by an Attempt ref id or by an observed canonical tx hash. The engine's
   * AttemptRef guard, which refuses an Attempt whose ref another Operation of the
   * namespace holds, relies on this read being read-your-writes consistent across every
   * process that shares the store: it must see any `appendAttempt` that another store
   * instance committed before it was called (no read replica, no eventually consistent
   * index).
   *
   * At most one Operation of a namespace holds a ref: that guard refuses an Attempt whose
   * ref another Operation holds. Should several hold it anyway (records written outside
   * the core), a store may return any one of them.
   */
  findByRef(namespace: string, refOrTxHash: string): Promise<OperationRecord | null>;
  /**
   * Compare-and-set on `expectedVersion`, optionally fenced. Every successful update bumps
   * version, even when the patch changes no field (the engine fences stale writers
   * with such a no-effect update). Fails with `NOT_FOUND`, `VERSION_CONFLICT`, `FENCING`, or
   * `INVALID_TRANSITION` for a patch key outside the whitelist or a `clear` that is not
   * an array of `CLEARABLE_FIELDS`.
   */
  update(
    namespace: string,
    id: string,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord>;
  /**
   * Appends `attempt` after the earlier ones and applies `patch`, in one atomic write that
   * bumps the version and makes `attempt` the `activeAttemptId`. Checked and fenced as
   * `update`; a duplicate attempt id fails with `INVALID_TRANSITION`.
   */
  appendAttempt(
    namespace: string,
    id: string,
    attempt: AttemptRecord,
    patch: OperationPatch,
    expectedVersion: number,
    fence?: Fence,
  ): Promise<OperationRecord>;
  /** The latest observation of the Attempt, or `null`. */
  getObservation(attemptId: string): Promise<AttemptObservation | null>;
  /**
   * Stores `observation` as the whole new record, version-checked. An optional field left
   * out of it or set to `undefined` (a cleared `reason`, `blockHash` or `blockHeight`)
   * reads back `undefined` (never `null`) afterwards. A store must replace the record, never
   * merge fields into the old one. The monitor relies on this to clear stale values.
   * `expectedVersion` `null` creates the first observation (version 1) and fails with
   * `VERSION_CONFLICT` if one exists; otherwise it must be the stored version. It never
   * changes the Operation's version.
   */
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
  /** Removes the claim `fence` holds; a claim taken over since fails with `FENCING`. */
  releaseClaim(namespace: string, id: string, fence: Fence): Promise<void>;
  /** The Operations `filter` matches, in creation order, at most `filter.limit` of them. */
  list(filter: OperationFilter): Promise<OperationRecord[]>;
  /**
   * Optional: deletes what `filter` matches, as `list` reads it (the oldest first, at most
   * `limit`), with their Attempts' observations and their idempotency keys, and returns
   * how many it deleted. The core never calls it. It deletes live Operations too, and a
   * purged key creates a new Operation that pays again: purge only terminal Operations
   * older than any time a caller could still repeat their key.
   */
  purge?(filter: OperationFilter): Promise<number>;
}

/** A held lock on `key` until `expiresAt` (the store's clock). */
export interface Lease {
  readonly key: string;
  readonly owner: string;
  /** Strictly increasing per key across all acquisitions. */
  readonly token: bigint;
  readonly expiresAt: number;
}

/**
 * Leases that serialize work on one key across processes, such as one sending address's
 * nonces. Required guarantees (verified by the contract suite):
 * - One holder per key at a time, among any number of concurrent acquirers; keys are
 *   independent.
 * - Tokens grow strictly per key across every acquisition, after an expiry or a release.
 */
export interface LockManager {
  /**
   * A lease on `key` for `ttlMs`, or `null` while another lease on it is unexpired. Leases
   * are not reentrant: the same owner gets `null` too.
   */
  acquire(key: string, owner: string, ttlMs: number): Promise<Lease | null>;
  /**
   * Extends a lease still held for `ttlMs` more, keeping its token, or `null` once it
   * expired or another holder took the key.
   */
  renew(lease: Lease, ttlMs: number): Promise<Lease | null>;
  /** Frees the key if `lease` still holds it; a stale lease's release changes nothing. */
  release(lease: Lease): Promise<void>;
}

/** The nonce state of one sending address. */
export interface SequenceState {
  /** The next nonce never handed out. */
  readonly next: bigint;
  /** Nonces handed out and given back, to hand out again before `next`. */
  readonly released: readonly bigint[];
  /** The token of the address lease that last wrote this state. */
  readonly fence: bigint;
  /** Starts at 1 and grows by one on each `put`. */
  readonly version: number;
}

/**
 * Nonce state per sending address. Values keep their types exactly (nonces past 2^64),
 * returned states are copies, and a refusal leaves the stored state unchanged and never
 * names the key, which embeds a wallet address.
 */
export interface SequenceStore {
  /** The stored state, or `null` for an unknown key. */
  get(key: string): Promise<SequenceState | null>;
  /**
   * Compare-and-set: `expectedVersion` `null` creates the key (version 1) and fails with
   * `VERSION_CONFLICT` if it exists; otherwise it must be the stored version. Rejects on
   * version mismatch (`VERSION_CONFLICT`) or when `fence` < stored fence (`FENCING`).
   */
  put(
    key: string,
    state: Omit<SequenceState, 'version'>,
    expectedVersion: number | null,
  ): Promise<void>;
}

/** Where a scanner is: its last block and the recent ones it uses to detect reorgs. */
export interface ScanCursor {
  readonly height: bigint;
  readonly hash: string;
  readonly recent: readonly { readonly height: bigint; readonly hash: string }[];
}

/** A cursor and its version, as `CursorStore.get` returns it. */
export interface StoredCursor {
  readonly cursor: ScanCursor;
  readonly version: number;
}

/**
 * Scanner cursors. A refusal leaves the stored cursor unchanged and never names the key,
 * which can name a watched wallet.
 */
export interface CursorStore {
  /** The stored cursor with its version, or `null` for an unknown key. */
  get(key: string): Promise<StoredCursor | null>;
  /**
   * Compare-and-set, as `SequenceStore.put`: `expectedVersion` `null` creates the key
   * (version 1) and fails with `VERSION_CONFLICT` if it exists. Returns the new version.
   */
  put(key: string, cursor: ScanCursor, expectedVersion: number | null): Promise<number>;
}

/** The four stores a container uses; `crypto-aio/testing` has a contract suite for each. */
export interface Stores {
  readonly operations: OperationStore;
  readonly locks: LockManager;
  readonly sequences: SequenceStore;
  readonly cursors: CursorStore;
}

/**
 * How sensitive a stored field is, so a store can encrypt and retain each field as
 * `DATA_CLASSIFICATION` says: encrypt `sensitive` fields at rest; `sensitive-until-broadcast`
 * ones are public once the transaction is sent; `operational` ones are safe for
 * telemetry. No stored field is `secret`.
 */
export type DataClass =
  'secret' | 'sensitive' | 'sensitive-until-broadcast' | 'operational';

/**
 * Field classification so backing stores can apply encryption and retention per field.
 *
 * `operation.reservation` and `attempt.ordering` are `sensitive` because an `inputs`
 * ordering lists UTXO outpoints, which tie a wallet to its coins. A nonce or seqno value
 * on its own is an operational identifier, like an Operation id: the `nonce.allocated`
 * and `nonce.gap` events carry it, and logs may too.
 */
export const DATA_CLASSIFICATION: {
  readonly operation: Readonly<Record<keyof OperationRecord, DataClass>>;
  readonly attempt: Readonly<Record<keyof AttemptRecord, DataClass>>;
  readonly observation: Readonly<Record<keyof AttemptObservation, DataClass>>;
} = Object.freeze({
  operation: Object.freeze({
    id: 'operational',
    format: 'operational',
    namespace: 'operational',
    idempotencyKey: 'sensitive',
    intentHash: 'operational',
    context: 'sensitive',
    kind: 'operational',
    state: 'operational',
    outcome: 'operational',
    intent: 'sensitive',
    unsigned: 'sensitive',
    // `inputs` orderings carry UTXO outpoints; nonce and seqno values are operational.
    reservation: 'sensitive',
    signerTickets: 'sensitive',
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
  }),
  attempt: Object.freeze({
    id: 'operational',
    ref: 'sensitive-until-broadcast',
    raw: 'sensitive-until-broadcast',
    // As `operation.reservation`.
    ordering: 'sensitive',
    fee: 'sensitive',
    unsigned: 'sensitive',
    purpose: 'operational',
    supersedes: 'operational',
    createdAt: 'operational',
  }),
  observation: Object.freeze({
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
    // A node's refusal or rejection text can carry addresses or amounts.
    reason: 'sensitive',
    failure: 'operational',
    replacedBy: 'operational',
    version: 'operational',
  }),
});
