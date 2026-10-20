import { createFakeEnv } from '../../../src/testing/env';
import { noopLogger, type Logger } from '../../../src/core/events/logger';
import { OPERATION_FORMAT, formatGuard } from '../../../src/core/store/format';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { NewOperation, OperationStore } from '../../../src/core/store/types';
import { sampleOperation } from '../../../src/testing/contracts/operations';
import { FakeClock } from '../../../src/testing/fake-clock';

/** A 0.1.0 record: no `format` at all. */
function withoutFormat(overrides: Partial<NewOperation> = {}): NewOperation {
  const { format: _format, ...rest } = sampleOperation(overrides);
  return rest as NewOperation;
}

function setup(log: Logger = noopLogger) {
  const clock = new FakeClock();
  const raw = new MemoryOperationStore(clock);
  return { clock, raw, guarded: formatGuard(raw, log) };
}

describe('the Operation record format', () => {
  it('is 1, and every new Operation is stored with it', async () => {
    expect(OPERATION_FORMAT).toBe(1);
    const env = await createFakeEnv();
    const sub = await env.run(
      env.bc.transfer({ to: env.stranger(), amount: '0.001' }, { idempotencyKey: 'k' }),
    );
    const stored = await env.stores.operations.get(env.aio.namespace, sub.id);
    expect(stored?.format).toBe(OPERATION_FORMAT);
  });

  it('reads a record without a format (0.1.0) as format 1', async () => {
    const { raw, guarded } = setup();
    const { record } = await raw.create(withoutFormat({ idempotencyKey: 'old' }));
    expect(record.format).toBeUndefined();
    expect((await guarded.get('ns', record.id))?.format).toBe(1);
    expect((await guarded.getByKey('ns', 'old'))?.format).toBe(1);
    expect((await guarded.list({ namespace: 'ns' }))[0]?.format).toBe(1);
    const updated = await guarded.update('ns', record.id, { state: 'prepared' }, 1);
    expect(updated.format).toBe(1);
    expect(
      (await guarded.create(withoutFormat({ idempotencyKey: 'old' }))).record.format,
    ).toBe(1);
  });

  it('refuses to read a record of a newer format, naming the Operation', async () => {
    const { raw, guarded } = setup();
    const { record } = await raw.create(
      sampleOperation({ format: OPERATION_FORMAT + 1, idempotencyKey: 'new' }),
    );
    const reads: Array<() => Promise<unknown>> = [
      () => guarded.get('ns', record.id),
      () => guarded.getByKey('ns', 'new'),
      () => guarded.list({ namespace: 'ns' }),
      () => guarded.update('ns', record.id, {}, 1),
      () =>
        guarded.create(
          sampleOperation({ format: OPERATION_FORMAT, idempotencyKey: 'new' }),
        ),
    ];
    for (const read of reads) {
      await expect(read()).rejects.toMatchObject({
        code: 'RECORD_FORMAT_UNSUPPORTED',
        retryable: false,
        context: { operationId: record.id },
      });
    }
    // The store itself still holds it unchanged, for a newer version to read.
    expect((await raw.get('ns', record.id))?.format).toBe(OPERATION_FORMAT + 1);
  });

  it.each([0, -1, 1.5, '1', null])('treats format %p as unreadable', async (format) => {
    const { raw, guarded } = setup();
    const { record } = await raw.create({
      ...sampleOperation(),
      format,
    } as unknown as NewOperation);
    await expect(guarded.get('ns', record.id)).rejects.toMatchObject({
      code: 'RECORD_FORMAT_UNSUPPORTED',
    });
  });

  it('leaves a newer record to another worker: its claim is released, the rest are kept', async () => {
    const warnings: unknown[] = [];
    const log: Logger = {
      ...noopLogger,
      warn: (message, fields) => warnings.push({ message, fields }),
    };
    const { clock, raw, guarded } = setup(log);
    const now = clock.now();
    const newer = await raw.create(
      sampleOperation({ format: OPERATION_FORMAT + 1, nextCheckAt: now - 2 }),
    );
    const current = await raw.create(sampleOperation({ nextCheckAt: now - 1 }));
    const claimed = await guarded.claimDue('ns', 'old-worker', now, 60_000, 10);
    expect(claimed.map((r) => r.id)).toEqual([current.record.id]);
    expect(warnings).toEqual([
      {
        message: 'skipped an operation stored in a newer record format',
        fields: { operationId: newer.record.id, format: OPERATION_FORMAT + 1 },
      },
    ]);
    // Released at once: a newer worker claims it without waiting for the lease.
    const next = await raw.claimDue('ns', 'new-worker', now, 60_000, 10);
    expect(next.map((r) => r.id)).toEqual([newer.record.id]);
  });

  it('offers purge only when the store has it', () => {
    const memory = new MemoryOperationStore(new FakeClock());
    expect(typeof formatGuard(memory, noopLogger).purge).toBe('function');
    const withoutPurge = Object.create(memory, {
      purge: { value: undefined },
    }) as OperationStore;
    expect(formatGuard(withoutPurge, noopLogger).purge).toBeUndefined();
  });
});
