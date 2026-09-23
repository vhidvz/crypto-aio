import { ed25519 } from '@noble/curves/ed25519';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  BUILTIN_SCHEMES,
  SchemeCatalog,
  ed25519Scheme,
  secp256k1Ecdsa,
  secp256k1Schnorr,
} from '../../../src/core/registry/schemes';
import { fromHex, toHex } from '../../../src/core/util/bytes';
import { thrown } from '../../helpers';

describe('secp256k1-ecdsa', () => {
  const key = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(key, true);
  const payload = sha256(utf8ToBytes('pay'));
  const sig = secp256k1.sign(payload, key, { lowS: true });

  it('verifies compact signatures with the right recovery bit', () => {
    expect(
      secp256k1Ecdsa.verify({
        publicKey,
        payload,
        signature: sig.toCompactRawBytes(),
        recovery: sig.recovery,
      }),
    ).toBe(true);
  });

  it('rejects wrong recovery, missing recovery, tampering and high-s', () => {
    const compact = sig.toCompactRawBytes();
    expect(
      secp256k1Ecdsa.verify({
        publicKey,
        payload,
        signature: compact,
        recovery: sig.recovery ^ 1,
      }),
    ).toBe(false);
    expect(secp256k1Ecdsa.verify({ publicKey, payload, signature: compact })).toBe(false);
    expect(
      secp256k1Ecdsa.verify({
        publicKey,
        payload: sha256(utf8ToBytes('other')),
        signature: compact,
        recovery: sig.recovery,
      }),
    ).toBe(false);
    const high = new secp256k1.Signature(
      sig.r,
      secp256k1.CURVE.n - sig.s,
    ).toCompactRawBytes();
    expect(
      secp256k1Ecdsa.verify({
        publicKey,
        payload,
        signature: high,
        recovery: sig.recovery ^ 1,
      }),
    ).toBe(false);
    expect(
      secp256k1Ecdsa.verify({
        publicKey: new Uint8Array(33),
        payload,
        signature: compact,
        recovery: 0,
      }),
    ).toBe(false);
  });
});

describe('secp256k1-schnorr', () => {
  it('verifies BIP340 signatures against x-only keys', () => {
    const key = secp256k1.utils.randomPrivateKey();
    const payload = sha256(utf8ToBytes('taproot'));
    const signature = schnorr.sign(payload, key);
    expect(
      secp256k1Schnorr.verify({
        publicKey: schnorr.getPublicKey(key),
        payload,
        signature,
      }),
    ).toBe(true);
    expect(
      secp256k1Schnorr.verify({
        publicKey: schnorr.getPublicKey(key),
        payload: new Uint8Array(32),
        signature,
      }),
    ).toBe(false);
  });
});

describe('ed25519', () => {
  it('verifies the RFC 8032 test vector 1', () => {
    const publicKey = fromHex(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
    const signature = fromHex(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(
      ed25519Scheme.verify({ publicKey, payload: new Uint8Array(), signature }),
    ).toBe(true);
    expect(
      ed25519Scheme.verify({ publicKey, payload: new Uint8Array([1]), signature }),
    ).toBe(false);
    const sk = fromHex(
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    );
    expect(toHex(ed25519.getPublicKey(sk))).toBe(toHex(publicKey));
  });
});

describe('SchemeCatalog', () => {
  it('holds built-ins and rejects unknown or duplicate ids', () => {
    const catalog = new SchemeCatalog(BUILTIN_SCHEMES);
    expect(catalog.list().map((s) => s.id)).toEqual([
      'secp256k1-ecdsa',
      'secp256k1-schnorr',
      'ed25519',
    ]);
    expect(catalog.get('ed25519')).toBe(ed25519Scheme);
    expect(thrown(() => catalog.get('bls'))).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/unknown signature scheme 'bls'/),
    });
    expect(thrown(() => catalog.register(ed25519Scheme))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    const copy = catalog.clone();
    copy.register({ id: 'custom', publicKeyLength: 1, verify: () => true });
    expect(catalog.has('custom')).toBe(false);
  });
});
