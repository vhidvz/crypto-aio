/**
 * SDK-free types of the Solana family: the `ext.solana` API, fee details and overrides, and
 * the narrow `SolanaCodec` that the `@solana/web3.js` module implements (spec §15). Nothing
 * here imports an SDK, so the composition root can export these types.
 */
import type { DisposableNativeClient } from '../../core/driver/types';
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    solana: { family: 'solana'; network: 'mainnet' | 'devnet' | 'testnet' };
  }
  interface FamilyRegistry {
    solana: { library: '@solana/web3.js'; ext: SolanaExt; fee: SolanaFeeDetails };
  }
}

/** One SPL token account (classic Token program) of an owner. */
export interface SolanaTokenAccount {
  /** The token account's own address (an associated token account or any other). */
  readonly address: string;
  readonly mint: string;
  /** Base units of the mint. */
  readonly amount: bigint;
  readonly frozen: boolean;
}

/** `bc.ext.solana`: the Solana family extension (spec §5.5). */
export interface SolanaExt {
  readonly solana: {
    /**
     * The owner's classic SPL token accounts, optionally for one mint, at the `confirmed`
     * commitment. Token-2022 accounts are not listed (Token-2022 is unsupported).
     */
    getTokenAccounts(
      owner: string,
      mint?: string,
    ): Promise<readonly SolanaTokenAccount[]>;
  };
}

/**
 * `FeeEstimate.details` of the `solana` fee kind (lamports; compute-unit price in
 * micro-lamports). The charges are `network` (the signature fee), `priority`
 * (`ceil(computeUnitPrice × computeUnitLimit / 1_000_000)`) and, when the recipient's
 * associated token account is created, `rent`.
 */
export interface SolanaFeeDetails {
  readonly signatures: number;
  /** The signature fee the node quoted for the message (`getFeeForMessage` minus priority). */
  readonly baseFee: bigint;
  readonly computeUnitLimit: bigint;
  /** Micro-lamports per compute unit. */
  readonly computeUnitPrice: bigint;
  readonly priorityFee: bigint;
  /** The rent-exempt deposit of a created associated token account; `0n` otherwise. */
  readonly rent: bigint;
  /** Whether the transaction creates the recipient's associated token account. */
  readonly createsRecipientAccount: boolean;
}

/**
 * An explicit Solana fee (`TransferIntent.fee`): the compute-unit price in micro-lamports
 * and, optionally, the compute-unit limit (1 to 1,400,000), which otherwise comes from a
 * simulation of the transaction.
 */
export interface SolanaFeeOverride {
  readonly computeUnitPrice: bigint;
  readonly computeUnitLimit?: bigint;
}

/**
 * The transport tags every Solana I/O call carries: purpose, retry, quorum, fanout, signal,
 * and optionally the caller's own `quorumKey` (lesson 17), which replaces the method's
 * default consensus key.
 */
export type SolanaCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal'
>;

export type Commitment = 'confirmed' | 'finalized';

/**
 * The expiry ordering a Solana build records (F5-R9): the recent blockhash's
 * `lastValidBlockHeight`, the blockhash itself and the slot of its block, all from one
 * `getLatestBlockhash` answer. Proofs use the height only once the quorum attests that the
 * finalized block at `blockhashSlot` has hash `blockhash` and sits exactly 150 heights
 * below `lastValidHeight` (agave's `MAX_PROCESSING_AGE`), so no endpoint proposes the
 * height a verdict rests on (lesson 17).
 */
export interface SolanaExpiryOrdering {
  readonly kind: 'expiry';
  readonly lastValidHeight: bigint;
  /** The message's recent blockhash (base58). */
  readonly blockhash: string;
  /** The slot of the block whose hash `blockhash` is. */
  readonly blockhashSlot: bigint;
}

/** One instruction of a transaction we build: program, accounts and data. */
export interface SolanaInstruction {
  readonly programId: string;
  readonly accounts: readonly {
    readonly address: string;
    readonly signer: boolean;
    readonly writable: boolean;
  }[];
  readonly data: Uint8Array;
}

/**
 * The codec work the driver delegates to `@solana/web3.js` (spec §15): program-derived
 * addresses and legacy message compilation. Inputs are already-validated canonical base58
 * keys; outputs are plain bytes and strings, never SDK objects (R11).
 */
export interface SolanaCodec {
  /** The associated token account of `owner` for `mint` (classic Token program). */
  associatedTokenAddress(owner: string, mint: string): string;
  /** The legacy message bytes: header, account keys, recent blockhash, instructions. */
  compileMessage(
    payer: string,
    recentBlockhash: string,
    instructions: readonly SolanaInstruction[],
  ): Uint8Array;
  /** A fresh `Connection` on the same transport, for `crypto-aio/native` (R34). */
  createNative(): DisposableNativeClient;
}
