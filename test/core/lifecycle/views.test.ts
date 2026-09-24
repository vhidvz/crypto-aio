import { statusOf } from '../../../src/core/lifecycle/views';
import type { Evidence, TxState } from '../../../src/core/model/transaction';

const observation = (state: TxState, evidence: Evidence) => ({
  attemptId: 'at_1',
  operationId: 'op_1',
  state,
  evidence,
  confirmations: 3,
  version: 1,
});

describe('statusOf', () => {
  // Only proven evidence may report final finality; an observed view stays probabilistic.
  it.each([
    ['final', 'proven', 'final'],
    ['failed', 'proven', 'final'],
    ['final', 'observed', 'probabilistic'],
    ['failed', 'observed', 'probabilistic'],
    ['included', 'observed', 'probabilistic'],
    ['included', 'proven', 'probabilistic'],
    ['mempool', 'observed', 'none'],
    ['dropped', 'observed', 'none'],
    ['replaced', 'proven', 'none'],
    ['expired', 'proven', 'none'],
  ] as const)('%s with %s evidence has %s finality', (state, evidence, finality) => {
    expect(statusOf(observation(state, evidence))).toMatchObject({
      state,
      evidence,
      finality,
      confirmations: 3,
    });
  });
});
