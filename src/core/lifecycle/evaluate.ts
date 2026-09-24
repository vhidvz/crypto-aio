import type { CodesOf } from '../errors/codes';
import type {
  AttemptObservation,
  AttemptRecord,
  OperationRecord,
  OperationState,
} from '../store/types';

export interface Evaluation {
  readonly state: OperationState;
  readonly outcome?: 'executed' | 'cancelled';
  readonly error?: { readonly code: CodesOf<'chain'>; readonly message: string };
  /** The Attempt whose proven result decided the Operation. */
  readonly winner?: AttemptRecord;
}

const PROVEN_DEAD = new Set(['rejected', 'replaced', 'expired']);

/**
 * Pure: derives the Operation state from its Attempts' observations (spec §8.2, §6.7).
 * Every terminal verdict rests on `proven` evidence only: an executed or reverted Attempt
 * proven in finalized state, or every Attempt proven dead (rejected, replaced, expired).
 * Observed-only states (`dropped`, `refused`, absence, an unfinalized block) never end it.
 */
export function evaluateOperation(
  op: OperationRecord,
  observations: ReadonlyMap<string, AttemptObservation>,
): Evaluation {
  if (op.attempts.length === 0) return { state: op.state };
  const of = (attempt: AttemptRecord) => observations.get(attempt.id);
  const provenAs = (attempt: AttemptRecord, state: string) => {
    const o = of(attempt);
    return o?.evidence === 'proven' && o.state === state;
  };
  const executed = op.attempts.find((a) => provenAs(a, 'final'));
  if (executed) {
    return {
      state: 'final',
      outcome: executed.purpose === 'cancel' ? 'cancelled' : 'executed',
      winner: executed,
    };
  }
  const reverted = op.attempts.find((a) => provenAs(a, 'failed'));
  if (reverted) {
    return {
      state: 'failed',
      error: {
        code: 'TX_REVERTED',
        message: 'the transaction was included but failed on chain',
      },
      winner: reverted,
    };
  }
  const all = op.attempts.map(of);
  if (all.every((o) => o?.evidence === 'proven' && PROVEN_DEAD.has(o.state))) {
    if (all.some((o) => o?.state === 'expired')) {
      return {
        state: 'expired',
        error: {
          code: 'TX_EXPIRED',
          message: 'the transaction expired without being included',
        },
      };
    }
    if (all.every((o) => o?.state === 'rejected')) {
      return {
        state: 'failed',
        error: { code: 'TX_REJECTED', message: 'every attempt was rejected as invalid' },
      };
    }
    return {
      state: 'failed',
      error: {
        code: 'TX_REPLACED',
        message: 'the ordering slot was consumed by another transaction',
      },
    };
  }
  if (all.some((o) => o?.state === 'included' || o?.state === 'failed'))
    return { state: 'included' };
  const visible = all.some((o) => o?.state === 'mempool');
  if (op.state === 'stalled' && !visible) return { state: 'stalled' };
  if (op.state === 'signed' && !visible) return { state: 'signed' };
  return { state: 'submitted' };
}
