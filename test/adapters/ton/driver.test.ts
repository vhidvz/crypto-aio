import { ed25519 } from '@noble/curves/ed25519';
import { BitString, Cell, beginCell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { TON_CHAINS } from '../../../src/adapters/ton/chains';
import { tonDriverFactory } from '../../../src/adapters/ton/driver';
import {
  tonLibraryDriverFactory,
  tonNativeClient,
} from '../../../src/adapters/ton/native-client';
import type {
  BuildContext,
  ChainDriver,
  DriverContext,
} from '../../../src/core/driver/types';
import { ProviderError } from '../../../src/core/errors/error';
import { noopLogger } from '../../../src/core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import type { DriverIntent } from '../../../src/core/model/intent';
import {
  PLACEHOLDER_ORIGIN,
  type CallOptions,
  type EndpointCall,
  type HealthProbes,
  type HttpRequest,
  type Transport,
} from '../../../src/core/transport/types';
import { tonNode } from './support/harness';
import { KEY, PUBLIC_KEY, TEST_WALLETS } from './support/vectors';

const chain = TON_CHAINS[0] as ChainInfo;
const testnet = chain.networks.testnet as NetworkInfo;
const PK = Buffer.from(PUBLIC_KEY, 'hex');
const GRAM = 1_000_000_000n;
const FRESH = `0:${'11'.repeat(32)}`;

/**
 * Config param 19 as live toncenter v2 serves it (`getConfigParam?param=19`, fetched
 * 2026-09-28): exactly one int32, the global id.
 */
const LIVE_PARAM_19 = {
  mainnet: 'te6cckEBAQEABgAACP///xHmo3/3',
  testnet: 'te6cckEBAQEABgAACP////0sxAxZ',
} as const;

/** An exotic (library) cell: a type byte and a 256-bit hash, never a config param's value. */
const LIBRARY_CELL = new Cell({
  exotic: true,
  bits: new BitString(Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 7)]), 0, 264),
})
  .toBoc()
  .toString('base64');

/**
 * Counts `setProbes` calls and HTTP traffic on a transport, and keeps the probes (M12).
 * Reads go through the real transport, whose private fields a Proxy cannot reach.
 */
function counting(transport: Transport) {
  const log: string[] = [];
  const probes: HealthProbes[] = [];
  const proxy: Transport = new Proxy(transport, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'setProbes' || prop === 'http') {
        return (...args: unknown[]) => {
          log.push(String(prop));
          if (prop === 'setProbes') probes.push(args[0] as HealthProbes);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { proxy, log, probes };
}

async function driverFor(
  networkId: 'mainnet' | 'testnet',
  options: {
    readonly nodeGlobalId?: number;
    readonly network?: Partial<NetworkInfo>;
    readonly endpoints?: readonly string[];
    readonly maxLagBlocks?: number;
    readonly options?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const network = {
    ...(chain.networks[networkId] as NetworkInfo),
    ...options.network,
  };
  const t = tonNode(
    { globalId: options.nodeGlobalId ?? Number(network.identity) },
    options.endpoints,
    options.maxLagBlocks,
  );
  const rpc = counting(t.rpc);
  const indexer = counting(t.indexer);
  const ctx: DriverContext = {
    chain,
    network,
    library: '@ton/ton',
    transport: rpc.proxy,
    indexer: indexer.proxy,
    clock: t.clock,
    log: noopLogger,
    options: options.options ?? {},
  };
  const driver = await tonLibraryDriverFactory.create(ctx);
  return { t, driver, rpc, indexer, ctx };
}

/** A single-endpoint probe call that answers each route with `answers[route]`. */
function endpointCall(answers: Readonly<Record<string, unknown>>): EndpointCall {
  return {
    rpc: async () => {
      throw new Error('no JSON-RPC probe');
    },
    http: async <T>(request: HttpRequest) => answers[request.path] as T,
  };
}

const malformed = { code: 'PROVIDER_UNAVAILABLE', retryable: true };

describe('the TON driver factory', () => {
  it('sets probes exactly once on both transports before any traffic (M12)', async () => {
    const { t, rpc, indexer } = await driverFor('testnet');
    expect(rpc.log).toEqual(['setProbes']);
    expect(indexer.log).toEqual(['setProbes']);
    expect(t.node.served).toEqual([]);
    expect(t.rpc.hasProbes()).toBe(true);
    expect(t.indexer.hasProbes()).toBe(true);
    // R19: both check the network's global id, parsed from the registry.
    expect(rpc.probes[0]?.expectedIdentity).toBe('-3');
    expect(indexer.probes[0]?.expectedIdentity).toBe('-3');
  });

  it('refuses to run without an indexer, before any probe or traffic', async () => {
    const t = tonNode();
    const rpc = counting(t.rpc);
    await expect(
      tonLibraryDriverFactory.create({
        chain,
        network: testnet,
        library: '@ton/ton',
        transport: rpc.proxy,
        clock: t.clock,
        log: noopLogger,
        options: {},
      }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('indexer'),
    });
    expect(rpc.log).toEqual([]);
    expect(t.node.served).toEqual([]);
  });

  it('refuses a network that adds batch-transfer or block-scan, before any probe (F6-R15)', async () => {
    for (const add of [
      'batch-transfer',
      'block-scan',
      'replace-fee',
      'cancel',
    ] as const) {
      const t = tonNode();
      const rpc = counting(t.rpc);
      const indexer = counting(t.indexer);
      await expect(
        tonLibraryDriverFactory.create({
          chain,
          network: { ...testnet, capabilities: { add: [add] } },
          library: '@ton/ton',
          transport: rpc.proxy,
          indexer: indexer.proxy,
          clock: t.clock,
          log: noopLogger,
          options: {},
        }),
      ).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining(`'${add}' is not available on TON`),
      });
      expect([...rpc.log, ...indexer.log]).toEqual([]);
    }
  });

  it('assembles the seqno driver: no block source, no replacement, history, ext and one output', async () => {
    const { driver } = await driverFor('testnet');
    expect(driver.ordering).toBe('seqno');
    expect([...driver.capabilities].sort()).toEqual([
      'address-history',
      'expiry',
      'memo',
      'tokens',
    ]);
    expect(driver.blocks).toBeUndefined();
    expect(driver.replacement).toBeUndefined();
    expect(driver.close).toBeUndefined();
    expect(driver.history).toBeDefined();
    expect(driver.sequence).toBeDefined();
    expect(Object.keys(driver.ext ?? {})).toEqual(['ton']);
    expect(Object.keys(driver.ext?.ton ?? {}).sort()).toEqual([
      'getSeqno',
      'jettonWallet',
    ]);
    // F6-R15: one output per transfer for every wallet; the core prefers this answer to
    // its capability default.
    expect(driver.limits?.({ ton: { version: 'v4r2' } })).toEqual({ maxOutputs: 1 });
    expect(driver.limits?.({ ton: { version: 'v5r1', workchain: -1 } })).toEqual({
      maxOutputs: 1,
    });
    expect(driver.limits?.({})).toEqual({ maxOutputs: 1 });
    // M18: a malformed identity is its CONFIG_INVALID, never a silent answer.
    for (const ton of [
      { version: 'v9' },
      { version: 'v5r1', networkGlobalId: -239 },
      { version: 'v4r2', subwalletNumber: 1 },
      null,
      'v4r2',
    ]) {
      expect(() => driver.limits?.({ ton })).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it("leaves address-history to the core's selection: a network may remove it", async () => {
    const { driver } = await driverFor('testnet', {
      network: { capabilities: { remove: ['address-history'] } },
    });
    expect([...driver.capabilities].sort()).toEqual(['expiry', 'memo', 'tokens']);
    // The core gates `history()` on its own selection (manifest ∪ indexer ∪ add − remove)
    // before it reaches the port, so the port stays.
    expect(driver.history).toBeDefined();
  });

  it("derives v5r1 wallets from the network's global id (Review Focus 4)", async () => {
    const testnetDriver = (await driverFor('testnet')).driver;
    const mainnetDriver = (await driverFor('mainnet')).driver;
    const v5 = { ton: { version: 'v5r1' } };
    expect(testnetDriver.address.fromPublicKey(PK, v5).canonical).toBe(
      TEST_WALLETS.v5r1.testnet,
    );
    expect(mainnetDriver.address.fromPublicKey(PK, v5).canonical).toBe(
      TEST_WALLETS.v5r1.mainnet,
    );
    expect(() =>
      testnetDriver.address.fromPublicKey(PK, {
        ton: { version: 'v5r1', networkGlobalId: -239 },
      }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('checks both endpoints: the global id as identity, the masterchain head as height (R19)', async () => {
    const { t, rpc, indexer } = await driverFor('testnet');
    t.node.mine(3);
    await t.run(rpc.proxy.refreshHealth());
    await t.run(indexer.proxy.refreshHealth());
    expect(rpc.proxy.status()).toEqual([
      expect.objectContaining({ state: 'healthy', height: 4n }),
    ]);
    expect(indexer.proxy.status()).toEqual([
      expect.objectContaining({ state: 'healthy', height: 4n }),
    ]);
    expect(t.node.served.map((s) => s.route).sort()).toEqual([
      '/getConfigParam',
      '/getMasterchainInfo',
      '/masterchainInfo',
      '/masterchainInfo',
    ]);
    const wrong = await driverFor('testnet', { nodeGlobalId: -239 });
    await wrong.t.run(wrong.rpc.proxy.refreshHealth());
    await wrong.t.run(wrong.indexer.proxy.refreshHealth());
    expect(wrong.rpc.proxy.status()[0]?.state).toBe('disabled');
    expect(wrong.indexer.proxy.status()[0]?.state).toBe('disabled');
  });

  it('parses probe answers strictly: an identity or height is a claim (lesson 17)', async () => {
    const { rpc, indexer } = await driverFor('testnet');
    const v2 = rpc.probes[0] as Required<HealthProbes>;
    const v3 = indexer.probes[0] as Required<HealthProbes>;
    const param19 = (bytes: unknown) => ({
      ok: true,
      result: { '@type': 'configInfo', config: { '@type': 'tvm.cell', bytes } },
    });
    const head = (last: unknown) => ({ ok: true, result: { last } });
    const mc = { workchain: -1, shard: '-9223372036854775808', seqno: 42 };
    // Live answers read as the network's global id.
    for (const [network, bytes] of Object.entries(LIVE_PARAM_19)) {
      expect(await v2.identity(endpointCall({ '/getConfigParam': param19(bytes) }))).toBe(
        network === 'mainnet' ? '-239' : '-3',
      );
    }
    expect(await v2.height(endpointCall({ '/getMasterchainInfo': head(mc) }))).toBe(42n);
    const cell = (build: (b: ReturnType<typeof beginCell>) => unknown) => {
      const b = beginCell();
      build(b);
      return b.endCell().toBoc().toString('base64');
    };
    const badIdentity: unknown[] = [
      { ok: false, error: 'LITE_SERVER_NOTREADY', code: 500 },
      { ...param19(LIVE_PARAM_19.testnet), ok: false },
      { ok: true },
      { ok: true, result: { config: {} } },
      param19(5),
      param19('not a boc'),
      param19(''),
      param19('A'.repeat(1 << 20)),
      param19(cell((b) => b.storeInt(-3, 33))),
      param19(cell((b) => b.storeInt(-3, 16))),
      param19(cell((b) => b.storeInt(-3, 32).storeRef(beginCell().endCell()))),
      param19(LIBRARY_CELL),
      null,
      'ok',
    ];
    for (const answer of badIdentity) {
      await expect(
        v2.identity(endpointCall({ '/getConfigParam': answer })),
      ).rejects.toMatchObject(malformed);
    }
    const badHeads: unknown[] = [
      { ok: false, result: { last: mc } },
      head(undefined),
      head({ ...mc, workchain: 0 }),
      head({ ...mc, seqno: -1 }),
      head({ ...mc, seqno: 2 ** 32 }),
      head({ ...mc, seqno: 1.5 }),
      head({ ...mc, seqno: '9'.repeat(100) }),
      head({ ...mc, seqno: null }),
    ];
    for (const answer of badHeads) {
      await expect(
        v2.height(endpointCall({ '/getMasterchainInfo': answer })),
      ).rejects.toMatchObject(malformed);
    }
    // v3: the indexed head names the global id and the newest indexed block.
    const indexed = (last: unknown) => endpointCall({ '/masterchainInfo': { last } });
    const last = { workchain: -1, seqno: 42, global_id: -3 };
    expect(await v3.identity(indexed(last))).toBe('-3');
    expect(await v3.identity(indexed({ ...last, global_id: '-239' }))).toBe('-239');
    expect(await v3.height(indexed(last))).toBe(42n);
    for (const bad of [
      { ...last, global_id: undefined },
      { ...last, global_id: 2 ** 31 },
      { ...last, global_id: -(2 ** 31) - 1 },
      { ...last, global_id: 'testnet' },
    ]) {
      await expect(v3.identity(indexed(bad))).rejects.toMatchObject(malformed);
    }
    for (const bad of [
      { ...last, workchain: 0 },
      { ...last, seqno: 2 ** 32 },
      { ...last, seqno: -5 },
      { ...last, seqno: undefined },
      undefined,
    ]) {
      await expect(v3.height(indexed(bad))).rejects.toMatchObject(malformed);
    }
    await expect(
      v3.height(endpointCall({ '/masterchainInfo': null })),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("keeps the transport's lag tolerance: the network's maxLagBlocks is only a default (R36)", async () => {
    expect(testnet.maxLagBlocks).toBe(150);
    const { t, rpc } = await driverFor('testnet', {
      endpoints: ['a', 'b'],
      maxLagBlocks: 7,
    });
    expect(t.rpc.maxLagBlocks).toBe(7);
    t.node.mine(20);
    t.node.lagEndpoint('b', 10);
    await t.run(rpc.proxy.refreshHealth());
    expect(t.rpc.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'healthy'],
      ['b', 'lagging'],
    ]);
  });

  it("trails its attested head by the transport's lag tolerance, never the network's (F6-R23 M2, R36)", async () => {
    // The driver itself: with a peer 20 blocks behind, the head trailed by the skew (10) is
    // not attested, so the proofs retry at the transport's tolerance (30), never at the
    // network's `maxLagBlocks` (150).
    const { t, driver } = await driverFor('testnet', {
      endpoints: ['a', 'b'],
      maxLagBlocks: 30,
    });
    t.node.mine(200);
    t.node.lagEndpoint('b', 20);
    const head = t.node.head;
    expect(await t.run(driver.proofs.finalizedHead())).toMatchObject({
      height: BigInt(head - 30),
    });
  });

  it('gives each native client its own TonClient over the transport (R34)', async () => {
    const { t, driver } = await driverFor('testnet');
    const first = driver.createNativeClient!();
    const second = driver.createNativeClient!();
    expect(first.client).toBeInstanceOf(TonClient);
    expect(first.client).not.toBe(second.client);
    expect(first.close).toBeUndefined();
    t.node.mine(2);
    const info = await t.run((first.client as TonClient).getMasterchainInfo());
    expect(info.latestSeqno).toBe(t.node.head);
    expect(t.node.served.at(-1)).toEqual({ endpoint: 'main', route: '/jsonRPC' });
  });

  it('keeps URLs and keys in the transport, and tags a native broadcast as one (M3)', async () => {
    const calls: { readonly request: HttpRequest; readonly options?: CallOptions }[] = [];
    let answer: unknown = { ok: true, result: { '@type': 'ok' } };
    const transport = {
      http: async (request: HttpRequest, options?: CallOptions) => {
        calls.push({ request, ...(options ? { options } : {}) });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as Transport;
    const client = tonNativeClient(transport).client as TonClient;
    expect(client.parameters.endpoint).toBe(`${PLACEHOLDER_ORIGIN}/jsonRPC`);
    expect(client.parameters.apiKey).toBeUndefined();
    await client.sendFile(Buffer.from('boc'));
    expect(calls[0]?.request).toEqual({
      method: 'POST',
      path: '/jsonRPC',
      body: {
        id: '1',
        jsonrpc: '2.0',
        method: 'sendBoc',
        params: { boc: Buffer.from('boc').toString('base64') },
      },
      route: '/jsonRPC',
    });
    expect(calls[0]?.options).toEqual({
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
    });
    const blockId = (seqno: number) => ({
      '@type': 'ton.blockIdExt',
      workchain: -1,
      shard: '-9223372036854775808',
      seqno,
      root_hash: 'r',
      file_hash: 'f',
    });
    answer = {
      ok: true,
      result: { state_root_hash: 's', last: blockId(9), init: blockId(0) },
    };
    expect((await client.getMasterchainInfo()).latestSeqno).toBe(9);
    expect(calls[1]?.options).toEqual({ purpose: 'read', retry: 'safe' });
    // The transport's own error reaches the caller unchanged.
    answer = new ProviderError('RATE_LIMITED', 'rate limited', { retryable: true });
    await expect(client.getMasterchainInfo()).rejects.toBe(answer);
  });

  it('takes the family shape: tonDriverFactory(makeNative), the library module supplies it (I2)', async () => {
    const made: Transport[] = [];
    const factory = tonDriverFactory((transport) => {
      made.push(transport);
      return tonNativeClient(transport);
    });
    const t = tonNode();
    const driver = await factory.create({
      chain,
      network: testnet,
      library: '@ton/ton',
      transport: t.rpc,
      indexer: t.indexer,
      clock: t.clock,
      log: noopLogger,
      options: {},
    });
    expect(made).toEqual([]);
    driver.createNativeClient!();
    expect(made).toEqual([t.rpc]);
  });

  it('reads seqnos through ext.ton', async () => {
    const { t, driver } = await driverFor('testnet');
    const read = driver.ext?.ton?.getSeqno as (address: string) => Promise<bigint>;
    expect(await t.run(read(TEST_WALLETS.v4r2.basechain))).toBe(0n);
  });
});

describe('the assembled TON driver', () => {
  const from = TEST_WALLETS.v4r2.basechain;
  const intent: DriverIntent = {
    asset: 'native',
    outputs: [{ to: FRESH, amount: GRAM, variant: { bounceable: false } }],
    from,
    fee: 'normal',
  };
  const buildAt = (seqno: bigint): BuildContext => ({
    from,
    keys: [{ scheme: 'ed25519', publicKey: PK }],
    wallet: { ton: { version: 'v4r2' } },
    ordering: { kind: 'seqno', seqno, validUntil: 0 },
  });

  /** estimate → check → build → sign → assemble at the wallet's live seqno (F6-R19). */
  async function send(t: ReturnType<typeof tonNode>, driver: ChainDriver) {
    const seqno = await t.run(driver.sequence!.pending(from));
    const fee = await t.run(driver.builder.estimateFee(intent, buildAt(seqno)));
    expect(await t.run(driver.builder.checkFunds(intent, fee, buildAt(seqno)))).toEqual({
      ok: true,
    });
    const unsigned = await t.run(driver.builder.build(intent, fee, buildAt(seqno)));
    const request = unsigned.signingRequests[0]!;
    const signed = await driver.builder.assemble(unsigned, [
      {
        requestId: request.id,
        bytes: ed25519.sign(request.payload, Buffer.from(KEY, 'hex')),
      },
    ]);
    expect(await t.run(driver.broadcaster.broadcast(signed))).toEqual({
      kind: 'accepted',
    });
    return { seqno, unsigned, signed };
  }

  it('sends through its own ports, and its sequence source returns the live seqno', async () => {
    const { t, driver } = await driverFor('testnet');
    t.node.fund(from, 3n * GRAM);
    const first = await send(t, driver);
    expect(first.seqno).toBe(0n);
    t.node.mine(2);
    expect(t.node.balance(FRESH)).toBe(GRAM);
    expect(
      await t.run(driver.reader.observe(first.signed.ref, first.unsigned.ordering, from)),
    ).toMatchObject({ seen: 'block', success: true });
    expect(await t.run(driver.sequence!.latest(from))).toBe(1n);
    expect(await t.run(driver.sequence!.pending(from))).toBe(1n);
    const second = await send(t, driver);
    expect(second.seqno).toBe(1n);
    t.node.mine(2);
    expect(t.node.seqno(from)).toBe(2);
    expect(await t.run(driver.sequence!.latest(from))).toBe(2n);
    expect(
      (await t.run(driver.history!.list(from, { limit: 10 }))).items.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('reads its handle options: maxNetworkFee reaches the builder, anything else is refused before any probe (F6-R24, F6-R25)', async () => {
    const tight = await driverFor('testnet', {
      options: { maxNetworkFee: { basechain: 1n } },
    });
    tight.t.node.fund(from, 3n * GRAM);
    await expect(
      tight.t.run(tight.driver.builder.estimateFee(intent, buildAt(0n))),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    // The option overrides the network's own ceiling.
    const loose = await driverFor('testnet', {
      network: { params: { maxNetworkFee: { basechain: 1n } } },
      options: { maxNetworkFee: { basechain: 10n ** 9n } },
    });
    loose.t.node.fund(from, 3n * GRAM);
    expect(
      (await loose.t.run(loose.driver.builder.estimateFee(intent, buildAt(0n)))).kind,
    ).toBe('ton');
    for (const options of [
      { maxNetworkFe: { basechain: 1n } },
      { maxNetworkFee: 'high' },
    ]) {
      const t = tonNode();
      const rpc = counting(t.rpc);
      const indexer = counting(t.indexer);
      await expect(
        tonLibraryDriverFactory.create({
          chain,
          network: testnet,
          library: '@ton/ton',
          transport: rpc.proxy,
          indexer: indexer.proxy,
          clock: t.clock,
          log: noopLogger,
          options,
        }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      expect([...rpc.log, ...indexer.log]).toEqual([]);
    }
  });

  it("takes the network's maxNetworkFee into its builder (F6-R17)", async () => {
    const tight = await driverFor('testnet', {
      network: { params: { maxNetworkFee: { basechain: 1n } } },
    });
    tight.t.node.fund(from, 3n * GRAM);
    await expect(
      tight.t.run(tight.driver.builder.estimateFee(intent, buildAt(0n))),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    const plain = await driverFor('testnet');
    plain.t.node.fund(from, 3n * GRAM);
    expect(
      (await plain.t.run(plain.driver.builder.estimateFee(intent, buildAt(0n)))).kind,
    ).toBe('ton');
  });
});
