import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, rpcResult, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };

const blockA = () => ({
  number: '0x10',
  hash: '0xaa',
  size: '0x200',
  totalDifficulty: '0x0',
});

/** M3: fresh fixtures per test. Endpoint a serves `blockA()`, endpoint b serves `blockB`. */
function twoNodes(blockB: unknown) {
  const fake = new FakeFetch()
    .route('https://a.test', (req: FakeRequest) => rpcResult(req, blockA()))
    .route('https://b.test', (req: FakeRequest) => rpcResult(req, blockB));
  return setup([A, B], fake);
}

const consensus = (value: unknown) => {
  const block = value as { number: string; hash: string } | null;
  return block && { number: block.number, hash: block.hash };
};

describe('HttpTransport quorum keys', () => {
  it('compares only the projected facts and resolves with the first whole result', async () => {
    const { transport, clock } = twoNodes({
      number: '0x10',
      hash: '0xaa',
      size: '0x201',
    });
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof', quorumKey: consensus })),
    ).resolves.toEqual(blockA());
  });

  it('compares whole results without a key', async () => {
    const { transport, clock } = twoNodes({
      number: '0x10',
      hash: '0xaa',
      size: '0x201',
    });
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });

  it('still fails when the projected facts disagree', async () => {
    const { transport, clock } = twoNodes({ ...blockA(), hash: '0xbb' });
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof', quorumKey: consensus })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });

  it('treats a key that throws as a disagreement, never a foreign error (M2)', async () => {
    const { transport, clock, seen } = twoNodes({ number: '0x10' });
    const strict = (value: unknown) => {
      const block = value as { hash?: string };
      if (block.hash === undefined) throw new TypeError('block without hash');
      return block.hash;
    };
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof', quorumKey: strict })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
    expect(seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.inconsistent',
        method: 'block',
        endpointIds: ['a', 'b'],
      }),
    );
  });
});
