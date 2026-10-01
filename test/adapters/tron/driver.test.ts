import { TRON_CHAIN } from '../../../src/adapters/tron/chains';
import { tronwebDriverFactory } from '../../../src/adapters/tron/codec';
import { noopLogger } from '../../../src/core/events/logger';
import type { NetworkInfo } from '../../../src/core/model/chain';
import type { Transport } from '../../../src/core/transport/types';
import { nodeTransport } from './support/harness';
import { GENESIS } from './support/node';
import { toHexAddress } from '../../../src/adapters/tron/address';
import { signedTransaction } from './support/signing';
import { KEY_ADDRESS, KEY_HEX, KEY_PUBLIC, RECIPIENT } from './support/vectors';

async function driverOn(
  options: {
    network?: string;
    withIndexer?: boolean;
    driverOptions?: Record<string, unknown>;
  } = {},
) {
  const t = nodeTransport({ network: options.network ?? 'nile', solidDepth: 2 }, [
    'a',
    'b',
  ]);
  const driver = await t.run(
    tronwebDriverFactory.create({
      chain: TRON_CHAIN,
      network: TRON_CHAIN.networks.nile as NetworkInfo,
      library: 'tronweb',
      transport: t.transport,
      ...(options.withIndexer ? { indexer: t.transport } : {}),
      clock: t.clock,
      log: noopLogger,
      options: options.driverOptions ?? {},
    }),
  );
  return { ...t, driver };
}

describe('tronwebDriverFactory', () => {
  it('assembles an expiry driver with the Tron capabilities; history comes with an indexer', async () => {
    const { driver } = await driverOn();
    expect(driver.ordering).toBe('expiry');
    expect([...driver.capabilities].sort()).toEqual([
      'block-scan',
      'expiry',
      'hd-public-derivation',
      'memo',
      'tokens',
    ]);
    expect(driver.replacement).toBeUndefined();
    expect(driver.sequence).toBeUndefined();
    expect(driver.history).toBeUndefined();
    expect(driver.limits?.({})).toEqual({ maxOutputs: 1 });
    expect(driver.address.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    const indexed = await driverOn({ withIndexer: true });
    expect(indexed.driver.capabilities.has('address-history')).toBe(true);
    expect(indexed.driver.history).toBeDefined();
  });

  it('sets the probes exactly once on the transport and the indexer, before any traffic', async () => {
    const t = nodeTransport({ solidDepth: 2 });
    const log: string[] = [];
    const counting = (name: string): Transport =>
      new Proxy(t.transport, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            log.push(`${name}.${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const driver = await t.run(
      tronwebDriverFactory.create({
        chain: TRON_CHAIN,
        network: TRON_CHAIN.networks.nile as NetworkInfo,
        library: 'tronweb',
        transport: counting('rpc'),
        indexer: counting('indexer'),
        clock: t.clock,
        log: noopLogger,
        options: {},
      }),
    );
    await t.run(driver.reader.getBlockHeight());
    expect(log.filter((l) => l.endsWith('.setProbes'))).toEqual([
      'rpc.setProbes',
      'indexer.setProbes',
    ]);
    expect(log.slice(0, 2)).toEqual(['rpc.setProbes', 'indexer.setProbes']);
  });

  it('checks every endpoint against the network identity: block 0', async () => {
    const good = await driverOn();
    await good.run(good.transport.refreshHealth());
    expect(good.transport.status().map((s) => s.state)).toEqual(['healthy', 'healthy']);
    const wrong = await driverOn({ network: 'shasta' });
    await wrong.run(wrong.transport.refreshHealth());
    expect(wrong.transport.status().map((s) => s.state)).toEqual([
      'disabled',
      'disabled',
    ]);
    expect(wrong.seen.some((e) => e.type === 'provider.misconfigured')).toBe(true);
  });

  it('validates options with CONFIG_INVALID', async () => {
    for (const driverOptions of [
      { expirationMs: 1_000 },
      { expirationMs: 600_000 },
      { energyMarginPercent: 1.5 },
      { maxFeeLimit: 0n },
      { maxFeeLimit: 100_000_000 },
    ]) {
      await expect(driverOn({ driverOptions })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    }
    await expect(
      driverOn({ driverOptions: { expirationMs: 120_000, maxFeeLimit: 500_000_000n } }),
    ).resolves.toBeDefined();
  });

  it('serves ext.tron and a fresh native TronWeb client on the same transport', async () => {
    const { driver, node, run, calls } = await driverOn();
    node.fund(KEY_ADDRESS, 3n);
    expect(
      await run(
        driver.ext?.tron?.getResources?.(KEY_ADDRESS as never) as Promise<unknown>,
      ),
    ).toMatchObject({
      activated: true,
    });
    const first = driver.createNativeClient?.();
    const second = driver.createNativeClient?.();
    expect(first?.client).not.toBe(second?.client);
    const client = first?.client as { trx: { getBalance(a: string): Promise<number> } };
    expect(await run(client.trx.getBalance(KEY_ADDRESS))).toBe(3);
    expect(calls.at(-1)).toMatchObject({
      path: expect.stringMatching(/^\/wallet(solidity)?\/getaccount$/),
      tags: { purpose: 'read', retry: 'safe' },
    });
    expect(await run(client.trx.getBalance(RECIPIENT))).toBe(0);
  });

  it('never waits on a real timer on any driver request path', async () => {
    const { driver, run, node, clock } = await driverOn();
    node.fund(KEY_ADDRESS, 100_000_000n);
    // Genesis serves no timestamp (proto3): a build needs a mined head to reference.
    node.mine();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    try {
      const intent = {
        asset: 'native' as const,
        outputs: [{ to: RECIPIENT, amount: 5n }],
        from: KEY_ADDRESS,
        fee: 'normal' as const,
      };
      const build = {
        from: KEY_ADDRESS,
        keys: [{ scheme: 'secp256k1-ecdsa', publicKey: KEY_PUBLIC }],
        wallet: {},
      };
      const fee = await run(driver.builder.estimateFee(intent, build));
      await run(driver.builder.build(intent, fee, build));
      await run(driver.reader.getFinalizedHeight());
      await run(driver.proofs.blockHash(0n, 'finalized'));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(clock.pending).toBe(0);
  });

  it("tags the native client's broadcasts ambiguous-on-failure", async () => {
    const { driver, run, node, calls } = await driverOn();
    node.fund(KEY_ADDRESS, 10_000_000n);
    const head = node.block(node.head) as { id: string; timestamp: number };
    const tx = signedTransaction({
      refBlockBytes: head.id.slice(12, 16),
      refBlockHash: head.id.slice(16, 32),
      expiration: head.timestamp + 60_000,
      timestamp: head.timestamp,
      contract: {
        type: 'TransferContract',
        owner: KEY_HEX,
        to: toHexAddress(RECIPIENT),
        amount: 1n,
      },
    });
    const client = driver.createNativeClient?.().client as {
      trx: { sendHexTransaction(hex: string): Promise<{ result?: boolean }> };
    };
    expect(await run(client.trx.sendHexTransaction(tx.hex))).toMatchObject({
      result: true,
    });
    expect(calls.at(-1)).toEqual({
      path: '/wallet/broadcasthex',
      tags: { purpose: 'broadcast', retry: 'ambiguous-on-failure' },
    });
    expect(node.inPool(tx.id)).toBe(true);
  });

  it('fails the identity check of an endpoint that lacks the solidity or JSON-RPC service', async () => {
    const t = await driverOn();
    t.node.intercept('b', '/jsonrpc', () => ({ status: 404, text: 'Not Found' }));
    await t.run(t.transport.refreshHealth());
    expect(t.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'healthy'],
      ['b', expect.not.stringMatching(/^healthy$/)],
    ]);
    const solid = await driverOn();
    solid.node.intercept('a', '/walletsolidity/getblockbynum', () => ({
      status: 404,
      text: 'Not Found',
    }));
    await solid.run(solid.transport.refreshHealth());
    expect(solid.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', expect.not.stringMatching(/^healthy$/)],
      ['b', 'healthy'],
    ]);
    // Services that answer for another chain: each must serve this network's block 0.
    const mixed = await driverOn();
    mixed.node.intercept('a', '/walletsolidity/getblockbynum', () => ({
      json: { blockID: GENESIS.shasta, block_header: { raw_data: {} } },
    }));
    mixed.node.intercept('b', '/jsonrpc', (request) => ({
      json: {
        jsonrpc: '2.0',
        id: request.json().id,
        result: { hash: `0x${GENESIS.shasta as string}` },
      },
    }));
    await mixed.run(mixed.transport.refreshHealth());
    expect(mixed.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', expect.not.stringMatching(/^healthy$/)],
      ['b', expect.not.stringMatching(/^healthy$/)],
    ]);
  });
});
