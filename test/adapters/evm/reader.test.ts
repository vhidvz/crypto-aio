import { secp256k1 } from '@noble/curves/secp256k1';
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import {
  FEE_HISTORY_BLOCKS,
  FEE_PERCENTILES,
  feesFromHistory,
} from '../../../src/adapters/evm/fees';
import { evmNetworkConfig } from '../../../src/adapters/evm/network';
import {
  MONITOR as MONITOR_TAGS,
  PROOF,
  READ as READ_TAGS,
  createEvmAddressCodec,
  createEvmExt,
  createEvmReader,
  createEvmSequence,
  withSignal,
} from '../../../src/adapters/evm/reader';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { LIBRARIES } from './support/harness';
import { evmHarness, submit } from './support/context';
import { REVERTER } from './support/node';
import { KEY, KEY_ADDRESS, KEY_PUBLIC, RECIPIENT, VECTORS } from './support/vectors';

const TOKEN = '0x00000000000000000000000000000000000070Ce';
const JUNK = '0x0000000000000000000000000000000000000Bad';
const MONITOR = { purpose: 'monitor', retry: 'safe' };
const READ = { purpose: 'read', retry: 'safe' };
const GWEI = 1_000_000_000n;

describe('EVM network config', () => {
  const ethereum = EVM_CHAINS[0] as ChainInfo;
  const sepolia = ethereum.networks.sepolia as NetworkInfo;
  const chain = (id: string) => EVM_CHAINS.find((c) => c.id === id) as ChainInfo;
  const invalid = (message: RegExp) =>
    expect.objectContaining({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(message),
    });

  it('reads every built-in network', () => {
    for (const chain of EVM_CHAINS)
      for (const network of Object.values(chain.networks))
        expect(() => evmNetworkConfig(chain, network)).not.toThrow();
    expect(evmNetworkConfig(ethereum, sepolia)).toMatchObject({
      chainId: 11155111n,
      feeModel: 'evm-1559',
      finality: { kind: 'tag' },
      minBumpPercent: 10,
      minPriorityFeePerGas: 0n,
      l1DataFee: false,
    });
    const arbitrum = EVM_CHAINS.find((c) => c.id === 'arbitrum') as ChainInfo;
    expect(
      evmNetworkConfig(arbitrum, arbitrum.networks.mainnet as NetworkInfo).minBumpPercent,
    ).toBeUndefined();
  });

  it('takes the chain id from the registry identity, and the minimum tip from params (R61)', () => {
    for (const chain of EVM_CHAINS)
      for (const network of Object.values(chain.networks))
        expect(evmNetworkConfig(chain, network).chainId).toBe(
          BigInt(network.identity as string),
        );
    const polygon = chain('polygon');
    const tip = (network: string) =>
      evmNetworkConfig(polygon, polygon.networks[network] as NetworkInfo)
        .minPriorityFeePerGas;
    expect(tip('mainnet')).toBe(25n * GWEI);
    expect(tip('amoy')).toBe(0n);
  });

  it.each([
    [{ identity: undefined }, /decimal chain id/],
    [{ identity: '0x1' }, /decimal chain id/],
    [{ feeModel: 'utxo' }, /fee model/],
    [{ finality: { kind: 'solidified' } }, /not an EVM policy/],
    [{ finality: { kind: 'confirmations', confirmations: 3 } }, /finality-tag/],
    [{ feeModel: 'evm-legacy' }, /fee-market-1559/],
    [{ params: { minPriorityFeePerGas: 25 } }, /bigint/],
  ])('refuses inconsistent custom network data: %j', (patch, message) => {
    expect(() =>
      evmNetworkConfig(ethereum, { ...sepolia, ...patch } as NetworkInfo),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringMatching(message),
      }),
    );
  });

  it('accepts a non-negative integer price bump and refuses any other (M3)', () => {
    const bump = (minBumpPercent: unknown, id = 'ethereum', network = 'sepolia') =>
      evmNetworkConfig(chain(id), {
        ...chain(id).networks[network],
        replacement: { minBumpPercent },
      } as NetworkInfo);
    expect(bump(0).minBumpPercent).toBe(0);
    expect(bump(25).minBumpPercent).toBe(25);
    for (const value of [12.5, -1, '10', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => bump(value)).toThrow(invalid(/minBumpPercent/));
    }
    // Present means checked, also on a network without replace or cancel.
    expect(() => bump(1.5, 'arbitrum', 'mainnet')).toThrow(invalid(/minBumpPercent/));
  });
});

describe('EVM call tags', () => {
  it('tags reads, monitor reads and quorum proof reads (R41, R59)', () => {
    expect(READ_TAGS).toEqual(READ);
    expect(MONITOR_TAGS).toEqual(MONITOR);
    expect(PROOF).toEqual({ purpose: 'proof', retry: 'safe', quorum: 'proof' });
    const signal = new AbortController().signal;
    expect(withSignal(PROOF, signal)).toEqual({ ...PROOF, signal });
    expect(withSignal(READ_TAGS)).toBe(READ_TAGS);
  });
});

describe.each(LIBRARIES)('EVM reader (%s)', (library) => {
  it('validates and checksums addresses, and derives them from public keys', () => {
    const codec = createEvmAddressCodec(evmHarness(library).client);
    expect(codec.normalize(KEY_ADDRESS.toLowerCase())).toEqual({
      canonical: KEY_ADDRESS,
      display: KEY_ADDRESS,
    });
    expect(codec.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    expect(codec.validate('0x123')).toBe(false);
    expect(() => codec.normalize('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
    expect(() => codec.fromPublicKey(new Uint8Array(33))).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
  });

  it("derives through the client's strict public-key decode, unwrapped (R58)", () => {
    const codec = createEvmAddressCodec(evmHarness(library).client);
    expect(codec.fromPublicKey(secp256k1.getPublicKey(KEY, false)).canonical).toBe(
      KEY_ADDRESS,
    );
    // A 32-byte private key and a 64-byte raw key must never yield an address.
    const raw = secp256k1.getPublicKey(KEY, false).slice(1);
    for (const key of [Uint8Array.from(Buffer.from(KEY, 'hex')), raw]) {
      expect(() => codec.fromPublicKey(key)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'public key must be a 33- or 65-byte secp256k1 point',
        }),
      );
    }
  });

  it('reads native and ERC-20 balances and token metadata', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 5n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    h.node.mintToken(TOKEN, KEY_ADDRESS, 42n);
    expect(await h.run(reader.getBalance(KEY_ADDRESS, 'native'))).toBe(5n);
    expect(
      await h.run(reader.getBalance(KEY_ADDRESS, { standard: 'erc20', contract: TOKEN })),
    ).toBe(42n);
    expect(
      await h.run(reader.getTokenMetadata!({ standard: 'erc20', contract: TOKEN })),
    ).toEqual({ symbol: 'TKN', decimals: 6 });
    expect(
      reader.normalizeTokenRef!({ standard: 'erc20', contract: TOKEN.toLowerCase() }),
    ).toEqual({ standard: 'erc20', contract: TOKEN });
    expect(() =>
      reader.normalizeTokenRef!({ standard: 'trc20', contract: TOKEN }),
    ).toThrow(expect.objectContaining({ code: 'ASSET_RESOLUTION' }));
    expect(h.calls.every((c) => c.tags.purpose === 'read')).toBe(true);
  });

  it('classifies token metadata failures: permanent for the token, retryable for the node (N6)', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.deployToken(JUNK, { symbol: 'JUNK' });
    for (const contract of [JUNK, REVERTER, RECIPIENT]) {
      await expect(
        h.run(reader.getTokenMetadata!({ standard: 'erc20', contract })),
      ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION', retryable: false });
    }
    h.node.intercept = (_e, method) =>
      method === 'eth_call'
        ? { error: { code: -32000, message: 'header not found' } }
        : undefined;
    await expect(
      h.run(reader.getTokenMetadata!({ standard: 'erc20', contract: TOKEN })),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: true });
  });

  it('keeps unreadable token data permanent and every other provider failure retryable (R53)', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    const metadata = () =>
      h.run(reader.getTokenMetadata!({ standard: 'erc20', contract: TOKEN }));
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    const symbolCall = h.client.abi.encodeSymbol();
    const answer = (decimals: unknown, symbol: unknown) => {
      h.node.intercept = (_e, method, params) => {
        if (method !== 'eth_call') return undefined;
        const { data } = params[0] as { data: string };
        const result = data.startsWith(symbolCall) ? symbol : decimals;
        return result === undefined ? undefined : { result };
      };
    };
    answer('0x1234', undefined);
    await expect(metadata()).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
    });
    answer(`0x${'0'.repeat(61)}100`, undefined);
    await expect(metadata()).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      message: 'the token decimals are out of range',
    });
    answer(undefined, '0x12');
    await expect(metadata()).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
    });
    // A malformed JSON-RPC answer is the node's fault, not the token's.
    answer(42, undefined);
    await expect(metadata()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    // So is a misconfigured endpoint, whose error the transport marks non-retryable.
    h.node.intercept = undefined;
    h.node.fetch.route('https://main.evm.test/rpc', () => ({ status: 401, text: 'no' }));
    await expect(metadata()).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
      retryable: true,
    });
  });

  it('reads heights with monitor tags: the finalized tag, or the head on confirmation networks', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.mine(5);
    expect(await h.run(reader.getBlockHeight())).toBe(5n);
    expect(await h.run(reader.getFinalizedHeight())).toBe(3n);
    expect(h.calls.map((c) => [c.method, c.tags])).toEqual([
      ['blockNumber', MONITOR],
      ['getBlock', MONITOR],
    ]);
    const avalanche = evmHarness(library, 'avalanche', 'fuji');
    avalanche.node.mine(4);
    expect(await avalanche.run(createEvmReader(avalanche.ctx).getFinalizedHeight())).toBe(
      4n,
    );
    h.node.intercept = (_e, method, params) =>
      method === 'eth_getBlockByNumber' && params[0] === 'finalized'
        ? { result: null }
        : undefined;
    await expect(h.run(reader.getFinalizedHeight())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('decodes native, token, reverted and pending transactions', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    h.node.mintToken(TOKEN, KEY_ADDRESS, 100n);
    const native = await submit(h, 0);
    expect(await h.run(reader.getTransaction(native))).toMatchObject({
      observation: { seen: 'mempool' },
      decoding: 'partial',
    });
    const token = await submit(h, 1, {
      to: TOKEN,
      value: 0n,
      gasLimit: 60_000n,
      data: h.client.abi.encodeTransfer(RECIPIENT, 30n),
    });
    const reverted = await submit(h, 2, { to: REVERTER, gasLimit: 60_000n });
    h.node.mine();
    const block = h.node.block(1n)?.hash;
    expect(await h.run(reader.getTransaction(native))).toEqual({
      id: native,
      observation: {
        seen: 'block',
        txHash: native,
        blockHeight: 1n,
        blockHash: block,
        success: true,
      },
      fee: [{ asset: 'native', amount: 21_000n * 2_000_000_000n }],
      transfers: [
        {
          locator: 'native',
          from: [KEY_ADDRESS],
          to: RECIPIENT,
          asset: 'native',
          amount: 1_000n,
          source: 'native',
        },
      ],
      decoding: 'complete',
      details: {
        nonce: 0n,
        type: 2,
        gasLimit: 21_000n,
        gasUsed: 21_000n,
        effectiveGasPrice: 2_000_000_000n,
        status: 1,
      },
    });
    expect(await h.run(reader.getTransaction(token))).toMatchObject({
      observation: { seen: 'block', success: true },
      transfers: [
        {
          locator: 'log:0',
          from: [KEY_ADDRESS],
          to: RECIPIENT,
          asset: { standard: 'erc20', contract: TOKEN },
          amount: 30n,
          source: 'token-event',
        },
      ],
      decoding: 'partial',
    });
    expect(await h.run(reader.getTransaction(reverted))).toMatchObject({
      observation: { success: false, reason: 'reverted' },
      transfers: [],
      decoding: 'complete',
    });
    expect(await h.run(reader.getTransaction(`0x${'ab'.repeat(32)}`))).toBeNull();
  });

  it('reports a token transfer that logged no Transfer as failed (R50)', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6, returnsFalse: true });
    const hash = await submit(h, 0, {
      to: TOKEN,
      value: 0n,
      gasLimit: 60_000n,
      data: h.client.abi.encodeTransfer(RECIPIENT, 30n),
    });
    h.node.mine();
    const failed = { seen: 'block', success: false, reason: 'token transfer failed' };
    expect(await h.run(reader.getTransaction(hash))).toMatchObject({
      observation: failed,
      transfers: [],
      decoding: 'partial',
    });
    const ref = { id: hash, idKind: 'tx-hash' as const, canonical: true };
    expect(await h.run(reader.observe(ref, undefined, undefined))).toMatchObject(failed);
  });

  it('adds the OP Stack L1 data fee to the paid fee', async () => {
    const h = evmHarness(library, 'optimism', 'sepolia', { node: { l1Fee: 1_234n } });
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const hash = await submit(h, 0);
    h.node.mine();
    expect((await h.run(createEvmReader(h.ctx).getTransaction(hash)))?.fee).toEqual([
      { asset: 'native', amount: 21_000n * 2_000_000_000n + 1_234n },
    ]);
  });

  it('observes an Attempt with monitor reads, from its ref alone (R32)', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const ref = (id: string) => ({ id, idKind: 'tx-hash' as const, canonical: true });
    expect(
      await h.run(reader.observe(ref(`0x${'ab'.repeat(32)}`), undefined, undefined)),
    ).toEqual({ seen: 'none' });
    const hash = await submit(h, 0);
    h.calls.length = 0;
    expect(await h.run(reader.observe(ref(hash), undefined, undefined))).toEqual({
      seen: 'mempool',
      txHash: hash,
    });
    h.node.mine();
    expect(
      await h.run(reader.observe(ref(hash), { kind: 'nonce', nonce: 0n }, KEY_ADDRESS)),
    ).toMatchObject({ seen: 'block', blockHeight: 1n, success: true });
    expect(h.calls.every((c) => c.tags.purpose === 'monitor')).toBe(true);
  });

  it('reads nonces for the sequence and ext.evm.getNonce', async () => {
    const h = evmHarness(library);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    await submit(h, 0);
    h.calls.length = 0;
    const sequence = createEvmSequence(h.client);
    expect(await h.run(sequence.pending(KEY_ADDRESS))).toBe(1n);
    expect(await h.run(sequence.latest(KEY_ADDRESS))).toBe(0n);
    const ext = createEvmExt(h.client);
    expect(await h.run(ext.evm.getNonce(KEY_ADDRESS.toLowerCase(), 'pending'))).toBe(1n);
    await expect(h.run(ext.evm.getNonce('nope'))).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    });
    await expect(
      h.run(ext.evm.getNonce(KEY_ADDRESS, 'finalized' as 'latest')),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    expect(h.calls.slice(0, 2).map((c) => c.tags)).toEqual([MONITOR, MONITOR]);
    expect(h.calls[2]?.tags).toEqual(READ);
  });

  it("builds every transaction from the network config's chain id (R61)", async () => {
    const h = evmHarness(library, 'bsc', 'testnet');
    const vector = VECTORS[1] as (typeof VECTORS)[number];
    const fields = { ...vector.fields, chainId: h.ctx.config.chainId };
    expect(h.client.serializeUnsigned(fields)).toBe(vector.unsigned);
    expect(() => h.client.serializeUnsigned({ ...fields, chainId: 56n })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    expect(await submit(h, 0)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('floors the tip at the network minimum and refuses a fee history without rewards', async () => {
    const h = evmHarness(library, 'polygon', 'mainnet');
    const fast = async () =>
      feesFromHistory(
        await h.run(
          h.client.feeHistory(FEE_HISTORY_BLOCKS, 'latest', FEE_PERCENTILES, READ_TAGS),
        ),
        'fast',
        h.ctx.config.minPriorityFeePerGas,
      );
    expect((await fast()).params).toMatchObject({ maxPriorityFeePerGas: 25n * GWEI });
    for (const reward of [undefined, []]) {
      h.node.intercept = (_e, method) =>
        method === 'eth_feeHistory'
          ? {
              result: {
                oldestBlock: '0x0',
                baseFeePerGas: ['0x1', '0x1'],
                gasUsedRatio: [0.5],
                ...(reward ? { reward } : {}),
              },
            }
          : undefined;
      await expect(fast()).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        message: 'malformed fee history',
      });
    }
  });
});
