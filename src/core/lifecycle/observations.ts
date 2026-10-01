import { StateError, isCryptoAioError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type {
  AttemptObservation,
  AttemptRecord,
  OperationRecord,
  OperationStore,
} from '../store/types';

export type ObservationPatch = Partial<
  Omit<AttemptObservation, 'attemptId' | 'operationId' | 'version'>
>;

export interface ObservationDeps {
  readonly operations: OperationStore;
  readonly events: EventBus;
  readonly namespace: string;
}

/**
 * Compare-and-set write of an Attempt observation; emits `attempt.state` on state changes.
 * A function patch sees the stored observation on every try (so a writer can refuse to
 * overwrite stronger evidence) and may return `undefined` to keep a stored
 * observation unchanged: it is then returned without a write (with none stored, the
 * default observation is created as for an empty patch).
 */
export async function writeObservation(
  deps: ObservationDeps,
  attempt: AttemptRecord,
  operationId: string,
  patch:
    | ObservationPatch
    | ((current: AttemptObservation | null) => ObservationPatch | undefined),
): Promise<AttemptObservation> {
  for (let tries = 0; tries < 5; tries++) {
    const current = await deps.operations.getObservation(attempt.id);
    const proposed = typeof patch === 'function' ? patch(current) : patch;
    if (proposed === undefined && current) return current;
    const changes = proposed ?? {};
    const base: Omit<AttemptObservation, 'version'> = current
      ? (({ version: _version, ...rest }) => rest)(current)
      : {
          attemptId: attempt.id,
          operationId,
          state: 'pending',
          evidence: 'observed',
          confirmations: 0,
        };
    try {
      const saved = await deps.operations.putObservation(
        { ...base, ...changes, attemptId: attempt.id, operationId },
        current?.version ?? null,
      );
      if (
        !current ||
        current.state !== saved.state ||
        current.evidence !== saved.evidence
      ) {
        deps.events.emit('attempt.state', {
          namespace: deps.namespace,
          operationId,
          attemptId: attempt.id,
          state: saved.state,
          evidence: saved.evidence,
        });
      }
      return saved;
    } catch (error) {
      if (!isCryptoAioError(error, 'VERSION_CONFLICT')) throw error;
    }
  }
  throw new StateError(
    'VERSION_CONFLICT',
    `observation of attempt '${attempt.id}' kept changing`,
  );
}

export async function loadObservations(
  operations: OperationStore,
  record: OperationRecord,
): Promise<Map<string, AttemptObservation>> {
  const entries = await Promise.all(
    record.attempts.map(
      async (attempt) =>
        [attempt.id, await operations.getObservation(attempt.id)] as const,
    ),
  );
  const map = new Map<string, AttemptObservation>();
  for (const [id, observation] of entries) if (observation) map.set(id, observation);
  return map;
}
