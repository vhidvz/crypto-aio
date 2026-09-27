/**
 * bitcoinjs-lib's ECC interface (`isXOnlyPoint`, `xOnlyPointAddTweak`) over
 * `@noble/curves` (spec §15). SDK-free: bitcoinjs checks it against its own vectors when
 * `initEccLib` installs it.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { isXOnlyPoint } from './address';

export interface XOnlyTweakResult {
  readonly parity: 0 | 1;
  readonly xOnlyPubkey: Uint8Array;
}

export const nobleEcc = Object.freeze({
  isXOnlyPoint,
  xOnlyPointAddTweak(point: Uint8Array, tweak: Uint8Array): XOnlyTweakResult | null {
    if (!isXOnlyPoint(point) || tweak.length !== 32) return null;
    const t = schnorr.utils.bytesToNumberBE(tweak);
    if (t >= secp256k1.CURVE.n) return null;
    const P = schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(point));
    const Q = t === 0n ? P : P.add(secp256k1.ProjectivePoint.BASE.multiply(t));
    if (Q.equals(secp256k1.ProjectivePoint.ZERO)) return null;
    return { parity: Q.hasEvenY() ? 0 : 1, xOnlyPubkey: Q.toRawBytes(true).slice(1) };
  },
});
