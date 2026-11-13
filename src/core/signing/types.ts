import type { FeeEstimateDraft } from '../model/fee';
import type { IntentSummary } from '../model/intent';
import type { Secret } from '../secret/secret';

/** Which key a signer uses, for a signer that holds several. */
export interface KeyRef {
  /** Routes a request to a specific signer through `WalletConfig.signers`. */
  readonly id?: string;
  /** HD derivation path for mnemonic-backed signers. */
  readonly path?: string;
}

/** Scheme-specific parameters of a signing request. */
export interface SigningParams {
  /** BIP341 key-path tweak for `secp256k1-schnorr`. */
  readonly tweak?: Uint8Array;
}

/** One signature to make. The core verifies every signature against its request. */
export interface SigningRequest {
  /** Identifies the request; the signature answers it by `requestId`. */
  readonly id: string;
  /** The signature scheme, such as `secp256k1-ecdsa`, `secp256k1-schnorr` or `ed25519`. */
  readonly scheme: string;
  /** What to sign: a 32-byte digest, or the whole message for `ed25519`. */
  readonly payload: Uint8Array;
  readonly payloadKind: 'digest' | 'message';
  /** The key that must sign, as the wallet resolved it. */
  readonly publicKey: Uint8Array;
  readonly keyRef?: KeyRef;
  /** For a Bitcoin `p2tr` key-path spend, the BIP341 tweak to apply to the key. */
  readonly params?: SigningParams;
}

/**
 * A signature for one request. `secp256k1-ecdsa`: 64-byte compact r‖s (low-s) plus
 * `recovery`; `secp256k1-schnorr`: a 64-byte BIP340 signature (by the tweaked key when the
 * request has a tweak); `ed25519`: a 64-byte RFC 8032 signature; another scheme: its raw
 * signature.
 */
export interface SignatureBundle {
  readonly requestId: string;
  readonly bytes: Uint8Array;
  readonly recovery?: number;
}

/** A signer's answer: the signatures, or `pending` with a ticket to collect them later. */
export type SigningResult =
  | { readonly status: 'signed'; readonly signatures: readonly SignatureBundle[] }
  | { readonly status: 'pending'; readonly ticket?: string };

/** A pending signer's ticket, kept with the signer that issued it (only it can cancel it). */
export interface SignerTicket {
  readonly signerId: string;
  readonly ticket: string;
}

/** Which kind of Attempt a signing request is for, as `AttemptPurpose`. */
export type SigningPurpose = 'original' | 'replacement' | 'cancel' | 'rebuild';

/** Context handed to signers and policy hooks. Never contains secrets or SDK objects. */
export interface SigningContext {
  readonly operationId: string;
  readonly namespace: string;
  readonly chain: string;
  readonly network: string;
  /** The wallet's name. */
  readonly wallet: string;
  /** The wallet's `tier`, when set. */
  readonly tier?: string;
  readonly purpose: SigningPurpose;
  /** What the transaction pays, as the driver describes its payload. */
  readonly summary: IntentSummary;
  /** The fee the transaction pays. */
  readonly fee: FeeEstimateDraft;
  /** A hash of the unsigned payload, the same for every request of one transaction. */
  readonly unsignedHash: string;
}

/**
 * Holds keys and signs. A port you may implement: it never gains a required member in a
 * 1.x release.
 */
export interface Signer {
  /**
   * The signer's own label. The core names a signer by its key in `signers`, which is what
   * an Operation records (`context.signer`).
   */
  readonly id: string;
  /** The signature schemes it signs with; a wallet needs each scheme it signs with. */
  readonly schemes: readonly string[];
  /** The public key it signs with under `scheme`, for `keyRef`. */
  getPublicKey(scheme: string, keyRef?: KeyRef): Promise<Uint8Array>;
  /**
   * Signs every request, or answers `pending` with a ticket. Check `ctx` against your
   * policy here or in `beforeSign`; the core verifies each signature it gets back.
   */
  sign(requests: readonly SigningRequest[], ctx: SigningContext): Promise<SigningResult>;
  /** Best-effort cancellation of a pending request (used by `abandon`). */
  cancelRequest?(ticket: string): Promise<void>;
  /** Only available on signers created as exportable. */
  exportKey?(scheme: string, keyRef?: KeyRef): Promise<Secret<Uint8Array>>;
}
