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

  // Characterization: withLease is not re-entrant; production callers pass the held lease down.
  it('fails a nested same-key call with SEQUENCE_BUSY when acquireTimeoutMs < leaseMs', async () => {
    const { clock, coordinator } = setup(); // leaseMs 1_000, acquireTimeoutMs 500
    const nested = coordinator.withLease(KEY, async (outer) => {
      const error = await coordinator
        .withLease(KEY, async () => 'inner')
        .catch((e: unknown) => e);
      await outer.renew(); // the outer lease is still held
      return error;
    });
    expect(await drive(clock, nested)).toMatchObject({ code: 'SEQUENCE_BUSY' });
  });

  it('lets a nested same-key call take over and fence the outer lease when acquireTimeoutMs = leaseMs', async () => {
    const clock = new FakeClock();
    const locks = new MemoryLockManager(clock);
    const sequences = new MemorySequenceStore();
    const coordinator = new SequenceCoordinator({
      locks,
      sequences,
      clock,
      owner: 'w1',
      leaseMs: 1_000, // acquireTimeoutMs defaults to leaseMs
    });
    const outcome = coordinator.withLease(KEY, async (outer) => {
      const inner = await coordinator.withLease(KEY, (lease) =>
        coordinator.allocate(lease, KEY, 0n),
      );
      const late = await coordinator.allocate(outer, KEY, 0n).catch((e: unknown) => e);
      return { inner, late };
    });
    const { inner, late } = await drive(clock, outcome);
    expect(inner).toBe(0n);
    expect(late).toMatchObject({ code: 'FENCING' });
  });

  it('does not take the lease when the signal is already aborted', async () => {
    const { clock, locks, coordinator } = setup();
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    controller.abort(reason);
    let ran = false;
    const call = coordinator.withLease(
      KEY,
      async () => {
        ran = true;
      },
      controller.signal,
    );
    await expect(drive(clock, call)).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(await locks.acquire(KEY, 'next', 1_000)).not.toBeNull();
  });

  it('stops waiting for a busy address when the signal aborts', async () => {
    const { clock, locks, coordinator } = setup(10_000);
    await locks.acquire(KEY, 'someone-else', 10_000);
    const controller = new AbortController();
    const reason = new Error('caller gave up');
    let ran = false;
    const call = coordinator.withLease(
      KEY,
      async () => {
        ran = true;
      },
      controller.signal,
    );
    await clock.advance(100); // still inside acquireTimeoutMs (500)
    controller.abort(reason);
    await expect(drive(clock, call)).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('ignores releases that would not change the sequence', async () => {
    const { coordinator, clock, sequences } = setup();
    const run = <T>(fn: (lease: LeaseHandle) => Promise<T>) =>
      drive(clock, coordinator.withLease(KEY, fn));
    await run((lease) => coordinator.release(lease, KEY, 0n)); // nothing allocated yet
    expect(await sequences.get(KEY)).toBeNull();
    await run((lease) => coordinator.allocate(lease, KEY, 0n));
    await run((lease) => coordinator.allocate(lease, KEY, 0n));
    await run((lease) => coordinator.release(lease, KEY, 0n));
    const after = await sequences.get(KEY);
    expect(after).toMatchObject({ next: 2n, released: [0n] });
    await run((lease) => coordinator.release(lease, KEY, 0n)); // already released
    await run((lease) => coordinator.release(lease, KEY, 2n)); // never allocated
    expect(await sequences.get(KEY)).toEqual(after); // same version: nothing written
  });

  it('persists the pruning of released values the chain already consumed', async () => {
    const { coordinator, clock, sequences } = setup();
    const run = <T>(fn: (lease: LeaseHandle) => Promise<T>) =>
      drive(clock, coordinator.withLease(KEY, fn));
    for (let i = 0; i < 5; i++)
      await run((lease) => coordinator.allocate(lease, KEY, 0n));
    for (const value of [1n, 3n, 4n])
      await run((lease) => coordinator.release(lease, KEY, value));
    expect(await run((lease) => coordinator.allocate(lease, KEY, 2n))).toBe(3n);
    expect(await sequences.get(KEY)).toMatchObject({ next: 5n, released: [4n] });
  });

  function failingRelease(clock: FakeClock): LockManager {
    const inner = new MemoryLockManager(clock);
    return {
      acquire: (key, owner, ttlMs) => inner.acquire(key, owner, ttlMs),
      renew: (lease, ttlMs) => inner.renew(lease, ttlMs),
      release: async () => {
        throw new Error('lock store unavailable');
      },
    };
  }

  it('keeps the callback outcome when releasing the lease fails, and reports the failure', async () => {
    const clock = new FakeClock();
    const releaseErrors: unknown[] = [];
    const coordinator = new SequenceCoordinator({
      locks: failingRelease(clock),
      sequences: new MemorySequenceStore(),
      clock,
      owner: 'w1',
      leaseMs: 1_000,
      onReleaseError: (error) => releaseErrors.push(error),
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
    expect(releaseErrors).toEqual([
      expect.objectContaining({ message: 'lock store unavailable' }),
      expect.objectContaining({ message: 'lock store unavailable' }),
    ]);
  });

  it('keeps the callback outcome when the onReleaseError observer throws', async () => {
    const clock = new FakeClock();
    const coordinator = new SequenceCoordinator({
      locks: failingRelease(clock),
      sequences: new MemorySequenceStore(),
      clock,
      owner: 'w1',
      leaseMs: 1_000,
      onReleaseError: () => {
        throw new Error('observer failed');
      },
    });
    expect(
      await drive(
        clock,
        coordinator.withLease(KEY, async () => 'done'),
      ),
    ).toBe('done');
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
    const otherKey = sequenceKey('ns', 'c', 'n', '0xOTHER');
    const mismatch = await drive(
      clock,
      coordinator.withLease(otherKey, (lease) => coordinator.allocate(lease, key, 0n)),
    ).catch((e: Error) => e);
    expect([busy, lost, mismatch]).toEqual([
      expect.objectContaining({ code: 'SEQUENCE_BUSY' }),
      expect.objectContaining({ code: 'FENCING' }),
      expect.objectContaining({ code: 'FENCING' }),
    ]);
    for (const error of [busy, lost, mismatch]) {
      expect(String((error as Error).message)).not.toContain('0xWALLET');
      expect(String((error as Error).message)).not.toContain('0xOTHER');
    }
  });

  it('reclaims only unreserved, unreleased values in [chainPending, next)', async () => {
    const { coordinator, clock, sequences } = setup();
    const run = <T>(fn: (lease: LeaseHandle) => Promise<T>) =>
      drive(clock, coordinator.withLease(KEY, fn));
    for (let i = 0; i < 6; i++)
      await run((lease) => coordinator.allocate(lease, KEY, 0n));
    await run((lease) => coordinator.release(lease, KEY, 4n));
    // The chain consumed 0 and 1, a live operation holds 2, and 4 is already released.
    expect(await run((lease) => coordinator.reclaim(lease, KEY, 2n, [2n]))).toEqual([
      3n,
      5n,
    ]);
    const after = await sequences.get(KEY);
    expect(after).toMatchObject({ next: 6n, released: [3n, 4n, 5n] });
    expect(await run((lease) => coordinator.reclaim(lease, KEY, 2n, [2n]))).toEqual([]);
    expect(await run((lease) => coordinator.reclaim(lease, KEY, 9n, []))).toEqual([]);
    expect(await sequences.get(KEY)).toEqual(after); // same version: nothing written
  });

  it('fences a stale or foreign lease out of reclaiming', async () => {
    const { clock, locks, make } = setup(1_000);
    const a = make('a');
    const b = make('b');
    const leaseA = new LeaseHandle(locks, 1_000, (await locks.acquire(KEY, 'a', 1_000))!);
    await clock.advance(1_001);
    await drive(
      clock,
      b.withLease(KEY, (lease) => b.allocate(lease, KEY, 0n)),
    );
    await expect(a.reclaim(leaseA, KEY, 0n, [])).rejects.toMatchObject({
      code: 'FENCING',
    });
    const OTHER = sequenceKey('ns', 'c', 'n', 'other');
    await expect(
      drive(
        clock,
        b.withLease(OTHER, (lease) => b.reclaim(lease, KEY, 0n, [])),
      ),
    ).rejects.toMatchObject({ code: 'FENCING' });
    expect(await b.withLease(KEY, async () => undefined)).toBeUndefined();
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
      // Already consumed on chain: counting it would mask a gap above it.
      op({ id: 'd', state: 'included', reservation: { kind: 'nonce', nonce: 2n } }),
    ];
    expect(lowestOutstandingNonce(ops)).toEqual({ nonce: 3n, operationId: 'b' });
  });
});
