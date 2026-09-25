import { secp256k1 } from '@noble/curves/secp256k1';
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { decodeTransaction } from '../../../src/adapters/evm/decode';
import {
  FEE_HISTORY_BLOCKS,
  FEE_PERCENTILES,
  feesFromHistory,
} from '../../../src/adapters/evm/fees';
import {
  evmNetworkConfig,
  type EvmNetworkConfig,
} from '../../../src/adapters/evm/network';
import {
  MONITOR as MONITOR_TAGS,
  PROOF,
  READ as READ_TAGS,
  createEvmAddressCodec,
  createEvmExt,
  createEvmReader,
  createEvmSequence,
  provenFinal,
  withSignal,
} from '../../../src/adapters/evm/reader';
import type { EvmReceipt, EvmTx } from '../../../src/adapters/evm/types';
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
const PROOF_TAGS = { purpose: 'proof', retry: 'safe', quorum: 'proof' };
/** Selector-sharing call target: an address the scripted node runs as a plain call. */
const OTHER = '0x0000000000000000000000000000000000005151';
/** Polygon PoS system logs (bor core/bor_fee_log.go), emitted from the MRC20 predeploy. */
const POLYGON_FEE_EMITTER = '0x0000000000000000000000000000000000001010';
const LOG_FEE_TRANSFER =
  '0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63';
const LOG_TRANSFER = '0xe6497e3ee548a3372136af2fcb0696db31fc6cf20260707645068bd3fe97f3c4';
const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

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

  it('requires a whole number of at least one confirmation (R67)', () => {
    const avalanche = chain('avalanche');
    const fuji = avalanche.networks.fuji as NetworkInfo;
    const confirmations = (value: unknown) =>
      evmNetworkConfig(avalanche, {
        ...fuji,
        finality: { kind: 'confirmations', confirmations: value },
      } as NetworkInfo);
    expect(confirmations(1).finality).toEqual({
      kind: 'confirmations',
      confirmations: 1,
    });
    expect(confirmations(12).finality).toEqual({
      kind: 'confirmations',
      confirmations: 12,
    });
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => confirmations(value)).toThrow(invalid(/confirmations/));
    }
  });

  it("marks Polygon PoS networks, whose receipts carry bor's system logs (R69, R70)", () => {
    for (const chain of EVM_CHAINS)
      for (const network of Object.values(chain.networks))
        expect(evmNetworkConfig(chain, network).polygonSystemLogs).toBe(
          chain.id === 'polygon',
        );
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

  it("classifies the token's VM execution failures as permanent, other RPC errors as retryable (R66)", async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    const failing = async (message: string) => {
      h.node.intercept = (_e, method) =>
        method === 'eth_call' ? { error: { code: -32000, message } } : undefined;
      return h.run(reader.getTokenMetadata!({ standard: 'erc20', contract: TOKEN })).then(
        () => undefined,
        (error: unknown) => error,
      );
    };
    for (const message of ['invalid opcode: INVALID', 'out of gas']) {
      expect(await failing(message)).toMatchObject({
        code: 'ASSET_RESOLUTION',
        retryable: false,
      });
    }
    for (const message of ['execution aborted (timeout = 5s)', 'header not found']) {
      expect(await failing(message)).toMatchObject({
        code: 'RPC_ERROR',
        retryable: true,
      });
    }
  });

  it('keeps unreadable token data permanent and leaves other provider failures as they are (R53, R66)', async () => {
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
    // A misconfigured endpoint stays final (transport I10), and is never the token's fault.
    h.node.intercept = undefined;
    h.node.fetch.route('https://main.evm.test/rpc', () => ({ status: 401, text: 'no' }));
    await expect(metadata()).rejects.toMatchObject({
      code: 'PROVIDER_MISCONFIGURED',
      retryable: false,
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

  it('proves a confirmation height under the quorum before trusting it (R67, R74)', async () => {
    const h = evmHarness(library, 'avalanche', 'fuji', { endpoints: ['a', 'b'] });
    h.node.mine(4);
    // R74: the quorum confirms the block 2 below one endpoint's head, which a peer a block
    // or two behind still holds; with one confirmation, that block is the final one.
    expect(await h.run(provenFinal(h.ctx, PROOF))).toEqual({
      height: 2n,
      block: expect.objectContaining({ number: 2n, hash: h.node.block(2n)?.hash }),
    });
    expect(h.calls.map((c) => [c.method, c.tags])).toEqual([
      ['blockNumber', MONITOR],
      ['getBlock', PROOF_TAGS],
    ]);
    // Endpoint 'a' over-reports its head, with or without a block to show for it.
    const fake = {
      number: '0x62',
      hash: `0x${'11'.repeat(32)}`,
      parentHash: `0x${'22'.repeat(32)}`,
      timestamp: '0x1',
      transactions: [],
    };
    for (const block of [fake, null]) {
      h.node.served.length = 0;
      h.node.intercept = (endpoint, method, params) => {
        if (endpoint !== 'a') return undefined;
        if (method === 'eth_blockNumber') return { result: '0x64' };
        if (method === 'eth_getBlockByNumber' && params[0] === '0x62')
          return { result: block };
        return undefined;
      };
      await expect(h.run(provenFinal(h.ctx, PROOF))).rejects.toMatchObject({
        code: 'PROVIDER_INCONSISTENT',
        retryable: true,
      });
      expect(h.node.served[0]).toEqual({ endpoint: 'a', method: 'eth_blockNumber' });
    }
    // The head read carries the proof's signal.
    h.node.intercept = undefined;
    h.node.served.length = 0;
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      h.run(provenFinal(h.ctx, withSignal(PROOF, aborted.signal))),
    ).rejects.toBeDefined();
    expect(h.node.served).toEqual([]);
  });

  it('reads blocks by height and hash with read tags', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const hash = await submit(h, 0);
    h.node.mine();
    const mined = h.node.block(1n);
    const expected = {
      height: 1n,
      hash: mined?.hash,
      parentHash: h.node.block(0n)?.hash,
      timestamp: mined?.timestamp,
      transactionIds: [hash],
    };
    expect(await h.run(reader.getBlock(1n))).toEqual(expected);
    expect(await h.run(reader.getBlock(mined?.hash as string))).toEqual(expected);
    expect(await h.run(reader.getBlock(9n))).toBeNull();
    expect(h.calls.filter((c) => c.method === 'getBlock').map((c) => c.tags)).toEqual([
      READ,
      READ,
      READ,
    ]);
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
    h.calls.length = 0;
    await h.run(reader.getTransaction(native));
    expect(h.calls.map((c) => [c.method, c.tags])).toEqual([
      ['getTransaction', READ],
      ['getReceipt', READ],
    ]);
  });

  it('fails a token transfer that logged no Transfer on the verdict path only (R50, R68)', async () => {
    const h = evmHarness(library);
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    h.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6, returnsFalse: true });
    const transfer = { value: 0n, gasLimit: 60_000n };
    const data = h.client.abi.encodeTransfer(RECIPIENT, 30n);
    const token = await submit(h, 0, { ...transfer, to: TOKEN, data });
    // A third party's contract call that shares the `transfer(address,uint256)` selector.
    const other = await submit(h, 1, { ...transfer, to: OTHER, data });
    h.node.mine();
    const ref = (id: string) => ({ id, idKind: 'tx-hash' as const, canonical: true });
    // Our own Attempt, observed with its ordering: the R50 verdict.
    expect(
      await h.run(reader.observe(ref(token), { kind: 'nonce', nonce: 0n }, KEY_ADDRESS)),
    ).toMatchObject({
      seen: 'block',
      success: false,
      reason: 'token transfer failed',
    });
    // A status lookup by id (no ordering) is the chain's view: a selector-sharing call
    // that logged no Transfer succeeded, as its receipt says.
    for (const hash of [other, token]) {
      const seen = await h.run(reader.observe(ref(hash), undefined, undefined));
      expect(seen).toMatchObject({ seen: 'block', success: true });
      expect(seen).not.toHaveProperty('reason');
    }
    // The general decoder reports what the chain reports: the call succeeded, moving nothing.
    for (const hash of [token, other]) {
      const decoded = await h.run(reader.getTransaction(hash));
      expect(decoded).toMatchObject({
        observation: { seen: 'block', success: true },
        transfers: [],
        decoding: 'partial',
      });
      expect(decoded?.observation).not.toHaveProperty('reason');
    }
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

  it('counts only execution gas: an Arbitrum transfer with L1 gas is complete (D14)', () => {
    const { abi } = evmHarness(library, 'arbitrum', 'sepolia').client;
    const hash = `0x${'cd'.repeat(32)}`;
    const blockHash = `0x${'ef'.repeat(32)}`;
    const tx: EvmTx = {
      hash,
      from: KEY_ADDRESS,
      to: RECIPIENT,
      nonce: 0n,
      value: 1_000n,
      input: '0x',
      type: 2,
      gasLimit: 30_000n,
      blockHash,
      blockNumber: 1n,
    };
    const receipt = (extra: Partial<EvmReceipt>): EvmReceipt => ({
      transactionHash: hash,
      blockHash,
      blockNumber: 1n,
      status: 1,
      from: KEY_ADDRESS,
      to: RECIPIENT,
      contractAddress: null,
      gasUsed: 21_000n,
      effectiveGasPrice: 10n,
      logs: [],
      ...extra,
    });
    const l1 = 4_321n;
    expect(
      decodeTransaction(abi, tx, receipt({ gasUsed: 21_000n + l1, gasUsedForL1: l1 })),
    ).toMatchObject({
      observation: { success: true },
      fee: [{ asset: 'native', amount: (21_000n + l1) * 10n }],
      decoding: 'complete',
    });
    // Without the L1 part, the same gas means code ran.
    expect(decodeTransaction(abi, tx, receipt({ gasUsed: 21_000n + l1 })).decoding).toBe(
      'partial',
    );
  });

  it("ignores exactly bor's system logs on a plain Polygon transfer (R69, R70)", async () => {
    const h = evmHarness(library, 'polygon', 'amoy');
    const reader = createEvmReader(h.ctx);
    h.node.fund(KEY_ADDRESS, 10n ** 18n);
    const hash = await submit(h, 0);
    h.node.mine();
    const blockHash = h.node.block(1n)?.hash as string;
    const log = (emitter: string, topic: string, index = 0) => ({
      address: emitter,
      topics: [topic, word(POLYGON_FEE_EMITTER), word(KEY_ADDRESS), word(RECIPIENT)],
      data: `0x${'00'.repeat(160)}`,
      logIndex: `0x${index.toString(16)}`,
      blockHash,
      blockNumber: '0x1',
      transactionHash: hash,
      removed: false,
    });
    const decodedWith = async (logs: readonly object[]) => {
      h.node.intercept = (_e, method) =>
        method === 'eth_getTransactionReceipt'
          ? {
              result: {
                transactionHash: hash,
                blockHash,
                blockNumber: '0x1',
                status: '0x1',
                from: KEY_ADDRESS,
                to: RECIPIENT,
                contractAddress: null,
                gasUsed: '0x5208',
                effectiveGasPrice: '0x77359400',
                logs,
              },
            }
          : undefined;
      return h.run(reader.getTransaction(hash));
    };
    const decodingWith = async (logs: readonly object[]) =>
      (await decodedWith(logs))?.decoding;
    const transferLog = log(POLYGON_FEE_EMITTER, LOG_TRANSFER, 0);
    const feeLog = log(POLYGON_FEE_EMITTER, LOG_FEE_TRANSFER, 1);
    expect(await decodingWith([])).toBe('complete');
    expect(await decodingWith([feeLog])).toBe('complete');
    // The same topics from any other emitter still mean code ran.
    expect(await decodingWith([log(OTHER, LOG_FEE_TRANSFER)])).toBe('partial');
    expect(await decodingWith([log(OTHER, LOG_TRANSFER), feeLog])).toBe('partial');
    // A plain POL transfer carries both system logs; its value is `tx.value`, and
    // bor's LogTransfer is never a token movement.
    const plain = await decodedWith([transferLog, feeLog]);
    expect(plain?.decoding).toBe('complete');
    expect(plain?.transfers).toEqual([
      {
        locator: 'native',
        from: [KEY_ADDRESS],
        to: RECIPIENT,
        asset: 'native',
        amount: 1_000n,
        source: 'native',
      },
    ]);
    // Only on Polygon, and only with no calldata and exactly 21,000 execution gas.
    const tx = (await h.run(h.client.getTransaction(hash, READ_TAGS))) as EvmTx;
    const receipt = (await h.run(h.client.getReceipt(hash, READ_TAGS))) as EvmReceipt;
    expect(receipt.logs).toHaveLength(2);
    const ethereum = EVM_CHAINS[0] as ChainInfo;
    const decoding = (
      t: EvmTx,
      r: EvmReceipt,
      network?: Pick<EvmNetworkConfig, 'polygonSystemLogs'>,
    ) => decodeTransaction(h.client.abi, t, r, undefined, network).decoding;
    expect(decoding(tx, receipt, h.ctx.config)).toBe('complete');
    expect(decoding(tx, receipt)).toBe('partial');
    expect(
      decoding(
        tx,
        receipt,
        evmNetworkConfig(ethereum, ethereum.networks.sepolia as NetworkInfo),
      ),
    ).toBe('partial');
    expect(decoding({ ...tx, input: '0x1234' }, receipt, h.ctx.config)).toBe('partial');
    expect(decoding(tx, { ...receipt, gasUsed: 21_001n }, h.ctx.config)).toBe('partial');
  });
});
