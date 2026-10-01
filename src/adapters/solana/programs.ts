/**
 * Solana program ids, account layouts and the instructions the driver builds, SDK-free
 * (built without `@solana/spl-token`). Every encoding is checked against a real devnet
 * transaction and `@solana/web3.js`'s own builders (`codec.test.ts`).
 */
import { ValidationError } from '../../core/errors/error';
import type { SolanaInstruction } from './types';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** The first Memo program; still parsed on received transactions. */
export const MEMO_V1_PROGRAM = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

/** Classic Token program account sizes (bytes). */
export const MINT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;
/** A transaction's maximum serialized size (the network packet limit). */
export const MAX_TRANSACTION_SIZE = 1232;
/** The compute-unit limit of one transaction, and the default per instruction. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;
export const DEFAULT_INSTRUCTION_COMPUTE_UNITS = 200_000n;
/** Memo text limit (UTF-8 bytes): a library policy that keeps every transfer well under
 *  the packet limit. */
export const MAX_MEMO_BYTES = 256;

/**
 * DataView and `Uint8Array.of` silently wrap a value that does not fit (2^64 + 5 lamports
 * would encode as 5); we refuse it with a fixed text: `INVALID_AMOUNT` for a u64
 * (lamports, token amounts and micro-lamports), `INVALID_INTENT` for a u8 (decimals) or a
 * u32 (compute units).
 */
const outOfRange = (bits: 8 | 32 | 64) =>
  new ValidationError(
    bits === 64 ? 'INVALID_AMOUNT' : 'INVALID_INTENT',
    `a value does not fit in its u${bits} field`,
  );

function u8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw outOfRange(8);
  return Uint8Array.of(value);
}

function u32(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffffn) throw outOfRange(32);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), true);
  return out;
}

function u64(value: bigint): Uint8Array {
  if (value < 0n || value >= 2n ** 64n) throw outOfRange(64);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

const bytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const signer = (address: string, writable: boolean) => ({
  address,
  signer: true,
  writable,
});
const account = (address: string, writable: boolean) => ({
  address,
  signer: false,
  writable,
});

/** ComputeBudget `SetComputeUnitLimit` (2, u32). */
export function setComputeUnitLimit(units: bigint): SolanaInstruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: bytes(Uint8Array.of(2), u32(units)),
  };
}

/** ComputeBudget `SetComputeUnitPrice` (3, u64 micro-lamports). */
export function setComputeUnitPrice(microLamports: bigint): SolanaInstruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: bytes(Uint8Array.of(3), u64(microLamports)),
  };
}

/** System `Transfer` (2, u64 lamports). */
export function systemTransfer(
  from: string,
  to: string,
  lamports: bigint,
): SolanaInstruction {
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [signer(from, true), account(to, true)],
    data: bytes(u32(2n), u64(lamports)),
  };
}

/** Associated Token Account `CreateIdempotent` (1). */
export function createAssociatedTokenAccountIdempotent(
  payer: string,
  associated: string,
  owner: string,
  mint: string,
): SolanaInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      signer(payer, true),
      account(associated, true),
      account(owner, false),
      account(mint, false),
      account(SYSTEM_PROGRAM, false),
      account(TOKEN_PROGRAM, false),
    ],
    data: Uint8Array.of(1),
  };
}

/** Token `TransferChecked` (12, u64 amount, u8 decimals). */
export function transferChecked(
  source: string,
  mint: string,
  destination: string,
  authority: string,
  amount: bigint,
  decimals: number,
): SolanaInstruction {
  return {
    programId: TOKEN_PROGRAM,
    accounts: [
      account(source, true),
      account(mint, false),
      account(destination, true),
      signer(authority, false),
    ],
    data: bytes(Uint8Array.of(12), u64(amount), u8(decimals)),
  };
}

/** Memo v2: the UTF-8 text, no accounts. */
export function memo(text: string): SolanaInstruction {
  return { programId: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode(text) };
}

/** A classic Token mint (82 bytes): its decimals, when initialized. */
export function decodeMint(data: Uint8Array): { readonly decimals: number } | null {
  if (data.length !== MINT_SIZE || data[45] !== 1) return null;
  return { decimals: data[44] as number };
}

/** A classic Token account (165 bytes): mint, owner, amount and state. */
export function decodeTokenAccount(data: Uint8Array): {
  readonly mint: Uint8Array;
  readonly owner: Uint8Array;
  readonly amount: bigint;
  readonly frozen: boolean;
} | null {
  if (data.length !== TOKEN_ACCOUNT_SIZE) return null;
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  return {
    mint: data.slice(0, 32),
    owner: data.slice(32, 64),
    amount: new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true),
    frozen: state === 2,
  };
}
