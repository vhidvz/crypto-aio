import { Wallet, parseUnits } from 'ethers';
import { FakeClock } from '../../../src/testing/fake-clock';
import { REVERTER, ScriptedEvmNode, TRANSFER_TOPIC } from './support/node';

const alice = new Wallet(`0x${'11'.repeat(32)}`);
const bob = new Wallet(`0x${'22'.repeat(32)}`).address;
const TOKEN = '0x00000000000000000000000000000000000070ce';

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
    const data = `0xa9059cbb${bob.slice(2).toLowerCase().padStart(64, '0')}${200n.toString(16).padStart(64, '0')}`;
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
});
