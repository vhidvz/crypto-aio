import { inspect } from 'node:util';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { EventBus } from '../../../src/core/events/bus';
import { noopLogger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import { Address } from '../../../src/core/model/address';
import { BUILTIN_SCHEMES, SchemeCatalog } from '../../../src/core/registry/schemes';
import { secret } from '../../../src/core/secret/secret';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import { SigningOrchestrator } from '../../../src/core/signing/orchestrator';
import type {
  Signer,
  SigningRequest,
  SignatureBundle,
  SigningResult,
} from '../../../src/core/signing/types';
import type { ResolvedWallet } from '../../../src/core/signing/wallet';
import { toHex, utf8ToBytes } from '../../../src/core/util/bytes';
import { FakeClock } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';
import { ctx } from './fixtures';

const keyA = secp256k1.utils.randomPrivateKey();
const keyB = secp256k1.utils.randomPrivateKey();
const hot = localSigner({ id: 'hot', secp256k1: secret(keyA) });
const cold = localSigner({ id: 'cold', secp256k1: secret(keyB) });

function wallet(signers: Record<string, Signer>, primary = 'hot'): ResolvedWallet {
  return {
    name: 'w',
    config: { signer: primary, signers: { cold: 'cold' } },
    address: new Address('c', { canonical: 'x', display: 'x' }),
    keys: [],
    options: {},
    watchOnly: false,
    signerFor: (ref) => {
      const id = ref?.id !== undefined ? ref.id : primary;
      const signer = signers[id];
      return signer ? { id, signer } : undefined;
    },
    signerById: (id) => {
      const signer = Object.hasOwn(signers, id) ? signers[id] : undefined;
      return signer ? { id, signer } : undefined;
    },
  };
}

/** A pending signer whose `cancelRequest` records tickets (or throws when `cancel` says so). */
function pendingSigner(
  id: string,
  ticket: string | undefined,
  cancelled: string[],
  cancel: 'ok' | 'throws' | 'missing' = 'ok',
): Signer {
  return callbackSigner({
    id,
    schemes: ['secp256k1-ecdsa'],
    getPublicKey: async () => new Uint8Array(33),
    sign: async () => ({
      status: 'pending',
      ...(ticket !== undefined ? { ticket } : {}),
    }),
    ...(cancel === 'missing'
      ? {}
      : {
          cancelRequest: async (t: string) => {
            if (cancel === 'throws')
              throw new Error('https://mpc.io/SECRETKEY1234567890abc down');
            cancelled.push(`${id}:${t}`);
          },
        }),
  });
}

const liarSigner = callbackSigner({
  id: 'liar',
  schemes: ['secp256k1-ecdsa'],
  getPublicKey: async () => new Uint8Array(33),
  sign: async (requests) => ({
    status: 'signed',
    // Signs with keyA; the tests route keyB requests to it, so nothing verifies.
    signatures: requests.map((r) => signWith(keyA, r)),
  }),
});

function request(id: string, key: Uint8Array, keyRef?: { id: string }): SigningRequest {
  return {
    id,
    scheme: 'secp256k1-ecdsa',
    payload: sha256(utf8ToBytes(id)),
    payloadKind: 'digest',
    publicKey: secp256k1.getPublicKey(key, true),
    ...(keyRef ? { keyRef } : {}),
  };
}

function setup(beforeSign?: (c: typeof ctx) => void) {
  const clock = new FakeClock();
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((e) => seen.push(e));
  const orchestrator = new SigningOrchestrator({
    schemes: () => new SchemeCatalog(BUILTIN_SCHEMES),
    events,
    clock,
    hooks: () => (beforeSign ? { beforeSign } : {}),
  });
  return { orchestrator, seen };
}

/** A signer that returns whatever `result` is, bypassing the `SigningResult` type. */
function returning(result: unknown): Signer {
  return callbackSigner({
    id: 'hot',
    schemes: ['secp256k1-ecdsa'],
    getPublicKey: async () => new Uint8Array(33),
    sign: async () => result as SigningResult,
  });
}

function signWith(key: Uint8Array, r: SigningRequest) {
  const sig = secp256k1.sign(r.payload, key, { lowS: true });
  return { requestId: r.id, bytes: sig.toCompactRawBytes(), recovery: sig.recovery };
}

function completions(seen: readonly AioEvent[]): string[] {
  return seen
    .filter((e) => e.type === 'signer.completed')
    .map((e) => (e as AioEvent<'signer.completed'>).status);
}

describe('SigningOrchestrator', () => {
  it('routes requests by keyRef, verifies them and keeps request order', async () => {
    const { orchestrator, seen } = setup();
    const requests = [request('r0', keyA), request('r1', keyB, { id: 'cold' })];
    const result = await orchestrator.sign(wallet({ hot, cold }), requests, ctx);
    expect(result.status).toBe('signed');
    expect(result.signatures.map((s) => s.requestId)).toEqual(['r0', 'r1']);
    expect(
      seen
        .filter((e) => e.type === 'signer.requested')
        .map((e) => (e as { signerId: string }).signerId),
    ).toEqual(['hot', 'cold']);
    expect(seen.filter((e) => e.type === 'signer.completed')).toHaveLength(2);
  });

  it('rejects signatures that do not verify against the expected key', async () => {
    const { orchestrator, seen } = setup();
    const liar = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => secp256k1.getPublicKey(keyA, true),
      sign: async (requests) => ({
        status: 'signed',
        signatures: requests.map((r) => {
          const sig = secp256k1.sign(r.payload, keyB, { lowS: true });
          return {
            requestId: r.id,
            bytes: sig.toCompactRawBytes(),
            recovery: sig.recovery,
          };
        }),
      }),
    });
    await expect(
      orchestrator.sign(wallet({ hot: liar }), [request('r0', keyA)], ctx),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
    expect(completions(seen)).toEqual(['error']);
  });

  it('returns verified partial signatures while a signer is pending', async () => {
    const { orchestrator } = setup();
    const mpc = callbackSigner({
      id: 'cold',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => ({ status: 'pending', ticket: 'mpc-7' }),
    });
    const result = await orchestrator.sign(
      wallet({ hot, cold: mpc }),
      [request('r0', keyA), request('r1', keyB, { id: 'cold' })],
      ctx,
    );
    expect(result).toMatchObject({
      status: 'pending',
      tickets: [{ signerId: 'cold', ticket: 'mpc-7' }],
    });
    expect(result.signatures.map((s) => s.requestId)).toEqual(['r0']);
  });

  it('keeps every issued ticket with the signer that issued it (R22)', async () => {
    const { orchestrator } = setup();
    const cancelled: string[] = [];
    const result = await orchestrator.sign(
      wallet({
        hot: pendingSigner('hot', 'h-1', cancelled),
        cold: pendingSigner('cold', 'c-1', cancelled),
        quiet: pendingSigner('quiet', undefined, cancelled),
      }),
      [
        request('r0', keyA),
        request('r1', keyB, { id: 'cold' }),
        request('r2', keyB, { id: 'quiet' }),
      ],
      ctx,
    );
    expect(result).toEqual({
      status: 'pending',
      tickets: [
        { signerId: 'hot', ticket: 'h-1' },
        { signerId: 'cold', ticket: 'c-1' },
      ],
      signatures: [],
    });
    expect(cancelled).toEqual([]);
  });

  it('cancels already-issued tickets through their own signers before rethrowing (R22)', async () => {
    const { orchestrator } = setup();
    const cancelled: string[] = [];
    const error = await orchestrator
      .sign(
        wallet({
          hot: pendingSigner('hot', 'h-1', cancelled),
          cold: pendingSigner('cold', 'c-1', cancelled),
          liar: liarSigner,
        }),
        [
          request('r0', keyA),
          request('r1', keyB, { id: 'cold' }),
          request('r2', keyB, { id: 'liar' }),
        ],
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'SIGNATURE_MISMATCH',
      details: { cancelFailures: 0 },
    });
    expect(cancelled).toEqual(['hot:h-1', 'cold:c-1']);
  });

  it('counts failed or impossible cancellations and still rethrows the original error', async () => {
    const { orchestrator } = setup();
    const cancelled: string[] = [];
    const broken = callbackSigner({
      id: 'broken',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => {
        throw new Error('HSM offline');
      },
    });
    const error = await orchestrator
      .sign(
        wallet({
          hot: pendingSigner('hot', 'h-1', cancelled, 'throws'),
          cold: pendingSigner('cold', 'c-1', cancelled, 'missing'),
          ok: pendingSigner('ok', 'o-1', cancelled),
          broken,
        }),
        [
          request('r0', keyA),
          request('r1', keyB, { id: 'cold' }),
          request('r2', keyB, { id: 'ok' }),
          request('r3', keyB, { id: 'broken' }),
        ],
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'SIGNING_FAILED',
      details: { cancelFailures: 2 },
    });
    expect(cancelled).toEqual(['ok:o-1']);
    expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
  });

  it('does not re-sign requests that already have signatures', async () => {
    const { orchestrator } = setup();
    let calls = 0;
    const counting = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async (r, c) => {
        calls += 1;
        return hot.sign(r, c);
      },
    });
    const first = await orchestrator.sign(
      wallet({ hot: counting }),
      [request('r0', keyA)],
      ctx,
    );
    const again = await orchestrator.sign(
      wallet({ hot: counting }),
      [request('r0', keyA)],
      ctx,
      first.signatures,
    );
    expect(again.status).toBe('signed');
    expect(calls).toBe(1);
  });

  it.each<[string, unknown]>([
    ['64 zero bytes', { requestId: 'r0', bytes: new Uint8Array(64), recovery: 0 }],
    ['a string bytes value', { requestId: 'r0', bytes: 'ab'.repeat(64), recovery: 0 }],
  ])(
    'sign() verifies existing signatures before trusting them: %s',
    async (_label, bad) => {
      const { orchestrator } = setup();
      let calls = 0;
      const counting = callbackSigner({
        id: 'hot',
        schemes: ['secp256k1-ecdsa'],
        getPublicKey: async () => new Uint8Array(33),
        sign: async (r, c) => {
          calls += 1;
          return hot.sign(r, c);
        },
      });
      const existing = [bad as SignatureBundle];
      await expect(
        orchestrator.sign(
          wallet({ hot: counting }),
          [request('r0', keyA)],
          ctx,
          existing,
        ),
      ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
      expect(calls).toBe(0);
    },
  );

  it('sign() ignores existing entries for unknown requests and copies known ones', async () => {
    const { orchestrator } = setup();
    const r1 = request('r1', keyA);
    const s1 = signWith(keyA, r1);
    const stray = { requestId: 'zz', bytes: 'not bytes' } as unknown as SignatureBundle;
    const result = await orchestrator.sign(
      wallet({ hot }),
      [request('r0', keyA), r1],
      ctx,
      [stray, s1],
    );
    expect(result.signatures.map((s) => s.requestId)).toEqual(['r0', 'r1']);
    expect(result.signatures[1]?.bytes).not.toBe(s1.bytes);
    expect(result.signatures[1]?.bytes).toEqual(s1.bytes);
  });

  it('turns an async policy rejection into POLICY_REJECTED', async () => {
    const { orchestrator } = setup(async () => {
      await Promise.resolve();
      throw new Error('approval denied');
    });
    await expect(orchestrator.authorize(ctx)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'approval denied',
    });
  });

  it('batches every request routed to one signer into a single call', async () => {
    const { orchestrator, seen } = setup();
    const batches: string[][] = [];
    const batching = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async (r, c) => {
        batches.push(r.map((x) => x.id));
        return hot.sign(r, c);
      },
    });
    const result = await orchestrator.sign(
      wallet({ hot: batching }),
      [request('r0', keyA), request('r1', keyA)],
      ctx,
    );
    expect(result.status).toBe('signed');
    expect(batches).toEqual([['r0', 'r1']]);
    expect(seen.filter((e) => e.type === 'signer.requested')).toMatchObject([
      { requests: 2 },
    ]);
  });

  it('ignores extra signatures and uses only the first one per request', async () => {
    const { orchestrator } = setup();
    const r = request('r0', keyA);
    const good = signWith(keyA, r);
    const bad = signWith(keyB, r);
    const extra = signWith(keyA, request('r9', keyA));
    const ok = await orchestrator.sign(
      wallet({ hot: returning({ status: 'signed', signatures: [extra, good, bad] }) }),
      [r],
      ctx,
    );
    expect(ok.signatures).toHaveLength(1);
    expect(ok.signatures[0]?.bytes).toEqual(good.bytes);
    await expect(
      orchestrator.sign(
        wallet({ hot: returning({ status: 'signed', signatures: [bad, good] }) }),
        [r],
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
  });

  it('turns policy vetoes into POLICY_REJECTED', async () => {
    const { orchestrator } = setup(() => {
      throw new Error('daily withdrawal limit reached');
    });
    await expect(orchestrator.authorize(ctx)).rejects.toMatchObject({
      code: 'POLICY_REJECTED',
      message: 'daily withdrawal limit reached',
    });
    await expect(setup().orchestrator.authorize(ctx)).resolves.toBeUndefined();
  });

  it('never leaks a URL secret from a policy hook failure', async () => {
    const { orchestrator } = setup(() => {
      throw new Error(
        'policy engine at https://policy.io/SECRETKEY1234567890abc refused',
      );
    });
    const error = await orchestrator.authorize(ctx).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'POLICY_REJECTED' });
    expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
    expect(JSON.stringify(error)).not.toContain('SECRETKEY1234567890abc');
  });

  it('fails clearly when no signer can serve a request or a signer crashes', async () => {
    const { orchestrator } = setup();
    await expect(
      orchestrator.sign(wallet({}), [request('r0', keyA)], ctx),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    const broken = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => {
        throw new Error('HSM offline');
      },
    });
    await expect(
      orchestrator.sign(wallet({ hot: broken }), [request('r0', keyA)], ctx),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    const edOnly = callbackSigner({
      id: 'hot',
      schemes: ['ed25519'],
      getPublicKey: async () => new Uint8Array(32),
      sign: async () => ({ status: 'pending' }),
    });
    await expect(
      orchestrator.sign(wallet({ hot: edOnly }), [request('r0', keyA)], ctx),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
  });

  it('wraps an unprintable signer failure as SIGNING_FAILED (M5)', async () => {
    const { orchestrator } = setup();
    const odd = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => {
        throw Object.create(null);
      },
    });
    const error = await orchestrator
      .sign(wallet({ hot: odd }), [request('r0', keyA)], ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'SIGNING_FAILED',
      cause: { message: '[unprintable error]' },
    });
  });

  it('guards the routing reads: signerFor and the signer scheme list (M5)', async () => {
    const { orchestrator } = setup();
    const unreadable = {
      id: 'hot',
      get schemes(): never {
        throw new Error('vault https://vault.io/SECRETKEY1234567890abc sealed');
      },
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => ({ status: 'pending' }) as const,
    } as Signer;
    const router: ResolvedWallet = {
      ...wallet({ hot }),
      signerFor: () => {
        throw new Error('router https://router.io/SECRETKEY1234567890abc down');
      },
    };
    for (const w of [wallet({ hot: unreadable }), router]) {
      const error = await orchestrator
        .sign(w, [request('r0', keyA)], ctx)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
      expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
    }
  });

  it('never leaks a URL secret from a signer failure', async () => {
    const { orchestrator, seen } = setup();
    const custody = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => {
        throw new Error('HSM at https://hsm.io/SECRETKEY1234567890abc refused');
      },
    });
    const error = await orchestrator
      .sign(wallet({ hot: custody }), [request('r0', keyA)], ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SIGNING_FAILED' });
    expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
    expect(JSON.stringify(error)).not.toContain('SECRETKEY1234567890abc');
    expect(completions(seen)).toEqual(['error']);
  });

  const r0 = request('r0', keyA);
  const r0Sig = signWith(keyA, r0);
  it.each<[string, unknown]>([
    ['a non-object result', null],
    ['an unknown status', { status: 'done', signatures: [r0Sig] }],
    ['signatures that are not an array', { status: 'signed', signatures: 'r0' }],
    [
      'bytes given as a hex string',
      { status: 'signed', signatures: [{ ...r0Sig, bytes: toHex(r0Sig.bytes) }] },
    ],
    [
      'a missing requestId',
      { status: 'signed', signatures: [{ ...r0Sig, requestId: 0 }] },
    ],
    [
      'a recovery outside 0..3',
      { status: 'signed', signatures: [{ ...r0Sig, recovery: 4 }] },
    ],
    [
      'a fractional recovery',
      { status: 'signed', signatures: [{ ...r0Sig, recovery: 0.5 }] },
    ],
    ['a non-string ticket', { status: 'pending', ticket: 7 }],
    ['a null signature entry', { status: 'signed', signatures: [null] }],
    [
      'bytes given as a DataView',
      {
        status: 'signed',
        signatures: [{ ...r0Sig, bytes: new DataView(r0Sig.bytes.buffer) }],
      },
    ],
    [
      'bytes given as an ArrayBuffer',
      { status: 'signed', signatures: [{ ...r0Sig, bytes: r0Sig.bytes.slice().buffer }] },
    ],
    ['a NaN recovery', { status: 'signed', signatures: [{ ...r0Sig, recovery: NaN }] }],
    [
      'signatures whose own map would skip the entry checks',
      {
        status: 'signed',
        signatures: Object.assign([{ ...r0Sig, bytes: toHex(r0Sig.bytes) }], {
          map(this: unknown[]) {
            return this;
          },
        }),
      },
    ],
    [
      'a result that throws when read',
      {
        get status(): never {
          throw new TypeError('boom');
        },
      },
    ],
  ])('turns %s into SIGNING_FAILED', async (_label, result) => {
    const { orchestrator, seen } = setup();
    const error = await orchestrator
      .sign(wallet({ hot: returning(result) }), [r0], ctx)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SIGNING_FAILED' });
    expect(error).not.toBeInstanceOf(TypeError);
    expect(completions(seen)).toEqual(['error']);
  });

  it('returns its own copy of the verified bytes, not the signer’s buffer', async () => {
    const { orchestrator } = setup();
    const bundle = signWith(keyA, r0);
    const result = await orchestrator.sign(
      wallet({ hot: returning({ status: 'signed', signatures: [bundle] }) }),
      [r0],
      ctx,
    );
    bundle.bytes.fill(0);
    const [signature] = result.signatures;
    expect(signature?.bytes).not.toBe(bundle.bytes);
    expect(() => orchestrator.verify(r0, signature!)).not.toThrow();
  });

  it('hands signers copies and verifies against its own snapshot of each request', async () => {
    const { orchestrator } = setup();
    const tweak = new Uint8Array(32).fill(7);
    const original: SigningRequest = { ...request('r0', keyA), params: { tweak } };
    const before = {
      payload: original.payload.slice(),
      publicKey: original.publicKey.slice(),
      tweak: tweak.slice(),
    };
    const mutator = callbackSigner({
      id: 'hot',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: async () => new Uint8Array(33),
      sign: async ([r]) => {
        // Rewrites the request in place, then signs what it now says with the key it now names.
        r!.payload.reverse();
        r!.publicKey.set(secp256k1.getPublicKey(keyB, true));
        r!.params?.tweak?.fill(0);
        return { status: 'signed', signatures: [signWith(keyB, r!)] };
      },
    });
    await expect(
      orchestrator.sign(wallet({ hot: mutator }), [original], ctx),
    ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
    expect(original.payload).toEqual(before.payload);
    expect(original.publicKey).toEqual(before.publicKey);
    expect(tweak).toEqual(before.tweak);
  });

  it('emits operational data only in signer events', async () => {
    const { orchestrator, seen } = setup();
    await orchestrator.sign(wallet({ hot }), [r0], ctx);
    const [requested, completed] = seen;
    expect(Object.keys(requested ?? {}).sort()).toEqual([
      'at',
      'namespace',
      'operationId',
      'requests',
      'signerId',
      'type',
    ]);
    expect(Object.keys(completed ?? {}).sort()).toEqual([
      'at',
      'latencyMs',
      'namespace',
      'operationId',
      'signerId',
      'status',
      'type',
    ]);
    expect(requested).toMatchObject({ requests: 1, signerId: 'hot' });
    expect(completed).toMatchObject({ status: 'signed', latencyMs: 0 });
  });

  it('accepts only valid external signatures for known requests', () => {
    const { orchestrator } = setup();
    const requests = [request('r0', keyA), request('r1', keyB)];
    const sig = secp256k1.sign(requests[0]!.payload, keyA, { lowS: true });
    const good = {
      requestId: 'r0',
      bytes: sig.toCompactRawBytes(),
      recovery: sig.recovery,
    };
    expect(orchestrator.accept(requests, [good], []).map((s) => s.requestId)).toEqual([
      'r0',
    ]);
    expect(
      thrown(() => orchestrator.accept(requests, [{ ...good, requestId: 'r9' }], [])),
    ).toMatchObject({ code: 'INVALID_INTENT' });
    expect(() =>
      orchestrator.accept(requests, [{ ...good, requestId: 'r1' }], []),
    ).toThrow(/does not verify/);
  });

  it('merges external signatures with existing ones and rejects malformed ones', () => {
    const { orchestrator } = setup();
    const requests = [request('r0', keyA), request('r1', keyB)];
    const s0 = signWith(keyA, requests[0]!);
    const s1 = signWith(keyB, requests[1]!);
    const merged = orchestrator.accept(requests, [s1], [s0]);
    expect(merged.map((s) => s.requestId)).toEqual(['r0', 'r1']);
    expect(merged[1]?.bytes).not.toBe(s1.bytes);
    expect(
      thrown(() =>
        orchestrator.accept(requests, [{ ...s1, bytes: toHex(s1.bytes) } as never], []),
      ),
    ).toMatchObject({ code: 'INVALID_INTENT' });
    expect(
      thrown(() => orchestrator.accept(requests, [{ ...s1, recovery: 9 }], [])),
    ).toMatchObject({ code: 'INVALID_INTENT' });
    expect(
      thrown(() =>
        orchestrator.accept(requests, [{ ...s1, recovery: s1.recovery ^ 1 }], [s0]),
      ),
    ).toMatchObject({ code: 'SIGNATURE_MISMATCH' });
  });

  it('accept() verifies existing signatures, ignores unknown ones and copies known ones', () => {
    const { orchestrator } = setup();
    const requests = [request('r0', keyA), request('r1', keyB)];
    const s0 = signWith(keyA, requests[0]!);
    const s1 = signWith(keyB, requests[1]!);
    const zeros = { requestId: 'r0', bytes: new Uint8Array(64), recovery: 0 };
    const text = {
      requestId: 'r0',
      bytes: 'ab'.repeat(64),
    } as unknown as SignatureBundle;
    expect(thrown(() => orchestrator.accept(requests, [s1], [zeros]))).toMatchObject({
      code: 'SIGNATURE_MISMATCH',
    });
    expect(thrown(() => orchestrator.accept(requests, [s1], [text]))).toMatchObject({
      code: 'SIGNATURE_MISMATCH',
    });
    const stray = { requestId: 'zz', bytes: 'x' } as unknown as SignatureBundle;
    const merged = orchestrator.accept(requests, [s1], [stray, s0]);
    expect(merged.map((s) => s.requestId)).toEqual(['r0', 'r1']);
    expect(merged[0]?.bytes).not.toBe(s0.bytes);
  });
});
