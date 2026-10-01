// A rate-limited probe keeps the last good height and identity (keyless TronGrid and
// toncenter answer probes HTTP 429 under load), and one forged far-future head never
// stales every view for good.
import { isStaleView } from '../../../src/core/transport/stale-view';
import { drive } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../src/testing/fake-fetch';
import { setup } from './support';

type Rpc = { id: unknown; method: string };
const answer = (req: FakeRequest, result: unknown): FakeReply => ({
  json: { jsonrpc: '2.0', id: req.json<Rpc>().id, result },
});
const LIMITED: FakeReply = { status: 429, text: '', headers: { 'retry-after': '2' } };

/** A node on chain id 1 at `height()`, whose methods `limit` may answer with a 429. */
function node(height: () => number, limit: Set<string> = new Set(), balance = '0x0') {
  const served: string[] = [];
  const handler = (req: FakeRequest): FakeReply => {
    const { method } = req.json<Rpc>();
    served.push(method);
    if (limit.has(method)) return LIMITED;
    if (method === 'eth_chainId') return answer(req, '0x1');
    if (method === 'eth_blockNumber') return answer(req, `0x${height().toString(16)}`);
    return answer(req, balance);
  };
  return { handler, served, limit };
}

const probes = {
  identity: async (call: { rpc<T>(m: string): Promise<T> }) =>
    String(BigInt(await call.rpc<string>('eth_chainId'))),
  expectedIdentity: '1',
  height: async (call: { rpc<T>(m: string): Promise<T> }) =>
    BigInt(await call.rpc<string>('eth_blockNumber')),
};

describe('rate-limited health probes', () => {
  it('keeps the last good height through a height-probe 429, so reads go on', async () => {
    const n = node(() => 100);
    const fake = new FakeFetch().route('https://a.example', n.handler);
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    n.limit.add('eth_blockNumber');
    await clock.advance(15_001);
    await drive(clock, transport.refreshHealth());
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
    n.limit.clear();
    await expect(
      drive(clock, transport.rpc('eth_getBalance', [], { purpose: 'monitor' })),
    ).resolves.toBe('0x0');
  });

  it('waits out an identity-probe 429 for its Retry-After, not a health interval', async () => {
    const n = node(() => 100, new Set(['eth_chainId']));
    const fake = new FakeFetch().route('https://a.example', (req) => {
      const reply = n.handler(req);
      n.limit.clear(); // one 429 (Retry-After: 2), then answers
      return reply;
    });
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes({ identity: probes.identity, expectedIdentity: '1' });
    await expect(drive(clock, transport.rpc('eth_getBalance'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    // Before, the endpoint stayed locked out for a whole health interval (15 s).
    await clock.advance(2_001);
    await expect(drive(clock, transport.rpc('eth_getBalance'))).resolves.toBe('0x0');
  });

  it('keeps a rate-limited endpoint in the proof count, so the other never proves alone', async () => {
    const a = node(() => 100, new Set(), '0x1');
    const b = node(() => 100, new Set(), '0x2');
    const fake = new FakeFetch()
      .route('https://a.example', a.handler)
      .route('https://b.example', b.handler);
    const { transport, clock } = setup(
      [
        { name: 'a', url: 'https://a.example' },
        { name: 'b', url: 'https://b.example' },
      ],
      fake,
    );
    transport.setProbes({ identity: probes.identity, expectedIdentity: '1' });
    await drive(clock, transport.refreshHealth());
    b.limit.add('eth_chainId');
    for (let i = 0; i < 4; i++) {
      await clock.advance(15_001);
      await drive(clock, transport.refreshHealth());
    }
    expect(transport.status()[1]).toMatchObject({ state: 'healthy' });
    b.limit.clear();
    await clock.advance(2_001); // a proof read never waits out a pending Retry-After
    // b still counts, so a's answer alone decides nothing; before, three rate-limited
    // re-probes were three health misses, b left the count, and a proved alone.
    await expect(
      drive(clock, transport.rpc('eth_getBalance', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });

  it('does not probe an endpoint before the Retry-After its 429 asked for', async () => {
    const n = node(() => 100);
    const fake = new FakeFetch().route('https://a.example', n.handler);
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    n.limit.add('eth_blockNumber');
    await clock.advance(15_001);
    await drive(clock, transport.refreshHealth()); // the 429 asks for 2 s
    const before = n.served.length;
    await clock.advance(1_000);
    await drive(clock, transport.refreshHealth());
    expect(n.served.length).toBe(before);
  });
});

describe('the height high-water mark', () => {
  function threeNodes(liar: () => number) {
    const honest = node(() => 100);
    const lying = node(liar);
    const fake = new FakeFetch()
      .route('https://a.example', honest.handler)
      .route('https://b.example', honest.handler)
      .route('https://c.example', lying.handler);
    const { transport, clock } = setup(
      [
        { name: 'a', url: 'https://a.example' },
        { name: 'b', url: 'https://b.example' },
        { name: 'c', url: 'https://c.example' },
      ],
      fake,
    );
    transport.setProbes(probes);
    const refresh = async () => {
      await clock.advance(15_001);
      await drive(clock, transport.refreshHealth());
    };
    return { transport, clock, refresh };
  }

  it('drops a forged far-future head after three refreshes without it', async () => {
    let forged = true;
    const { transport, clock, refresh } = threeNodes(() => (forged ? 10 ** 12 : 100));
    await drive(clock, transport.refreshHealth());
    expect(transport.highestHeight()).toBe(10n ** 12n);
    expect(isStaleView(transport, 100n)).toBe(true);
    forged = false;
    await refresh();
    await refresh();
    expect(isStaleView(transport, 100n)).toBe(true);
    await refresh();
    expect(transport.highestHeight()).toBe(100n);
    expect(isStaleView(transport, 100n)).toBe(false);
  });

  it('keeps a peak that a verified endpoint comes within maxLagBlocks of', async () => {
    let height = 110;
    const { transport, clock, refresh } = threeNodes(() => height);
    await drive(clock, transport.refreshHealth());
    height = 105; // the default maxLagBlocks (5) below the peak of 110
    for (let i = 0; i < 4; i++) await refresh();
    expect(transport.highestHeight()).toBe(110n);
  });
});
