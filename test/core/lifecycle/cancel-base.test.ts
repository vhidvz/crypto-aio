import { cancelBase } from '../../../src/core/lifecycle/engine-rules';
import type { UnsignedTx } from '../../../src/core/model/transaction';
import type { AttemptRecord, OperationRecord } from '../../../src/core/store/types';
import {
  sampleAttempt,
  sampleOperation,
} from '../../../src/testing/contracts/operations';

/** An Attempt whose total charges are `total` and whose price is `price`. */
function attempt(
  id: string,
  total: bigint,
  price: bigint,
  overrides: Partial<AttemptRecord> = {},
): AttemptRecord {
  const base = sampleAttempt(id, overrides);
  const fee = {
    ...base.fee,
    charges: [{ asset: 'native' as const, amount: total, label: 'network' }],
    details: { price },
  };
  return { ...base, fee, unsigned: { ...base.unsigned, fee } };
}

const byPrice = (a: UnsignedTx, b: UnsignedTx) => {
  const pa = a.fee.details.price as bigint;
  const pb = b.fee.details.price as bigint;
  return pa === pb ? 0 : pa < pb ? -1 : 1;
};

describe('cancelBase', () => {
  const original = attempt('original', 600n, 10n);
  // A high price with a small gas limit pays less in total than a lower price with a
  // larger one: only the price says which a node would have to out-bump.
  const pricey = attempt('pricey', 210n, 20n, {
    purpose: 'cancel',
    supersedes: 'original',
  });
  const bulky = attempt('bulky', 300n, 15n, {
    purpose: 'cancel',
    supersedes: 'original',
  });
  const other = attempt('other', 900n, 99n, {
    purpose: 'cancel',
    supersedes: 'elsewhere',
  });
  const op: OperationRecord = {
    ...sampleOperation({ attempts: [original, pricey, bulky, other] }),
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  it("climbs from the earlier cancel the driver's comparator ranks highest", () => {
    expect(cancelBase(op, original, byPrice).id).toBe('pricey');
  });

  it('ranks by total charges without a comparator', () => {
    expect(cancelBase(op, original).id).toBe('bulky');
  });

  it('starts from the Attempt itself when no cancel superseded it', () => {
    expect(cancelBase(op, bulky, byPrice).id).toBe('bulky');
  });
});
