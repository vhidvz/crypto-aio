/**
 * The two pieces of Solana's wire format the driver builds itself, SDK-free: a legacy
 * message and a program-derived address. Both used to come from `@solana/web3.js`, whose
 * 3.x line dropped the synchronous derivation and rebuilt its classes on Kit; owning them
 * keeps every signed byte independent of the SDK version a user installs. `codec.test.ts`
 * checks both against `@solana/web3.js` 1.99 and frozen vectors.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { ValidationError } from '../../core/errors/error';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM } from './programs';
import type { SolanaInstruction } from './types';
import { encodeLength } from './wire';

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

/** A 32-byte public key from its base58 text; the inputs are already validated. */
function key(address: string): Uint8Array {
  const bytes = base58.decode(address);
  if (bytes.length !== 32) {
    throw new ValidationError('INVALID_ADDRESS', 'a Solana key is 32 bytes');
  }
  return bytes;
}

/** Whether `bytes` is a point of the ed25519 curve, i.e. could have a private key. */
function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * `findProgramAddressSync`: the first bump from 255 down whose address is off the curve,
 * so no private key can sign for it. A seed is at most 32 bytes, as the runtime requires.
 */
export function programAddress(seeds: readonly Uint8Array[], programId: string): string {
  const program = key(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256
      .create()
      .update(Uint8Array.from(seeds.flatMap((seed) => [...seed])))
      .update(Uint8Array.of(bump))
      .update(program)
      .update(PDA_MARKER)
      .digest();
    if (!onCurve(hash)) return base58.encode(hash);
  }
  // Each bump has a one-in-two chance; all 256 failing does not happen.
  throw new ValidationError('INVALID_ADDRESS', 'no program address for these seeds');
}

/** The associated token account of `owner` for `mint` (classic Token program). */
export function associatedTokenAddress(owner: string, mint: string): string {
  return programAddress(
    [key(owner), key(TOKEN_PROGRAM), key(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
}

/**
 * A legacy message by the Solana message rules, as `@solana/web3.js` compiles it: the
 * payer first, then the signers (writable, then read-only) and the non-signers (writable,
 * then read-only), each group in order of first appearance, an instruction's program id
 * before its accounts; an account is a signer or writable when any use makes it one.
 */
export function compileLegacyMessage(
  payer: string,
  recentBlockhash: string,
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
    for (const account of ix.accounts)
      note(account.address, account.signer, account.writable);
  }
  const entries = [...meta.entries()];
  const group = (signer: boolean, writable: boolean) =>
    entries
      .filter(([, m]) => m.signer === signer && m.writable === writable)
      .map(([address]) => address);
  const writableSigners = group(true, true);
  const readonlySigners = group(true, false);
  const writableOthers = group(false, true);
  const readonlyOthers = group(false, false);
  const keys = [
    ...writableSigners,
    ...readonlySigners,
    ...writableOthers,
    ...readonlyOthers,
  ];
  // Indices are single bytes in a legacy message.
  if (keys.length > 256) {
    throw new ValidationError('INVALID_INTENT', 'too many accounts for one message');
  }
  const index = new Map(keys.map((address, i) => [address, i]));
  const parts: Uint8Array[] = [
    Uint8Array.of(
      writableSigners.length + readonlySigners.length,
      readonlySigners.length,
      readonlyOthers.length,
    ),
    encodeLength(keys.length),
    ...keys.map(key),
    key(recentBlockhash),
    encodeLength(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(
      Uint8Array.of(index.get(ix.programId) as number),
      encodeLength(ix.accounts.length),
      Uint8Array.from(ix.accounts.map((a) => index.get(a.address) as number)),
      encodeLength(ix.data.length),
      ix.data,
    );
  }
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
