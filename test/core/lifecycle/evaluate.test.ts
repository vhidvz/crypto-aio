import { CONSUMED_FAILURES } from '../../../src/core/lifecycle/engine-rules';
import { evaluateOperation } from '../../../src/core/lifecycle/evaluate';
import type { AttemptObservation, OperationRecord } from '../../../src/core/store/types';
import {
  sampleAttempt,
  sampleOperation,
} from '../../../src/testing/contracts/operations';

function operation(): OperationRecord {
  return {
    ...sampleOperation({ state: 'submitted', attempts: [sampleAttempt('att_1')] }),
    version: 2,
    createdAt: 1,
    updatedAt: 1,
  };
}

function failed(
  failure?: AttemptObservation['failure'],
): Map<string, AttemptObservation> {
  return new Map([
    [
      'att_1',
      {
        attemptId: 'att_1',
        operationId: 'op',
        state: 'failed',
        evidence: 'proven',
        confirmations: 3,
        ...(failure ? { failure } : {}),
        version: 1,
      },
    ],
  ]);
}

describe('evaluateOperation: proven failures', () => {
  it('fails a reverted transaction with TX_REVERTED, as an observation without a kind', () => {
    for (const observations of [failed(), failed('reverted')]) {
      expect(evaluateOperation(operation(), observations)).toMatchObject({
        state: 'failed',
        error: { code: 'TX_REVERTED' },
      });
    }
  });

  it('fails one that executed without evidence of the transfer with TX_UNEVIDENCED', () => {
    expect(evaluateOperation(operation(), failed('unevidenced'))).toMatchObject({
      state: 'failed',
      error: {
        code: 'TX_UNEVIDENCED',
        message: expect.stringContaining('check the chain before paying again'),
      },
      winner: { id: 'att_1' },
    });
  });

  it('counts both as failures that consumed their nonce', () => {
    expect(CONSUMED_FAILURES.has('TX_REVERTED')).toBe(true);
    expect(CONSUMED_FAILURES.has('TX_UNEVIDENCED')).toBe(true);
    expect(CONSUMED_FAILURES.has('TX_REJECTED')).toBe(false);
  });
});
