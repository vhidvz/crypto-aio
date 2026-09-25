import type { ChainDriver, FinalityLevel } from '../../src/core/driver/types';
import { EventBus } from '../../src/core/events/bus';
import { noopLogger } from '../../src/core/events/logger';
import type { NetworkInfo } from '../../src/core/model/chain';
import type { OrderingData } from '../../src/core/model/ordering';
import { localSigner } from '../../src/core/signing/local';
import type { SigningContext } from '../../src/core/signing/types';
import { HttpTransport } from '../../src/core/transport/http-transport';
import {
  FakeChain,
  type FakeEndpointOptions,
  type FakeOrdering,
} from '../../src/testing/fake-chain';
import { FakeClock, drive } from '../../src/testing/fake-clock';
import { FakeFetch, hang, rpcError } from '../../src/testing/fake-fetch';
import { fakeManifest, fakePlugin } from '../../src/testing/fake-plugin';

const CHAIN_OF: Record<FakeOrdering, string> = {
  nonce: 'fakechain',
  expiry: 'fakeexpiry',
  seqno: 'fakeseqno',
};
const ctx = {
  operationId: 'op',
  namespace: 'ns',
  chain: 'fakechain',
  network: 'local',
  wallet: 'w',
  purpose: 'original',
  summary: { asset: 'x', outputs: [] },
  fee: { kind: 'fake', speed: 'normal', charges: [], bound: 'exact', details: {} },
  unsignedHash: 'h',
} as SigningContext;

async function setupDriver(
  ordering: FakeOrdering = 'nonce',
  endpoints: Readonly<Record<string, FakeEndpointOptions>> = { main: {} },
) {
  const clock = new FakeClock();
  const chain = new FakeChain({ ordering, clock });
  const configs = Object.entries(endpoints).map(([name, options]) => ({
    name,
    url: chain.endpoint(name, options),
  }));
  const info = fakePlugin().chains?.find((c) => c.id === CHAIN_OF[ordering]);
  if (!info) throw new Error('missing chain');
  const transport = new HttpTransport(configs, {
    clock,
    events: new EventBus(clock, noopLogger),
    log: noopLogger,
    options: { fetch: chain.fetch, baseDelayMs: 1, maxDelayMs: 2 },
  });
  const factory = await fakeManifest.load();
  const driver: ChainDriver = await factory.create({
    chain: info,
    network: info.networks.local as NonNullable<(typeof info.networks)['local']>,
    library: 'fake-sdk',
    transport,
    clock,
    log: noopLogger,
    options: {},
  });
  const { signer } = localSigner.generate({ curves: ['secp256k1'] });
  const publicKey = await signer.getPublicKey('secp256k1-ecdsa');
  const from = driver.address.fromPublicKey(publicKey).canonical;
  const other = driver.address.fromPublicKey(
    localSigner.generate({ curves: ['secp256k1'] }).publicKeys.secp256k1 as Uint8Array,
  ).canonical;
  const keys = [{ scheme: 'secp256k1-ecdsa', publicKey }];
  const run = <T>(p: Promise<T>) => drive(clock, p);
  const send = async (
    options: {
      amount?: bigint;
      ordering?: OrderingData;
      fee?: 'slow' | 'normal' | 'fast';
    } = {},
  ) => {
    const intent = {
      asset: 'native' as const,
      outputs: [{ to: other, amount: options.amount ?? 10n }],
      from,
      fee: options.fee ?? 'normal',
    };
    const fee = await run(driver.builder.estimateFee(intent, { from, keys, wallet: {} }));
    const unsigned = await run(
      driver.builder.build(intent, fee, {
        from,
        keys,
        wallet: {},
        ...(options.ordering ? { ordering: options.ordering } : {}),
      }),
    );
    const result = await signer.sign(unsigned.signingRequests, ctx);
    if (result.status !== 'signed') throw new Error('unreachable');
    const signed = await run(driver.builder.assemble(unsigned, result.signatures));
    return {
      unsigned,
      signed,
      broadcast: () => run(driver.broadcaster.broadcast(signed)),
    };
  };
  return { clock, chain, driver, from, other, keys, run, send, transport };
}

describe('fake driver', () => {
  it('round-trips a transfer and decodes it', async () => {
    const t = await setupDriver();
    t.chain.fund(t.from, 1_000n);
    expect(
      await t.run(
        t.driver.builder.checkFunds(
          {
            asset: 'native',
            outputs: [{ to: t.other, amount: 10_000n }],
            from: t.from,
            fee: 'normal',
          },
          {
            kind: 'fake',
            speed: 'normal',
            charges: [{ asset: 'native', amount: 2n, label: 'network' }],
            bound: 'exact',
            details: {},
          },
          { from: t.from, keys: t.keys, wallet: {} },
        ),
      ),
    ).toMatchObject({ ok: false, available: 1_000n });
    const { signed, broadcast } = await t.send({
      ordering: { kind: 'nonce', nonce: 0n },
    });
    expect(await broadcast()).toEqual({ kind: 'accepted' });
    expect(t.chain.inMempool(signed.ref.id)).toBe(true);
    expect(await t.run(t.driver.reader.observe(signed.ref, undefined, t.from))).toEqual({
      seen: 'mempool',
    });
    t.chain.mine();
    expect(
      await t.run(t.driver.reader.observe(signed.ref, undefined, t.from)),
    ).toMatchObject({ seen: 'block', blockHeight: 1n, success: true });
    const tx = await t.run(t.driver.reader.getTransaction(signed.ref.id));
    expect(tx?.transfers).toEqual([
      {
        locator: 'native',
        from: [t.from],
        to: t.other,
        asset: 'native',
        amount: 10n,
        source: 'native',
      },
    ]);
    expect(tx?.decoding).toBe('complete');
    expect(await t.run(t.driver.reader.getBalance(t.other, 'native'))).toBe(10n);
  });

  it('classifies node responses into accepted, already-known, refused and rejected', async () => {
    const t = await setupDriver();
    const poor = await t.send({ ordering: { kind: 'nonce', nonce: 0n } });
    expect(await poor.broadcast()).toMatchObject({
      kind: 'refused',
      code: 'INSUFFICIENT_FUNDS',
    });
    t.chain.fund(t.from, 1_000n);
    const ok = await t.send({ ordering: { kind: 'nonce', nonce: 0n } });
    expect(await ok.broadcast()).toEqual({ kind: 'accepted' });
    expect(await ok.broadcast()).toEqual({ kind: 'already-known' });
    t.chain.mine();
    expect(await ok.broadcast()).toMatchObject({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
    });
    const bad = {
      ...ok.signed,
      raw: {
        encoding: 'base64' as const,
        data: Buffer.from(
          '{"tx":{"chainId":"fake-local"},"sig":"00","recovery":0,"pub":"00"}',
        ).toString('base64'),
      },
    };
    expect(await t.run(t.driver.broadcaster.broadcast(bad))).toMatchObject({
      kind: 'rejected',
    });
  });

  it('proves finality and slot consumption', async () => {
    const t = await setupDriver();
    t.chain.fund(t.from, 1_000n);
    const { signed, broadcast } = await t.send({
      ordering: { kind: 'nonce', nonce: 0n },
    });
    await broadcast();
    t.chain.mine();
    expect(
      await t.run(
        t.driver.proofs.includedFinal(signed.ref, { kind: 'nonce', nonce: 0n }, t.from),
      ),
    ).toEqual({ included: false });
    expect(
      await t.run(
        t.driver.proofs.slotConsumed({ kind: 'nonce', nonce: 0n }, t.from, 'latest'),
      ),
    ).toBe(true);
    expect(
      await t.run(
        t.driver.proofs.slotConsumed({ kind: 'nonce', nonce: 0n }, t.from, 'finalized'),
      ),
    ).toBe(false);
    t.chain.mine(3);
    expect(
      await t.run(
        t.driver.proofs.includedFinal(signed.ref, { kind: 'nonce', nonce: 0n }, t.from),
      ),
    ).toMatchObject({ included: true, success: true, blockHeight: 1n });
    expect(
      await t.run(
        t.driver.proofs.slotConsumed({ kind: 'nonce', nonce: 0n }, t.from, 'finalized'),
      ),
    ).toBe(true);
    expect(await t.run(t.driver.sequence!.pending(t.from))).toBe(1n);
  });

  it('serves block hashes through the proof quorum (R33)', async () => {
    const t = await setupDriver('nonce', { liar: {}, honest: {} });
    t.chain.mine(4);
    const hash = (height: bigint, level: FinalityLevel) =>
      t.run(t.driver.proofs.blockHash(height, level));
    expect(await hash(3n, 'latest')).toBe(t.chain.block(3n)?.hash);
    expect(await hash(5n, 'latest')).toBeNull();
    const finalized = t.chain.finalizedHeight();
    expect(await hash(finalized, 'finalized')).toBe(t.chain.block(finalized)?.hash);
    expect(await hash(finalized + 1n, 'finalized')).toBeNull();
    t.chain.configureEndpoint('liar', { forkAbove: 1 });
    expect((await t.run(t.driver.blocks!.header(3n)))?.hash).not.toBe(
      t.chain.block(3n)?.hash,
    );
    await expect(hash(3n, 'latest')).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
    });
    expect(await hash(1n, 'latest')).toBe(t.chain.block(1n)?.hash);
  });

  it('builds expiring transactions and proves expiry', async () => {
    const t = await setupDriver('expiry');
    t.chain.fund(t.from, 1_000n);
    const { unsigned } = await t.send();
    expect(unsigned.ordering).toEqual({ kind: 'expiry', lastValidHeight: 5n });
    expect(await t.run(t.driver.proofs.expired(unsigned.ordering))).toBe(false);
    t.chain.mine(8);
    expect(await t.run(t.driver.proofs.expired(unsigned.ordering))).toBe(true);
    expect(t.driver.sequence).toBeUndefined();
    expect(t.driver.replacement).toBeUndefined();
    expect(t.driver.capabilities.has('expiry')).toBe(true);
  });

  it('enforces replacement fee bumps and keeps the nonce', async () => {
    const t = await setupDriver();
    t.chain.fund(t.from, 1_000n);
    const { unsigned } = await t.send({
      ordering: { kind: 'nonce', nonce: 0n },
      fee: 'slow',
    });
    await expect(
      t.run(
        t.driver.replacement!.buildReplacement!(unsigned, 'slow', {
          from: t.from,
          keys: t.keys,
          wallet: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'FEE_TOO_LOW' });
    const replacement = await t.run(
      t.driver.replacement!.buildReplacement!(unsigned, 'fast', {
        from: t.from,
        keys: t.keys,
        wallet: {},
      }),
    );
    expect(replacement.ordering).toEqual({ kind: 'nonce', nonce: 0n });
    const cancel = await t.run(
      t.driver.replacement!.buildCancel!(unsigned, {
        from: t.from,
        keys: t.keys,
        wallet: {},
      }),
    );
    expect(JSON.parse(cancel.payload.data)).toMatchObject({ to: t.from, amount: '0' });
  });

  it('scans blocks with address filters and hands out fresh native clients', async () => {
    const t = await setupDriver();
    t.chain.fund(t.from, 1_000n);
    await (await t.send({ ordering: { kind: 'nonce', nonce: 0n } })).broadcast();
    t.chain.mine();
    const header = await t.run(t.driver.blocks!.header(1n));
    expect(header?.parentHash).toBe(t.chain.block(0n)?.hash);
    expect(
      await t.run(t.driver.blocks!.transactions(header!, { addresses: [t.other] })),
    ).toHaveLength(1);
    const stranger = t.driver.address.fromPublicKey(
      localSigner.generate({ curves: ['secp256k1'] }).publicKeys.secp256k1 as Uint8Array,
    ).canonical;
    expect(
      await t.run(t.driver.blocks!.transactions(header!, { addresses: [stranger] })),
    ).toHaveLength(0);
    expect(t.driver.createNativeClient?.()).not.toBe(t.driver.createNativeClient?.());
  });

  it('keeps a broadcast error ambiguous when an earlier attempt may have been delivered', async () => {
    const clock = new FakeClock();
    const info = fakePlugin().chains?.find((c) => c.id === 'fakechain');
    if (!info) throw new Error('missing chain');
    const base = info.networks.local as NonNullable<(typeof info.networks)['local']>;
    // Drop `identity` so the driver never registers an `expectedIdentity` probe: with only
    // two scripted responses (a hang, then a definitive RPC error), an identity check would
    // consume the first one and break the scenario below.
    const network: NetworkInfo = { ...base, identity: undefined };
    const fake = new FakeFetch();
    let attempts = 0;
    fake.route('https://ambiguous.test/rpc', (request, signal) => {
      attempts += 1;
      // Attempt 1 hangs until the transport's own deadline aborts it (an ambiguous,
      // possibly-delivered failure, per I4). Attempt 2 answers as if a different attempt's
      // send had already landed and consumed the slot ("nonce too low").
      return attempts === 1 ? hang(signal) : rpcError(request, -32000, 'nonce too low');
    });
    const transport = new HttpTransport(
      [{ name: 'main', url: 'https://ambiguous.test/rpc' }],
      {
        clock,
        events: new EventBus(clock, noopLogger),
        log: noopLogger,
        options: { fetch: fake.fetch, baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 5 },
      },
    );
    const factory = await fakeManifest.load();
    const driver: ChainDriver = await factory.create({
      chain: info,
      network,
      library: 'fake-sdk',
      transport,
      clock,
      log: noopLogger,
      options: {},
    });
    const signed = {
      raw: { encoding: 'base64' as const, data: 'ZmFrZQ==' },
      ref: { id: 'deadbeef', idKind: 'tx-hash' as const, canonical: true },
    };
    await expect(
      drive(clock, driver.broadcaster.broadcast(signed)),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', ambiguous: true });
    expect(attempts).toBe(2);
  });

  it('covers seqno ordering: build, checkFunds, broadcast and same-slot conflicts', async () => {
    const t = await setupDriver('seqno');
    t.chain.fund(t.from, 1_000n);
    expect(
      await t.run(
        t.driver.builder.checkFunds(
          {
            asset: 'native',
            outputs: [{ to: t.other, amount: 10n }],
            from: t.from,
            fee: 'normal',
          },
          {
            kind: 'fake',
            speed: 'normal',
            charges: [{ asset: 'native', amount: 2n, label: 'network' }],
            bound: 'exact',
            details: {},
          },
          { from: t.from, keys: t.keys, wallet: {} },
        ),
      ),
    ).toEqual({ ok: true });
    const first = await t.send({
      ordering: { kind: 'seqno', seqno: 0n, validUntil: 0 },
      amount: 10n,
    });
    expect(first.unsigned.ordering).toMatchObject({ kind: 'seqno', seqno: 0n });
    if (first.unsigned.ordering.kind === 'seqno') {
      expect(typeof first.unsigned.ordering.validUntil).toBe('number');
    }
    expect(await first.broadcast()).toEqual({ kind: 'accepted' });
    const second = await t.send({
      ordering: { kind: 'seqno', seqno: 0n, validUntil: 0 },
      amount: 20n,
    });
    expect(await second.broadcast()).toMatchObject({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
    });
  });

  it('classifies an already-mined resend (expiry chains) as already-known', async () => {
    const t = await setupDriver('expiry');
    t.chain.fund(t.from, 1_000n);
    const { broadcast } = await t.send();
    expect(await broadcast()).toEqual({ kind: 'accepted' });
    t.chain.mine();
    expect(await broadcast()).toEqual({ kind: 'already-known' });
  });
});
