// A12 (P5-A, amended): opt-in exact JSON integers on every JSON-bodied transport call.
import type { EndpointConfig } from '../../../src/core/transport/types';
import { parseJson } from '../../../src/core/util/json';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const C: EndpointConfig = { name: 'c', url: 'https://c.test' };
const D: EndpointConfig = { name: 'd', url: 'https://d.test' };
const BODY =
  '{"lamports":18446744073709551615,"small":5,"negative":-9007199254740993,"float":1.5,"exp":1e21,"list":[9007199254740993]}';
const EXACT = {
  lamports: 18_446_744_073_709_551_615n,
  small: 5,
  negative: -9_007_199_254_740_993n,
  float: 1.5,
  exp: 1e21,
  list: [9_007_199_254_740_993n],
};
/** An integer literal longer than the 80 digits the flag revives (P25-R4). */
const TOO_LONG = '9'.repeat(100);

/** A JSON-RPC answer written as raw text, so its numbers are exactly what a node sends. */
const rpcAnswer = (request: FakeRequest, result: string) => ({
  text: `{"jsonrpc":"2.0","id":${request.json<{ id: number }>().id},"result":${result}}`,
  headers: { 'content-type': 'application/json' },
});
/** A REST answer written as raw text. */
const restAnswer = (text: string) => ({
  text,
  headers: { 'content-type': 'application/json' },
});

describe('exact JSON integers (A12)', () => {
  it('parseJson revives integers outside the safe range as bigints, and only them', () => {
    expect(parseJson(BODY, true)).toEqual(EXACT);
    const lossy = parseJson(BODY) as { lamports: unknown; list: unknown[] };
    expect(lossy.lamports).toBe(18_446_744_073_709_552_000);
    expect(lossy.list).toEqual([9_007_199_254_740_992]);
    expect(parseJson('-9007199254740993', true)).toBe(-9_007_199_254_740_993n);
    expect(parseJson('9007199254740991', true)).toBe(9_007_199_254_740_991);
    expect(parseJson('1e30', true)).toBe(1e30);
    expect(typeof parseJson('12345678901234567890.5', true)).toBe('number');
  });

  it('the fast path never skips a 16-digit literal (M3)', () => {
    expect(parseJson('[900719925474099]', true)).toEqual([900_719_925_474_099]);
    expect(parseJson('[9007199254740991]', true)).toEqual([9_007_199_254_740_991]);
    expect(parseJson('[9007199254740993]', true)).toEqual([9_007_199_254_740_993n]);
    expect(parseJson('{"id":"1234567890123456","n":7}', true)).toEqual({
      id: '1234567890123456',
      n: 7,
    });
  });

  it('revives at most 80 digits, sign excluded, and refuses a longer integer literal', () => {
    const u256Max = 2n ** 256n - 1n; // 78 digits
    expect(parseJson(`[${u256Max}]`, true)).toEqual([u256Max]);
    expect(parseJson(`[${'9'.repeat(80)}]`, true)).toEqual([BigInt('9'.repeat(80))]);
    expect(parseJson(`[-${'9'.repeat(80)}]`, true)).toEqual([-BigInt('9'.repeat(80))]);
    expect(() => parseJson(`[${'9'.repeat(81)}]`, true)).toThrow(SyntaxError);
    expect(() => parseJson(`[-${TOO_LONG}]`, true)).toThrow(SyntaxError);
    // Opt-in: without the flag a long literal parses as before.
    expect(parseJson(`[${TOO_LONG}]`)).toEqual([1e100]);
  });

  it('refuses a multi-megabyte integer literal in bounded time', () => {
    // 2 MB of digits: an uncapped BigInt() of it takes about half a second.
    const huge = `{"lamports":${'9'.repeat(2_000_000)}}`;
    let fastest = Number.POSITIVE_INFINITY;
    let error: unknown;
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      try {
        parseJson(huge, true);
        error = undefined;
      } catch (caught) {
        error = caught;
      }
      fastest = Math.min(fastest, performance.now() - started);
    }
    // The best of three runs, so a GC pause or a busy worker cannot flake it.
    expect(fastest).toBeLessThan(50);
    expect(error).toBeInstanceOf(SyntaxError);
  });

  it('applies to rpc and rpcRaw answers with the flag, and never without it', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcAnswer(req, BODY));
    const { transport, clock } = setup([A], fake);
    expect(await drive(clock, transport.rpc('m', [], { exactIntegers: true }))).toEqual(
      EXACT,
    );
    const lossy = await drive(clock, transport.rpc<{ lamports: unknown }>('m', []));
    expect(lossy.lamports).toBe(18_446_744_073_709_552_000);
    expect(
      await drive(
        clock,
        transport.rpcRaw({ jsonrpc: '2.0', id: 1, method: 'm' }, { exactIntegers: true }),
      ),
    ).toMatchObject({ result: { lamports: 18_446_744_073_709_551_615n } });
    expect(
      await drive(clock, transport.rpcRaw({ jsonrpc: '2.0', id: 1, method: 'm' })),
    ).toMatchObject({ result: { lamports: 18_446_744_073_709_552_000 } });
  });

  it('applies to http answers (their own endpoint: this pins parsing, not failover)', async () => {
    const fake = new FakeFetch().route('https://c.test', () => restAnswer(BODY));
    const { transport, clock } = setup([C], fake);
    const request = { method: 'POST' as const, path: '/wallet/getaccount', body: {} };
    expect(await drive(clock, transport.http(request, { exactIntegers: true }))).toEqual(
      EXACT,
    );
    expect(await drive(clock, transport.http(request))).toMatchObject({
      lamports: 18_446_744_073_709_552_000,
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('answers a too-long integer literal as a malformed body: a retryable PROVIDER_UNAVAILABLE', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) =>
      rpcAnswer(req, TOO_LONG),
    );
    const { transport, clock } = setup([A], fake);
    await expect(
      drive(clock, transport.rpc('m', [], { exactIntegers: true })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: expect.stringMatching(/non-JSON body/),
    });
  });

  it('lets quorum keys see the revived values', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => rpcAnswer(req, BODY))
      .route('https://b.test', (req) => rpcAnswer(req, BODY));
    const { transport, clock } = setup([A, B], fake);
    const seen: unknown[] = [];
    await drive(
      clock,
      transport.rpc('m', [], {
        exactIntegers: true,
        quorum: 2,
        quorumKey: (result) => {
          seen.push((result as { lamports: unknown }).lamports);
          return result;
        },
      }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((value) => value === 18_446_744_073_709_551_615n)).toBe(true);
  });

  it('counts a quorum key that JSON.stringifies revived values as a disagreement', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => rpcAnswer(req, BODY))
      .route('https://b.test', (req) => rpcAnswer(req, BODY));
    const { transport, clock } = setup([A, B], fake);
    const stringKey = (result: unknown) => JSON.stringify(result);
    // Without the flag the same key agrees; with it, JSON.stringify throws on a bigint.
    await expect(
      drive(clock, transport.rpc('m', [], { quorum: 2, quorumKey: stringKey })),
    ).resolves.toMatchObject({ lamports: 18_446_744_073_709_552_000 });
    await expect(
      drive(
        clock,
        transport.rpc('m', [], { exactIntegers: true, quorum: 2, quorumKey: stringKey }),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('tells apart answers that round to the same number', async () => {
    const fake = new FakeFetch()
      .route('https://c.test', () => restAnswer('{"balance":18446744073709551615}'))
      .route('https://d.test', () => restAnswer('{"balance":18446744073709551614}'));
    const { transport, clock } = setup([C, D], fake);
    const request = { method: 'POST' as const, path: '/x', body: {} };
    // Both round to 18446744073709552000: a lossy quorum agrees on the wrong value.
    await expect(
      drive(clock, transport.http(request, { quorum: 'proof' })),
    ).resolves.toEqual({ balance: 18_446_744_073_709_552_000 });
    await expect(
      drive(clock, transport.http(request, { quorum: 'proof', exactIntegers: true })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
  });

  it('never lets an object pass for a revived bigint in a quorum (P25-R21/M1)', async () => {
    // A liar's object shaped like canonicalJson's bigint tag, against an honest u64.
    const LIAR = '{"lamports":{"$bigint":"18446744073709551615"}}';
    const HONEST = '{"lamports":18446744073709551615}';
    const lamports = (result: unknown) => (result as { lamports: unknown }).lamports;
    for (const [first, second] of [
      [LIAR, HONEST],
      [HONEST, LIAR],
    ]) {
      const fake = new FakeFetch()
        .route('https://a.test', (req) => rpcAnswer(req, first as string))
        .route('https://b.test', (req) => rpcAnswer(req, second as string));
      const { transport, clock } = setup([A, B], fake);
      for (const quorumKey of [undefined, lamports]) {
        await expect(
          drive(
            clock,
            transport.rpc('m', [], {
              exactIntegers: true,
              quorum: 'proof',
              ...(quorumKey ? { quorumKey } : {}),
            }),
          ),
        ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      }
    }
    // Answers alike still agree, `$` keys and all.
    const same = new FakeFetch()
      .route('https://a.test', (req) => rpcAnswer(req, LIAR))
      .route('https://b.test', (req) => rpcAnswer(req, LIAR));
    const { transport, clock } = setup([A, B], same);
    await expect(
      drive(clock, transport.rpc('m', [], { exactIntegers: true, quorum: 'proof' })),
    ).resolves.toEqual({ lamports: { $bigint: '18446744073709551615' } });
  });

  it('keeps health probes on plain parsing', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) =>
      rpcAnswer(req, '18446744073709551615'),
    );
    const { transport, clock } = setup([A], fake);
    const probed: unknown[] = [];
    transport.setProbes({
      height: async (call) => {
        probed.push(await call.rpc('height'));
        return 1n;
      },
    });
    await drive(
      clock,
      transport.rpc('m', [], { purpose: 'monitor', exactIntegers: true }),
    );
    expect(probed).toEqual([18_446_744_073_709_552_000]);
  });
});

describe('exact JSON integers in JSON-RPC errors (A12)', () => {
  /** A definitive JSON-RPC error whose `data` is the raw JSON text given. */
  const rpcError = (data: string) =>
    new FakeFetch().route('https://a.test', (req) => ({
      text: `{"jsonrpc":"2.0","id":${req.json<{ id: number }>().id},"error":{"code":-32002,"message":"simulation failed","data":${data}}}`,
      headers: { 'content-type': 'application/json' },
    }));

  it('keeps a revived error data field a definitive RPC_ERROR', async () => {
    const { transport, clock } = setup(
      [A],
      rpcError('{"lamports":18446744073709551615}'),
    );
    await expect(
      drive(clock, transport.rpc('m', [], { exactIntegers: true })),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
      details: { rpcData: '{"lamports":"18446744073709551615"}' },
    });
  });

  it('writes a top-level revived error data as its bare decimal digits', async () => {
    const { transport, clock } = setup([A], rpcError('18446744073709551615'));
    await expect(
      drive(clock, transport.rpc('m', [], { exactIntegers: true })),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      retryable: false,
      details: { rpcData: '18446744073709551615' },
    });
  });
});
