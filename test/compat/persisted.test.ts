/**
 * What a process stores and reads back must not change between versions: an idempotency key
 * repeated after an upgrade must find its Operation and hash its intent the same way, a
 * worker must find the nonce state and leases the previous version wrote, and a scanner its
 * cursor. Each value here is pinned as 0.1.0 wrote it. A change that breaks one of these
 * tests breaks every deployment that upgrades: keep reading the old form instead.
 */
import type { ScanEvent } from '../../src';
import { intentHash, type StoredIntent } from '../../src/core/model/intent';
import { sequenceKey } from '../../src/core/ordering/sequence';
import { OPERATION_FORMAT } from '../../src/core/store/format';
import { createFakeEnv } from '../../src/testing/env';

const VECTORS: ReadonlyArray<
  readonly [chain: string, network: string, intent: StoredIntent, hash: string]
> = [
  [
    'ethereum',
    'mainnet',
    {
      assetId: 'ethereum:mainnet/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7',
      asset: {
        standard: 'erc20',
        contract: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      },
      outputs: [
        { to: '0x3535353535353535353535353535353535353535', amount: 2n ** 64n + 1n },
        { to: '0x0000000000000000000000000000000000000001', amount: 1n },
      ],
      from: '0x0000000000000000000000000000000000000002',
      memo: 'order-42',
      fee: { maxFeePerGas: 30_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
    },
    '2aec4a8692eb96b116762a290586bdb9b7feb5fd90e5ba8e5dfb93ba0d5650ab',
  ],
  [
    'ton',
    'mainnet',
    {
      assetId: 'ton:mainnet/native',
      asset: 'native',
      outputs: [
        {
          to: `0:${'ab'.repeat(32)}`,
          amount: 5n,
          variant: { bounceable: false, testOnly: false, urlSafe: true },
        },
      ],
      from: `0:${'cd'.repeat(32)}`,
      fee: 'fast',
    },
    'e9e55aadf1386f403989e8a730617f9227222bbd165a3f92f457fbadac038cf5',
  ],
  [
    'bitcoin',
    'testnet4',
    {
      assetId: 'bitcoin:testnet4/native',
      asset: 'native',
      outputs: [{ to: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', amount: 1000n }],
      from: 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
      fee: { satPerVByte: 12 },
    },
    '86662c3938569a85776f291ac0e8783ee344a416ffcc03c1d008ec4d50b82e61',
  ],
];

describe('persisted values stay readable across versions', () => {
  it.each(VECTORS)(
    'hashes a %s:%s intent as 0.1.0 did',
    (chain, network, intent, hash) => {
      expect(intentHash(chain, network, intent)).toBe(hash);
    },
  );

  it('keys nonce state and its lease as 0.1.0 did', () => {
    expect(sequenceKey('payments', 'ethereum', 'mainnet', '0xabc')).toBe(
      'seq:payments:ethereum:mainnet:0xabc',
    );
  });

  it('keys a scanner cursor as 0.1.0 did', async () => {
    const env = await createFakeEnv();
    env.chain.mine(2);
    const iterator = env.bc
      .scanner({ cursorKey: 'deposits', from: 1n })
      [Symbol.asyncIterator]();
    const next = await env.run(iterator.next(), 500);
    await (next.value as ScanEvent).ack();
    const key = `${env.aio.namespace}:${env.chainId}:${env.bc.network}:deposits`;
    expect((await env.stores.cursors.get(key))?.cursor.height).toBe(1n);
    await iterator.return?.();
  });

  it('writes record format 1, which every later version reads', () => {
    // Raising OPERATION_FORMAT is allowed; dropping support for format 1 is not.
    expect(OPERATION_FORMAT).toBe(1);
  });
});
