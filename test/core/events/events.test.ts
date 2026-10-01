import { StateError } from '../../../src/core/errors/error';
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

  // The warning carries the event type and the error code, never the error itself.
  it('logs a throwing handler by event type and error code only', () => {
    const warnings: unknown[] = [];
    const bus = new EventBus(new FakeClock(), {
      ...noopLogger,
      warn: (message, fields) => warnings.push([message, fields]),
    });
    bus.on('scanner.block', () => {
      throw new Error('boom at https://user:pw@rpc.example/key');
    });
    bus.on('scanner.block', () => {
      throw new StateError('NOT_FOUND', 'missing');
    });
    bus.emit('scanner.block', { namespace: 'ns', cursorKey: 'c', height: '1' });
    expect(warnings).toEqual([
      ['event handler threw', { type: 'scanner.block', code: 'UNKNOWN' }],
      ['event handler threw', { type: 'scanner.block', code: 'NOT_FOUND' }],
    ]);
  });

  it('tolerates a double unsubscribe and stops delivery after unsubscribing', () => {
    const bus = new EventBus(new FakeClock(), noopLogger);
    const seen: string[] = [];
    const anySeen: string[] = [];
    const off = bus.on('scanner.block', (e) => seen.push(e.height));
    const offAny = bus.onAny((e) => anySeen.push(e.type));

    off();
    offAny();
    expect(() => {
      off();
      offAny();
    }).not.toThrow();

    bus.emit('scanner.block', { namespace: 'ns', cursorKey: 'c', height: '1' });
    expect(seen).toEqual([]);
    expect(anySeen).toEqual([]);
  });

  it('lets a self-unsubscribing handler leave later handlers unaffected within the same emit', () => {
    const bus = new EventBus(new FakeClock(), noopLogger);
    const later: string[] = [];
    let selfCalls = 0;

    const off = bus.on('scanner.block', () => {
      selfCalls++;
      off();
    });
    bus.on('scanner.block', (e) => later.push(e.height));

    bus.emit('scanner.block', { namespace: 'ns', cursorKey: 'c', height: '1' });
    expect(selfCalls).toBe(1);
    expect(later).toEqual(['1']);

    bus.emit('scanner.block', { namespace: 'ns', cursorKey: 'c', height: '2' });
    expect(selfCalls).toBe(1);
    expect(later).toEqual(['1', '2']);
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

  it('redacts the message string, not only fields', () => {
    const lines: Parameters<LogWriter>[] = [];
    const log = createLogger('crypto-aio', (...args) => lines.push(args));
    log.warn('connect failed to https://h.io/AbCdEf0123456789XyZ', undefined);
    expect(lines).toEqual([
      ['warn', 'crypto-aio', 'connect failed to https://h.io/[REDACTED]', undefined],
    ]);
  });
});
