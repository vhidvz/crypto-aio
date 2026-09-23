import { mutuallyExclusive, orderingLabel } from '../../../src/core/model/ordering';

describe('ordering', () => {
  it('detects mutual exclusion per model', () => {
    expect(
      mutuallyExclusive({ kind: 'nonce', nonce: 3n }, { kind: 'nonce', nonce: 3n }),
    ).toBe(true);
    expect(
      mutuallyExclusive({ kind: 'nonce', nonce: 3n }, { kind: 'nonce', nonce: 4n }),
    ).toBe(false);
    expect(
      mutuallyExclusive(
        { kind: 'seqno', seqno: 1n, validUntil: 5 },
        { kind: 'seqno', seqno: 1n, validUntil: 9 },
      ),
    ).toBe(true);
    expect(
      mutuallyExclusive(
        { kind: 'inputs', inputs: ['a:0', 'b:1'] },
        { kind: 'inputs', inputs: ['b:1'] },
      ),
    ).toBe(true);
    expect(
      mutuallyExclusive(
        { kind: 'inputs', inputs: ['a:0'] },
        { kind: 'inputs', inputs: ['c:0'] },
      ),
    ).toBe(false);
    expect(
      mutuallyExclusive({ kind: 'expiry', lastValidHeight: 5n }, { kind: 'expiry' }),
    ).toBe(false);
    expect(
      mutuallyExclusive(
        { kind: 'nonce', nonce: 1n },
        { kind: 'seqno', seqno: 1n, validUntil: 0 },
      ),
    ).toBe(false);
  });

  it('labels orderings without leaking inputs', () => {
    expect(orderingLabel({ kind: 'nonce', nonce: 7n })).toBe('nonce:7');
    expect(orderingLabel({ kind: 'inputs', inputs: ['a:0', 'b:1'] })).toBe('inputs:2');
    expect(orderingLabel({ kind: 'expiry' })).toBe('expiry');
  });
});
