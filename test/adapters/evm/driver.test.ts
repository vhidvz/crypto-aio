import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { ethersDriverFactory } from '../../../src/adapters/evm/ethers-client';
import { createEvmBlocks, createEvmProofs } from '../../../src/adapters/evm/proofs';
import { createEvmReader } from '../../../src/adapters/evm/reader';
import { web3DriverFactory } from '../../../src/adapters/evm/web3-client';
import type { ChainDriver } from '../../../src/core/driver/types';
import { noopLogger } from '../../../src/core/events/logger';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import type {
  EndpointCall,
  HealthProbes,
  Transport,
  TransportOptions,
} from '../../../src/core/transport/types';
import { LIBRARIES, nodeTransport, type Library } from './support/harness';
import { evmHarness, submit } from './support/context';
import { KEY_ADDRESS, RECIPIENT } from './support/vectors';

const TOKEN = '0x00000000000000000000000000000000000070Ce';
const OTHER = '0x00000000000000000000000000000000000000aa';
/** Polygon PoS system logs (bor core/bor_fee_log.go), emitted from the MRC20 predeploy. */
const POLYGON_EMITTER = '0x0000000000000000000000000000000000001010';
const LOG_FEE_TRANSFER =
  '0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63';
const LOG_TRANSFER = '0xe6497e3ee548a3372136af2fcb0696db31fc6cf20260707645068bd3fe97f3c4';
const ref = (id: string) => ({ id, idKind: 'tx-hash' as const, canonical: true });
const nonce = (n: bigint) => ({ kind: 'nonce' as const, nonce: n });
const hex = (value: bigint | number) => `0x${value.toString(16)}`;
const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
const inconsistent = { code: 'PROVIDER_INCONSISTENT', retryable: true };
const notYetFinal = {
  code: 'PROVIDER_UNAVAILABLE',
  retryable: true,
  message: 'receipt not yet final',
};

type Harness = ReturnType<typeof evmHarness>;

/**
 * `endpoint` answers every `finalized` read as of `lag` blocks below the node's finalized
 * block; a negative `lag` over-reports it.
 */
function finalityLag(h: Harness, endpoint: string, lag: bigint): void {
  h.node.intercept = (e, method, params) => {
    if (e !== endpoint || !params.includes('finalized')) return undefined;
    const at = hex(h.node.finalized - lag);
    return {
      result: h.node.answer(
        method,
        params.map((p) => (p === 'finalized' ? at : p)),
      ),
    };
  };
}

/** `endpoint` has not seen the node's last `lag` blocks yet. */
function headLag(h: Harness, endpoint: string, lag: bigint): void {
  h.node.intercept = (e, method, params) => {
    if (e !== endpoint) return undefined;
    const head = h.node.head - lag;
    if (method === 'eth_blockNumber') return { result: hex(head) };
    const [at] = params;
    const unseen = typeof at === 'string' && at.startsWith('0x') && BigInt(at) > head;
    return method === 'eth_getBlockByNumber' && unseen ? { result: null } : undefined;
  };
}

async function driverFor(
  library: Library,
  chainId: string,
  networkId: string,
  endpoints: readonly string[] = ['main'],
  transportOptions: Omit<TransportOptions, 'fetch'> = {},
) {
  const chain = EVM_CHAINS.find((c) => c.id === chainId) as ChainInfo;
  const network = chain.networks[networkId] as NetworkInfo;
  const t = nodeTransport(
    { chainId: BigInt(network.identity as string) },
    endpoints,
    transportOptions,
  );
  const factory = library === 'ethers' ? ethersDriverFactory : web3DriverFactory;
  const driver: ChainDriver = await factory.create({
    chain,
    network,
    library,
    transport: t.transport,
    clock: t.clock,
    log: noopLogger,
    options: {},
  });
  return { ...t, driver };
}

describe.each(LIBRARIES)('EVM driver factory (%s)', (library) => {
  it('sets identity (eth_chainId) and height (eth_blockNumber) probes before any traffic', async () => {
    const t = await driverFor(library, 'ethereum', 'sepolia', ['a', 'b']);
    expect(t.transport.hasProbes()).toBe(true);
    expect(t.node.served).toEqual([]);
    t.node.intercept = (endpoint, method) =>
      endpoint === 'a' && method === 'eth_chainId' ? { result: '0x1' } : undefined;
    t.node.mine(3);
    await t.run(t.transport.refreshHealth());
    expect(t.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'disabled'],
      ['b', 'healthy'],
    ]);
    expect(t.transport.highestHeight()).toBe(3n);
    expect(t.seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.misconfigured',
        expected: '11155111',
        actual: '1',
      }),
    );
  });

  it('sets the probes exactly once on every transport it receives, the indexer too (M12, R19)', async () => {
    const chain = EVM_CHAINS.find((c) => c.id === 'ethereum') as ChainInfo;
    const counting = (transport: Transport) => {
      const set: HealthProbes[] = [];
      const proxy = new Proxy(transport, {
        get(target, prop) {
          if (prop === 'setProbes') {
            return (probes: HealthProbes) => {
              set.push(probes);
              target.setProbes(probes);
            };
          }
          // Read through the real transport, whose private fields a Proxy cannot reach.
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { set, proxy };
    };
    const main = nodeTransport({ chainId: 11155111n }, ['a']);
    const index = nodeTransport({ chainId: 11155111n }, ['i']);
    const rpc = counting(main.transport);
    const indexer = counting(index.transport);
    const factory = library === 'ethers' ? ethersDriverFactory : web3DriverFactory;
    await factory.create({
      chain,
      network: chain.networks.sepolia as NetworkInfo,
      library,
      transport: rpc.proxy,
      indexer: indexer.proxy,
      clock: main.clock,
      log: noopLogger,
      options: {},
    });
    expect(rpc.set).toHaveLength(1);
    expect(indexer.set).toHaveLength(1);
    expect(main.node.served).toEqual([]);
    expect(index.node.served).toEqual([]);
    const probes = rpc.set[0] as HealthProbes;
    expect(probes.expectedIdentity).toBe('11155111');
    const answers: Record<string, unknown> = {
      eth_chainId: '0xaa36a7',
      eth_blockNumber: '0x2a',
    };
    const call = {
      rpc: async (method: string) => answers[method],
      http: async () => {
        throw new Error('no HTTP probe');
      },
    } as unknown as EndpointCall;
    expect(await probes.identity?.(call)).toBe('11155111');
    expect(await probes.height?.(call)).toBe(42n);
    answers.eth_blockNumber = 42;
    await expect(probes.height?.(call)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it("derives each network's capabilities and replacement support from its data", async () => {
    const caps = async (chain: string, network: string) => {
      const { driver } = await driverFor(library, chain, network);
      return {
        caps: [...driver.capabilities].sort(),
        replace: driver.replacement !== undefined,
      };
    };
    expect(await caps('ethereum', 'mainnet')).toEqual({
      caps: [
        'block-scan',
        'cancel',
        'fee-market-1559',
        'finality-tag',
        'hd-public-derivation',
        'replace-fee',
        'tokens',
      ],
      replace: true,
    });
    expect((await caps('bsc', 'mainnet')).caps).not.toContain('fee-market-1559');
    expect((await caps('avalanche', 'fuji')).caps).not.toContain('finality-tag');
    expect(await caps('arbitrum', 'mainnet')).toMatchObject({ replace: false });
    expect((await caps('arbitrum', 'mainnet')).caps).not.toContain('cancel');
  });

  it('exposes ext.evm, one output, and a fresh native client per call', async () => {
    const t = await driverFor(library, 'base', 'sepolia');
    t.node.fund(KEY_ADDRESS, 1n);
    expect(
      await t.run(t.driver.ext!.evm!.getNonce!(KEY_ADDRESS as never) as Promise<bigint>),
    ).toBe(0n);
    expect(t.driver.limits?.({})).toEqual({ maxOutputs: 1 });
    const first = t.driver.createNativeClient!();
    const second = t.driver.createNativeClient!();
    expect(first.client).not.toBe(second.client);
    await first.close?.();
    await second.close?.();
  });

  it("keeps the transport's lag tolerance: a network's maxLagBlocks is only a default (R36)", async () => {
    const bsc = EVM_CHAINS.find((c) => c.id === 'bsc') as ChainInfo;
    expect(bsc.networks.mainnet?.maxLagBlocks).toBe(134);
    const t = await driverFor(library, 'bsc', 'mainnet', ['a', 'b'], { maxLagBlocks: 7 });
    expect(t.transport.maxLagBlocks).toBe(7);
    t.node.mine(20);
    t.node.intercept = (endpoint, method) =>
      endpoint === 'b' && method === 'eth_blockNumber' ? { result: hex(10) } : undefined;
    await t.run(t.transport.refreshHealth());
    expect(t.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'healthy'],
      ['b', 'lagging'],
    ]);
  });
});

describe.each(LIBRARIES)('EVM proofs (%s)', (library) => {
  function setup(chain = 'ethereum', network = 'sepolia') {
    const h = evmHarness(library, chain, network, { endpoints: ['a', 'b'] });
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    return { ...h, proofs: createEvmProofs(h.ctx) };
  }

  it('proves inclusion only at finality, and slot consumption by any transaction', async () => {
    const t = setup();
    const hash = await submit(t, 0);
    t.node.mine();
    // R77: a receipt in a block that is not final yet decides nothing, never "not included".
    await expect(
      t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).rejects.toMatchObject(notYetFinal);
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'latest'))).toBe(
      true,
    );
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      false,
    );
    t.node.mine(2);
    t.calls.length = 0;
    t.node.served.length = 0;
    expect(
      await t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: true,
      blockHeight: 1n,
      blockHash: t.node.block(1n)?.hash,
      txHash: hash,
    });
    expect(
      t.calls.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
    expect(new Set(t.node.served.map((s) => s.endpoint))).toEqual(new Set(['a', 'b']));
    // R85: the nonce is read at the proposed finalized height less PEER_SKEW (block 1 here).
    t.node.mine(2);
    t.calls.length = 0;
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
    expect(await t.run(t.proofs.slotConsumed(nonce(1n), KEY_ADDRESS, 'finalized'))).toBe(
      false,
    );
    // One endpoint's view only proposes the height (a monitor read); the quorum decides.
    const proof = [
      ['getBlock', 'monitor', undefined],
      ['getBlock', 'proof', 'proof'],
      ['getTransactionCount', 'proof', 'proof'],
    ];
    expect(t.calls.map((c) => [c.method, c.tags.purpose, c.tags.quorum])).toEqual([
      ...proof,
      ...proof,
    ]);
    expect(await t.run(t.proofs.expired(nonce(0n)))).toBe(false);
  });

  it('serves block hashes by level, null above the head or the finalized block (R33)', async () => {
    const t = setup();
    t.node.mine(4);
    t.calls.length = 0;
    // R74: one endpoint proposes its finalized block, the proof trails it by 2 blocks, and
    // the quorum attests that height before the block at it is read.
    expect(await t.run(t.proofs.finalizedHead())).toEqual({
      height: 0n,
      hash: t.node.block(0n)?.hash,
      timestamp: expect.any(Number),
    });
    expect(t.calls.map((c) => [c.method, c.tags.purpose, c.tags.quorum])).toEqual([
      ['getBlock', 'monitor', undefined],
      ['getBlock', 'proof', 'proof'],
      ['getBlock', 'proof', 'proof'],
    ]);
    t.calls.length = 0;
    expect(await t.run(t.proofs.blockHash(2n, 'finalized'))).toBe(t.node.block(2n)?.hash);
    expect(await t.run(t.proofs.blockHash(1n, 'finalized'))).toBe(t.node.block(1n)?.hash);
    expect(await t.run(t.proofs.blockHash(3n, 'finalized'))).toBeNull();
    expect(await t.run(t.proofs.blockHash(4n, 'latest'))).toBe(t.node.block(4n)?.hash);
    expect(await t.run(t.proofs.blockHash(5n, 'latest'))).toBeNull();
    expect(
      t.calls.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
  });

  it('decides nothing while endpoints disagree on consensus facts, and ignores formatting', async () => {
    const t = setup();
    t.node.mine(4);
    const real = t.node.block(3n)?.hash as string;
    t.node.intercept = (endpoint, method, params) => {
      if (endpoint !== 'b' || method !== 'eth_getBlockByNumber' || params[0] !== '0x3')
        return undefined;
      return {
        result: {
          number: '0x3',
          hash: real,
          parentHash: t.node.block(2n)?.hash,
          timestamp: `0x${(1_700_000_000).toString(16)}`,
          size: '0x1',
          transactions: [],
        },
      };
    };
    expect(await t.run(t.proofs.blockHash(3n, 'latest'))).toBe(real);
    t.node.intercept = (endpoint, method, params) =>
      endpoint === 'b' && method === 'eth_getBlockByNumber' && params[0] === '0x3'
        ? {
            result: {
              number: '0x3',
              hash: `0x${'ee'.repeat(32)}`,
              parentHash: `0x${'ee'.repeat(32)}`,
              timestamp: '0x1',
              transactions: [],
            },
          }
        : undefined;
    await expect(t.run(t.proofs.blockHash(3n, 'latest'))).rejects.toMatchObject(
      inconsistent,
    );
  });

  it('proves a confirmation network (Avalanche) from the head less 2 blocks, read once (R74)', async () => {
    const t = setup('avalanche', 'fuji');
    t.node.mine(3);
    t.calls.length = 0;
    expect(await t.run(t.proofs.finalizedHead())).toMatchObject({
      height: 1n,
      hash: t.node.block(1n)?.hash,
    });
    // One confirmation: the block the quorum confirmed is the final block itself.
    expect(t.calls.map((c) => [c.method, c.tags.purpose])).toEqual([
      ['blockNumber', 'monitor'],
      ['getBlock', 'proof'],
    ]);
    // A height is final once every quorum endpoint holds its confirming block.
    expect(await t.run(t.proofs.blockHash(3n, 'finalized'))).toBe(t.node.block(3n)?.hash);
    expect(await t.run(t.proofs.blockHash(4n, 'finalized'))).toBeNull();
  });

  it('proves a token transfer that returned false as failed, never executed (R50)', async () => {
    const t = setup();
    const reader = createEvmReader(t.ctx);
    t.node.deployToken(TOKEN, { symbol: 'FLS', decimals: 6, returnsFalse: true });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 5n);
    const data = t.client.abi.encodeTransfer(RECIPIENT, 10n);
    const hash = await submit(t, 0, { to: TOKEN, value: 0n, gasLimit: 60_000n, data });
    t.node.mine(3);
    expect(t.node.receipt(hash)?.status).toBe(1);
    expect(await t.run(reader.observe(ref(hash), nonce(0n), KEY_ADDRESS))).toMatchObject({
      seen: 'block',
      success: false,
      reason: 'token transfer failed',
    });
    t.calls.length = 0;
    expect(
      await t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: false,
      blockHeight: 1n,
      blockHash: t.node.block(1n)?.hash,
      txHash: hash,
    });
    expect(t.calls.map((c) => c.method)).toContain('getTransaction');
    expect(
      t.calls.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
    expect((await t.run(reader.getTransaction(hash)))?.transfers).toEqual([]);
  });

  it("reaches a proof while two endpoints' finalized heads differ by a block (R74)", async () => {
    const t = setup();
    const hash = await submit(t, 0);
    t.node.mine(3);
    await submit(t, 1);
    t.node.mine(3);
    // Nonce 1 lands in block 4: final on the node (4), not on a lagging endpoint (3), so the
    // two endpoints' nonces at `finalized` differ (2 and 1).
    expect(t.node.finalized).toBe(4n);
    expect(t.node.block(4n)?.txs).toHaveLength(1);
    for (const lagging of ['a', 'b']) {
      finalityLag(t, lagging, 1n);
      expect(
        await t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
      ).toMatchObject({ included: true, success: true, blockHeight: 1n });
      expect(
        await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized')),
      ).toBe(true);
      // R85: both endpoints read the nonce at the one attested height (2, or 1 when 'a'
      // lags), where nonce 1 is not consumed yet: nothing is proven, whatever their views.
      expect(
        await t.run(t.proofs.slotConsumed(nonce(1n), KEY_ADDRESS, 'finalized')),
      ).toBe(false);
      expect(
        await t.run(t.proofs.slotConsumed(nonce(2n), KEY_ADDRESS, 'finalized')),
      ).toBe(false);
      expect(await t.run(t.proofs.blockHash(3n, 'finalized'))).toBe(
        t.node.block(3n)?.hash,
      );
      // 'a' proposes (4, or 3 when it lags); the 2-block trail lets the other attest it.
      const head = await t.run(t.proofs.finalizedHead());
      expect(head.height).toBe(lagging === 'a' ? 1n : 2n);
      expect(head.hash).toBe(t.node.block(head.height)?.hash);
      // Final on one endpoint only: that decides nothing, in either direction.
      await expect(t.run(t.proofs.blockHash(4n, 'finalized'))).rejects.toMatchObject(
        inconsistent,
      );
    }
  });

  it('never lets one endpoint over-reporting its finalized height advance finality (R74)', async () => {
    const t = setup();
    const hash = await submit(t, 0);
    t.node.mine(2);
    expect(t.node.finalized).toBe(0n);
    for (const liar of ['a', 'b']) {
      // The liar reports its head (block 2, holding the transaction's block) as final.
      finalityLag(t, liar, -2n);
      await expect(
        t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
      ).rejects.toMatchObject(inconsistent);
      // R85: the nonce is read at the height the quorum attests (0), which the liar cannot
      // advance: the slot is not proven consumed.
      expect(
        await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized')),
      ).toBe(false);
      await expect(t.run(t.proofs.blockHash(1n, 'finalized'))).rejects.toMatchObject(
        inconsistent,
      );
      // Within the 2-block trail, the proposal still lands on the honest final height.
      expect((await t.run(t.proofs.finalizedHead())).height).toBe(0n);
    }
    // 'a', which proposes, claims a final block far past the head: the quorum refuses it.
    t.node.intercept = (endpoint, method, params) =>
      endpoint === 'a' && method === 'eth_getBlockByNumber' && params[0] === 'finalized'
        ? {
            result: {
              number: '0x64',
              hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'22'.repeat(32)}`,
              timestamp: '0x1',
              transactions: [],
            },
          }
        : undefined;
    await expect(t.run(t.proofs.finalizedHead())).rejects.toMatchObject(inconsistent);
  });

  it('takes no finality from an endpoint that serves no finalized block (R74)', async () => {
    const t = setup();
    const hash = await submit(t, 0);
    t.node.mine(3);
    for (const silent of ['a', 'b']) {
      t.node.intercept = (endpoint, method, params) =>
        endpoint === silent &&
        method === 'eth_getBlockByNumber' &&
        params[0] === 'finalized'
          ? { result: null }
          : undefined;
      await expect(
        t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
      ).rejects.toMatchObject(inconsistent);
      await expect(t.run(t.proofs.blockHash(1n, 'finalized'))).rejects.toMatchObject(
        inconsistent,
      );
    }
  });

  it('proves on a confirmation network while one endpoint trails the head by a block (R74)', async () => {
    const t = setup('avalanche', 'fuji');
    const hash = await submit(t, 0);
    t.node.mine(4);
    for (const trailing of ['a', 'b']) {
      headLag(t, trailing, 1n);
      // 'a' proposes its head (4, or 3 when it trails); both hold the block 2 below it.
      expect((await t.run(t.proofs.finalizedHead())).height).toBe(
        trailing === 'a' ? 1n : 2n,
      );
      expect(
        await t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
      ).toMatchObject({ included: true, success: true, blockHeight: 1n });
      expect(
        await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized')),
      ).toBe(true);
      expect(await t.run(t.proofs.blockHash(3n, 'finalized'))).toBe(
        t.node.block(3n)?.hash,
      );
      await expect(t.run(t.proofs.blockHash(4n, 'finalized'))).rejects.toMatchObject(
        inconsistent,
      );
    }
  });

  it('counts further confirmations below the confirmed block (a custom network)', async () => {
    const t = setup('avalanche', 'fuji');
    const proofs = createEvmProofs({
      ...t.ctx,
      config: { ...t.ctx.config, finality: { kind: 'confirmations', confirmations: 3 } },
    });
    const hash = await submit(t, 0);
    t.node.mine(6);
    t.calls.length = 0;
    // The quorum confirms block 4 (the head less 2); with 3 confirmations, 2 is final.
    expect(await t.run(proofs.finalizedHead())).toMatchObject({
      height: 2n,
      hash: t.node.block(2n)?.hash,
    });
    expect(t.calls.map((c) => [c.method, c.tags.purpose])).toEqual([
      ['blockNumber', 'monitor'],
      ['getBlock', 'proof'],
      ['getBlock', 'proof'],
    ]);
    // Block 4 is final once the quorum holds block 6, which confirms it three times.
    expect(await t.run(proofs.blockHash(4n, 'finalized'))).toBe(t.node.block(4n)?.hash);
    expect(await t.run(proofs.blockHash(5n, 'finalized'))).toBeNull();
    expect(
      await t.run(proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).toMatchObject({ included: true, blockHeight: 1n });
    expect(await t.run(proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
  });

  it('lets no single endpoint decide a token verdict by dropping its Transfer log (R59)', async () => {
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 100n);
    const data = t.client.abi.encodeTransfer(RECIPIENT, 10n);
    const hash = await submit(t, 0, { to: TOKEN, value: 0n, gasLimit: 60_000n, data });
    t.node.mine(3);
    const proof = () => t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS));
    expect(await proof()).toMatchObject({ included: true, success: true });
    t.node.intercept = (endpoint, method, params) =>
      endpoint === 'b' && method === 'eth_getTransactionReceipt'
        ? { result: { ...(t.node.answer(method, params) as object), logs: [] } }
        : undefined;
    await expect(proof()).rejects.toMatchObject(inconsistent);
  });

  it('decides nothing when a receipt names a block that is not canonical at its final height', async () => {
    const t = setup();
    const hash = await submit(t, 0);
    t.node.mine(3);
    t.node.intercept = (_endpoint, method, params) =>
      method === 'eth_getTransactionReceipt'
        ? {
            result: {
              ...(t.node.answer(method, params) as object),
              blockHash: `0x${'ab'.repeat(32)}`,
            },
          }
        : undefined;
    await expect(
      t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).rejects.toMatchObject(inconsistent);
  });

  it("decides nothing when the quorum sees the receipt but not yet its block's finality (R77)", async () => {
    // The core's whenAbsent: the slot is proven consumed at finality, then the inclusion
    // proof may reach endpoints whose finality trails the transaction's block. Answering
    // "not included" there would prove a final transfer `replaced`.
    const t = setup();
    const hash = await submit(t, 0);
    // Block 1 is final at the proposed height less PEER_SKEW (R85).
    t.node.mine(5);
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
    t.node.intercept = (_endpoint, method, params) =>
      params.includes('finalized')
        ? {
            result: t.node.answer(
              method,
              params.map((p) => (p === 'finalized' ? '0x0' : p)),
            ),
          }
        : undefined;
    await expect(
      t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS)),
    ).rejects.toMatchObject(notYetFinal);
    // Confirmation networks: no endpoint holds the block that confirms the receipt's yet.
    const c = setup('avalanche', 'fuji');
    const proofs = createEvmProofs({
      ...c.ctx,
      config: { ...c.ctx.config, finality: { kind: 'confirmations', confirmations: 3 } },
    });
    const pending = await submit(c, 0);
    c.node.mine(2);
    await expect(
      c.run(proofs.includedFinal(ref(pending), nonce(0n), KEY_ADDRESS)),
    ).rejects.toMatchObject(notYetFinal);
  });

  it('proves "not included" only when the quorum agrees there is no receipt', async () => {
    // whenAbsent's other shape: a replacement consumed the slot, and the replaced
    // transaction has no receipt on any quorum endpoint.
    const t = setup();
    const replaced = await submit(t, 0);
    const winner = await submit(t, 0, {
      maxFeePerGas: 4_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
    });
    t.node.mine(5);
    expect(t.node.receipt(winner)?.blockNumber).toBe(1n);
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
    expect(
      await t.run(t.proofs.includedFinal(ref(replaced), nonce(0n), KEY_ADDRESS)),
    ).toEqual({ included: false });
    // One endpoint that hides the winner's receipt cannot make it "not included".
    for (const hider of ['a', 'b']) {
      t.node.intercept = (endpoint, method) =>
        endpoint === hider && method === 'eth_getTransactionReceipt'
          ? { result: null }
          : undefined;
      await expect(
        t.run(t.proofs.includedFinal(ref(winner), nonce(0n), KEY_ADDRESS)),
      ).rejects.toMatchObject(inconsistent);
    }
  });

  it('ignores whatever the first endpoint forges outside the consensus facts', async () => {
    // A quorum call resolves with the first endpoint's whole answer: a proof may use only
    // the fields its quorum key compares.
    const t = setup();
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, KEY_ADDRESS, 100n);
    const data = t.client.abi.encodeTransfer(RECIPIENT, 10n);
    const hash = await submit(t, 0, { to: TOKEN, value: 0n, gasLimit: 60_000n, data });
    t.node.mine(3);
    const proof = () => t.run(t.proofs.includedFinal(ref(hash), nonce(0n), KEY_ADDRESS));
    const honest = await proof();
    expect(honest).toMatchObject({ included: true, success: true, blockHeight: 1n });
    const forged = `0x${'99'.repeat(32)}`;
    const forge =
      (keyed: boolean) =>
      (endpoint: string, method: string, params: readonly unknown[]) => {
        if (endpoint !== 'a') return undefined;
        const real = t.node.answer(method, params);
        if (real === null || typeof real !== 'object') return undefined;
        const answer = real as Record<string, unknown>;
        switch (method) {
          case 'eth_getTransactionReceipt':
            return {
              result: {
                ...answer,
                from: OTHER,
                gasUsed: '0x1',
                effectiveGasPrice: '0x1',
                logs: (answer.logs as Record<string, unknown>[]).map((log) => ({
                  ...log,
                  transactionHash: forged,
                  removed: true,
                })),
                ...(keyed ? { status: '0x0' } : {}),
              },
            };
          case 'eth_getTransactionByHash':
            return { result: { ...answer, value: '0x999', gas: '0x1' } };
          case 'eth_getBlockByNumber':
            return {
              result: {
                ...answer,
                transactions: [],
                miner: OTHER,
                ...(params[0] === 'finalized'
                  ? { hash: forged, parentHash: forged }
                  : {}),
              },
            };
          default:
            return undefined;
        }
      };
    t.node.intercept = forge(false);
    expect(await proof()).toEqual(honest);
    t.node.intercept = forge(true);
    await expect(proof()).rejects.toMatchObject(inconsistent);
  });

  /** Records the block parameter of every nonce read, by endpoint, around `intercept`. */
  function nonceReads(t: ReturnType<typeof setup>, intercept = t.node.intercept) {
    const reads: [string, unknown][] = [];
    t.node.intercept = (endpoint, method, params) => {
      if (method === 'eth_getTransactionCount') reads.push([endpoint, params[1]]);
      return intercept?.(endpoint, method, params);
    };
    return reads;
  }

  it('reads the nonce at an attested height, so a node that serves no state at the tag still proves it (R85)', async () => {
    const t = setup();
    await submit(t, 0);
    t.node.mine(5);
    // bnbchain's public nodes answer state reads at the `finalized` and `safe` tags so,
    // while serving the same state by number.
    const reads = nonceReads(t, (_endpoint, method, params) =>
      method === 'eth_getTransactionCount' &&
      (params[1] === 'finalized' || params[1] === 'safe')
        ? { error: { code: -32000, message: 'missing trie node' } }
        : undefined,
    );
    t.calls.length = 0;
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
    // One endpoint's finalized block proposes (3), trailed by PEER_SKEW (1); the quorum
    // attests it, then reads the nonce there.
    expect(t.calls.map((c) => [c.method, c.tags.purpose, c.tags.quorum])).toEqual([
      ['getBlock', 'monitor', undefined],
      ['getBlock', 'proof', 'proof'],
      ['getTransactionCount', 'proof', 'proof'],
    ]);
    expect(await t.run(t.proofs.slotConsumed(nonce(1n), KEY_ADDRESS, 'finalized'))).toBe(
      false,
    );
    expect(reads).toEqual([
      ['a', '0x1'],
      ['b', '0x1'],
      ['a', '0x1'],
      ['b', '0x1'],
    ]);
  });

  it('decides nothing when a quorum endpoint does not hold the finalized state (R85)', async () => {
    const t = setup();
    await submit(t, 0);
    t.node.mine(5);
    const texts = [
      'missing trie node',
      'missing trie node 6b3f0e (path ) <nil>',
      'historical state 78a623931a1572accf29e587178165d2707eb480e210fb468756699abbe3edf4 is not available',
      'header not found',
      'world state not available',
      'state is not available',
      'state at block #1 is pruned',
    ];
    for (const failing of ['a', 'b']) {
      for (const message of texts) {
        t.node.intercept = (endpoint, method, params) =>
          endpoint === failing &&
          method === 'eth_getTransactionCount' &&
          params[1] !== 'latest'
            ? { error: { code: -32000, message } }
            : undefined;
        await expect(
          t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized')),
        ).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
          message: 'finalized state not available',
        });
      }
    }
    // Any other answer is the node's own definitive error, passed on unchanged.
    t.node.intercept = (_endpoint, method) =>
      method === 'eth_getTransactionCount'
        ? { error: { code: -32602, message: 'invalid argument 1: hex number > 64 bits' } }
        : undefined;
    await expect(
      t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized')),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: false });
  });

  it('never lets one endpoint over-reporting its finalized height advance the nonce read (R85)', async () => {
    const t = setup();
    t.node.finalizedDepth = 6;
    await submit(t, 0);
    t.node.mine(5);
    expect(t.node.finalized).toBe(0n);
    for (const liar of ['a', 'b']) {
      // The liar reports its head (block 5) as final: 3 blocks past PEER_SKEW's reach.
      finalityLag(t, liar, -5n);
      const reads = nonceReads(t);
      const consumed = t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'));
      if (liar === 'a') {
        // It proposes: its honest peer refuses to attest the height (3), so no nonce is read.
        await expect(consumed).rejects.toMatchObject(inconsistent);
        expect(reads).toEqual([]);
      } else {
        // The honest proposal (0) stands, where the slot is not consumed: nothing is proven.
        expect(await consumed).toBe(false);
        expect(reads).toEqual([
          ['a', '0x0'],
          ['b', '0x0'],
        ]);
      }
    }
  });

  it('reads the nonce at one attested height while the head moves, never a false negative (R85)', async () => {
    const t = setup();
    t.node.mine(2);
    const hash = await submit(t, 0);
    t.node.mine(2);
    expect([t.node.receipt(hash)?.blockNumber, t.node.finalized]).toEqual([3n, 2n]);
    // A block lands between the two endpoints' nonce reads of every proof.
    const reads = nonceReads(t, (endpoint, method) => {
      if (endpoint === 'b' && method === 'eth_getTransactionCount') t.node.mine();
      return undefined;
    });
    // The slot is consumed in block 3, which turns final on the node mid-proof: at the
    // attested height (the finalized block 2, less PEER_SKEW) it is not, so nothing is
    // proven, and the endpoints agree whatever their views.
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      false,
    );
    t.node.mine(2);
    // Once the attested height reaches block 3, the moving head cannot hide the consumption.
    expect(await t.run(t.proofs.slotConsumed(nonce(0n), KEY_ADDRESS, 'finalized'))).toBe(
      true,
    );
    expect(reads).toEqual([
      ['a', '0x0'],
      ['b', '0x0'],
      ['a', '0x3'],
      ['b', '0x3'],
    ]);
  });
});

describe.each(LIBRARIES)('EVM block source (%s)', (library) => {
  it('scans native and ERC-20 transfers, filtered by address', async () => {
    const h = evmHarness(library);
    const blocks = createEvmBlocks(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    h.node.mintToken(TOKEN, KEY_ADDRESS, 100n);
    const native = await submit(h, 0);
    const token = await submit(h, 1, {
      to: TOKEN,
      value: 0n,
      gasLimit: 60_000n,
      data: h.client.abi.encodeTransfer(OTHER, 7n),
    });
    h.node.mine();
    h.calls.length = 0;
    const header = await h.run(blocks.header(1n));
    expect(header).toMatchObject({
      height: 1n,
      hash: h.node.block(1n)?.hash,
      parentHash: h.node.block(0n)?.hash,
      transactionIds: [native, token],
    });
    expect(await h.run(blocks.header(2n))).toBeNull();
    const all = await h.run(blocks.transactions(header!));
    expect(
      all.map((tx) => [tx.id, tx.decoding, tx.transfers.map((t) => t.locator)]),
    ).toEqual([
      [native, 'complete', ['native']],
      [token, 'partial', ['log:0']],
    ]);
    expect(
      (
        await h.run(
          blocks.transactions(header!, {
            addresses: [OTHER.toUpperCase().replace('0X', '0x')],
          }),
        )
      ).map((tx) => tx.id),
    ).toEqual([token]);
    expect(
      (await h.run(blocks.transactions(header!, { addresses: [RECIPIENT] }))).map(
        (tx) => tx.id,
      ),
    ).toEqual([native]);
    expect(
      await h.run(
        blocks.transactions(header!, {
          addresses: ['0x00000000000000000000000000000000000000bb'],
        }),
      ),
    ).toEqual([]);
    expect(h.calls.every((c) => c.tags.purpose === 'monitor')).toBe(true);
  });

  it('refuses a block that changed under the scanner, retryably', async () => {
    const h = evmHarness(library);
    const blocks = createEvmBlocks(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    await submit(h, 0);
    h.node.mine();
    const header = await h.run(blocks.header(1n));
    h.node.reorg(1);
    h.node.mine();
    await expect(h.run(blocks.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it("scans a plain Polygon transfer as complete despite bor's system logs (R69, R70)", async () => {
    const h = evmHarness(library, 'polygon', 'amoy');
    const blocks = createEvmBlocks(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const hash = await submit(h, 0);
    h.node.mine();
    const blockHash = h.node.block(1n)?.hash as string;
    const systemLog = (topic: string, index: number) => ({
      address: POLYGON_EMITTER,
      topics: [topic, word(POLYGON_EMITTER), word(KEY_ADDRESS), word(RECIPIENT)],
      data: `0x${'00'.repeat(160)}`,
      logIndex: hex(index),
      blockHash,
      blockNumber: '0x1',
      transactionHash: hash,
      removed: false,
    });
    h.node.intercept = (_endpoint, method, params) =>
      method === 'eth_getTransactionReceipt'
        ? {
            result: {
              ...(h.node.answer(method, params) as object),
              logs: [systemLog(LOG_TRANSFER, 0), systemLog(LOG_FEE_TRANSFER, 1)],
            },
          }
        : undefined;
    const header = await h.run(blocks.header(1n));
    expect(await h.run(blocks.transactions(header!))).toMatchObject([
      {
        id: hash,
        decoding: 'complete',
        transfers: [{ locator: 'native', to: RECIPIENT, amount: 1_000n }],
      },
    ]);
  });

  it('scans a token call as the chain reports it; only verdicts apply R50 (R68)', async () => {
    const h = evmHarness(library);
    const blocks = createEvmBlocks(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'FLS', decimals: 6, returnsFalse: true });
    h.node.mintToken(TOKEN, KEY_ADDRESS, 5n);
    const data = h.client.abi.encodeTransfer(RECIPIENT, 10n);
    const hash = await submit(h, 0, { to: TOKEN, value: 0n, gasLimit: 60_000n, data });
    h.node.mine();
    const header = await h.run(blocks.header(1n));
    expect(await h.run(blocks.transactions(header!))).toMatchObject([
      {
        id: hash,
        observation: { seen: 'block', success: true },
        transfers: [],
        decoding: 'partial',
      },
    ]);
  });

  it('keeps contract creations in a filtered scan: only the receipt names the recipient (R78)', async () => {
    const h = evmHarness(library);
    const blocks = createEvmBlocks(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const hash = await submit(h, 0);
    h.node.mine();
    // The scripted node cannot deploy code: serve its transaction as a creation of CREATED.
    const created = h.client.checksum('0x00000000000000000000000000000000000c0de1');
    h.node.intercept = (_endpoint, method, params) => {
      const real = h.node.answer(method, params) as Record<string, unknown> | null;
      if (real === null) return undefined;
      if (method === 'eth_getBlockByNumber' && params[1] === true) {
        const txs = real.transactions as Record<string, unknown>[];
        return {
          result: { ...real, transactions: txs.map((tx) => ({ ...tx, to: null })) },
        };
      }
      if (method === 'eth_getTransactionReceipt') {
        return { result: { ...real, to: null, contractAddress: created.toLowerCase() } };
      }
      return undefined;
    };
    const header = await h.run(blocks.header(1n));
    expect(
      await h.run(blocks.transactions(header!, { addresses: [created] })),
    ).toMatchObject([
      {
        id: hash,
        transfers: [
          { locator: 'native', from: [KEY_ADDRESS], to: created, amount: 1_000n },
        ],
      },
    ]);
  });
});
