import {
  ChainError,
  ConfigError,
  CryptoAioError,
  ProviderError,
  StateError,
  createError,
  isCryptoAioError,
  withContext,
} from '../../../src/core/errors/error';

describe('CryptoAioError', () => {
  it('derives category and retryable from the code', () => {
    const e = new ProviderError('RATE_LIMITED', 'slow down', {
      context: { endpointId: 'a' },
    });
    expect(e).toBeInstanceOf(CryptoAioError);
    expect(e.name).toBe('ProviderError');
    expect(e.category).toBe('provider');
    expect(e.retryable).toBe(true);
    expect(e.ambiguous).toBe(false);
    expect(e.context).toEqual({ endpointId: 'a' });
  });

  it('allows retryable/ambiguous overrides', () => {
    const e = new ChainError('TX_REFUSED', 'x', { retryable: true, ambiguous: true });
    expect(e.retryable).toBe(true);
    expect(e.ambiguous).toBe(true);
  });

  it('createError picks the subclass for the code category', () => {
    expect(createError('CONFIG_INVALID', 'bad')).toBeInstanceOf(ConfigError);
    expect(createError('TIMEOUT', 'late').category).toBe('timeout');
  });

  it('catalogues STATE_UNRECORDED as a retryable state error (R27)', () => {
    const e = createError('STATE_UNRECORDED', 'not recorded');
    expect(e).toBeInstanceOf(StateError);
    expect(e).toMatchObject({ category: 'state', retryable: true, ambiguous: false });
  });

  it('serializes without stack or cause', () => {
    const e = new ConfigError('CONFIG_INVALID', 'bad', {
      cause: new Error('inner'),
      details: { k: 1 },
    });
    const json = e.toJSON();
    expect(json).toEqual({
      name: 'ConfigError',
      code: 'CONFIG_INVALID',
      category: 'config',
      message: 'bad',
      retryable: false,
      ambiguous: false,
      context: {},
      details: { k: 1 },
    });
    expect(JSON.stringify(e)).not.toContain('inner');
  });

  it('isCryptoAioError narrows by code', () => {
    const e = createError('NOT_FOUND', 'missing');
    expect(isCryptoAioError(e)).toBe(true);
    expect(isCryptoAioError(e, 'NOT_FOUND')).toBe(true);
    expect(isCryptoAioError(e, 'TIMEOUT')).toBe(false);
    expect(isCryptoAioError(new Error('x'))).toBe(false);
  });

  it('withContext returns a new error of the same class with merged context', () => {
    const e = new ChainError('INSUFFICIENT_FUNDS', 'poor', { context: { chain: 'c' } });
    const w = withContext(e, { operationId: 'op_1' }, { ambiguous: true });
    expect(w).toBeInstanceOf(ChainError);
    expect(w.context).toEqual({ chain: 'c', operationId: 'op_1' });
    expect(w.ambiguous).toBe(true);
    expect(w.message).toBe('poor');
  });
});
