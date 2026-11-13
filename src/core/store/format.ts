import { StateError } from '../errors/error';
import type { Logger } from '../events/logger';
import type { OperationRecord, OperationStore } from './types';

/**
 * The format of the Operation records this version writes. A record holds the stored
 * intent, the family's unsigned transaction and ordering data, and its Attempts; a release
 * that changes how any of them is stored or read raises this number, and keeps reading
 * every earlier format. Records written before formats existed (0.1.0) carry none and are
 * format 1.
 */
export const OPERATION_FORMAT = 1;

/** The format of `record`: a record without one (0.1.0) is format 1. */
export function formatOf(record: OperationRecord): number {
  return (record as { format?: unknown }).format === undefined ? 1 : record.format;
}

function supported(record: OperationRecord): boolean {
  const format = formatOf(record);
  return Number.isSafeInteger(format) && format >= 1 && format <= OPERATION_FORMAT;
}

function unsupported(record: OperationRecord): StateError {
  const format = (record as { format?: unknown }).format;
  return new StateError(
    'RECORD_FORMAT_UNSUPPORTED',
    `operation '${record.id}' was stored in record format ${String(format)}, newer than ` +
      `this crypto-aio reads (${OPERATION_FORMAT}): upgrade crypto-aio to handle it`,
    { context: { operationId: record.id } },
  );
}

/** `record` with its format filled in, or `RECORD_FORMAT_UNSUPPORTED` for a newer one. */
function checked(record: OperationRecord): OperationRecord {
  if (!supported(record)) throw unsupported(record);
  return record.format === undefined ? { ...record, format: 1 } : record;
}

function checkedOrNull(record: OperationRecord | null): OperationRecord | null {
  return record === null ? null : checked(record);
}

/**
 * The Operation store as the engine, the workers and `aio.operations` read it: every
 * record it returns is in a format this version reads. A record a newer version wrote, as
 * in a rolling upgrade, is never read as an older format: a read of it, by id, key, ref or
 * in a list, throws `RECORD_FORMAT_UNSUPPORTED`, and a worker pass releases its claim, with
 * a warning, and leaves it to a process that reads it. A list throws rather than leave the
 * record out because the engine reads which slots live Operations hold (inputs, nonces,
 * seqnos) from lists: one it could not see could be spent twice. Only `aio.operations.list()`
 * and `recover()`, which hold no slot, go on without it (`listReadable`).
 */
export function formatGuard(store: OperationStore, log: Logger): OperationStore {
  const skipped = (record: OperationRecord) =>
    log.warn('skipped an operation stored in a newer record format', {
      operationId: record.id,
      format: (record as { format?: unknown }).format,
    });
  const guarded: OperationStore = {
    create: async (operation) => {
      const result = await store.create(operation);
      return { created: result.created, record: checked(result.record) };
    },
    get: async (namespace, id) => checkedOrNull(await store.get(namespace, id)),
    getByKey: async (namespace, key) =>
      checkedOrNull(await store.getByKey(namespace, key)),
    findByRef: async (namespace, ref) =>
      checkedOrNull(await store.findByRef(namespace, ref)),
    update: async (namespace, id, patch, expectedVersion, fence) =>
      checked(await store.update(namespace, id, patch, expectedVersion, fence)),
    appendAttempt: async (namespace, id, attempt, patch, expectedVersion, fence) =>
      checked(
        await store.appendAttempt(namespace, id, attempt, patch, expectedVersion, fence),
      ),
    getObservation: (attemptId) => store.getObservation(attemptId),
    putObservation: (observation, expectedVersion) =>
      store.putObservation(observation, expectedVersion),
    claimDue: async (namespace, workerId, now, leaseMs, limit) => {
      const claimed = await store.claimDue(namespace, workerId, now, leaseMs, limit);
      const kept: OperationRecord[] = [];
      for (const record of claimed) {
        if (supported(record)) {
          kept.push(checked(record));
          continue;
        }
        skipped(record);
        if (record.claim) {
          await store
            .releaseClaim(namespace, record.id, { claimToken: record.claim.token })
            .catch(() => undefined);
        }
      }
      return kept;
    },
    releaseClaim: (namespace, id, fence) => store.releaseClaim(namespace, id, fence),
    list: async (filter) => (await store.list(filter)).map(checked),
  };
  const result: OperationStore = store.purge
    ? { ...guarded, purge: (filter) => (store.purge as Purge).call(store, filter) }
    : guarded;
  // What a report or a recovery reads: the records this process can read, with a warning
  // for each one a newer version stored, so a mixed fleet goes on with the rest.
  readable.set(result, async (filter) =>
    (await store.list(filter))
      .filter((record) => {
        if (supported(record)) return true;
        skipped(record);
        return false;
      })
      .map(checked),
  );
  return result;
}

type Purge = NonNullable<OperationStore['purge']>;
type ListFn = OperationStore['list'];
const readable = new WeakMap<OperationStore, ListFn>();

/**
 * `store.list(filter)` for a reader that holds no slot (`aio.operations.list()`,
 * `recover()`): on a store `formatGuard` returned, it leaves out each record of a newer
 * format, with a warning, instead of throwing; on any other store it is `store.list`.
 */
export function listReadable(
  store: OperationStore,
  filter: Parameters<ListFn>[0],
): ReturnType<ListFn> {
  return (readable.get(store) ?? store.list.bind(store))(filter);
}
