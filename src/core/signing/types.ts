import type { FeeEstimateDraft } from '../model/fee';
import type { IntentSummary } from '../model/intent';
import type { Secret } from '../secret/secret';

export interface KeyRef {
  /** Routes a request to a specific signer through `WalletConfig.signers`. */
  readonly id?: string;
  /** HD derivation path for mnemonic-backed signers. */
  readonly path?: string;
}

export interface SigningParams {
  /** BIP341 key-path tweak for `secp256k1-schnorr`. */
  readonly tweak?: Uint8Array;
}

export interface SigningRequest {
  readonly id: string;
  readonly scheme: string;
  readonly payload: Uint8Array;
  readonly payloadKind: 'digest' | 'message';
  readonly publicKey: Uint8Array;
  readonly keyRef?: KeyRef;
  readonly params?: SigningParams;
}

/** `secp256k1-ecdsa`: 64-byte compact r‖s (low-s) plus `recovery`; others: raw signature. */
export interface SignatureBundle {
  readonly requestId: string;
  readonly bytes: Uint8Array;
  readonly recovery?: number;
}

export type SigningResult =
  | { readonly status: 'signed'; readonly signatures: readonly SignatureBundle[] }
  | { readonly status: 'pending'; readonly ticket?: string };

/** A pending signer's ticket, kept with the signer that issued it (only it can cancel it). */
export interface SignerTicket {
  readonly signerId: string;
  readonly ticket: string;
}

export type SigningPurpose = 'original' | 'replacement' | 'cancel' | 'rebuild';

/** Context handed to signers and policy hooks. Never contains secrets or SDK objects. */
export interface SigningContext {
  readonly operationId: string;
  readonly namespace: string;
  readonly chain: string;
  readonly network: string;
  readonly wallet: string;
  readonly tier?: string;
  readonly purpose: SigningPurpose;
  readonly summary: IntentSummary;
  readonly fee: FeeEstimateDraft;
  readonly unsignedHash: string;
}

export interface Signer {
  readonly id: string;
  readonly schemes: readonly string[];
  getPublicKey(scheme: string, keyRef?: KeyRef): Promise<Uint8Array>;
  sign(requests: readonly SigningRequest[], ctx: SigningContext): Promise<SigningResult>;
  /** Best-effort cancellation of a pending request (used by `abandon`). */
  cancelRequest?(ticket: string): Promise<void>;
  /** Only available on signers created as exportable. */
  exportKey?(scheme: string, keyRef?: KeyRef): Promise<Secret<Uint8Array>>;
}
