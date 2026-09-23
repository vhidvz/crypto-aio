import { inspect } from 'node:util';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  ed25519Scheme,
  secp256k1Ecdsa,
  secp256k1Schnorr,
} from '../../../src/core/registry/schemes';
import { secret } from '../../../src/core/secret/secret';
import { localSigner, tweakPrivateKey } from '../../../src/core/signing/local';
import type { SigningRequest } from '../../../src/core/signing/types';
import { toHex } from '../../../src/core/util/bytes';
import { thrown } from '../../helpers';
import { ctx } from './fixtures';

const digest = sha256(utf8ToBytes('payload'));

describe('localSigner', () => {
  it('signs ecdsa digests that verify with recovery', async () => {
    const { signer, publicKeys } = localSigner.generate({ curves: ['secp256k1'] });
    const publicKey = await signer.getPublicKey('secp256k1-ecdsa');
    expect(toHex(publicKey)).toBe(toHex(publicKeys.secp256k1 as Uint8Array));
    const request: SigningRequest = {
      id: 'r0',
      scheme: 'secp256k1-ecdsa',
      payload: digest,
      payloadKind: 'digest',
      publicKey,
    };
    const result = await signer.sign([request], ctx);
    expect(result.status).toBe('signed');
    if (result.status !== 'signed') throw new Error('unreachable');
    const [sig] = result.signatures;
    expect(sig?.requestId).toBe('r0');
    expect(
      secp256k1Ecdsa.verify({
        publicKey,
        payload: digest,
        signature: sig!.bytes,
        recovery: sig!.recovery,
      }),
    ).toBe(true);
  });

  it('signs ed25519 messages', async () => {
    const { signer } = localSigner.generate({ curves: ['ed25519'] });
    const publicKey = await signer.getPublicKey('ed25519');
    const payload = utf8ToBytes('any length message');
    const result = await signer.sign(
      [{ id: 'r', scheme: 'ed25519', payload, payloadKind: 'message', publicKey }],
      ctx,
    );
    if (result.status !== 'signed') throw new Error('unreachable');
    expect(
      ed25519Scheme.verify({
        publicKey,
        payload,
        signature: result.signatures[0]!.bytes,
      }),
    ).toBe(true);
    expect(signer.schemes).toEqual(['ed25519']);
  });

  it('applies BIP341 tweaks for schnorr requests', async () => {
    const key = secp256k1.utils.randomPrivateKey();
    const signer = localSigner({ secp256k1: secret(key) });
    const tweak = sha256(utf8ToBytes('tweak'));
    const tweakedPublic = schnorr.getPublicKey(tweakPrivateKey(key, tweak));
    const result = await signer.sign(
      [
        {
          id: 't',
          scheme: 'secp256k1-schnorr',
          payload: digest,
          payloadKind: 'digest',
          publicKey: tweakedPublic,
          params: { tweak },
        },
      ],
      ctx,
    );
    if (result.status !== 'signed') throw new Error('unreachable');
    expect(
      secp256k1Schnorr.verify({
        publicKey: tweakedPublic,
        payload: digest,
        signature: result.signatures[0]!.bytes,
      }),
    ).toBe(true);
  });

  it('refuses requests for keys it does not hold', async () => {
    const { signer } = localSigner.generate({ curves: ['secp256k1'] });
    const other = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true);
    await expect(
      signer.sign(
        [
          {
            id: 'r',
            scheme: 'secp256k1-ecdsa',
            payload: digest,
            payloadKind: 'digest',
            publicKey: other,
          },
        ],
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    await expect(signer.getPublicKey('ed25519')).rejects.toMatchObject({
      code: 'SIGNER_UNAVAILABLE',
    });
  });

  it('imports hex keys and validates them', async () => {
    const hex = '0x' + '11'.repeat(32);
    const signer = localSigner({ secp256k1: secret(hex) });
    expect(toHex(await signer.getPublicKey('secp256k1-ecdsa'))).toBe(
      toHex(secp256k1.getPublicKey('11'.repeat(32), true)),
    );
    expect(thrown(() => localSigner({ secp256k1: secret('0x1234') }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(thrown(() => localSigner({ secp256k1: secret('zz') }))).toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(
      thrown(() => localSigner({ secp256k1: secret('00'.repeat(32)) })),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(thrown(() => localSigner({}))).toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('keeps keys private and exports only when exportable', async () => {
    const hex = '22'.repeat(32);
    const locked = localSigner({ secp256k1: secret(hex) });
    expect(JSON.stringify(locked)).not.toContain(hex);
    expect(inspect(locked, { depth: 5 })).not.toContain(hex);
    await expect(locked.exportKey?.('secp256k1-ecdsa')).rejects.toMatchObject({
      code: 'KEY_NOT_EXPORTABLE',
    });
    const open = localSigner({ secp256k1: secret(hex), exportable: true });
    const exported = await open.exportKey?.('secp256k1-ecdsa');
    expect(JSON.stringify({ exported })).toBe('{"exported":"[REDACTED]"}');
    expect(toHex(exported!.reveal())).toBe(hex);
  });
});
