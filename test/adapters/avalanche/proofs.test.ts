import {
  blockSource,
  parseInput,
  proofSource,
} from '../../../src/adapters/avalanche/proofs';
import { cb58Encode } from '../../../src/adapters/avalanche/cb58';
import type { OrderingData } from '../../../src/core/model/ordering';
import { avalancheHarness, type Harness } from './support/harness';
import { FAUCET_BYTES, OTHER_BYTES, TEST_BYTES, type Vm } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'txid' as const, canonical: true });
const MISSING = cb58Encode(new Uint8Array(32).fill(9));

/** Two endpoints, so every proof read is a quorum of two. */
const quorum = (vm: Vm = 'avm') => avalancheHarness({ vm, endpoints: ['a', 'b'] });

function inputsOf(h: Harness, owner: Uint8Array): OrderingData {
  return { kind: 'inputs', inputs: h.node.utxoKeysOf(owner) };
}

describe.each(['avm', 'pvm'] as Vm[])('%s proofs under a quorum of two', (vm) => {
  it('proves an accepted transaction final at its block', async () => {
    const h = quorum(vm);
    const ordering = inputsOf(h, FAUCET_BYTES);
    const id = h.node.fund(OTHER_BYTES, 5n);
    const proofs = proofSource(h.ctx);
    const faucet = h.address(FAUCET_BYTES);
    expect(await h.run(proofs.includedFinal(ref(id), ordering, faucet))).toEqual({
      included: true,
      success: true,
      blockHeight: 1n,
      blockHash: h.node.block(1)?.id,
      txHash: id,
    });
    expect(await h.run(proofs.slotConsumed(ordering, faucet, 'finalized'))).toBe(true);
    expect(await h.run(proofs.slotConsumed(ordering, faucet, 'latest'))).toBe(true);
    expect(h.calls.some((c) => c.tags.quorum === 'proof' && c.tags.quorumKey)).toBe(true);
  });

  it('proves a transaction dead when another spent its input', async () => {
    const h = quorum(vm);
    const ordering = inputsOf(h, FAUCET_BYTES);
    const faucet = h.address(FAUCET_BYTES);
    const proofs = proofSource(h.ctx);
    // Not accepted, inputs unspent: nothing is decided yet.
    await expect(
      h.run(proofs.includedFinal(ref(MISSING), ordering, faucet)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(await h.run(proofs.slotConsumed(ordering, faucet, 'finalized'))).toBe(false);
    h.node.fund(OTHER_BYTES, 5n); // spends the faucet's output: ours never can now
    expect(await h.run(proofs.includedFinal(ref(MISSING), ordering, faucet))).toEqual({
      included: false,
    });
  });

  it('decides nothing for a transaction with no inputs in its ordering', async () => {
    const h = quorum(vm);
    await expect(
      h.run(
        proofSource(h.ctx).includedFinal(
          ref(MISSING),
          { kind: 'inputs', inputs: [] },
          h.from,
        ),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(
      await h.run(
        proofSource(h.ctx).slotConsumed({ kind: 'nonce', nonce: 1n }, h.from, 'latest'),
      ),
    ).toBe(false);
  });

  it('answers block hashes, the finalized head, and no expiry', async () => {
    const h = quorum(vm);
    h.node.mine();
    h.node.mine();
    const proofs = proofSource(h.ctx);
    expect(await h.run(proofs.blockHash(1n, 'finalized'))).toBe(h.node.block(1)?.id);
    expect(await h.run(proofs.blockHash(5n, 'latest'))).toBeNull();
    expect(await h.run(proofs.blockHash(-1n, 'latest'))).toBeNull();
    expect(await h.run(proofs.finalizedHead())).toMatchObject({
      height: 1n,
      hash: h.node.block(1)?.id,
    });
    expect(await h.run(proofs.expired({ kind: 'inputs', inputs: [] }))).toBe(false);
  });

  it('decides nothing while the endpoints disagree', async () => {
    const h = quorum(vm);
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.node.setLag('b', 1); // b has not seen the block yet
    await expect(
      h.run(proofSource(h.ctx).includedFinal(ref(id), inputsOf(h, FAUCET_BYTES), h.from)),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('proof details', () => {
  it('waits for N confirmations when the network asks for more than one', async () => {
    const h = quorum();
    const id = h.node.fund(OTHER_BYTES, 5n);
    const deep = { ...h.ctx, config: { ...h.ctx.config, confirmations: 3 } };
    const proofs = proofSource(deep);
    const ordering = { kind: 'inputs' as const, inputs: [] };
    await expect(
      h.run(proofs.includedFinal(ref(id), ordering, h.from)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(await h.run(proofs.blockHash(1n, 'finalized'))).toBeNull();
    h.node.mine();
    h.node.mine();
    expect(await h.run(proofs.includedFinal(ref(id), ordering, h.from))).toMatchObject({
      included: true,
      blockHeight: 1n,
    });
  });

  it('forgets a located block the quorum does not confirm', async () => {
    const h = quorum();
    const id = h.node.fund(OTHER_BYTES, 5n);
    h.ctx.located.set(id, { height: 1n, hash: MISSING });
    await expect(
      h.run(
        proofSource(h.ctx).includedFinal(ref(id), { kind: 'inputs', inputs: [] }, h.from),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    expect(h.ctx.located.get(id)).toBeUndefined();
  });

  it('decides nothing for an accepted transaction it cannot locate', async () => {
    const h = quorum();
    const id = h.node.fund(OTHER_BYTES, 5n);
    jest.spyOn(h.ctx.dataApi, 'locate').mockResolvedValue(null);
    jest.spyOn(h.ctx.node, 'blockAt').mockResolvedValue(null);
    await expect(
      h.run(
        proofSource(h.ctx).includedFinal(ref(id), { kind: 'inputs', inputs: [] }, h.from),
      ),
    ).rejects.toThrow('not located yet');
  });

  // On a proof path only a definitive negative answers "no".
  it('turns an endpoint refusal into "nothing decided"', async () => {
    const h = quorum();
    h.node.intercept('a', (method) =>
      method === 'avm.getHeight' ? { rpcError: 'internal error' } : undefined,
    );
    h.node.intercept('b', (method) =>
      method === 'avm.getHeight' ? { rpcError: 'internal error' } : undefined,
    );
    await expect(h.run(proofSource(h.ctx).finalizedHead())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('reads malformed ordering entries as undecided', () => {
    expect(() => parseInput('nope')).toThrow('malformed input in the ordering');
    expect(() => parseInput(`${MISSING}:99999999999`)).toThrow('malformed');
    expect(parseInput(`${MISSING}:3`)).toEqual({ txId: MISSING, outputIndex: 3 });
  });

  it('reads an aborted P-Chain proposal as included and failed', async () => {
    const h = quorum('pvm');
    h.node.mine({ proposal: 'abort' });
    const id = h.node.block(1)?.txIds[0] as string;
    expect(
      await h.run(
        proofSource(h.ctx).includedFinal(ref(id), { kind: 'inputs', inputs: [] }, h.from),
      ),
    ).toMatchObject({
      included: true,
      success: false,
      reason: 'the transaction was aborted',
    });
  });
});

describe('the block source', () => {
  it('reads headers and the transactions of a block, filtered by address', async () => {
    const h = avalancheHarness();
    const paid = h.node.fund(OTHER_BYTES, 5n, { mine: false });
    const other = h.node.fund(TEST_BYTES, 6n, { mine: false });
    h.node.mine();
    const blocks = blockSource(h.ctx);
    const header = await h.run(blocks.header(1n));
    expect(header).toMatchObject({ height: 1n, hash: h.node.block(1)?.id });
    expect(await h.run(blocks.header(2n))).toBeNull();
    expect(await h.run(blocks.header(-1n))).toBeNull();
    const all = await h.run(blocks.transactions(header!));
    expect(all.map((t) => t.id).sort()).toEqual([paid, other].sort());
    const filtered = await h.run(
      blocks.transactions(header!, { addresses: [h.address(OTHER_BYTES), 'junk'] }),
    );
    expect(filtered.map((t) => t.id)).toEqual([paid]);
    // A watched sender is kept too: the faucet signed both.
    const sent = await h.run(
      blocks.transactions(header!, { addresses: [h.address(FAUCET_BYTES)] }),
    );
    expect(sent).toHaveLength(2);
    expect(
      await h.run(
        blocks.transactions(header!, { assets: [{ standard: 'erc20', contract: 'x' }] }),
      ),
    ).toEqual([]);
  });

  it('decides nothing when the block at the height changed', async () => {
    const h = avalancheHarness();
    h.node.mine();
    const blocks = blockSource(h.ctx);
    const header = await h.run(blocks.header(1n));
    await expect(
      h.run(blocks.transactions({ ...header!, hash: MISSING })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });

  it('marks an aborted P-Chain proposal transaction failed', async () => {
    const h = avalancheHarness({ vm: 'pvm' });
    h.node.mine({ proposal: 'abort' });
    const blocks = blockSource(h.ctx);
    const [tx] = await h.run(blocks.transactions((await h.run(blocks.header(1n)))!));
    expect(tx?.observation).toMatchObject({ success: false });
  });
});
