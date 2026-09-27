import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import {
  addressFromPublicKey,
  decodeBase58,
  isAddress,
  isSignature,
} from '../../../src/adapters/solana/keys';

const SEED = '97710888410ad41b69cb42c4f84f954f7c842f259ca6af5be39872a9ded1f3d1';
const ADDRESS = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
const SIGNATURE =
  '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv';

describe('strict Solana keys (lesson 4)', () => {
  it('accepts only canonical base58 of the exact length', () => {
    expect(isAddress(ADDRESS)).toBe(true);
    expect(isAddress('11111111111111111111111111111111')).toBe(true);
    expect(isAddress(SIGNATURE)).toBe(false);
    expect(isSignature(SIGNATURE)).toBe(true);
    expect(isSignature(ADDRESS)).toBe(false);
    // Not base58, 0/O/I/l, padding, whitespace, other types.
    for (const bad of [
      '',
      `${ADDRESS} `,
      ADDRESS.replace('7', '0'),
      ADDRESS.replace('7', 'l'),
      `0x${'ab'.repeat(32)}`,
      32,
      null,
      ['77PL'],
    ]) {
      expect(isAddress(bad)).toBe(false);
    }
    // A leading '1' is a zero byte: 33 bytes is not an address.
    expect(isAddress(`1${ADDRESS}`)).toBe(false);
    expect(decodeBase58(ADDRESS, 32)).toEqual(ed25519.getPublicKey(SEED));
  });

  it('refuses text longer than the format allows before decoding it (lesson 20)', () => {
    // base58 decoding is O(n²): 30,000 characters block the event loop for seconds.
    const decode = jest.spyOn(base58, 'decode');
    try {
      const huge = 'z'.repeat(100_000);
      expect(isAddress(huge)).toBe(false);
      expect(isSignature(huge)).toBe(false);
      expect(decodeBase58(`1${ADDRESS}`.repeat(2_000), 32)).toBeNull();
      // The longest texts of 32 and 64 bytes are 44 and 88 characters; one more is refused.
      expect(isAddress('z'.repeat(45))).toBe(false);
      expect(isSignature('z'.repeat(89))).toBe(false);
      expect(decode).not.toHaveBeenCalled();
      expect(isAddress('z'.repeat(44))).toBe(false);
      expect(isSignature('z'.repeat(88))).toBe(false);
      expect(decode).toHaveBeenCalledTimes(2);
    } finally {
      decode.mockRestore();
    }
  });

  it('derives the address of an ed25519 public key only', () => {
    expect(addressFromPublicKey(ed25519.getPublicKey(SEED))).toBe(ADDRESS);
    const refused = (key: Uint8Array) =>
      expect(() => addressFromPublicKey(key)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    // A 64-byte secret key (seed ‖ public key), a 33-byte key, an empty key.
    refused(new Uint8Array([...Buffer.from(SEED, 'hex'), ...ed25519.getPublicKey(SEED)]));
    refused(new Uint8Array(33).fill(2));
    refused(new Uint8Array());
    // The identity point is on the curve but of small order.
    refused(ed25519.ExtendedPoint.ZERO.toRawBytes());
    // A y coordinate with no x on the curve.
    let offCurve: Uint8Array | undefined;
    for (let i = 1; !offCurve; i++) {
      const candidate = new Uint8Array(32);
      candidate[0] = i;
      try {
        ed25519.ExtendedPoint.fromHex(candidate);
      } catch {
        offCurve = candidate;
      }
    }
    refused(offCurve);
    expect(base58.encode(offCurve)).not.toBe(ADDRESS);
  });
});
