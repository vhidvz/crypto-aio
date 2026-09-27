// A22: drivers receive the wallet's extended public key as plain data (R11), as
// `WalletOptions.hd`, so a family can check change addresses on the xpub chain (A19).
import { HDKey } from '@scure/bip32';
import { internalsOf } from '../../../src/core/blockchain/internal';
import type { WalletOptions } from '../../../src/core/driver/types';
import { walletOptionsOf } from '../../../src/core/signing/wallet';
import { fromHex } from '../../../src/core/util/bytes';
import { createFakeEnv } from '../../../src/testing/env';
import { thrown } from '../../helpers';

const SEED = fromHex('000102030405060708090a0b0c0d0e0f');
const xpub = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'").publicExtendedKey;
const ZPUB = { private: 0x04b2430c, public: 0x04b24746 };
const zpub = HDKey.fromMasterSeed(SEED, ZPUB).derive("m/84'/0'/0'").publicExtendedKey;

/** A26: a refusal repeats no part of the refused input, and chains no library error. */
function expectNoEcho(error: unknown, input: string): void {
  expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
  expect((error as Error).cause).toBeUndefined();
  expect((error as Error).message).not.toContain(input.slice(0, 4));
  expect(JSON.stringify(error)).not.toContain(input.slice(4, 20));
}

describe('the xpub passed to drivers (A22)', () => {
  it('adds the xpub, its path and its versions as a frozen plain copy', () => {
    const versions = { ...ZPUB, label: 'zpub' };
    const options = walletOptionsOf({
      xpub: zpub,
      xpubPath: '0/{index}',
      xpubVersions: versions,
      options: { speed: 'fast' },
      utxo: { addressType: 'p2wpkh' },
    });
    // M5: only the two version numbers are copied.
    expect(options).toEqual({
      speed: 'fast',
      utxo: { addressType: 'p2wpkh' },
      hd: { xpub: zpub, xpubPath: '0/{index}', xpubVersions: ZPUB },
    });
    const hd = options.hd as { readonly xpubVersions: object };
    expect(Object.isFrozen(hd)).toBe(true);
    expect(Object.isFrozen(hd.xpubVersions)).toBe(true);
    expect(hd.xpubVersions).not.toBe(versions);
  });

  it('never passes an hd option the wallet did not configure as its xpub', () => {
    expect(
      walletOptionsOf({ signer: 'hot', options: { hd: { xpub: 'forged' } } }),
    ).toEqual({});
    expect(walletOptionsOf({ xpub, options: { hd: { xpub: 'forged' } } })).toEqual({
      hd: { xpub },
    });
  });

  it('treats an empty xpub as none and refuses a non-string one, as deriveAddress does (M3)', async () => {
    for (const empty of ['', null]) {
      expect(walletOptionsOf({ xpub: empty as never })).toEqual({});
    }
    const error = thrown(() => walletOptionsOf({ xpub: 42 as never }));
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(JSON.stringify(error)).not.toContain('42');
    const env = await createFakeEnv({
      wallets: {
        empty: { signer: 'hot', xpub: '' },
        none: { signer: 'hot', xpub: null as never },
        number: { signer: 'hot', xpub: 42 as never },
      },
    });
    const handle = (wallet: string) =>
      env.aio.blockchain({ chain: 'fakechain', provider: 'fake', wallet });
    for (const wallet of ['empty', 'none']) {
      const resolved = await env.run(internalsOf(handle(wallet)).wallet());
      expect(resolved.options).toEqual({});
      await expect(env.run(env.bc.deriveAddress(wallet, 0))).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
        message: `wallet '${wallet}' has no xpub`,
      });
    }
    const atResolution = await env
      .run(internalsOf(handle('number')).wallet())
      .catch((e: unknown) => e);
    const atDerivation = await env
      .run(env.bc.deriveAddress('number', 0))
      .catch((e: unknown) => e);
    expect(atResolution).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(atDerivation).not.toBeInstanceOf(TypeError);
    expect((atDerivation as Error).message).toBe((atResolution as Error).message);
  });

  it("reaches the driver through the handle's resolved wallet", async () => {
    const env = await createFakeEnv({ wallets: { main: { signer: 'hot', xpub } } });
    const wallet = await env.run(internalsOf(env.bc).wallet());
    expect(wallet.options).toEqual({ hd: { xpub } });
    const plain = await createFakeEnv();
    expect((await plain.run(internalsOf(plain.bc).wallet())).options).toEqual({});
  });

  it("gives the driver the core's hd when it builds and in limits() (M4)", async () => {
    const env = await createFakeEnv({
      wallets: { main: { signer: 'hot', xpub, options: { hd: { xpub: 'forged' } } } },
    });
    const { driver } = await env.run(internalsOf(env.bc).pooled());
    const built: WalletOptions[] = [];
    const limited: WalletOptions[] = [];
    const build = driver.builder.build.bind(driver.builder);
    Object.assign(driver.builder, {
      build: (...args: Parameters<typeof build>) => {
        built.push(args[2].wallet);
        return build(...args);
      },
    });
    Object.assign(driver, {
      limits: (wallet: WalletOptions) => {
        limited.push(wallet);
        return { maxOutputs: 1 };
      },
    });
    await env.run(
      env.bc.prepareTransfer(
        { to: env.stranger(), amount: 1n },
        { idempotencyKey: 'hd-1' },
      ),
    );
    await env.run(env.bc.limits());
    expect(built.length).toBeGreaterThan(0);
    for (const wallet of [...built, ...limited]) {
      expect(wallet).toEqual({ hd: { xpub } });
      expect(Object.isFrozen(wallet['hd'])).toBe(true);
    }
    expect(limited).toHaveLength(1);
  });

  it("keeps a caller's hd from the driver; deriveAddress passes the core's (I1)", async () => {
    const env = await createFakeEnv({ wallets: { deposits: { xpub } } });
    const { driver } = await env.run(internalsOf(env.bc).pooled());
    const seen: (WalletOptions | undefined)[] = [];
    const fromPublicKey = driver.address.fromPublicKey.bind(driver.address);
    Object.assign(driver.address, {
      fromPublicKey: (...args: Parameters<typeof fromPublicKey>) => {
        seen.push(args[1]);
        return fromPublicKey(...args);
      },
    });
    const publicKey = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'/0/0")
      .publicKey as Uint8Array;
    const xprv = HDKey.fromMasterSeed(SEED).privateExtendedKey;
    await env.run(
      env.bc.addressFromPublicKey(publicKey, { hd: { xpub: xprv }, speed: 'fast' }),
    );
    await env.run(env.bc.addressFromPublicKey(publicKey, { hd: { xpub: 'forged' } }));
    await env.run(env.bc.deriveAddress('deposits', 0));
    expect(seen).toEqual([{ speed: 'fast' }, {}, { hd: { xpub } }]);
    expect(JSON.stringify(seen.slice(0, 2))).not.toContain(xprv.slice(4, 20));
  });

  it('refuses a private extended key, naming no key (A26)', () => {
    const tpub = { private: 0x04358394, public: 0x043587cf };
    const cases: readonly (readonly [string, typeof ZPUB | undefined])[] = [
      [HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'").privateExtendedKey, undefined],
      [HDKey.fromMasterSeed(SEED, tpub).privateExtendedKey, undefined],
      [HDKey.fromMasterSeed(SEED, ZPUB).privateExtendedKey, ZPUB],
    ];
    for (const [key, versions] of cases) {
      const error = thrown(() =>
        walletOptionsOf({ xpub: key, ...(versions ? { xpubVersions: versions } : {}) }),
      );
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message: 'expected an extended PUBLIC key; never configure private extended keys',
      });
      expect(String((error as Error).message)).not.toContain(key.slice(4, 20));
      expectNoEcho(error, key);
    }
  });

  it('refuses an unreadable or unknown key at resolution, echoing none of it (I2, M1, M4)', async () => {
    // Public test vectors (Bitcoin wiki, BIP-39): mis-pasted secrets must not be echoed.
    const inputs = {
      checksum: `${xpub.slice(0, -1)}${xpub.endsWith('A') ? 'B' : 'A'}`,
      letter: `${xpub.slice(0, 20)}0${xpub.slice(21)}`,
      zpub,
      mnemonic: `${'abandon '.repeat(11)}about`,
      wif: '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ',
      hex: '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d',
    };
    const wallets = Object.fromEntries(
      Object.entries(inputs).map(([name, key]) => [name, { signer: 'hot', xpub: key }]),
    );
    const env = await createFakeEnv({ wallets });
    for (const [wallet, key] of Object.entries(inputs)) {
      const bc = env.aio.blockchain({ chain: 'fakechain', provider: 'fake', wallet });
      const error = await env.run(internalsOf(bc).wallet()).catch((e: unknown) => e);
      expectNoEcho(error, key);
      expectNoEcho(
        thrown(() => walletOptionsOf({ xpub: key })),
        key,
      );
    }
  });

  it('fails such a wallet before any driver call (A26)', async () => {
    const xprv = HDKey.fromMasterSeed(SEED).privateExtendedKey;
    const env = await createFakeEnv({ wallets: { hdw: { signer: 'hot', xpub: xprv } } });
    const bc = env.aio.blockchain({
      chain: 'fakechain',
      provider: 'fake',
      wallet: 'hdw',
    });
    const { driver } = await env.run(internalsOf(bc).pooled());
    let calls = 0;
    const fromPublicKey = driver.address.fromPublicKey.bind(driver.address);
    Object.assign(driver.address, {
      fromPublicKey: (...args: Parameters<typeof fromPublicKey>) => {
        calls += 1;
        return fromPublicKey(...args);
      },
    });
    Object.assign(driver, {
      limits: () => {
        calls += 1;
        return { maxOutputs: 1 };
      },
    });
    await expect(env.run(internalsOf(bc).wallet())).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(env.run(bc.limits())).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(calls).toBe(0);
  });
});
