import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { secret } from '../../../src/core/secret/secret';
import {
  deriveEd25519,
  deriveSecp256k1,
  deriveXpubChild,
  mnemonicToSeed,
  parsePath,
} from '../../../src/core/signing/hd';
import { localSigner } from '../../../src/core/signing/local';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { thrown } from '../../helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SEED_1 = fromHex('000102030405060708090a0b0c0d0e0f');

describe('BIP39', () => {
  it('matches the reference seed vectors', () => {
    expect(toHex(mnemonicToSeed(MNEMONIC))).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
    );
    expect(toHex(mnemonicToSeed(MNEMONIC, 'TREZOR'))).toBe(
      'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
    );
  });

  it('rejects invalid mnemonics without echoing them', () => {
    const error = thrown(() => mnemonicToSeed('abandon abandon zebra'));
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain('zebra');
  });
});

describe('derivation', () => {
  it('matches BIP32 test vector 1', () => {
    expect(toHex(deriveSecp256k1(SEED_1, "m/0'/1/2'/2/1000000000"))).toBe(
      '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8',
    );
  });

  it('matches BIP32 test vector 1 via the h/H hardened markers and surrounding whitespace', () => {
    expect(toHex(deriveSecp256k1(SEED_1, 'm/0h/1/2H/2/1000000000'))).toBe(
      '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8',
    );
    expect(toHex(deriveSecp256k1(SEED_1, " m/0'/1/2'/2/1000000000 "))).toBe(
      '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8',
    );
  });

  it('matches SLIP-10 ed25519 test vector 1', () => {
    expect(toHex(deriveEd25519(SEED_1, 'm'))).toBe(
      '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    );
    expect(toHex(deriveEd25519(SEED_1, "m/0'"))).toBe(
      '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    );
    expect(toHex(deriveEd25519(SEED_1, "m/0'/1'"))).toBe(
      'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    );
    expect(thrown(() => deriveEd25519(SEED_1, 'm/0'))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/hardened/),
    });
  });

  it('parses paths strictly', () => {
    expect(parsePath("m/44'/60h/0H/0/5")).toEqual([
      { index: 44, hardened: true },
      { index: 60, hardened: true },
      { index: 0, hardened: true },
      { index: 0, hardened: false },
      { index: 5, hardened: false },
    ]);
    expect(thrown(() => parsePath('44/0'))).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(thrown(() => parsePath('m/x'))).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(thrown(() => parsePath(`m/${2 ** 31}`))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(thrown(() => parsePath(`m/${2 ** 31}'`))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('derives the same public key from an xpub as from the private path', () => {
    const account = HDKey.fromMasterSeed(SEED_1).derive("m/44'/0'/0'");
    const fromXpub = deriveXpubChild(account.publicExtendedKey, '0/7');
    const fromPrivate = HDKey.fromMasterSeed(SEED_1).derive("m/44'/0'/0'/0/7").publicKey;
    expect(toHex(fromXpub)).toBe(toHex(fromPrivate as Uint8Array));
    expect(
      thrown(() => deriveXpubChild(account.privateExtendedKey, '0/1')),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(thrown(() => deriveXpubChild('zpub6r...', '0/1'))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/xpubVersions/),
    });
    expect(
      thrown(() => deriveXpubChild(account.publicExtendedKey, "0'/1")),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

/** SLIP-0132 version pairs, `{ private, public }`, exactly as the standard registers them. */
const TPUB = { private: 0x04358394, public: 0x043587cf };
const ZPUB = { private: 0x04b2430c, public: 0x04b24746 };
const VPUB = { private: 0x045f18bc, public: 0x045f1cf6 };

describe('deriveXpubChild network class', () => {
  const key = (versions?: { private: number; public: number }) =>
    HDKey.fromMasterSeed(SEED_1, versions).derive("m/84'/0'/0'").publicExtendedKey;
  const mainnet = { testnet: false };
  const test = { testnet: true };

  it('refuses an extended key of the other network class', () => {
    for (const [xpub, versions, network] of [
      [key(), undefined, test],
      [key(ZPUB), ZPUB, test],
      [key(TPUB), undefined, mainnet],
      [key(VPUB), VPUB, mainnet],
    ] as const) {
      const error = thrown(() => deriveXpubChild(xpub, '0/1', versions, network));
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
      expect(String((error as Error).message)).not.toContain(xpub.slice(4, 20));
      expect(JSON.stringify(error)).not.toContain(xpub.slice(4, 20));
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('derives from a key of the matching class, or when no network is given', () => {
    expect(deriveXpubChild(key(), '0/1', undefined, mainnet)).toHaveLength(33);
    expect(deriveXpubChild(key(ZPUB), '0/1', ZPUB, mainnet)).toHaveLength(33);
    expect(deriveXpubChild(key(TPUB), '0/1', undefined, test)).toHaveLength(33);
    expect(deriveXpubChild(key(VPUB), '0/1', VPUB, test)).toHaveLength(33);
    expect(deriveXpubChild(key(), '0/1', undefined, undefined)).toHaveLength(33);
    // An unlisted version (outside the Bitcoin SLIP-0132 table) has no known class and is
    // not checked.
    const other = { private: 0x0488ade5, public: 0x0488b21f };
    expect(deriveXpubChild(key(other), '0/1', other, test)).toHaveLength(33);
  });

  it('refuses a private key before its network class', () => {
    const tprv = HDKey.fromMasterSeed(SEED_1, TPUB).derive(
      "m/84'/1'/0'",
    ).privateExtendedKey;
    for (const versions of [undefined, TPUB]) {
      const error = thrown(() => deriveXpubChild(tprv, '0/1', versions, mainnet));
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message: 'expected an extended PUBLIC key; never configure private extended keys',
      });
      expect(JSON.stringify(error)).not.toContain(tprv.slice(4, 20));
    }
  });

  it('refuses an unknown, unreadable or non-string key with a fixed text', () => {
    const unreadable = `${key().slice(0, 20)}0${key().slice(21)}`;
    for (const input of [`${'abandon '.repeat(11)}about`, unreadable, 42 as never]) {
      const error = thrown(() => deriveXpubChild(input, '0/1'));
      expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
      expect(error).not.toBeInstanceOf(TypeError);
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toContain(String(input).slice(0, 4));
    }
  });
});

describe('localSigner.fromMnemonic', () => {
  it('derives per keyRef.path for each curve', async () => {
    const signer = localSigner.fromMnemonic(secret(MNEMONIC));
    const ethPath = "m/44'/60'/0'/0/0";
    const solPath = "m/44'/501'/0'/0'";
    const seed = mnemonicToSeed(MNEMONIC);
    expect(toHex(await signer.getPublicKey('secp256k1-ecdsa', { path: ethPath }))).toBe(
      toHex(secp256k1.getPublicKey(deriveSecp256k1(seed, ethPath), true)),
    );
    expect(toHex(await signer.getPublicKey('ed25519', { path: solPath }))).toBe(
      toHex(ed25519.getPublicKey(deriveEd25519(seed, solPath))),
    );
    await expect(signer.getPublicKey('ed25519')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/keyRef.path/),
    });
  });
});
