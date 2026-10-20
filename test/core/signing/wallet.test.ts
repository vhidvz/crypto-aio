import { inspect } from 'node:util';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { ResolvedSelection } from '../../../src/core/config/types';
import type { ChainDriver, WalletOptions } from '../../../src/core/driver/types';
import { ProviderError } from '../../../src/core/errors/error';
import { BUILTIN_SCHEMES, SchemeCatalog } from '../../../src/core/registry/schemes';
import { secret } from '../../../src/core/secret/secret';
import { callbackSigner } from '../../../src/core/signing/callback';
import { localSigner } from '../../../src/core/signing/local';
import type { Signer } from '../../../src/core/signing/types';
import { resolveWallet } from '../../../src/core/signing/wallet';
import { toHex } from '../../../src/core/util/bytes';

const hot = localSigner({
  id: 'hot',
  secp256k1: secret(secp256k1.utils.randomPrivateKey()),
});
const cold = localSigner({
  id: 'cold',
  secp256k1: secret(secp256k1.utils.randomPrivateKey()),
});

/** Just enough of a driver for `resolveWallet`: the address is the key's hex. */
const driver = {
  address: {
    validate: () => true,
    normalize: (address: string) => ({ canonical: address, display: address }),
    fromPublicKey: (publicKey: Uint8Array) => ({
      canonical: toHex(publicKey),
      display: toHex(publicKey),
    }),
  },
} as unknown as ChainDriver;

const catalog = new SchemeCatalog(BUILTIN_SCHEMES);

function selection(signer: Signer): ResolvedSelection {
  return {
    chain: { id: 'c', schemes: ['secp256k1-ecdsa'] },
    wallet: { name: 'w', config: { signer: signer.id, signers: { vault: 'cold' } } },
    signer: { id: signer.id, instance: signer },
  } as unknown as ResolvedSelection;
}

describe('resolveWallet', () => {
  it('signerById finds the primary and configured signers by own key only', async () => {
    const wallet = await resolveWallet(selection(hot), driver, { hot, cold }, catalog);
    expect(wallet.signerById('hot')).toEqual({ id: 'hot', signer: hot });
    expect(wallet.signerById('cold')).toEqual({ id: 'cold', signer: cold });
    expect(wallet.signerById('missing')).toBeUndefined();
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(wallet.signerById(inherited)).toBeUndefined();
    }
  });

  /** A signer whose `getPublicKey` does `publicKey()`. */
  function custody(publicKey: () => Promise<unknown>): Signer {
    return callbackSigner({
      id: 'hsm',
      schemes: ['secp256k1-ecdsa'],
      getPublicKey: () => publicKey() as Promise<Uint8Array>,
      sign: async () => ({ status: 'pending' }),
    });
  }

  async function resolveWith(signer: Signer) {
    return resolveWallet(
      selection(signer),
      driver,
      { [signer.id]: signer },
      catalog,
    ).catch((error: unknown) => error);
  }

  it('turns a failing getPublicKey into SIGNER_UNAVAILABLE without leaking its URL', async () => {
    const error = await resolveWith(
      custody(async () => {
        throw new Error('HSM at https://hsm.io/SECRETKEY1234567890abc refused');
      }),
    );
    expect(error).toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
    expect(JSON.stringify(error)).not.toContain('SECRETKEY1234567890abc');
  });

  it('lets a CryptoAioError from getPublicKey through unchanged', async () => {
    const original = new ProviderError('PROVIDER_UNAVAILABLE', 'kms down');
    const error = await resolveWith(
      custody(async () => {
        throw original;
      }),
    );
    expect(error).toBe(original);
  });

  it.each<[string, unknown]>([
    [
      'a hex-string public key',
      toHex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true)),
    ],
    ['a wrong-length public key', new Uint8Array(32).fill(2)],
    ['no public key', undefined],
  ])('rejects %s with SIGNER_UNAVAILABLE', async (_label, key) => {
    const error = await resolveWith(custody(async () => key));
    expect(error).toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    expect(error).not.toBeInstanceOf(TypeError);
  });

  it('keeps its own copy of the public key', async () => {
    const key = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
    const original = key.slice();
    const wallet = await resolveWallet(
      selection(custody(async () => key)),
      driver,
      {},
      catalog,
    );
    key.fill(0);
    expect(wallet.keys[0]?.publicKey).toEqual(original);
  });

  it.each<[string, unknown]>([
    ['a short key', toHex(new Uint8Array(32).fill(2))],
    [
      'an uncompressed key',
      toHex(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false)),
    ],
    ['odd hex', '0x02abc'],
    ['not hex', 'zz'.repeat(33)],
    ['not a string', 7],
  ])(
    'refuses a watch-only publicKey that is %s with CONFIG_INVALID',
    async (_label, publicKey) => {
      const watchOnly = {
        chain: { id: 'c', schemes: ['secp256k1-ecdsa'] },
        wallet: { name: 'w', config: { publicKey } },
      } as unknown as ResolvedSelection;
      const error = await resolveWallet(watchOnly, driver, {}, catalog).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message: "wallet 'w': publicKey must be 33 bytes of hex for secp256k1-ecdsa",
      });
    },
  );

  it('takes a watch-only publicKey of the right length, with or without 0x', async () => {
    const key = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
    for (const publicKey of [toHex(key), toHex(key, true)]) {
      const watchOnly = {
        chain: { id: 'c', schemes: ['secp256k1-ecdsa'] },
        wallet: { name: 'w', config: { publicKey } },
      } as unknown as ResolvedSelection;
      const wallet = await resolveWallet(watchOnly, driver, {}, catalog);
      expect(wallet.keys[0]?.publicKey).toEqual(key);
      expect(wallet.watchOnly).toBe(true);
    }
  });

  describe("a driver that narrows the schemes by the wallet's options", () => {
    /** `{ options: { taproot: true } }` wallets sign with Schnorr only, others with ECDSA. */
    const narrowing = {
      ...driver,
      signingSchemes: (wallet: WalletOptions) => [
        wallet.taproot === true ? 'secp256k1-schnorr' : 'secp256k1-ecdsa',
      ],
    } as unknown as ChainDriver;
    const key = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
    /** An ECDSA-only custody signer, recording each key it is asked for. */
    function ecdsaOnly(reads: string[]): Signer {
      return callbackSigner({
        id: 'kms',
        schemes: ['secp256k1-ecdsa'],
        getPublicKey: async (scheme) => {
          reads.push(scheme);
          return key;
        },
        sign: async () => ({ status: 'pending' }),
      });
    }
    function taproot(config: Record<string, unknown>, signer?: Signer) {
      return {
        chain: { id: 'c', schemes: ['secp256k1-ecdsa', 'secp256k1-schnorr'] },
        wallet: { name: 'w', config: { ...config, options: { taproot: true } } },
        ...(signer ? { signer: { id: signer.id, instance: signer } } : {}),
      } as unknown as ResolvedSelection;
    }

    it('refuses a signer without a scheme the wallet needs with CONFIG_INVALID, before reading any key', async () => {
      const reads: string[] = [];
      const kms = ecdsaOnly(reads);
      const error = await resolveWallet(
        taproot({ signer: 'kms' }, kms),
        narrowing,
        { kms },
        catalog,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          "signer 'kms' supports secp256k1-ecdsa but wallet 'w' needs secp256k1-schnorr",
      });
      expect(reads).toEqual([]);
      // Without the option, the same signer signs what the wallet needs.
      const plain = await resolveWallet(
        { ...taproot({ signer: 'kms' }, kms), wallet: { name: 'w', config: {} } },
        narrowing,
        { kms },
        catalog,
      );
      expect(plain.keys.map((k) => k.scheme)).toEqual(['secp256k1-ecdsa']);
    });

    it("takes a signer with every scheme, keeping the chain's first scheme's key first", async () => {
      const wallet = await resolveWallet(
        taproot({ signer: 'hot' }, hot),
        narrowing,
        { hot },
        catalog,
      );
      expect(wallet.keys.map((k) => k.scheme)).toEqual([
        'secp256k1-ecdsa',
        'secp256k1-schnorr',
      ]);
      expect(wallet.watchOnly).toBe(false);
    });

    it('leaves a watch-only wallet unchecked: it signs nothing', async () => {
      const wallet = await resolveWallet(
        taproot({ publicKey: toHex(key) }),
        narrowing,
        {},
        catalog,
      );
      expect(wallet).toMatchObject({ watchOnly: true, keys: [{ publicKey: key }] });
    });
  });

  it('guards reading the signer scheme list', async () => {
    const unreadable = {
      id: 'odd',
      get schemes(): never {
        throw new Error('vault https://vault.io/SECRETKEY1234567890abc sealed');
      },
      getPublicKey: async () => new Uint8Array(33),
      sign: async () => ({ status: 'pending' }) as const,
    } as Signer;
    const error = await resolveWith(unreadable);
    expect(error).toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    expect(inspect(error, { depth: 10 })).not.toContain('SECRETKEY1234567890abc');
    const listless = {
      ...hot,
      id: 'odd',
      schemes: 'secp256k1-ecdsa',
    } as unknown as Signer;
    expect(await resolveWith(listless)).toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
  });
});
