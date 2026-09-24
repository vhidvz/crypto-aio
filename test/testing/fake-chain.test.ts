import { secp256k1 } from '@noble/curves/secp256k1';
import {
  FakeChain,
  REVERT_ADDRESS,
  fakeAddress,
  signFake,
  type FakeUnsigned,
} from '../../src/testing/fake-chain';

const key = () => {
  const priv = secp256k1.utils.randomPrivateKey();
  return { priv, address: fakeAddress(secp256k1.getPublicKey(priv, true)) };
};
const tx = (
  from: string,
  to: string,
  extra: Partial<FakeUnsigned> = {},
): FakeUnsigned => ({
  chainId: 'fake-local',
  from,
  to,
  amount: '10',
  fee: '1',
  nonce: '0',
  ...extra,
});

describe('FakeChain', () => {
  it('moves value and nonces when mining', () => {
    const chain = new FakeChain();
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    const id = chain.submit(signFake(tx(alice.address, bob.address), alice.priv));
    expect(chain.inMempool(id)).toBe(true);
    chain.mine();
    expect(chain.balance(alice.address)).toBe(89n);
    expect(chain.balance(bob.address)).toBe(10n);
    expect(chain.nonce(alice.address)).toBe(1n);
    expect(chain.receipt(id)).toMatchObject({ success: true, height: 1n });
  });

  it('refuses and rejects like a node', () => {
    const chain = new FakeChain({ minFee: 2n });
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    expect(() =>
      chain.submit(signFake(tx(alice.address, bob.address, { fee: '1' }), alice.priv)),
    ).toThrow('fee too low');
    expect(() =>
      chain.submit(
        signFake(
          tx(alice.address, bob.address, { fee: '2', amount: '1000' }),
          alice.priv,
        ),
      ),
    ).toThrow('insufficient funds');
    expect(() =>
      chain.submit(
        signFake(
          tx(alice.address, bob.address, { fee: '2', chainId: 'other' }),
          alice.priv,
        ),
      ),
    ).toThrow('invalid chain id');
    expect(() =>
      chain.submit(signFake(tx(bob.address, alice.address, { fee: '2' }), alice.priv)),
    ).toThrow('invalid sender');
    const good = signFake(tx(alice.address, bob.address, { fee: '2' }), alice.priv);
    const envelope = JSON.parse(Buffer.from(good, 'base64').toString('utf8'));
    const tampered = Buffer.from(
      JSON.stringify({ ...envelope, tx: { ...envelope.tx, amount: '11' } }),
    ).toString('base64');
    expect(() => chain.submit(tampered)).toThrow('invalid signature');
    expect(() => chain.submit('not-base64-json')).toThrow('malformed transaction');
    const id = chain.submit(good);
    expect(() => chain.submit(good)).toThrow('already known');
    chain.mine();
    expect(() => chain.submit(good)).toThrow('nonce too low');
    expect(chain.receipt(id)?.success).toBe(true);
  });

  it('replaces same-nonce transactions only with a sufficient fee bump', () => {
    const chain = new FakeChain();
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    const first = chain.submit(
      signFake(tx(alice.address, bob.address, { fee: '10' }), alice.priv),
    );
    expect(() =>
      chain.submit(
        signFake(tx(alice.address, bob.address, { fee: '10', amount: '5' }), alice.priv),
      ),
    ).toThrow('replacement transaction underpriced');
    const second = chain.submit(
      signFake(tx(alice.address, bob.address, { fee: '11', amount: '5' }), alice.priv),
    );
    expect(chain.inMempool(first)).toBe(false);
    chain.mine();
    expect(chain.receipt(second)).toBeDefined();
    expect(chain.receipt(first)).toBeUndefined();
  });

  it('charges fees but moves no value for reverts', () => {
    const chain = new FakeChain();
    const alice = key();
    chain.fund(alice.address, 100n);
    const id = chain.submit(signFake(tx(alice.address, REVERT_ADDRESS), alice.priv));
    chain.mine();
    expect(chain.receipt(id)?.success).toBe(false);
    expect(chain.balance(alice.address)).toBe(99n);
    expect(chain.balance(REVERT_ADDRESS)).toBe(0n);
  });

  it('reorgs non-final blocks and can drop transactions', () => {
    const chain = new FakeChain({ finalityDepth: 3 });
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    const id1 = chain.submit(signFake(tx(alice.address, bob.address), alice.priv));
    chain.mine();
    const firstHash = chain.receipt(id1)?.hash;
    chain.reorg(1);
    expect(chain.head).toBe(2n);
    expect(chain.receipt(id1)?.hash).not.toBe(firstHash);
    const id2 = chain.submit(
      signFake(tx(alice.address, bob.address, { nonce: '1' }), alice.priv),
    );
    chain.mine();
    chain.reorg(1, { drop: [id2] });
    expect(chain.receipt(id2)).toBeUndefined();
    expect(chain.inMempool(id2)).toBe(false);
    chain.mine(5);
    expect(() => chain.reorg(5)).toThrow(/finalized/);
  });

  it('expires transactions in expiry mode', () => {
    const chain = new FakeChain({ ordering: 'expiry' });
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    const raw = signFake(
      {
        chainId: 'fake-local',
        from: alice.address,
        to: bob.address,
        amount: '1',
        fee: '1',
        lastValidHeight: '1',
      },
      alice.priv,
    );
    const id = chain.submit(raw);
    chain.dropFromMempool(id);
    chain.mine(2);
    expect(() => chain.submit(raw)).toThrow('transaction expired');
    expect(chain.receipt(id)).toBeUndefined();
  });

  it('accepts only the current seqno in seqno mode', () => {
    const chain = new FakeChain({ ordering: 'seqno' });
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    expect(() =>
      chain.submit(signFake(tx(alice.address, bob.address, { nonce: '1' }), alice.priv)),
    ).toThrow('seqno mismatch');
    chain.submit(signFake(tx(alice.address, bob.address), alice.priv));
    expect(() =>
      chain.submit(signFake(tx(alice.address, bob.address, { amount: '3' }), alice.priv)),
    ).toThrow('seqno mismatch');
  });

  it('serves JSON-RPC per endpoint with lag, mempool visibility and faults', async () => {
    const chain = new FakeChain();
    const alice = key();
    const bob = key();
    chain.fund(alice.address, 100n);
    chain.mine(5);
    const url = chain.endpoint('lagging', { lag: 2, seesMempool: false });
    const call = async (method: string, params: unknown[] = []) => {
      const response = await chain.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await response.json()) as { result?: unknown; error?: { message: string } };
    };
    expect((await call('fake_blockNumber')).result).toBe('3');
    const sent = await call('fake_sendRawTransaction', [
      signFake(tx(alice.address, bob.address), alice.priv),
    ]);
    expect(typeof sent.result).toBe('string');
    expect(chain.sendCount(sent.result as string)).toBe(1);
    expect((await call('fake_getTransaction', [sent.result])).result).toBeNull();
    expect((await call('fake_nope')).error?.message).toMatch(/method not found/);
    chain.configureEndpoint('lagging', { down: true });
    expect((await chain.fetch(url, { method: 'POST', body: '{}' })).status).toBe(503);
    await expect(chain.fetch('https://elsewhere.test/x')).rejects.toThrow('fetch failed');
  });
});
