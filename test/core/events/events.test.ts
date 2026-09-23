import { EventBus } from '../../../src/core/events/bus';
import {
  createLogger,
  noopLogger,
  type LogWriter,
} from '../../../src/core/events/logger';
import { secret } from '../../../src/core/secret/secret';
import { FakeClock } from '../../../src/testing/fake-clock';

describe('EventBus', () => {
  it('delivers typed events with type and timestamp', () => {
    const bus = new EventBus(new FakeClock(5), noopLogger);
    const seen: unknown[] = [];
    const off = bus.on('operation.stalled', (e) => seen.push(e));
    bus.emit('operation.stalled', {
      namespace: 'ns',
      operationId: 'op',
      code: 'INSUFFICIENT_FUNDS',
    });
    off();
    bus.emit('operation.stalled', { namespace: 'ns', operationId: 'op2', code: 'X' });
    expect(seen).toEqual([
      {
        type: 'operation.stalled',
        at: 5,
        namespace: 'ns',
        operationId: 'op',
        code: 'INSUFFICIENT_FUNDS',
      },
    ]);
  });

  it('isolates handler failures and supports onAny', () => {
    const warnings: string[] = [];
    const bus = new EventBus(new FakeClock(), {
      ...noopLogger,
      warn: (m) => warnings.push(m),
    });
    const all: string[] = [];
    bus.on('scanner.block', () => {
      throw new Error('boom');
    });
    bus.onAny((e) => all.push(e.type));
    bus.emit('scanner.block', { namespace: 'ns', cursorKey: 'c', height: '1' });
    expect(all).toEqual(['scanner.block']);
    expect(warnings).toEqual(['event handler threw']);
  });
});

describe('createLogger', () => {
  it('redacts fields before writing and namespaces children', () => {
    const lines: Parameters<LogWriter>[] = [];
    const log = createLogger('crypto-aio', (...args) => lines.push(args));
    log.child('evm').warn('rpc failed', {
      apiKey: 'k',
      url: 'https://h.io/AbCdEf0123456789XyZ',
      token: secret('t'),
    });
    expect(lines).toEqual([
      [
        'warn',
        'crypto-aio:evm',
        'rpc failed',
        { apiKey: '[REDACTED]', url: 'https://h.io/[REDACTED]', token: '[REDACTED]' },
      ],
    ]);
  });
});
