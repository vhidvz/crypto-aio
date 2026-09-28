import { CryptoAio, noopLogger } from '../../../src';
import { tronManifest, tronPlugin } from '../../../src/adapters/tron/plugin';
import { TRON_PRESETS } from '../../../src/adapters/tron/presets';
import { samePlugin } from '../../../src/core/registry/plugin';
import { REDACTED, secret } from '../../../src/core/secret/secret';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { thrown } from '../../helpers';
import { ScriptedTronNode } from './support/node';
import { KEY_ADDRESS } from './support/vectors';

function container(
  network = 'nile',
  extra: Partial<ConstructorParameters<typeof CryptoAio>[0]> = {},
) {
  const clock = new FakeClock(1_790_000_000_000);
  const node = new ScriptedTronNode({ clock, network });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: { local: { endpoints: [{ url: node.endpoint('main') }] } },
    ...extra,
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

describe('the built-in Tron plugin', () => {
  it('registers tron with tronweb as its library and the Tron capabilities', async () => {
    const { aio, node, run } = container();
    const bc = aio.blockchain({ chain: 'tron', network: 'nile', provider: 'local' });
    expect([bc.chain, bc.network, bc.library]).toEqual(['tron', 'nile', 'tronweb']);
    expect([...bc.capabilities].sort()).toEqual([
      'block-scan',
      'expiry',
      'hd-public-derivation',
      'memo',
      'tokens',
    ]);
    expect(bc.supports('replace-fee')).toBe(false);
    node.fund(KEY_ADDRESS, 1_500_000n);
    await run(bc.ready());
    expect((await run(bc.getBalance(KEY_ADDRESS))).amount.toDecimalString()).toBe('1.5');
    await expect(run(bc.history(KEY_ADDRESS, { limit: 1 }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    const indexed = aio.blockchain({
      chain: 'tron',
      network: 'nile',
      provider: 'local',
      indexer: 'local',
    });
    expect(indexed.supports('address-history')).toBe(true);
    expect(indexed.supports('cancel')).toBe(false);
    await aio.close();
  });

  it('resolves USDT by alias on mainnet only', async () => {
    const { aio, run } = container('mainnet');
    const bc = aio.blockchain({ chain: 'tron', provider: 'local' });
    expect((await run(bc.resolveAsset('USDT'))).id).toBe(
      'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    );
    await expect(
      run(
        aio
          .blockchain({ chain: 'tron', network: 'nile', provider: 'local' })
          .resolveAsset('USDT'),
      ),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    await aio.close();
  });

  it('builds TronGrid endpoints: the key in a Secret header, never in the URL', () => {
    const trongrid = TRON_PRESETS.find((p) => p.name === 'trongrid' && p.kind === 'rpc');
    const [endpoint] =
      trongrid?.endpoints({
        chain: 'tron',
        network: 'mainnet',
        apiKey: secret('k-123'),
      }) ?? [];
    expect(endpoint?.url).toBe('https://api.trongrid.io');
    expect(String(endpoint?.headers?.['TRON-PRO-API-KEY'])).toBe(REDACTED);
    for (const apiKey of [undefined, '', secret('  ')]) {
      expect(() =>
        trongrid?.endpoints({
          chain: 'tron',
          network: 'nile',
          ...(apiKey !== undefined ? { apiKey } : {}),
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message: expect.not.stringContaining('k-123'),
        }),
      );
    }
    const publicPreset = TRON_PRESETS.find(
      (p) => p.name === 'public' && p.kind === 'indexer',
    );
    expect(publicPreset?.production).toBe(false);
    expect(publicPreset?.endpoints({ chain: 'tron', network: 'shasta' })).toEqual([
      { name: 'trongrid-public', url: 'https://api.shasta.trongrid.io', kind: 'indexer' },
    ]);
    expect(trongrid?.supports('tron', 'goerli')).toBe(false);
    expect(trongrid?.supports('ethereum', 'mainnet')).toBe(false);
  });

  it('is data only: registering it loads no SDK', () => {
    const plugin = tronPlugin();
    expect(
      plugin.adapters?.map((m) => [m.family, m.library, m.chains, m.peerDependencies]),
    ).toEqual([['tron', 'tronweb', ['tron'], [{ name: 'tronweb', range: '^6.5.1' }]]]);
    expect(Object.isFrozen(plugin.chains?.[0]?.networks.mainnet)).toBe(true);
  });

  it('ships the deep-frozen presets, the keyless one with no rate limit (A28)', () => {
    const { presets } = tronPlugin();
    expect(presets).toBe(TRON_PRESETS);
    expect(presets?.every((preset) => Object.isFrozen(preset))).toBe(true);
    // TronGrid publishes no keyless rate, so none is guessed: the endpoint is the bare host.
    for (const kind of ['rpc', 'indexer'] as const) {
      const keyless = presets?.find((p) => p.name === 'public' && p.kind === kind);
      expect(keyless?.endpoints({ chain: 'tron', network: 'mainnet' })).toEqual([
        { name: 'trongrid-public', url: 'https://api.trongrid.io', kind },
      ]);
    }
  });
});

describe('the built-in Tron plugin registered again (A18, X6)', () => {
  it('keeps use() idempotent for the same plugin, and refuses another named tron', async () => {
    // The composition root already registered tronPlugin(); these are fresh copies of it.
    expect(samePlugin(tronPlugin(), tronPlugin())).toBe(true);
    const { aio } = container('nile', { plugins: [tronPlugin()] });
    expect(() => aio.use(tronPlugin())).not.toThrow();
    // Functions match by identity: the same manifest around a new `load` is another plugin.
    const rebuilt = {
      ...tronPlugin(),
      adapters: [{ ...tronManifest, load: () => tronManifest.load() }],
    };
    for (const other of [{ name: 'tron' }, rebuilt]) {
      expect(thrown(() => aio.use(other))).toMatchObject({
        code: 'CONFIG_INVALID',
        message: "plugin 'tron' is already registered with a different definition",
      });
    }
    await aio.close();
  });
});
