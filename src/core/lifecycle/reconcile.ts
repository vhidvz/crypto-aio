import { isCryptoAioError } from '../errors/error';
import type { LeaseHandle } from '../ordering/sequence';
import {
  NON_TERMINAL_STATES,
  type OperationFilter,
  type OperationPatch,
  type OperationRecord,
} from '../store/types';
import type { EngineDeps, OperationTarget, ReadTarget } from './engine';
import { CONSUMED_FAILURES, hasReclaimable, heldNonces } from './engine-rules';

/*
 * Nonce reconciliation, as functions over the engine's deps. The
 * engine hands in its deps and the few steps of its own these need (`Reconciler`).
 */

/** What reconciliation needs from `OperationEngine`: its deps and a few of its steps. */
export interface Reconciler {
  readonly deps: EngineDeps;
  update(op: OperationRecord, patch: OperationPatch): Promise<OperationRecord>;
  require(operationId: string): Promise<OperationRecord>;
  sequenceKeyOf(op: OperationRecord): string;
  assertOwnedBy(target: OperationTarget, op: OperationRecord): void;
  withAddressLease<T>(
    target: ReadTarget,
    op: OperationRecord,
    fn: (lease: LeaseHandle | undefined) => Promise<T>,
    signal?: AbortSignal,
    options?: { readonly acquireTimeoutMs?: number },
  ): Promise<T>;
}

/**
 * Nonce reconciliation, never a filler transaction. Under the address lease,
 * returns to `released` every value in [floor, next) that no live Operation of
 * `op`'s wallet reserves, so the next allocation reuses it and the transfers waiting
 * behind the gap can land; `floor` is `consumedFloor` (never below a nonce the chain
 * consumed at finality), and the wallet's history is read only when some value is
 * reclaimable at all. It closes the leaks a release cannot: a crash between
 * allocation and the `prepared` write, a store failure inside a release after a terminal
 * write, and a failure recorded without a release. Every live `created` Operation
 * without a reservation is fenced first (`fenceStalePrepare`), so a `prepared` write
 * still in flight from a lapsed lease can never land on a released value (a legitimate
 * transfer re-reads its Operation under the lease). Returns the reclaimed values. The
 * lease wait is bounded by `signal` and `acquireTimeoutMs` (`0` tries once); a busy lease
 * rejects with SEQUENCE_BUSY. A target whose wallet does not own `op` is refused
 * (INVALID_INTENT): its lease guards another sequence.
 */
export async function reconcileNonces(
  engine: Reconciler,
  target: OperationTarget,
  op: OperationRecord,
  options: { readonly signal?: AbortSignal; readonly acquireTimeoutMs?: number } = {},
): Promise<readonly bigint[]> {
  const { driver } = target.pooled;
  const sequence = driver.sequence;
  if (driver.ordering !== 'nonce' || !sequence) return [];
  engine.assertOwnedBy(target, op);
  const { signal, acquireTimeoutMs } = options;
  return engine.withAddressLease(
    target,
    op,
    async (lease) =>
      reclaimLeaked(
        engine,
        op,
        lease as LeaseHandle,
        await sequence.pending(op.intent.from),
      ),
    signal,
    acquireTimeoutMs === undefined ? undefined : { acquireTimeoutMs },
  );
}

/**
 * The body of `reconcileNonces`, under the held address lease of `op`'s wallet, with the
 * chain's pending nonce already read. `preparing` is an Operation this lease is preparing
 * right now (`prepareStage`): it is never fenced, since its own write follows.
 */
export async function reclaimLeaked(
  engine: Reconciler,
  op: OperationRecord,
  lease: LeaseHandle,
  chainPending: bigint,
  preparing?: string,
): Promise<readonly bigint[]> {
  const wallet = {
    namespace: engine.deps.namespace,
    chain: op.context.chain,
    network: op.context.network,
    from: op.intent.from,
  };
  const key = engine.sequenceKeyOf(op);
  // Cheap first: with nothing reclaimable, neither the fencing writes nor the wallet's
  // history are needed (fencing only ever adds held values), and with no value at or
  // above `chainPending` ever allocated, not even the live Operations.
  const state = await engine.deps.stores.sequences.get(key);
  if (!state || state.next <= chainPending) return [];
  const live = await engine.deps.stores.operations.list({
    ...wallet,
    states: NON_TERMINAL_STATES,
  });
  if (!hasReclaimable(state, chainPending, live.flatMap(heldNonces))) return [];
  const held: bigint[] = [];
  for (const record of live) {
    const current =
      record.id === preparing ? record : await fenceStalePrepare(engine, record);
    held.push(...heldNonces(current));
  }
  const floor = await consumedFloor(engine, wallet, chainPending);
  await lease.renew();
  return engine.deps.sequences.reclaim(lease, key, floor, held);
}

/**
 * The lowest value reconciliation may reclaim: `chainPending` (a lagging endpoint can
 * under-report it), raised above every nonce the chain consumed at finality, i.e. those
 * of `final` Operations and of failures proven on chain (`TX_REVERTED`, `TX_REPLACED`).
 * A rejection, a failure before signing or an abandoned Operation consumed nothing.
 */
export async function consumedFloor(
  engine: Reconciler,
  wallet: Omit<OperationFilter, 'states' | 'limit'>,
  chainPending: bigint,
): Promise<bigint> {
  let floor = chainPending;
  const history = await engine.deps.stores.operations.list({
    ...wallet,
    states: ['final', 'failed'],
  });
  for (const record of history) {
    if (record.state === 'failed' && !CONSUMED_FAILURES.has(record.error?.code ?? ''))
      continue;
    for (const nonce of heldNonces(record)) if (nonce >= floor) floor = nonce + 1n;
  }
  return floor;
}

/**
 * A `created` Operation without a reservation may still have a `prepared` write in
 * flight from a process whose lease lapsed (it allocated a nonce, renewed, then stalled).
 * A no-effect compare-and-set at the listed version makes that stale write lose its own
 * compare-and-set, so it can never land a reservation on a value this reconciliation
 * releases. This relies on the store bumping `version` on every `update`, a no-op one
 * included (the store contract pins it). After a lost compare-and-set the re-read
 * Operation is returned, and any reservation it now shows counts as held. Other
 * Operations are returned as listed.
 */
export async function fenceStalePrepare(
  engine: Reconciler,
  record: OperationRecord,
): Promise<OperationRecord> {
  if (record.state !== 'created' || record.reservation !== undefined) return record;
  try {
    return await engine.update(record, { clear: ['error'] });
  } catch (error) {
    if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
    return engine.require(record.id);
  }
}
