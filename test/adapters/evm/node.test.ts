import { Wallet, parseUnits } from 'ethers';
import { FakeClock } from '../../../src/testing/fake-clock';
import { REVERTER, ScriptedEvmNode, TRANSFER_TOPIC } from './support/node';

const alice = new Wallet(`0x${'11'.repeat(32)}`);
const bob = new Wallet(`0x${'22'.repeat(32)}`).address;
const TOKEN = '0x00000000000000000000000000000000000070ce';
const ETH = 10n ** 18n;
/** Calldata for ERC-20 `transfer(to, amount)`. */
const transferData = (to: string, amount: bigint) =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;

function setup() {
  const node = new ScriptedEvmNode({ chainId: 11155111n, clock: new FakeClock() });
  const url = node.endpoint('main');
  const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    const response = await node.fetch.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  };
  const sign = (nonce: number, extra: Record<string, unknown> = {}) =>
    alice.signTransaction({
      type: 2,
      chainId: 11155111n,
      nonce,
      to: bob,
      value: 1_000n,
      gasLimit: 21_000n,
      maxFeePerGas: parseUnits('10', 'gwei'),
      maxPriorityFeePerGas: parseUnits('1', 'gwei'),
      ...extra,
    });
  node.fund(alice.address, 10n ** 18n);
  return { node, rpc, sign };
}

describe('ScriptedEvmNode', () => {
  it('accepts, mines and reports a transfer with its receipt and finality', async () => {
    const { node, rpc, sign } = setup();
    const hash = await rpc<string>('eth_sendRawTransaction', [await sign(0)]);
    expect(await rpc('eth_getTransactionByHash', [hash])).toMatchObject({
      blockHash: null,
      nonce: '0x0',
    });
    expect(await rpc('eth_getTransactionCount', [alice.address, 'pending'])).toBe('0x1');
    node.mine();
    expect(await rpc('eth_getTransactionReceipt', [hash])).toMatchObject({
      status: '0x1',
      blockNumber: '0x1',
      gasUsed: '0x5208',
    });
    expect(node.balance(bob)).toBe(1_000n);
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: '0x0',
    });
    node.mine(2);
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: '0x1',
    });
    expect(await rpc('eth_getTransactionCount', [alice.address, 'finalized'])).toBe(
      '0x1',
    );
  });

  it('answers like geth: already known, nonce too low, underpriced replacement, insufficient funds', async () => {
    const { node, rpc, sign } = setup();
    const first = await sign(0);
    await rpc('eth_sendRawTransaction', [first]);
    await expect(rpc('eth_sendRawTransaction', [first])).rejects.toThrow('already known');
    await expect(
      rpc('eth_sendRawTransaction', [
        await sign(0, { maxFeePerGas: parseUnits('10.5', 'gwei') }),
      ]),
    ).rejects.toThrow('replacement transaction underpriced');
    const bumped = await sign(0, {
      maxFeePerGas: parseUnits('11', 'gwei'),
      maxPriorityFeePerGas: parseUnits('1.1', 'gwei'),
    });
    const replacement = await rpc<string>('eth_sendRawTransaction', [bumped]);
    node.mine();
    expect(node.receipt(replacement)?.status).toBe(1);
    await expect(
      rpc('eth_sendRawTransaction', [await sign(0, { value: 7n })]),
    ).rejects.toThrow('nonce too low');
    await expect(
      rpc('eth_sendRawTransaction', [await sign(1, { value: 10n ** 19n })]),
    ).rejects.toThrow(/insufficient funds.*address 0x/);
    await expect(
      rpc('eth_sendRawTransaction', [await sign(1, { chainId: 1n })]),
    ).rejects.toThrow('invalid chain id');
  });

  it('refuses a replacement that keeps a zero tip, like geth (R48)', async () => {
    const { rpc, sign } = setup();
    await rpc('eth_sendRawTransaction', [await sign(0, { maxPriorityFeePerGas: 0n })]);
    await expect(
      rpc('eth_sendRawTransaction', [
        await sign(0, {
          maxFeePerGas: parseUnits('20', 'gwei'),
          maxPriorityFeePerGas: 0n,
        }),
      ]),
    ).rejects.toThrow('replacement transaction underpriced');
    await expect(
      rpc('eth_sendRawTransaction', [
        await sign(0, {
          maxFeePerGas: parseUnits('20', 'gwei'),
          maxPriorityFeePerGas: 1n,
        }),
      ]),
    ).resolves.toMatch(/^0x/);
  });

  it('answers "nonce too low", not "already known", for a mined transaction (M8)', async () => {
    const { node, rpc, sign } = setup();
    const raw = await sign(0);
    await rpc('eth_sendRawTransaction', [raw]);
    node.mine();
    await expect(rpc('eth_sendRawTransaction', [raw])).rejects.toThrow('nonce too low');
  });

  it('moves ERC-20 balances with Transfer logs and reverts calls to the reverter', async () => {
    const { node, rpc, sign } = setup();
    node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    node.mintToken(TOKEN, alice.address, 500n);
    const data = transferData(bob, 200n);
    const token = await rpc<string>('eth_sendRawTransaction', [
      await sign(0, { to: TOKEN, value: 0n, data, gasLimit: 60_000n }),
    ]);
    const revert = await rpc<string>('eth_sendRawTransaction', [
      await sign(1, { to: REVERTER, gasLimit: 60_000n }),
    ]);
    node.mine();
    expect(node.tokenBalance(TOKEN, bob)).toBe(200n);
    const block = await rpc<{ hash: string }>('eth_getBlockByNumber', ['0x1', false]);
    const logs = await rpc<{ topics: string[]; transactionHash: string }[]>(
      'eth_getLogs',
      [{ blockHash: block.hash, topics: [TRANSFER_TOPIC] }],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]?.transactionHash).toBe(token);
    expect(node.receipt(revert)?.status).toBe(0);
    await expect(
      rpc('eth_estimateGas', [{ from: bob, to: TOKEN, data: data.replace(/c8$/, 'ff') }]),
    ).rejects.toThrow('execution reverted');
  });

  it('reorgs: drops blocks and their state, and re-mines the transactions on a new fork', async () => {
    const { node, rpc, sign } = setup();
    const hash = await rpc<string>('eth_sendRawTransaction', [await sign(0)]);
    node.mine();
    const before = node.receipt(hash);
    node.reorg(1);
    expect(node.inMempool(hash)).toBe(true);
    expect(node.balance(bob)).toBe(0n);
    node.mine();
    expect(node.receipt(hash)?.blockNumber).toBe(1n);
    expect(node.receipt(hash)?.blockHash).not.toBe(before?.blockHash);
    node.reorg(1, [hash]);
    node.mine();
    expect(await rpc('eth_getTransactionByHash', [hash])).toBeNull();
  });

  it("stops mining a sender's transactions at the first it cannot pay for (M1)", async () => {
    const { node, rpc, sign } = setup();
    const send = async (nonce: number, value: bigint) =>
      rpc<string>('eth_sendRawTransaction', [await sign(nonce, { value })]);
    const first = await send(0, ETH / 2n);
    const second = await send(1, (ETH * 6n) / 10n);
    const third = await send(2, ETH / 10n);
    node.mine();
    expect(node.receipt(first)?.status).toBe(1);
    expect(node.nonce(alice.address)).toBe(1n);
    expect([node.receipt(second), node.receipt(third)]).toEqual([undefined, undefined]);
    expect([node.inMempool(second), node.inMempool(third)]).toEqual([true, true]);
    expect(node.balance(bob)).toBe(ETH / 2n);
  });

  it("accepts a replacement at exactly geth's floored bump threshold (M2)", async () => {
    const { rpc, sign } = setup();
    const fees = async (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) =>
      rpc<string>('eth_sendRawTransaction', [
        await sign(0, { maxFeePerGas, maxPriorityFeePerGas }),
      ]);
    await fees(1_000_000_005n, 5n);
    // geth: floor(1_000_000_005 * 110 / 100) = 1_100_000_005; floor(5 * 110 / 100) = 5.
    await expect(fees(1_100_000_004n, 6n)).rejects.toThrow(
      'replacement transaction underpriced',
    );
    await expect(fees(1_100_000_005n, 6n)).resolves.toMatch(/^0x/);
  });

  it('refuses a reorg deeper than the chain or past the finalized block (M3)', () => {
    const { node } = setup();
    node.mine();
    expect(() => node.reorg(2)).toThrow('deeper than the chain');
    expect(node.head).toBe(1n);
    node.mine(4);
    expect(node.finalized).toBe(3n);
    expect(() => node.reorg(3)).toThrow('would drop the finalized block');
    expect(node.head).toBe(5n);
  });

  it('never moves the finalized block backwards (M3)', async () => {
    const { node, rpc } = setup();
    node.mine(5);
    node.reorg(2);
    expect(node.head).toBe(3n);
    expect(node.finalized).toBe(3n);
    expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toMatchObject({
      number: '0x3',
    });
    expect(() => node.reorg(1)).toThrow('would drop the finalized block');
    node.mine();
    expect(node.finalized).toBe(3n);
    node.mine(2);
    expect(node.finalized).toBe(4n);
    node.finalizedDepth = 10;
    expect(node.finalized).toBe(4n);
  });

  it('runs a transaction out of gas: status 0, the whole limit paid, nothing moved (M4)', async () => {
    const { node, rpc, sign } = setup();
    node.deployToken(TOKEN, { symbol: 'TKN', decimals: 6 });
    node.mintToken(TOKEN, alice.address, 500n);
    const hash = await rpc<string>('eth_sendRawTransaction', [
      await sign(0, {
        to: TOKEN,
        value: 0n,
        data: transferData(bob, 200n),
        gasLimit: 21_000n,
      }),
    ]);
    node.mine();
    expect(await rpc('eth_getTransactionReceipt', [hash])).toMatchObject({
      status: '0x0',
      gasUsed: '0x5208',
      logs: [],
    });
    expect(node.tokenBalance(TOKEN, alice.address)).toBe(500n);
    expect(node.tokenBalance(TOKEN, bob)).toBe(0n);
    expect(node.nonce(alice.address)).toBe(1n);
    // 21,000 gas at base fee 1 gwei + tip 1 gwei.
    expect(node.balance(alice.address)).toBe(ETH - 21_000n * 2_000_000_000n);
  });
});
