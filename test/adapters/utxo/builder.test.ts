import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { HDKey } from '@scure/bip32';
import { walletAddress } from '../../../src/adapters/utxo/address';
import {
  utxoBroadcaster,
  utxoBuilder,
  utxoReplacement,
} from '../../../src/adapters/utxo/builder';
import { chainReader } from '../../../src/adapters/utxo/reader';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import type { BuildContext } from '../../../src/core/driver/types';
import { ProviderError } from '../../../src/core/errors/error';
import type { DriverIntent } from '../../../src/core/model/intent';
import type { SignedTx, UnsignedTx } from '../../../src/core/model/transaction';
import type { SigningContext } from '../../../src/core/signing/types';
import { utxoHarness, type HarnessOptions } from './support/harness';
import { nativeSigner, signedSpend } from './support/tx';
import {
  OTHER_PUBKEY,
  REGTEST,
  TEST_KEY,
  TEST_PUBKEY,
  testSigner,
} from './support/vectors';

const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const KEYS = [{ scheme: 'secp256k1-ecdsa', publicKey: TEST_PUBKEY }];
const build = (extra: Partial<BuildContext> = {}): BuildContext => ({
  from: OWN.address,
  keys: KEYS,
  wallet: {},
  ...extra,
});
const intent = (amount: bigint, extra: Partial<DriverIntent> = {}): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: PAYEE.address, amount }],
  from: OWN.address,
  fee: 'normal',
  ...extra,
});
const bare = (data: string): SignedTx => ({
  raw: { encoding: 'hex', data },
  ref: { id: '', idKind: 'txid', canonical: true },
});
/** The node's 400 for a made-up consensus refusal (Blockstream's format). */
const FABRICATED = {
  status: 400,
  text: 'sendrawtransaction RPC error -26: bad-txns-inputs-duplicate',
};

async function funded(
  values: readonly bigint[] = [100_000n, 200_000n],
  options: HarnessOptions = {},
) {
  const h = await utxoHarness(options);
  const outpoints = values.map((value) => h.node.fund(OWN.address, value));
  const builder = utxoBuilder(h.ctx, h.network);
  const broadcaster = utxoBroadcaster(h.ctx);
  const policy = utxoReplacement(h.ctx, h.network);
  const make = async (i: DriverIntent, ctx: BuildContext = build()) => {
    const fee = await h.run(builder.estimateFee(i, ctx));
    return h.run(builder.build(i, fee, ctx));
  };
  const sign = (unsigned: UnsignedTx) => {
    const signatures = unsigned.signingRequests.map((r) => {
      const sig = secp256k1.sign(r.payload, TEST_KEY, { lowS: true });
      return { requestId: r.id, bytes: sig.toCompactRawBytes(), recovery: sig.recovery };
    });
    return h.run(builder.assemble(unsigned, signatures));
  };
  const send = async (unsigned: UnsignedTx) => {
    const signed = await sign(unsigned);
    return { signed, result: await h.run(broadcaster.broadcast(signed)) };
  };
  return { ...h, builder, broadcaster, policy, outpoints, make, sign, send };
}

describe('build and assemble', () => {
  it('builds an exact-fee PSBT, keeps the inputs as its ordering, and pays change back', async () => {
    const h = await funded();
    const unsigned = await h.make(intent(250_000n));
    expect(unsigned.payload.encoding).toBe('base64');
    expect(unsigned.fee).toMatchObject({ kind: 'utxo', bound: 'exact', speed: 'normal' });
    expect(unsigned.fee.details).toMatchObject({ satPerKvB: 10_000n, changeIndex: 1 });
    expect(unsigned.ordering).toEqual({
      kind: 'inputs',
      inputs: [...h.outpoints].sort(),
    });
    expect(unsigned.signingRequests.map((r) => r.id)).toEqual(['in:0', 'in:1']);
    const { signed, result } = await h.send(unsigned);
    expect(result).toEqual({ kind: 'accepted' });
    expect(signed.ref).toEqual(unsigned.expectedRef);
    const tx = h.node.transaction(signed.ref.id);
    const change = tx?.outs[1]?.value ?? 0n;
    expect(300_000n - 250_000n - change).toBe(unsigned.fee.charges[0]?.amount);
  });

  it("carries each segwit v0 input's previous transaction, unless turned off (M15)", async () => {
    const on = await funded([100_000n]);
    const psbtOf = (unsigned: UnsignedTx) =>
      bitcoin.Psbt.fromBase64(unsigned.payload.data, {
        network: bitcoin.networks.regtest,
      });
    const withPrev = psbtOf(await on.make(intent(50_000n)));
    expect(withPrev.data.inputs[0]?.nonWitnessUtxo).toBeDefined();
    expect(on.calls.some((c) => c.request.route === '/tx/:txid/hex')).toBe(true);
    const off = await utxoHarness({ options: { nonWitnessUtxo: false } });
    off.node.fund(OWN.address, 100_000n);
    const builder = utxoBuilder(off.ctx, off.network);
    const fee = await off.run(builder.estimateFee(intent(50_000n), build()));
    const without = psbtOf(await off.run(builder.build(intent(50_000n), fee, build())));
    expect(without.data.inputs[0]?.nonWitnessUtxo).toBeUndefined();
    expect(without.data.inputs[0]?.witnessUtxo?.value).toBe(100_000n);
  });

  it('builds, signs and sends from every wallet type: witness types fix the txid, p2tr signs with its tweak', async () => {
    for (const nonWitnessUtxo of [false, true]) {
      for (const type of ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const) {
        const h = await utxoHarness({ options: { nonWitnessUtxo } });
        const wallet = walletAddress(TEST_PUBKEY, type, REGTEST);
        h.node.fund(wallet.address, 100_000n);
        const builder = utxoBuilder(h.ctx, h.network);
        const ctx = build({ from: wallet.address });
        const i = intent(40_000n, { from: wallet.address });
        const unsigned = await h.run(
          builder.build(i, await h.run(builder.estimateFee(i, ctx)), ctx),
        );
        // p2pkh always needs its previous transaction (D12); p2tr never (BIP341, M15).
        const readsPrevious = type === 'p2pkh' || (nonWitnessUtxo && type !== 'p2tr');
        expect(h.calls.some((c) => c.request.route === '/tx/:txid/hex')).toBe(
          readsPrevious,
        );
        const [request] = unsigned.signingRequests;
        if (type === 'p2tr') {
          expect(request).toMatchObject({
            scheme: 'secp256k1-schnorr',
            publicKey: wallet.outputKey,
            params: { tweak: wallet.tweak },
          });
        } else {
          expect(request).toMatchObject({
            scheme: 'secp256k1-ecdsa',
            publicKey: TEST_PUBKEY,
          });
          expect(request?.params).toBeUndefined();
        }
        // The core's own signer, as a hot wallet signs.
        const result = await testSigner().sign(
          unsigned.signingRequests,
          {} as SigningContext,
        );
        if (result.status !== 'signed') throw new Error('the local signer signs at once');
        const signed = await h.run(builder.assemble(unsigned, result.signatures));
        // The txid is fixed before signing only when every input is witness-type.
        expect(unsigned.expectedRef).toEqual(type === 'p2pkh' ? undefined : signed.ref);
        expect(await h.run(utxoBroadcaster(h.ctx).broadcast(signed))).toEqual({
          kind: 'accepted',
        });
        expect(h.node.inMempool(signed.ref.id)).toBe(true);
      }
    }
  });

  it('never spends an output held by another Operation', async () => {
    const h = await funded();
    const unsigned = await h.make(
      intent(50_000n),
      build({ excludeInputs: [h.outpoints[1] as string] }),
    );
    expect(unsigned.ordering).toEqual({ kind: 'inputs', inputs: [h.outpoints[0]] });
    await expect(
      h.make(intent(50_000n), build({ excludeInputs: h.outpoints })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('spends only outputs confirmed as deeply as asked; a replacement adds only confirmed ones', async () => {
    const h = await utxoHarness();
    const confirmed = h.node.fund(OWN.address, 100_000n);
    const unconfirmed = h.node.fund(OWN.address, 200_000n, { mempool: true });
    const make = async (builder: ReturnType<typeof utxoBuilder>, i: DriverIntent) =>
      h.run(builder.build(i, await h.run(builder.estimateFee(i, build())), build()));
    const strict = utxoBuilder(h.ctx, h.network);
    await expect(make(strict, intent(150_000n))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    const eager = { ...h.ctx, config: { ...h.ctx.config, minInputConfirmations: 0 } };
    const spent = await make(utxoBuilder(eager, h.network), intent(150_000n));
    expect(spent.ordering).toEqual({
      kind: 'inputs',
      inputs: [unconfirmed],
    });
    // BIP125 rule 2: the bump needs another input, and only an unconfirmed one is left.
    const original = await make(strict, intent(95_000n));
    expect(original.ordering).toEqual({ kind: 'inputs', inputs: [confirmed] });
    await expect(
      h.run(
        utxoReplacement(eager, h.network).buildReplacement!(
          original,
          { satPerVByte: 100n },
          build(),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('counts an output the indexer lists twice once, and decides nothing on two that disagree', async () => {
    const h = await funded([100_000n]);
    type Utxo = Record<string, unknown>;
    const serve = (vary: (utxo: Utxo) => Utxo) =>
      h.node.intercept('a', (request, _signal, honest) => {
        if (!request.url.pathname.endsWith('/utxo')) return undefined;
        const listed = (honest() as { json: Utxo[] }).json;
        return { json: [...listed, ...listed.map(vary)] };
      });
    const i = intent(150_000n);
    const fee = await h.run(h.builder.estimateFee(i, build()));
    serve((utxo) => ({ ...utxo }));
    expect(await h.run(h.builder.checkFunds(i, fee, build()))).toMatchObject({
      ok: false,
      available: 100_000n,
    });
    serve((utxo) => ({ ...utxo, value: 100_001 }));
    await expect(h.run(h.builder.checkFunds(i, fee, build()))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    await expect(h.make(i)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it("decides nothing when the indexer's output disagrees with its previous transaction (M15)", async () => {
    const h = await funded([100_000n]);
    const foreign = (h.node.fund(PAYEE.address, 100_000n).split(':') as [string])[0];
    type Utxo = Record<string, unknown>;
    // The indexer lists another value for our output, or another script's output as ours.
    const lies: ((utxo: Utxo) => Utxo)[] = [
      (utxo) => ({ ...utxo, value: 100_001 }),
      (utxo) => ({ ...utxo, txid: foreign }),
    ];
    for (const vary of lies) {
      h.node.intercept('a', (request, _signal, honest) =>
        request.url.pathname.endsWith('/utxo')
          ? { json: (honest() as { json: Utxo[] }).json.map(vary) }
          : undefined,
      );
      await expect(h.make(intent(50_000n))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
    }
    h.node.clearIntercept('a');
    const { result } = await h.send(await h.make(intent(50_000n)));
    expect(result).toEqual({ kind: 'accepted' });
  });

  it("sends change to an address the wallet's key derives, or elsewhere only by opt-out (A19)", async () => {
    const h = await funded([100_000n, 100_000n]);
    const changeOutput = (unsigned: UnsignedTx) =>
      bitcoin.address.fromOutputScript(
        bitcoin.Psbt.fromBase64(unsigned.payload.data, {
          network: bitcoin.networks.regtest,
        }).txOutputs[1]!.script,
        bitcoin.networks.regtest,
      );
    // Derivable: the wallet key's p2tr address.
    const own = walletAddress(TEST_PUBKEY, 'p2tr', REGTEST).address;
    expect(
      changeOutput(
        await h.make(
          intent(10_000n),
          build({ wallet: { utxo: { changeAddress: own } } }),
        ),
      ),
    ).toBe(own);
    // A valid address of the network that the wallet's key does not derive (a typo that
    // happens to be valid, or a pasted foreign address): refused, naming no address.
    const foreign = walletAddress(OTHER_PUBKEY, 'p2tr', REGTEST).address;
    const refused = h.make(
      intent(10_000n),
      build({ wallet: { utxo: { changeAddress: foreign } } }),
    );
    await expect(refused).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(refused).rejects.not.toHaveProperty(
      'message',
      expect.stringContaining(foreign),
    );
    // Cancel pays to the change address too, so it is checked there as well.
    const sent = await h.make(intent(10_000n));
    await expect(
      h.run(
        h.policy.buildCancel!(
          sent,
          build({ wallet: { utxo: { changeAddress: foreign } } }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    // The explicit opt-out sends change to the foreign address.
    const optedOut = build({
      wallet: { utxo: { changeAddress: foreign, allowExternalChangeAddress: true } },
    });
    expect(changeOutput(await h.make(intent(10_000n), optedOut))).toBe(foreign);
    for (const utxo of [
      { changeAddress: 'bc1qnotours' },
      { changeAddress: foreign, allowExternalChangeAddress: 'yes' },
    ]) {
      await expect(
        h.make(intent(10_000n), build({ wallet: { utxo } })),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });

  it("accepts a change address on the wallet xpub's chains, within the search bound (A22)", async () => {
    const h = await funded([100_000n, 100_000n]);
    const tpub = { private: 0x04358394, public: 0x043587cf };
    const root = HDKey.fromMasterSeed(
      sha256(utf8ToBytes('crypto-aio/utxo change')),
      tpub,
    );
    const hd = { xpub: root.publicExtendedKey };
    const at = (path: string) =>
      walletAddress(root.derive(path).publicKey!, 'p2wpkh', REGTEST).address;
    const changeOf = (unsigned: UnsignedTx) =>
      bitcoin.address.fromOutputScript(
        bitcoin.Psbt.fromBase64(unsigned.payload.data, {
          network: bitcoin.networks.regtest,
        }).txOutputs[1]!.script,
        bitcoin.networks.regtest,
      );
    for (const path of ['m/0/0', 'm/1/19']) {
      const wallet = { utxo: { changeAddress: at(path) }, hd };
      expect(changeOf(await h.make(intent(10_000n), build({ wallet })))).toBe(at(path));
    }
    // Beyond the bound, or without the xpub: refused unless the wallet opts out.
    for (const wallet of [
      { utxo: { changeAddress: at('m/1/20') }, hd },
      { utxo: { changeAddress: at('m/1/3') } },
    ]) {
      await expect(h.make(intent(10_000n), build({ wallet }))).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    }
    // The wallet's own path template replaces the receive chain `0/{index}`.
    const custom = { ...hd, xpubPath: '5/{index}' };
    for (const [path, ok] of [
      ['m/5/7', true],
      ['m/1/7', true],
      ['m/0/7', false],
    ] as const) {
      const made = h.make(
        intent(10_000n),
        build({ wallet: { utxo: { changeAddress: at(path) }, hd: custom } }),
      );
      if (ok) expect(changeOf(await made)).toBe(at(path));
      else await expect(made).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
    // X4 (A20): a mainnet xpub on a test network is refused, even where it derives the
    // address (the same seed under mainnet versions derives the same keys).
    const mainnet = HDKey.fromMasterSeed(sha256(utf8ToBytes('crypto-aio/utxo change')));
    await expect(
      h.make(
        intent(10_000n),
        build({
          wallet: {
            utxo: { changeAddress: at('m/0/0') },
            hd: { xpub: mainnet.publicExtendedKey },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('refuses what it must not build, before anything is signed', async () => {
    const h = await funded();
    const cases: [DriverIntent, BuildContext, string][] = [
      [intent(100n), build(), 'INVALID_AMOUNT'],
      [
        intent(10_000n, { asset: { standard: 'brc20', contract: 'ordi' } }),
        build(),
        'UNSUPPORTED_CAPABILITY',
      ],
      // 1,500 sat/vB: affordable, but above the 1,000 sat/vB absurd-fee guard.
      [intent(10_000n, { fee: { satPerVByte: 1_500n } }), build(), 'INVALID_INTENT'],
      [intent(10_000n, { fee: { satPerVByte: 1.5 } }), build(), 'INVALID_INTENT'],
      [
        intent(10_000n),
        build({ keys: [{ scheme: 'secp256k1-ecdsa', publicKey: OTHER_PUBKEY }] }),
        'INVALID_INTENT',
      ],
      [
        intent(10_000n, {
          outputs: [
            { to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: 10_000n },
          ],
        }),
        build(),
        'INVALID_ADDRESS',
      ],
      // M2: more outputs than limits().maxOutputs.
      [
        intent(10_000n, {
          outputs: Array.from({ length: 1_001 }, () => ({
            to: PAYEE.address,
            amount: 1_000n,
          })),
        }),
        build(),
        'INVALID_INTENT',
      ],
    ];
    for (const [i, ctx, code] of cases) {
      await expect(h.make(i, ctx)).rejects.toMatchObject({ code });
    }
    expect(h.node.broadcasts).toHaveLength(0);
  });

  it('runs the absurd-fee guard on every build: dust given to the fee, and a fallback rate', async () => {
    // 10 sat/vB: 1,410 sat for one input and change. Paying 98,390 leaves 200 sat of change,
    // below the dust threshold (294), so the fee is 1,610: above maxFee.
    const h = await funded([100_000n], { options: { maxFee: 1_500n } });
    expect((await h.make(intent(50_000n))).fee.charges[0]?.amount).toBe(1_410n);
    await expect(h.make(intent(98_390n))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    // No estimate: regtest's fallback rate (1 sat/vB, 141 sat), still bounded by maxFee.
    for (const [maxFee, ok] of [
      [140n, false],
      [141n, true],
    ] as const) {
      const f = await funded([100_000n], { options: { maxFee } });
      f.node.setFeeEstimates({});
      const made = f.make(intent(50_000n));
      if (ok) await expect(made).resolves.toMatchObject({ fee: { speed: 'normal' } });
      else await expect(made).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    }
  });

  it('reports a shortfall with its amounts in the details only', async () => {
    const h = await funded();
    const error: unknown = await h.make(intent(400_000n)).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      message: 'insufficient funds for this transfer',
      details: { available: '300000', required: expect.stringMatching(/^4[0-9]{5}$/) },
    });
  });

  it('fails assembly with SIGNING_FAILED when a signature is missing, or the txid is not the prepared one', async () => {
    const h = await funded();
    const unsigned = await h.make(intent(150_000n));
    await expect(h.run(h.builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    const other = { id: 'ab'.repeat(32), idKind: 'txid', canonical: true } as const;
    await expect(h.sign({ ...unsigned, expectedRef: other })).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
  });

  it('reads the signatures of a PSBT signed elsewhere, at once and offline, and assembles from its own (A6)', async () => {
    const h = await funded();
    const unsigned = await h.make(intent(250_000n));
    const psbt = bitcoin.Psbt.fromBase64(unsigned.payload.data, {
      network: bitcoin.networks.regtest,
    });
    psbt.signAllInputs(nativeSigner(TEST_KEY));
    h.calls.length = 0;
    const bundles = h.builder.signaturesFrom(unsigned, {
      encoding: 'base64',
      data: psbt.toBase64(),
    });
    expect(bundles).toBeInstanceOf(Array);
    expect(h.calls).toHaveLength(0);
    expect(bundles.map((b) => b.requestId)).toEqual(['in:0', 'in:1']);
    // RFC 6979 signatures: the stored PSBT and the bundles give the locally signed bytes.
    const fromBundles = await h.run(h.builder.assemble(unsigned, bundles));
    expect(fromBundles).toEqual(await h.sign(unsigned));
    expect(fromBundles.ref).toEqual(unsigned.expectedRef);
    // Another transaction, or not a PSBT: a fixed-text INVALID_INTENT.
    const other = await h.make(intent(10_000n));
    expect(() =>
      h.builder.signaturesFrom(unsigned, {
        encoding: 'base64',
        data: other.payload.data,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT' }));
    expect(() =>
      h.builder.signaturesFrom(unsigned, { encoding: 'hex', data: 'ab' }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_INTENT',
        message: 'a signed PSBT is expected, as base64',
      }),
    );
  });

  it('tags every call (R41): building reads, sending broadcasts', async () => {
    const h = await funded([100_000n]);
    h.calls.length = 0;
    const unsigned = await h.make(intent(50_000n));
    expect(h.calls.length).toBeGreaterThan(0);
    for (const call of h.calls) {
      expect(call.options).toMatchObject({ purpose: 'read', retry: 'safe' });
      expect(call.options.quorum).toBeUndefined();
      const route = call.request.route ?? '';
      expect(call.transport).toBe(route.startsWith('/address/') ? 'indexer' : 'rpc');
      expect(route).toMatch(/^\/[a-z:/-]+$/);
    }
    h.calls.length = 0;
    await h.send(unsigned);
    expect(h.calls).toEqual([
      expect.objectContaining({
        transport: 'rpc',
        request: expect.objectContaining({ method: 'POST', route: '/tx' }),
        options: expect.objectContaining({
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
        }),
      }),
    ]);
  });
});

describe('broadcast', () => {
  it('classifies node answers, and rethrows an ambiguous failure unclassified', async () => {
    const h = await funded([100_000n]);
    const unsigned = await h.make(intent(50_000n));
    const { signed } = await h.send(unsigned);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'accepted',
    });
    h.node.mine();
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    const [txid, vout] = (h.outpoints[0] as string).split(':') as [string, string];
    const doubleSpend = signedSpend(
      TEST_KEY,
      [[txid, Number(vout), 100_000n]],
      [[PAYEE.script, 90_000n]],
    );
    expect(
      await h.run(
        h.broadcaster.broadcast({
          raw: { encoding: 'hex', data: doubleSpend },
          ref: { id: '', idKind: 'txid', canonical: true },
        }),
      ),
    ).toEqual({
      kind: 'refused',
      code: 'TX_REFUSED',
      reason: 'inputs missing or already spent',
    });
    h.node.intercept('a', (request) =>
      request.method === 'POST' ? { status: 502, text: 'bad gateway' } : undefined,
    );
    await expect(h.run(h.broadcaster.broadcast(signed))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      ambiguous: true,
    });
    // Accepted under another txid: the outcome is unknown, never `accepted`.
    h.node.intercept('a', (request) =>
      request.method === 'POST' ? { text: 'ab'.repeat(32) } : undefined,
    );
    await expect(h.run(h.broadcaster.broadcast(signed))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      ambiguous: true,
    });
  });

  it('rethrows every failure that is not a definitive node answer as the same object', async () => {
    const h = await funded([100_000n]);
    const { signed } = await h.send(await h.make(intent(50_000n)));
    const failures = [
      new ProviderError('RPC_ERROR', 'POST /tx refused (HTTP 400)', {
        ambiguous: true,
        details: { status: 400, body: 'sendrawtransaction RPC error -26: dust' },
      }),
      new ProviderError('PROVIDER_UNAVAILABLE', 'endpoint error (HTTP 503)'),
      new Error('foreign'),
    ];
    for (const failure of failures) {
      const stub = utxoBroadcaster({
        ...h.ctx,
        esplora: {
          broadcast: () => Promise.reject(failure),
        } as unknown as typeof h.ctx.esplora,
      });
      await expect(h.run(stub.broadcast(signed))).rejects.toBe(failure);
    }
  });

  it('refuses a bad signature on Bitcoin Core 30, and rejects it on 29 (F3-R8)', async () => {
    // v30 checks scripts once, with the policy flags: `mempool-script-verify-flag-failed`
    // (refused). v29 checks again with the consensus flags: `mandatory-…` (rejected).
    for (const legacyScriptErrors of [false, true]) {
      const h = await funded([100_000n], { node: { legacyScriptErrors } });
      const unsigned = await h.make(intent(50_000n));
      const signatures = unsigned.signingRequests.map((r) => ({
        requestId: r.id,
        bytes: secp256k1
          .sign(
            r.payload.map((b) => b ^ 1),
            TEST_KEY,
            { lowS: true },
          )
          .toCompactRawBytes(),
      }));
      const signed = await h.run(h.builder.assemble(unsigned, signatures));
      expect(await h.run(h.broadcaster.broadcast(signed))).toEqual(
        legacyScriptErrors
          ? { kind: 'rejected', reason: 'script verification failed' }
          : {
              kind: 'refused',
              code: 'TX_REFUSED',
              reason: 'the node refused the transaction',
            },
      );
      expect(h.node.inMempool(signed.ref.id)).toBe(false);
    }
  });

  it('refuses raw bytes that cannot be a transaction before sending, and never throws on a large one', async () => {
    const h = await funded([]);
    h.calls.length = 0;
    // Larger than any block (lesson 20), odd, empty or not hex: nothing is sent.
    for (const data of ['00'.repeat(4_000_001), '0', '', 'zz']) {
      await expect(h.run(h.broadcaster.broadcast(bare(data)))).rejects.toMatchObject({
        code: 'INVALID_INTENT',
      });
    }
    expect(h.calls).toHaveLength(0);
    // 3.6 MB: the node's answer, never V8's regexp stack overflow (a foreign error).
    expect(await h.run(h.broadcaster.broadcast(bare('00'.repeat(3_600_000))))).toEqual({
      kind: 'rejected',
      reason: 'the transaction does not decode',
    });
  });

  it("gives the engine's own-ref guard what it needs when an endpoint relays, then makes up a -26", async () => {
    const h = await funded([100_000n]);
    const unsigned = await h.make(intent(50_000n));
    const signed = await h.sign(unsigned);
    h.node.intercept('a', (request, _signal, honest) => {
      if (request.method !== 'POST') return undefined;
      honest();
      return FABRICATED;
    });
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'rejected',
      reason: 'invalid by consensus rules',
    });
    h.node.clearIntercept('a');
    // Spec §8.2: the engine believes a refusal only when its own lookup cannot see the
    // Attempt (`seenOwnRef`); here it can, so one endpoint's answer ends nothing.
    expect(
      await h.run(chainReader(h.ctx).observe(signed.ref, unsigned.ordering, OWN.address)),
    ).toMatchObject({ seen: 'mempool', txHash: signed.ref.id });
  });

  it("takes an honest endpoint's acceptance over another's made-up -26 in a fanout", async () => {
    const h = await funded([100_000n], { endpoints: ['a', 'b'] });
    const signed = await h.sign(await h.make(intent(50_000n)));
    h.node.intercept('a', (request) =>
      request.method === 'POST' ? FABRICATED : undefined,
    );
    expect(await h.run(h.broadcaster.broadcast(signed, { fanout: 2 }))).toEqual({
      kind: 'accepted',
    });
    expect(h.node.inMempool(signed.ref.id)).toBe(true);
  });
});

describe('replace and cancel', () => {
  async function pending(values: readonly bigint[] = [100_000n, 200_000n]) {
    const h = await funded(values);
    const original = await h.make(intent(50_000n, { fee: 'slow' }));
    const { signed: sent } = await h.send(original);
    return { ...h, original, sent };
  }

  it('signals BIP125 on every input, so a node without full RBF takes the replacement', async () => {
    for (const rbf of [true, false]) {
      const h = await funded([100_000n], { node: { fullRbf: false }, options: { rbf } });
      const original = await h.make(intent(50_000n, { fee: 'slow' }));
      const psbt = bitcoin.Psbt.fromBase64(original.payload.data, {
        network: bitcoin.networks.regtest,
      });
      expect(psbt.txInputs.map((input) => input.sequence)).toEqual([
        rbf ? 0xfffffffd : 0xfffffffe,
      ]);
      expect((await h.send(original)).result).toEqual({ kind: 'accepted' });
      const next = await h.run(h.policy.buildReplacement!(original, 'fast', build()));
      expect((await h.send(next)).result).toEqual(
        rbf
          ? { kind: 'accepted' }
          : {
              kind: 'refused',
              code: 'TX_REFUSED',
              reason: 'inputs missing or already spent',
            },
      );
    }
  });

  it('replaces over a superset of the inputs, only above the floor (R30)', async () => {
    const h = await pending();
    const { policy } = h;
    await expect(
      h.run(policy.buildReplacement!(h.original, { satPerVByte: '2.1' }, build())),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const next = await h.run(policy.buildReplacement!(h.original, 'fast', build()));
    const before =
      h.original.ordering.kind === 'inputs' ? h.original.ordering.inputs : [];
    const after = next.ordering.kind === 'inputs' ? next.ordering.inputs : [];
    expect(after).toEqual(expect.arrayContaining([...before]));
    expect(next.summary).toEqual(h.original.summary);
    const { result } = await h.send(next);
    expect(result).toEqual({ kind: 'accepted' });
  });

  it('adds a confirmed input when the change cannot pay the bump, never a held one', async () => {
    const h = await pending([60_000n, 100_000n]);
    const held = h.original.ordering.kind === 'inputs' ? h.original.ordering.inputs : [];
    const free = h.outpoints.find((o) => !held.includes(o)) as string;
    await expect(
      h.run(
        h.policy.buildReplacement!(
          h.original,
          { satPerVByte: 600n },
          build({ excludeInputs: [free] }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    const next = await h.run(
      h.policy.buildReplacement!(h.original, { satPerVByte: 600n }, build()),
    );
    expect(next.ordering).toEqual({ kind: 'inputs', inputs: [...h.outpoints].sort() });
  });

  it('replaces at the least fee it allows, which Bitcoin Core 30 (exact) and 29 (truncated) accept', async () => {
    const override = (rate: bigint) => ({
      satPerVByte: `${rate / 1_000n}.${(rate % 1_000n).toString().padStart(3, '0')}`,
    });
    // Rules 3 and 4 bind when the change pays the bump; rule 6 binds when an input is added
    // to an original that had no change (2,500 sat for 110 vB, then about 22.9 sat/vB).
    const cases: [readonly bigint[], bigint][] = [
      [[200_000n, 100_000n], 150_000n],
      [[100_000n, 60_000n], 97_500n],
    ];
    for (const version of [{}, { truncatedFeeRates: true }]) {
      for (const [values, amount] of cases) {
        // The node's incremental relay fee is the library's (1 sat/vB): rule 4 is tight.
        const h = await funded(values, {
          node: { incrementalRelayFee: 1_000n, ...version },
        });
        const original = await h.make(intent(amount, { fee: 'fast' }));
        expect((await h.send(original)).result).toEqual({ kind: 'accepted' });
        const replace = (rate: bigint) =>
          h.run(h.policy.buildReplacement!(original, override(rate), build()));
        const allowed = (rate: bigint) =>
          replace(rate).then(
            () => true,
            (error: unknown) => {
              if ((error as { code?: string }).code === 'FEE_TOO_LOW') return false;
              throw error;
            },
          );
        let low = 1_000n;
        let high = 100_000n;
        expect(await allowed(low)).toBe(false);
        while (high - low > 1n) {
          const mid = (low + high) / 2n;
          if (await allowed(mid)) high = mid;
          else low = mid;
        }
        const { result } = await h.send(await replace(high));
        expect(result).toEqual({ kind: 'accepted' });
      }
    }
  });

  it('stays live through a stale spend view: a stale outspend, then a fresh one naming our own txid', async () => {
    // Task 7 review: an index that has not caught up with the replacement names the Attempt
    // it replaced, or nothing, as the input's spender. Observed evidence only, never terminal.
    const h = await pending();
    const next = await h.run(h.policy.buildReplacement!(h.original, 'fast', build()));
    const { signed } = await h.send(next);
    const [first] = next.ordering.kind === 'inputs' ? next.ordering.inputs : [];
    const [txid, vout] = (first as string).split(':') as [string, string];
    const stale: unknown[] = [
      { spent: true, txid: h.sent.ref.id, vin: 0, status: { confirmed: false } },
      { spent: false },
    ];
    h.node.intercept('a', (request) =>
      request.url.pathname.endsWith(`/tx/${txid}/outspend/${vout}`) && stale.length > 0
        ? { json: stale.shift() }
        : undefined,
    );
    const reader = chainReader(h.ctx);
    const observe = () => h.run(reader.observe(signed.ref, next.ordering, OWN.address));
    expect(await observe()).toEqual({ seen: 'none' });
    expect(await observe()).toEqual({ seen: 'none' });
    expect(await observe()).toMatchObject({ seen: 'mempool', txHash: signed.ref.id });
    expect(h.node.inMempool(signed.ref.id)).toBe(true);
  });

  it('cancels to the change address at the minimum bump, or at a given fee', async () => {
    const h = await pending([100_000n]);
    const { policy } = h;
    const cancel = await h.run(policy.buildCancel!(h.original, build()));
    expect(cancel.ordering).toEqual(h.original.ordering);
    // Exactly the floor (R30): the replaced 282 sat (2 sat/vB, 141 vB) plus 1 sat/vB for the
    // cancel's 110 vB (rules 3 and 4; the rate rule asks only 222).
    expect(cancel.fee.charges[0]?.amount).toBe(392n);
    expect(cancel.summary.outputs).toEqual([
      {
        to: OWN.address,
        amount: (100_000n - (cancel.fee.charges[0]?.amount ?? 0n)).toString(),
      },
    ]);
    await expect(
      h.run(policy.buildCancel!(h.original, build(), { satPerVByte: 1n })),
    ).rejects.toMatchObject({
      code: 'FEE_TOO_LOW',
    });
    const explicit = await h.run(
      policy.buildCancel!(h.original, build(), { satPerVByte: 50n }),
    );
    expect(explicit.fee.details).toMatchObject({ satPerKvB: 50_000n });
    const { result } = await h.send(cancel);
    expect(result).toEqual({ kind: 'accepted' });
  });

  it('never reads or writes requestedFee, which the core adds to replacements (R30)', async () => {
    const h = await pending();
    const recorded = (unsigned: UnsignedTx, fee: unknown): UnsignedTx => ({
      ...unsigned,
      fee: { ...unsigned.fee, details: { ...unsigned.fee.details, requestedFee: fee } },
    });
    const next = await h.run(
      h.policy.buildReplacement!(recorded(h.original, 'slow'), 'fast', build()),
    );
    expect(next.fee.details).not.toHaveProperty('requestedFee');
    const cancel = await h.run(h.policy.buildCancel!(recorded(next, 'fast'), build()));
    expect(cancel.fee.details).not.toHaveProperty('requestedFee');
    // `assemble` finalizes the stored PSBT; it never re-serializes from the fee details.
    const { result } = await h.send(recorded(next, 'fast'));
    expect(result).toEqual({ kind: 'accepted' });
  });
});
