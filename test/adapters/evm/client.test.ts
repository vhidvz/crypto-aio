import { Wallet } from 'ethers';
import { eth } from 'web3';
import { quorumKeyFor } from '../../../src/adapters/evm/rpc';
import { settle } from '../../../src/testing/fake-clock';
import { LIBRARIES, makeClient, nodeTransport } from './support/harness';
import { GAS_PRICE_ORACLE, REVERTER, TRANSFER_TOPIC } from './support/node';
import {
  KEY,
  KEY_ADDRESS,
  KEY_PUBLIC,
  RECIPIENT,
  VECTORS,
  signDigest,
} from './support/vectors';

const READ = { purpose: 'read', retry: 'safe' } as const;
const TOKEN = '0x00000000000000000000000000000000000070ce';

async function sdkSigned(library: string, fields: (typeof VECTORS)[number]['fields']) {
  const common = {
    chainId: fields.chainId,
    nonce: Number(fields.nonce),
    to: fields.to,
    value: fields.value,
    data: fields.data,
    gasLimit: fields.gasLimit,
  };
  const fees =
    fields.type === 'eip1559'
      ? {
          type: 2,
          maxFeePerGas: fields.maxFeePerGas,
          maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
        }
      : { type: 0, gasPrice: fields.gasPrice };
  if (library === 'ethers')
    return new Wallet(`0x${KEY}`).signTransaction({ ...common, ...fees });
  const common1 = eth.accounts.Common.custom(
    { chainId: Number(fields.chainId), networkId: Number(fields.chainId) },
    { hardfork: 'london' },
  );
  const tx =
    fields.type === 'eip1559'
      ? eth.accounts.FeeMarketEIP1559Transaction.fromTxData(
          {
            ...common,
            nonce: fields.nonce,
            maxFeePerGas: fields.maxFeePerGas,
            maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
          },
          { common: common1 },
        )
      : eth.accounts.Transaction.fromTxData(
          { ...common, nonce: fields.nonce, gasPrice: fields.gasPrice },
          { common: common1 },
        );
  return (await eth.accounts.signTransaction(tx, `0x${KEY}`)).rawTransaction;
}

describe.each(LIBRARIES)('EvmClient codec (%s)', (library) => {
  const client = makeClient(library, nodeTransport({ chainId: 1n }).transport, 1n);

  it.each(VECTORS)(
    'matches the frozen vector and the SDK wallet: $name',
    async (vector) => {
      const local = makeClient(
        library,
        nodeTransport({ chainId: vector.fields.chainId }).transport,
        vector.fields.chainId,
      );
      expect(local.serializeUnsigned(vector.fields)).toBe(vector.unsigned);
      expect(local.unsignedHash(vector.fields)).toBe(vector.digest);
      const signed = local.serializeSigned(vector.fields, signDigest(vector.digest));
      expect(signed).toEqual({ raw: vector.raw, hash: vector.hash });
      expect(await sdkSigned(library, vector.fields)).toBe(vector.raw);
    },
  );

  it('validates, checksums and derives addresses strictly', () => {
    expect(client.addressFromPublicKey(KEY_PUBLIC)).toBe(KEY_ADDRESS);
    expect(
      client.addressFromPublicKey(
        new Wallet(`0x${KEY}`).signingKey.publicKey
          .slice(2)
          .match(/../g)!
          .reduce((b, h, i) => ((b[i] = parseInt(h, 16)), b), new Uint8Array(65)),
      ),
    ).toBe(KEY_ADDRESS);
    expect(client.checksum(KEY_ADDRESS.toLowerCase())).toBe(KEY_ADDRESS);
    expect(client.isAddress(KEY_ADDRESS)).toBe(true);
    expect(client.isAddress(KEY_ADDRESS.toLowerCase())).toBe(true);
    expect(client.isAddress(KEY_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(true);
    const badChecksum = KEY_ADDRESS.replace('E', 'e');
    for (const bad of [
      badChecksum,
      KEY_ADDRESS.slice(2),
      `${KEY_ADDRESS}00`,
      'XE7338O0KZ9VFPNB9B0YRVNQZ2VOYW3S6F',
      '',
    ]) {
      expect(client.isAddress(bad)).toBe(false);
    }
    expect(() => client.checksum(badChecksum)).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
  });

  it('does ERC-20 ABI work', () => {
    const { abi } = client;
    expect(abi.transferTopic).toBe(TRANSFER_TOPIC);
    expect(abi.encodeTransfer(RECIPIENT, 1_234_567n)).toBe(
      '0xa9059cbb0000000000000000000000003535353535353535353535353535353535353535000000000000000000000000000000000000000000000000000000000012d687',
    );
    expect(abi.encodeDecimals()).toBe('0x313ce567');
    expect(abi.encodeSymbol()).toBe('0x95d89b41');
    expect(abi.encodeBalanceOf(RECIPIENT)).toBe(
      `0x70a08231${RECIPIENT.slice(2).padStart(64, '0')}`,
    );
    expect(abi.encodeGetL1Fee('0x02c0')).toMatch(/^0x49948e0e/);
    expect(abi.decodeUint256(`0x${'00'.repeat(31)}06`)).toBe(6n);
    expect(() => abi.decodeUint256('0x06')).toThrow();
    const word = (hex: string) => `0x${hex.padStart(64, '0')}`;
    expect(
      abi.decodeTransfer({
        topics: [
          TRANSFER_TOPIC,
          word(KEY_ADDRESS.slice(2).toLowerCase()),
          word(RECIPIENT.slice(2)),
        ],
        data: word('2a'),
      }),
    ).toEqual({ from: KEY_ADDRESS, to: RECIPIENT, amount: 42n });
    expect(
      abi.decodeTransfer({ topics: [TRANSFER_TOPIC, word('01')], data: word('2a') }),
    ).toBeNull();
    // A look-alike event whose "address" topic has high bytes set is not a transfer.
    expect(
      abi.decodeTransfer({
        topics: [TRANSFER_TOPIC, `0x${'ff'.repeat(32)}`, word('02')],
        data: word('2a'),
      }),
    ).toBeNull();
    expect(
      abi.decodeTransfer({
        topics: [`0x${'ab'.repeat(32)}`, word('01'), word('02')],
        data: word('2a'),
      }),
    ).toBeNull();
  });
});

describe.each(LIBRARIES)('EvmClient I/O over the transport (%s)', (library) => {
  function setup(endpoints: readonly string[] = ['main'], l1Fee?: bigint) {
    const t = nodeTransport(
      { chainId: 11155111n, ...(l1Fee !== undefined ? { l1Fee } : {}) },
      endpoints,
    );
    const client = makeClient(library, t.transport, 11155111n);
    const wallet = new Wallet(`0x${KEY}`);
    t.node.fund(wallet.address, 10n ** 18n);
    const sign = (nonce: number, extra: Record<string, unknown> = {}) =>
      wallet.signTransaction({
        type: 2,
        chainId: 11155111n,
        nonce,
        to: RECIPIENT,
        value: 1_000n,
        gasLimit: 21_000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        ...extra,
      });
    return { ...t, client, wallet, sign };
  }

  it('reads blocks, transactions, receipts and logs as plain data', async () => {
    const t = setup(['main'], 7n);
    t.node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    t.node.mintToken(TOKEN, t.wallet.address, 100n);
    const hash = await t.run(
      t.client.sendRawTransaction(await t.sign(0), {
        purpose: 'broadcast',
        retry: 'ambiguous-on-failure',
      }),
    );
    const pending = await t.run(t.client.getTransaction(hash, READ));
    expect(pending).toMatchObject({
      hash,
      from: KEY_ADDRESS,
      to: RECIPIENT,
      nonce: 0n,
      value: 1_000n,
      input: '0x',
      type: 2,
      blockHash: null,
      blockNumber: null,
    });
    expect(await t.run(t.client.getReceipt(hash, READ))).toBeNull();
    const token = await t.run(
      t.client.sendRawTransaction(
        await t.sign(1, {
          to: TOKEN,
          value: 0n,
          gasLimit: 60_000n,
          data: t.client.abi.encodeTransfer(RECIPIENT, 40n),
        }),
        { purpose: 'broadcast' },
      ),
    );
    t.node.mine();
    const block = await t.run(t.client.getBlock(1n, READ));
    expect(block).toMatchObject({
      number: 1n,
      parentHash: t.node.block(0n)?.hash,
      baseFeePerGas: 1_000_000_000n,
      transactions: [hash, token],
    });
    expect(await t.run(t.client.getBlock(block!.hash, READ))).toEqual(block);
    expect(await t.run(t.client.getBlock('finalized', READ))).toMatchObject({
      number: 0n,
    });
    expect(await t.run(t.client.getBlock(9n, READ))).toBeNull();
    const full = await t.run(t.client.getBlockWithTransactions(1n, READ));
    expect(
      full?.transactions.map((tx) => [tx.hash, tx.blockNumber, tx.gasPrice]),
    ).toEqual([
      [hash, 1n, 2_000_000_000n],
      [token, 1n, 2_000_000_000n],
    ]);
    const receipt = await t.run(t.client.getReceipt(token, READ));
    expect(receipt).toMatchObject({
      transactionHash: token,
      blockNumber: 1n,
      status: 1,
      from: KEY_ADDRESS,
      to: '0x00000000000000000000000000000000000070Ce',
      gasUsed: 51_000n,
      effectiveGasPrice: 2_000_000_000n,
      l1Fee: 7n,
    });
    expect(receipt?.logs).toEqual([
      expect.objectContaining({
        address: '0x00000000000000000000000000000000000070Ce',
        logIndex: 0,
        transactionHash: token,
        removed: false,
      }),
    ]);
    expect(
      await t.run(
        t.client.getLogs({ blockHash: block!.hash, topics: [TRANSFER_TOPIC] }, READ),
      ),
    ).toEqual(receipt?.logs);
    expect(await t.run(t.client.getTransaction(`0x${'ab'.repeat(32)}`, READ))).toBeNull();
  });

  it('reads balances, nonces, calls, gas and fee history', async () => {
    const t = setup(['main'], 9n);
    await t.run(t.client.sendRawTransaction(await t.sign(0), { purpose: 'broadcast' }));
    expect(await t.run(t.client.getTransactionCount(KEY_ADDRESS, 'pending', READ))).toBe(
      1n,
    );
    expect(await t.run(t.client.getTransactionCount(KEY_ADDRESS, 'latest', READ))).toBe(
      0n,
    );
    t.node.mine();
    expect(await t.run(t.client.blockNumber(READ))).toBe(1n);
    expect(await t.run(t.client.getBalance(RECIPIENT, 'latest', READ))).toBe(1_000n);
    expect(await t.run(t.client.getBalance(RECIPIENT, 0n, READ))).toBe(0n);
    expect(
      await t.run(
        t.client.estimateGas({ from: KEY_ADDRESS, to: RECIPIENT, value: 1n }, READ),
      ),
    ).toBe(21_000n);
    expect(await t.run(t.client.gasPrice(READ))).toBe(5_000_000_000n);
    expect(
      await t.run(
        t.client.call(
          { to: GAS_PRICE_ORACLE, data: t.client.abi.encodeGetL1Fee('0x02') },
          'latest',
          READ,
        ),
      ),
    ).toBe(`0x${'00'.repeat(31)}09`);
    expect(await t.run(t.client.feeHistory(2, 'latest', [10, 25, 50], READ))).toEqual({
      oldestBlock: 0n,
      baseFeePerGas: [1_000_000_000n, 1_000_000_000n, 1_000_000_000n],
      reward: [
        [1_000_000_000n, 2_000_000_000n, 3_000_000_000n],
        [1_000_000_000n, 2_000_000_000n, 3_000_000_000n],
      ],
      gasUsedRatio: [0.5, 0.5],
    });
  });

  it("carries each call's tags to the transport: quorum, fanout, signal", async () => {
    const t = setup(['a', 'b']);
    await t.run(
      t.client.getBlock('latest', { purpose: 'proof', retry: 'safe', quorum: 'proof' }),
    );
    expect(t.node.served.map((s) => s.endpoint)).toEqual(['a', 'b']);
    t.node.served.length = 0;
    await t.run(
      t.client.sendRawTransaction(await t.sign(0), {
        purpose: 'broadcast',
        retry: 'ambiguous-on-failure',
        fanout: 2,
      }),
    );
    expect(t.node.served.map((s) => s.endpoint).sort()).toEqual(['a', 'b']);
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    await expect(
      t.run(t.client.blockNumber({ ...READ, signal: stop.signal })),
    ).rejects.toThrow('stopped');
  });

  it('reaches the transport with no real timer and no fake time (R46)', async () => {
    const t = setup();
    const timers = jest.spyOn(global, 'setTimeout');
    try {
      const pending = t.client.blockNumber(READ);
      await settle(20);
      expect(t.node.served.map((s) => s.method)).toEqual(['eth_blockNumber']);
      await expect(pending).resolves.toBe(0n);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  });

  it('passes node errors through unchanged, as classified crypto-aio errors', async () => {
    const t = setup();
    const raw = await t.sign(0);
    await t.run(
      t.client.sendRawTransaction(raw, {
        purpose: 'broadcast',
        retry: 'ambiguous-on-failure',
      }),
    );
    await expect(
      t.run(
        t.client.sendRawTransaction(raw, {
          purpose: 'broadcast',
          retry: 'ambiguous-on-failure',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      ambiguous: false,
      details: { rpcMessage: 'already known' },
    });
    // web3 wraps an "execution reverted" answer in its own ContractExecutionError; the
    // client must still surface the transport's classified error.
    await expect(
      t.run(t.client.call({ to: REVERTER, data: '0x' }, 'latest', READ)),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      details: { rpcCode: 3, rpcMessage: 'execution reverted' },
    });
    t.node.intercept = (_e, method) =>
      method === 'eth_blockNumber' ? { result: 'not-hex' } : undefined;
    await expect(t.run(t.client.blockNumber(READ))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('hands out a fresh native SDK client wired to the same transport', async () => {
    const t = setup();
    const first = t.client.createNative();
    const second = t.client.createNative();
    expect(first.client).not.toBe(second.client);
    const count = t.node.served.length;
    const height =
      library === 'ethers'
        ? await t.run(
            (first.client as { getBlockNumber(): Promise<number> }).getBlockNumber(),
          )
        : await t.run(
            (
              first.client as { eth: { getBlockNumber(): Promise<bigint> } }
            ).eth.getBlockNumber(),
          );
    expect(BigInt(height)).toBe(0n);
    expect(t.node.served.length).toBeGreaterThan(count);
    await first.close?.();
    await second.close?.();
  });
});

describe('quorum keys', () => {
  it('compare consensus facts of blocks and receipts only', () => {
    const block = quorumKeyFor('eth_getBlockByNumber');
    expect(
      block?.({
        number: '0x1',
        hash: '0xa',
        parentHash: '0xb',
        timestamp: '0x2',
        size: '0x9',
      }),
    ).toEqual({ number: '0x1', hash: '0xa', parentHash: '0xb', timestamp: '0x2' });
    expect(block?.(null)).toBeNull();
    expect(
      quorumKeyFor('eth_getTransactionReceipt')?.({
        transactionHash: '0x1',
        blockHash: '0x2',
        blockNumber: '0x3',
        status: '0x1',
        logs: [],
      }),
    ).toEqual({
      transactionHash: '0x1',
      blockHash: '0x2',
      blockNumber: '0x3',
      status: '0x1',
    });
    expect(
      quorumKeyFor('eth_getTransactionByHash')?.({
        hash: '0x1',
        blockHash: '0x2',
        blockNumber: '0x3',
        from: '0x4',
        to: '0x5',
        input: '0xa9059cbb',
        nonce: '0x0',
        gasPrice: '0x9',
        v: '0x1',
      }),
    ).toEqual({
      hash: '0x1',
      blockHash: '0x2',
      blockNumber: '0x3',
      from: '0x4',
      to: '0x5',
      input: '0xa9059cbb',
      nonce: '0x0',
    });
    expect(quorumKeyFor('eth_getTransactionCount')).toBeUndefined();
  });
});
