import { secp256k1 } from '@noble/curves/secp256k1';
import { native } from '../../../src/native';
import type { ScanEvent } from '../../../src/core/observe/scanner';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { createAvalancheEnv, mineWhile, type AvalancheEnv } from './support/env';
import { signWith } from './support/node';
import {
  OTHER_BYTES,
  TEST_BYTES,
  TEST_KEY,
  TEST_PUBKEY,
  type Vm,
} from './support/vectors';
import { CryptoAio } from '../../../src';
import '../../../src/adapters/avalanche';

// Determinism (R46): the container builds its own transports; their jitter is pinned here.
beforeEach(() => {
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function finalOf(env: AvalancheEnv, operationId: string) {
  return mineWhile(env, env.bc.waitForConfirmation(operationId, { finality: 'final' }));
}

describe.each(['avm', 'pvm'] as Vm[])('Avalanche %s transfers end to end', (vm) => {
  it('sends AVAX, pays change back and becomes final once accepted', async () => {
    const env = await createAvalancheEnv({ vm });
    expect(env.address).toBe(env.addressOf(TEST_BYTES));
    expect(env.address.startsWith(vm === 'avm' ? 'X-fuji1' : 'P-fuji1')).toBe(true);
    const to = env.addressOf(OTHER_BYTES);
    const sub = await env.run(
      env.bc.transfer({ to, amount: '0.05' }, { idempotencyKey: 'pay-1' }),
    );
    expect(sub.state).toBe('submitted');
    expect(sub.attempt?.idKind).toBe('txid');
    const done = await finalOf(env, sub.operationId);
    expect(done.status).toMatchObject({ state: 'final', evidence: 'proven' });
    expect((await env.run(env.bc.getBalance(to))).amount.base).toBe(50_000_000n);
    const record = await env.stores.operations.get('default', sub.operationId);
    const paid = record?.attempts[0]?.fee.charges[0]?.amount ?? 0n;
    expect(record?.attempts[0]?.fee.bound).toBe('exact');
    expect((await env.run(env.bc.getBalance(env.address))).amount.base).toBe(
      300_000_000n - 50_000_000n - paid,
    );
    // An idempotent repeat returns the same Operation, never a second payment.
    const again = await env.run(
      env.bc.transfer({ to, amount: '0.05' }, { idempotencyKey: 'pay-1' }),
    );
    expect(again.operationId).toBe(sub.operationId);
    expect(env.node.balance(OTHER_BYTES)).toBe(50_000_000n);
    // The transaction reads back with its transfers, block and fee.
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    // A read is observed evidence: included, in a block that is final.
    expect(tx?.status).toMatchObject({ state: 'included', finality: 'final' });
    expect(tx?.decoding).toBe('complete');
    expect(tx?.fee?.[0]?.base).toBe(paid);
    expect(
      tx?.transfers.map((t) => [t.to.canonical, t.amount?.base, t.from[0]?.canonical]),
    ).toEqual(expect.arrayContaining([[to, 50_000_000n, env.address]]));
  });

  it('sends a batch in one transaction', async () => {
    const env = await createAvalancheEnv({ vm });
    const a = env.addressOf(OTHER_BYTES);
    const b = env.addressOf(new Uint8Array(20).fill(7));
    const sub = await env.run(
      env.bc.transfer({
        outputs: [
          { to: a, amount: 1_000n },
          { to: b, amount: 2_000n },
        ],
      }),
    );
    await finalOf(env, sub.operationId);
    expect(env.node.balance(OTHER_BYTES)).toBe(1_000n);
    expect(env.node.balance(new Uint8Array(20).fill(7))).toBe(2_000n);
    expect((await env.run(env.bc.limits())).maxOutputs).toBe(127);
  });

  it('lands a transaction signed elsewhere (cold signing)', async () => {
    const env = await createAvalancheEnv({ vm });
    const cold = env.aio
      .scope({ wallets: { cold: { publicKey: toHex(TEST_PUBKEY) } } })
      .blockchain({ chain: env.chain, wallet: 'cold' });
    const prepared = await env.run(
      cold.prepareTransfer(
        { to: env.addressOf(OTHER_BYTES), amount: 10_000n },
        { idempotencyKey: 'cold' },
      ),
    );
    const unsigned = fromHex(prepared.unsigned?.payload.data ?? '');
    const signed = signWith(unsigned, TEST_KEY, vm);
    const sub = await env.run(
      cold.submitSignatures(prepared.operation.id, {
        encoding: 'hex',
        data: toHex(signed),
      }),
    );
    expect(sub.state).toBe('submitted');
    await finalOf(env, sub.operationId);
    expect(env.node.balance(OTHER_BYTES)).toBe(10_000n);
  });

  it('accepts signature bundles for a prepared transaction', async () => {
    const env = await createAvalancheEnv({ vm });
    const cold = env.aio
      .scope({ wallets: { cold: { publicKey: toHex(TEST_PUBKEY) } } })
      .blockchain({ chain: env.chain, wallet: 'cold' });
    const prepared = await env.run(
      cold.prepareTransfer(
        { to: env.addressOf(OTHER_BYTES), amount: 10_000n },
        { idempotencyKey: 'bundles' },
      ),
    );
    const request = prepared.unsigned?.signingRequests[0];
    const sig = secp256k1.sign(request?.payload ?? new Uint8Array(32), TEST_KEY, {
      lowS: true,
    });
    const sub = await env.run(
      cold.submitSignatures(prepared.operation.id, [
        {
          requestId: request?.id ?? '',
          bytes: sig.toCompactRawBytes(),
          recovery: sig.recovery,
        },
      ]),
    );
    expect(sub.state).toBe('submitted');
  });

  it('scans deposits in final mode', async () => {
    const env = await createAvalancheEnv({ vm });
    const to = env.addressOf(OTHER_BYTES);
    await env.run(env.bc.transfer({ to, amount: 3_000n }));
    env.node.mine();
    env.node.fund(OTHER_BYTES, 4_000n);
    const scanner = env.bc
      .scanner({
        cursorKey: 'deposits',
        from: 0n,
        mode: 'final',
        filter: { addresses: [to] },
      })
      [Symbol.asyncIterator]();
    const seen: ScanEvent[] = [];
    for (let i = 0; i < 40; i++) {
      const next = await env.run(scanner.next());
      if (next.done) break;
      await env.run(next.value.ack());
      seen.push(next.value);
      if (
        next.value.type === 'block' &&
        next.value.block.height >= BigInt(env.node.height)
      ) {
        break;
      }
    }
    const credited = seen
      .flatMap((e) => (e.type === 'block' ? e.transactions : []))
      .flatMap((t) => t.transfers)
      .filter((t) => t.to.canonical === to)
      .map((t) => t.amount?.base);
    expect(credited).toEqual([3_000n, 4_000n]);
    await env.run(Promise.resolve(scanner.return?.(undefined)));
  });

  it('lists the address history from the Data API', async () => {
    const env = await createAvalancheEnv({ vm });
    const sub = await env.run(
      env.bc.transfer({ to: env.addressOf(OTHER_BYTES), amount: 5_000n }),
    );
    env.node.mine();
    const page = await env.run(env.bc.history(env.address, { limit: 10 }));
    expect(page.items.map((t) => t.id)[0]).toBe(sub.attempt?.id);
    expect(page.items).toHaveLength(3); // the transfer and the two fundings
    expect(page.items.every((t) => t.status.finality === 'final')).toBe(true);
  });

  it('exposes listUnspent and the native client', async () => {
    const env = await createAvalancheEnv({ vm });
    const unspent = await env.run(env.bc.ext.avalanche.listUnspent(env.address));
    expect(unspent.map((u) => [u.amount, u.spendable])).toEqual([
      [200_000_000n, true],
      [100_000_000n, true],
    ]);
    const client = await env.run(native(env.bc, '@avalabs/avalanchejs'));
    expect(client.context.networkID).toBe(5);
    const height = await env.run(
      client.rpc<{ height: string }>(`${vm === 'avm' ? 'avm' : 'platform'}.getHeight`),
    );
    expect(height.height).toBe(String(env.node.height));
    expect(typeof client.avalanche.utils.getManagerForVM).toBe('function');
  });
});

describe('X-Chain memos and P-Chain limits', () => {
  it('writes a memo on the X-Chain and reads it back on every transfer', async () => {
    const env = await createAvalancheEnv({ vm: 'avm' });
    const sub = await env.run(
      env.bc.transfer({
        to: env.addressOf(OTHER_BYTES),
        amount: 1_000n,
        memo: 'invoice-7',
      }),
    );
    env.node.mine();
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers.every((t) => t.memo === 'invoice-7')).toBe(true);
  });

  it('refuses a memo on the P-Chain (Durango), before anything is signed', async () => {
    const env = await createAvalancheEnv({ vm: 'pvm' });
    expect(env.bc.supports('memo')).toBe(false);
    await expect(
      env.run(env.bc.transfer({ to: env.addressOf(OTHER_BYTES), amount: 1n, memo: 'x' })),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(env.node.issued).toEqual([]);
  });

  it('pays a P-Chain fee that follows the gas price', async () => {
    const env = await createAvalancheEnv({ vm: 'pvm' });
    const to = env.addressOf(OTHER_BYTES);
    const low = await env.run(env.bc.estimateFee({ to, amount: 1_000n, fee: 'normal' }));
    env.node.setGasPrice(10n);
    const high = await env.run(env.bc.estimateFee({ to, amount: 1_000n, fee: 'normal' }));
    const total = (fee: typeof low) => fee.charges[0]?.amount.base ?? 0n;
    // normal pays 1.5× the price, rounded up: 2 at price 1, 15 at price 10; the same gas.
    expect(low.details).toMatchObject({ model: 'dynamic', gasPrice: 2n });
    expect(high.details).toMatchObject({ model: 'dynamic', gasPrice: 15n });
    expect(total(high) * 2n).toBe(total(low) * 15n);
    const custom = await env.run(
      env.bc.estimateFee({ to, amount: 1_000n, fee: { gasPrice: '20' } }),
    );
    expect(custom).toMatchObject({ speed: 'custom', details: { gasPrice: 20n } });
  });
});

describe('the handle without a configured indexer', () => {
  it('falls back to the public Data API preset, which is not for production', () => {
    const aio = new CryptoAio({ env: false });
    const bc = aio.blockchain({ chain: 'avalanche-x', network: 'fuji' });
    expect([...bc.capabilities]).toEqual(
      expect.arrayContaining(['batch-transfer', 'memo', 'block-scan', 'address-history']),
    );
    expect(bc.supports('replace-fee')).toBe(false);
    expect(bc.supports('tokens')).toBe(false);
  });
});
