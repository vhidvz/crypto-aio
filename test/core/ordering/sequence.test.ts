import {
  reservedInputs,
  seqnoHolder,
  lowestOutstandingNonce,
} from '../../../src/core/ordering/reservations';
import {
  LeaseHandle,
  SequenceCoordinator,
  sequenceKey,
} from '../../../src/core/ordering/sequence';
import { MemoryLockManager, MemorySequenceStore } from '../../../src/core/store/memory';
import type { LockManager, OperationRecord } from '../../../src/core/store/types';
import {
  sampleAttempt,
  sampleOperation,
} from '../../../src/testing/contracts/operations';
import { FakeClock, drive } from '../../../src/testing/fake-clock';

function setup(leaseMs = 1_000) {
  const clock = new FakeClock();
  const locks = new MemoryLockManager(clock);
  const sequences = new MemorySequenceStore();
  const make = (owner: string) =>
    new SequenceCoordinator({
      locks,
      sequences,
      clock,
      owner,
      leaseMs,
      acquireTimeoutMs: 500,
    });
  return { clock, locks, sequences, coordinator: make('w1'), make };
}

const KEY = sequenceKey('ns', 'c', 'n', 'addr');

describe('SequenceCoordinator', () => {
  it('allocates consecutive nonces and follows the chain when it moves ahead', async () => {
    const { coordinator, clock } = setup();
    const take = (pending: bigint) =>
      drive(
        clock,
        coordinator.withLease(KEY, (lease) => coordinator.allocate(lease, KEY, pending)),
      );
    expect(await take(0n)).toBe(0n);
    expect(await take(0n)).toBe(1n);
    expect(await take(0n)).toBe(2n);
    expect(await take(7n)).toBe(7n);
    expect(await take(0n)).toBe(8n);
  });

  it('reuses released values first and drops released values the chain already consumed', async () => {
    const { coordinator, clock } = setup();
    const run = <T>(fn: (lease: LeaseHandle) => Promise<T>) =>
      drive(clock, coordinator.withLease(KEY, fn));
    for (let i = 0; i < 3; i++)
      await run((lease) => coordinator.allocate(lease, KEY, 0n));
    await run((lease) => coordinator.release(lease, KEY, 1n));
    expect(await run((lease) => coordinator.allocate(lease, KEY, 0n))).toBe(1n);
    expect(await run((lease) => coordinator.allocate(lease, KEY, 0n))).toBe(3n);
    await run((lease) => coordinator.release(lease, KEY, 0n));
    expect(await run((lease) => coordinator.allocate(lease, KEY, 1n))).toBe(4n);
  });

  // Review Focus 3 (coordinator level): concurrent callers get distinct consecutive nonces.
  it('serializes concurrent allocations for one address', async () => {
    const { coordinator, clock } = setup();
    const results = await drive(
      clock,
      Promise.all(
        Array.from({ length: 5 }, () =>
          coordinator.withLease(KEY, (lease) => coordinator.allocate(lease, KEY, 0n)),
        ),
      ),
      5,
    );
    expect([...results].sort()).toEqual([0n, 1n, 2n, 3n, 4n]);
  });

  it('fences a stale worker whose lease expired', async () => {
    const { clock, locks, make } = setup(1_000);
    const a = make('a');
    const b = make('b');
    const leaseA = new LeaseHandle(locks, 1_000, (await locks.acquire(KEY, 'a', 1_000))!);
    await clock.advance(1_001);
    await drive(
      clock,
      b.withLease(KEY, (lease) => b.allocate(lease, KEY, 0n)),
    );
    await expect(a.allocate(leaseA, KEY, 0n)).rejects.toMatchObject({ code: 'FENCING' });
    await expect(leaseA.renew()).rejects.toMatchObject({ code: 'FENCING' });
  });

  it('reports SEQUENCE_BUSY when the lease cannot be acquired in time', async () => {
    const { clock, locks, coordinator } = setup(10_000);
    await locks.acquire(KEY, 'someone-else', 10_000);
    await expect(
      drive(
        clock,
        coordinator.withLease(KEY, async () => 'never'),
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_BUSY', retryable: true });
  });

  it('releases the lease even when the callback fails', async () => {
    const { clock, locks, coordinator } = setup();
    await expect(
      drive(
        clock,
        coordinator.withLease(KEY, async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await locks.acquire(KEY, 'next', 1_000)).not.toBeNull();
  });

  it('bounds a nested acquire of a held address with SEQUENCE_BUSY instead of hanging', async () => {
    const { clock, coordinator } = setup();
    const nested = coordinator.withLease(KEY, () =>
      coordinator.withLease(KEY, async () => 'inner'),
    );
    await expect(drive(clock, nested)).rejects.toMatchObject({ code: 'SEQUENCE_BUSY' });
  });

  it('keeps the callback outcome when releasing the lease fails', async () => {
    const clock = new FakeClock();
    const inner = new MemoryLockManager(clock);
    const locks: LockManager = {
      acquire: (key, owner, ttlMs) => inner.acquire(key, owner, ttlMs),
      renew: (lease, ttlMs) => inner.renew(lease, ttlMs),
      release: async () => {
        throw new Error('lock store unavailable');
      },
    };
    const coordinator = new SequenceCoordinator({
      locks,
      sequences: new MemorySequenceStore(),
      clock,
      owner: 'w1',
      leaseMs: 1_000,
    });
    expect(
      await drive(
        clock,
        coordinator.withLease(KEY, async () => 'done'),
      ),
    ).toBe('done');
    await clock.advance(1_000); // the unreleased lease lapses by its TTL
    await expect(
      drive(
        clock,
        coordinator.withLease(KEY, async () => {
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
  });

  it('refuses to write a sequence with a lease held for another key', async () => {
    const { coordinator, clock, sequences } = setup();
    const OTHER = sequenceKey('ns', 'c', 'n', 'other');
    await drive(
      clock,
      coordinator.withLease(KEY, (lease) => coordinator.allocate(lease, KEY, 0n)),
    );
    const before = await sequences.get(KEY);
    await expect(
      drive(
        clock,
        coordinator.withLease(OTHER, (lease) => coordinator.allocate(lease, KEY, 0n)),
      ),
    ).rejects.toMatchObject({ code: 'FENCING' });
    await expect(
      drive(
        clock,
        coordinator.withLease(OTHER, (lease) => coordinator.release(lease, KEY, 0n)),
      ),
    ).rejects.toMatchObject({ code: 'FENCING' });
    expect(await sequences.get(KEY)).toEqual(before);
  });

  it('keeps the wallet address out of its error messages', async () => {
    const { clock, locks, coordinator } = setup(10_000);
    const key = sequenceKey('ns', 'c', 'n', '0xWALLET');
    await locks.acquire(key, 'someone-else', 10_000);
    const busy = await drive(
      clock,
      coordinator.withLease(key, async () => 'never'),
    ).catch((e: Error) => e);
    const stale = new LeaseHandle(locks, 10_000, {
      key,
      owner: 'gone',
      token: 0n,
      expiresAt: 0,
    });
    const lost = await stale.renew().catch((e: Error) => e);
    expect([busy, lost]).toEqual([
      expect.objectContaining({ code: 'SEQUENCE_BUSY' }),
      expect.objectContaining({ code: 'FENCING' }),
    ]);
    for (const error of [busy, lost])
      expect(String((error as Error).message)).not.toContain('0xWALLET');
  });
});

describe('reservations', () => {
  const op = (overrides: Partial<OperationRecord>): OperationRecord =>
    ({
      ...sampleOperation(),
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    }) as OperationRecord;

  it('collects inputs held by live operations only', () => {
    const live = op({
      id: 'a',
      state: 'prepared',
      reservation: { kind: 'inputs', inputs: ['t1:0', 't2:1'] },
    });
    const done = op({
      id: 'b',
      state: 'final',
      reservation: { kind: 'inputs', inputs: ['t3:0'] },
    });
    const attempted = op({
      id: 'c',
      state: 'submitted',
      attempts: [sampleAttempt('x', { ordering: { kind: 'inputs', inputs: ['t4:0'] } })],
    });
    expect(reservedInputs([live, done, attempted])).toEqual(['t1:0', 't2:1', 't4:0']);
    expect(reservedInputs([live, done, attempted], 'a')).toEqual(['t4:0']);
  });

  it('also counts inputs in a live unsigned payload (spec §8.5)', () => {
    const unsigned = {
      ...sampleAttempt('u').unsigned,
      ordering: { kind: 'inputs' as const, inputs: ['t5:2'] },
    };
    const awaiting = op({ id: 'd', state: 'awaiting-signature', unsigned });
    const abandoned = op({
      id: 'e',
      state: 'abandoned',
      unsigned: { ...unsigned, ordering: { kind: 'inputs', inputs: ['t6:0'] } },
    });
    expect(reservedInputs([awaiting, abandoned])).toEqual(['t5:2']);
  });

  it('finds the operation holding the current seqno', () => {
    const waiting = op({
      id: 'a',
      state: 'submitted',
      reservation: { kind: 'seqno', seqno: 4n, validUntil: 0 },
    });
    const included = op({
      id: 'b',
      state: 'included',
      reservation: { kind: 'seqno', seqno: 3n, validUntil: 0 },
    });
    expect(seqnoHolder([included, waiting])?.id).toBe('a');
    expect(seqnoHolder([included, waiting], 'a')).toBeUndefined();
  });

  it('finds the lowest outstanding nonce', () => {
    const ops = [
      op({ id: 'a', state: 'submitted', reservation: { kind: 'nonce', nonce: 5n } }),
      op({ id: 'b', state: 'stalled', reservation: { kind: 'nonce', nonce: 3n } }),
      op({ id: 'c', state: 'final', reservation: { kind: 'nonce', nonce: 1n } }),
    ];
    expect(lowestOutstandingNonce(ops)).toEqual({ nonce: 3n, operationId: 'b' });
  });
});
