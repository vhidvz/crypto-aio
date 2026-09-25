import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, rpcResult, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };

describe('HttpTransport quorum keys', () => {
  const blocks: Record<string, unknown> = {
    a: { number: '0x10', hash: '0xaa', size: '0x200', totalDifficulty: '0x0' },
    b: { number: '0x10', hash: '0xaa', size: '0x201' },
  };
  const fake = new FakeFetch()
    .route('https://a.test', (req: FakeRequest) => rpcResult(req, blocks.a))
    .route('https://b.test', (req: FakeRequest) => rpcResult(req, blocks.b));
  const consensus = (value: unknown) => {
    const block = value as { number: string; hash: string } | null;
    return block && { number: block.number, hash: block.hash };
  };

  it('compares only the projected facts and resolves with the first whole result', async () => {
    const { transport, clock } = setup([A, B], fake);
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof', quorumKey: consensus })),
    ).resolves.toEqual(blocks.a);
  });

  it('still fails when the projected facts disagree, and compares whole results without a key', async () => {
    const { transport, clock } = setup([A, B], fake);
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
    blocks.b = { number: '0x10', hash: '0xbb', size: '0x200', totalDifficulty: '0x0' };
    await expect(
      drive(clock, transport.rpc('block', [], { quorum: 'proof', quorumKey: consensus })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });
});
