// A22: drivers receive the wallet's extended public key as plain data (R11), as
// `WalletOptions.hd`, so a family can check change addresses on the xpub chain (A19).
import { HDKey } from '@scure/bip32';
import { internalsOf } from '../../../src/core/blockchain/internal';
import { walletOptionsOf } from '../../../src/core/signing/wallet';
import { fromHex } from '../../../src/core/util/bytes';
import { createFakeEnv } from '../../../src/testing/env';
import { thrown } from '../../helpers';

const SEED = fromHex('000102030405060708090a0b0c0d0e0f');
const xpub = HDKey.fromMasterSeed(SEED).derive("m/84'/0'/0'").publicExtendedKey;
const ZPUB = { private: 0x04b2430c, public: 0x04b24746 };

describe('the xpub passed to drivers (A22)', () => {
  it('adds the xpub, its path and its versions as a frozen plain copy', () => {
    const versions = { ...ZPUB };
    const zpub = HDKey.fromMasterSeed(SEED, ZPUB).derive("m/84'/0'/0'").publicExtendedKey;
    const options = walletOptionsOf({
      xpub: zpub,
      xpubPath: '0/{index}',
      xpubVersions: versions,
      options: { speed: 'fast' },
      utxo: { addressType: 'p2wpkh' },
    });
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

  it("reaches the driver through the handle's resolved wallet", async () => {
    const env = await createFakeEnv({ wallets: { main: { signer: 'hot', xpub } } });
    const wallet = await env.run(internalsOf(env.bc).wallet());
    expect(wallet.options).toEqual({ hd: { xpub } });
    const plain = await createFakeEnv();
    expect((await plain.run(internalsOf(plain.bc).wallet())).options).toEqual({});
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
    await expect(env.run(internalsOf(bc).wallet())).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(calls).toBe(0);
  });
});
