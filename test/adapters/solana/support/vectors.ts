/**
 * Test keys (never funded anywhere real) and an independent, SDK-free legacy message
 * encoder (`@noble/*`, `@scure/base`) that the codec vectors are checked against (lesson 11).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import type { SolanaInstruction } from '../../../../src/adapters/solana/types';

/** sha256("crypto-aio solana test key") as an ed25519 seed. */
export const KEY = '97710888410ad41b69cb42c4f84f954f7c842f259ca6af5be39872a9ded1f3d1';
export const KEY_PUBLIC = ed25519.getPublicKey(KEY);
export const KEY_ADDRESS = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
/** sha256("crypto-aio solana recipient"). */
export const RECIPIENT_KEY =
  '8b27be3ee021903655f39e7795662247b046070031091cf3f046f76ec4cd416b';
export const RECIPIENT = '6zYdUwXJR5fhQJazDByGv4PsNrdaNhoruAR5kekA7rGs';
/** sha256("crypto-aio solana mint"): a mint address for the scripted node. */
export const MINT = '3DqxN72sPTL4ahhvF18v1cTwc3ViRHXB8SSZ9P2wt21E';

export const sign = (message: Uint8Array, key = KEY): Uint8Array =>
  ed25519.sign(message, key);

const shortvec = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
};

/**
 * A legacy message by the Solana message rules: the payer first, then signers
 * (writable, then read-only) and non-signers (writable, then read-only), each group in
 * order of first appearance, an instruction's program id before its accounts.
 */
export function compileLegacy(
  payer: string,
  blockhash: string,
  instructions: readonly SolanaInstruction[],
): Uint8Array {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const note = (address: string, signer: boolean, writable: boolean) => {
    const seen = meta.get(address);
    meta.set(address, {
      signer: (seen?.signer ?? false) || signer,
      writable: (seen?.writable ?? false) || writable,
    });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    note(ix.programId, false, false);
    for (const a of ix.accounts) note(a.address, a.signer, a.writable);
  }
  const entries = [...meta.entries()];
  const group = (signer: boolean, writable: boolean) =>
    entries
      .filter(([, m]) => m.signer === signer && m.writable === writable)
      .map(([k]) => k);
  const keys = [
    ...group(true, true),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ];
  const header = [
    group(true, true).length + group(true, false).length,
    group(true, false).length,
    group(false, false).length,
  ];
  const out: number[] = [...header, ...shortvec(keys.length)];
  for (const key of keys) out.push(...base58.decode(key));
  out.push(...base58.decode(blockhash), ...shortvec(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.programId), ...shortvec(ix.accounts.length));
    for (const a of ix.accounts) out.push(keys.indexOf(a.address));
    out.push(...shortvec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}
