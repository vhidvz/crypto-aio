import { walletAddress } from '../../../src/adapters/utxo/address';
import { BITCOIN_CHAIN } from '../../../src/adapters/utxo/chains';
import {
  utxoDriverFactory,
  type UtxoNativeClient,
} from '../../../src/adapters/utxo/driver';
import { MAX_OUTPUTS } from '../../../src/adapters/utxo/spend';
import { UTXO_CAPABILITIES } from '../../../src/adapters/utxo/network';
import type { UtxoExt, UtxoSelectionRequest } from '../../../src/adapters/utxo/types';
import { noopLogger } from '../../../src/core/events/logger';
import type { Transport } from '../../../src/core/transport/types';
import { REGTEST_NETWORK, utxoHarness, withDriver } from './support/harness';
import { OTHER_PUBKEY, REGTEST, TEST_PUBKEY } from './support/vectors';

const OWN = walletAddress(TEST_PUBKEY, 'p2wpkh', REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);

describe('the UTXO driver factory', () => {
  it('builds every port of the inputs ordering', async () => {
    const h = await utxoHarness();
    const driver = await withDriver(h);
    expect(driver.ordering).toBe('inputs');
    expect([...driver.capabilities]).toEqual(UTXO_CAPABILITIES);
    expect(driver.sequence).toBeUndefined();
    expect(driver.replacement).toMatchObject({ replace: true, cancel: true });
    expect(driver.blocks).toBeDefined();
    expect(driver.history).toBeDefined();
    expect(driver.builder.signaturesFrom).toBeDefined();
    expect(driver.limits?.({})).toEqual({ maxOutputs: MAX_OUTPUTS });
  });

  it('probes both transports with the genesis hash and disables an endpoint of another network', async () => {
    const good = await utxoHarness();
    await withDriver(good);
    await good.run(good.transport.refreshHealth());
    await good.run(good.indexer.refreshHealth());
    expect(good.transport.status().map((s) => s.state)).toEqual(['healthy']);
    expect(good.indexer.status().map((s) => s.state)).toEqual(['healthy']);
    const other = await utxoHarness({
      node: {
        genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
      },
    });
    await withDriver(other);
    await other.run(other.transport.refreshHealth());
    await other.run(other.indexer.refreshHealth());
    expect(other.transport.status().map((s) => s.state)).toEqual(['disabled']);
    expect(other.indexer.status().map((s) => s.state)).toEqual(['disabled']);
  });

  it('sets the probes exactly once on each transport, before any traffic', async () => {
    const h = await utxoHarness();
    const seen: string[] = [];
    const counting = (name: string, inner: Transport): Transport =>
      new Proxy(inner, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            seen.push(`${name}.${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    await utxoDriverFactory.create({
      chain: BITCOIN_CHAIN,
      network: REGTEST_NETWORK,
      library: 'bitcoinjs-lib',
      transport: counting('rpc', h.transport),
      indexer: counting('indexer', h.indexer),
      clock: h.clock,
      log: noopLogger,
      options: {},
    });
    expect(seen).toEqual(['rpc.setProbes', 'indexer.setProbes']);
  });

  it('refuses bad handle options and a missing indexer with CONFIG_INVALID', async () => {
    const h = await utxoHarness();
    const context = {
      chain: BITCOIN_CHAIN,
      network: REGTEST_NETWORK,
      library: 'bitcoinjs-lib',
      transport: h.transport,
      clock: h.clock,
      log: noopLogger,
    };
    await expect(
      utxoDriverFactory.create({
        ...context,
        indexer: h.indexer,
        options: { coinSelection: 'random' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      utxoDriverFactory.create({ ...context, options: {} }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('exposes ext.utxo: unspent outputs and a coin selection preview', async () => {
    const h = await utxoHarness();
    h.node.fund(OWN.address, 60_000n);
    h.node.fund(OWN.address, 50_000n);
    const ext = (await withDriver(h)).ext as unknown as UtxoExt;
    expect((await h.run(ext.utxo.listUnspent(OWN.address))).map((u) => u.value)).toEqual([
      60_000n,
      50_000n,
    ]);
    const preview = await h.run(
      ext.utxo.coinSelection({
        from: OWN.address,
        outputs: [{ to: PAYEE.address, amount: 80_000n }],
      }),
    );
    expect(preview).toMatchObject({ sufficient: true, satPerKvB: 10_000n });
    expect(preview.inputs.map((i) => i.value)).toEqual([60_000n, 50_000n]);
    const short = await h.run(
      ext.utxo.coinSelection({
        from: OWN.address,
        outputs: [{ to: PAYEE.address, amount: 200_000n }],
      }),
    );
    expect(short.sufficient).toBe(false);
  });

  it('previews without the outputs it is told to exclude, and refuses a malformed request', async () => {
    const h = await utxoHarness();
    const first = h.node.fund(OWN.address, 60_000n);
    h.node.fund(OWN.address, 50_000n);
    const ext = (await withDriver(h)).ext as unknown as UtxoExt;
    const outputs = [{ to: PAYEE.address, amount: 40_000n }];
    const preview = await h.run(
      ext.utxo.coinSelection({ from: OWN.address, outputs, exclude: [first] }),
    );
    expect(preview.inputs.map((i) => i.value)).toEqual([50_000n]);
    // Never a foreign TypeError from a caller's shape: fixed-text validation errors.
    const refusals: [unknown, string][] = [
      [null, 'INVALID_INTENT'],
      [{ from: OWN.address }, 'INVALID_INTENT'],
      [{ from: OWN.address, outputs: [null] }, 'INVALID_INTENT'],
      [
        { from: OWN.address, outputs: [{ to: PAYEE.address, amount: 40_000 }] },
        'INVALID_AMOUNT',
      ],
      [
        { from: OWN.address, outputs: [{ to: PAYEE.address, amount: -1n }] },
        'INVALID_AMOUNT',
      ],
      [{ from: OWN.address, outputs, exclude: first }, 'INVALID_INTENT'],
      [{ from: OWN.address, outputs, exclude: [7] }, 'INVALID_INTENT'],
      [{ from: 7, outputs }, 'INVALID_ADDRESS'],
    ];
    for (const [request, code] of refusals) {
      await expect(
        h.run(ext.utxo.coinSelection(request as UtxoSelectionRequest)),
      ).rejects.toMatchObject({ code });
    }
  });

  it('creates a fresh native client on every call, wired to the transport', async () => {
    const h = await utxoHarness();
    const driver = await withDriver(h);
    const a = driver.createNativeClient?.().client as UtxoNativeClient;
    const b = driver.createNativeClient?.().client as UtxoNativeClient;
    expect(a).not.toBe(b);
    expect(a.network).not.toBe(b.network);
    expect(a.network.bech32).toBe('bcrt');
    expect(typeof a.bitcoin.Psbt).toBe('function');
    expect(await h.run(a.esplora<string>('/blocks/tip/height', 'text'))).toBe('0');
  });
});
