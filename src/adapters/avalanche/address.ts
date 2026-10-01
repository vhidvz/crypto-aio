/**
 * X-Chain and P-Chain addresses (SDK-free). An address is 20 bytes, the RIPEMD-160 of the
 * SHA-256 of a compressed secp256k1 public key, written in bech32 with the network's
 * human-readable part (`avax`, `fuji`) behind the chain's alias: `X-avax1…`, `P-avax1…`.
 * The canonical form carries the alias, lower case. A bare `avax1…` is accepted and
 * normalized to this chain's alias; the other chain's alias (`P-` on the X-Chain), a
 * C-Chain or another network's address, and anything that is not 20 bytes are refused: the
 * same key's bytes on another chain are a cross-chain transfer, which a transfer never is.
 */
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { bech32 } from '@scure/base';
import { ValidationError } from '../../core/errors/error';
import type { NormalizedAddress } from '../../core/model/address';
import type { AvalancheNetworkConfig } from './network';

export const ADDRESS_BYTES = 20;

/** Bech32 allows at most 90 characters; the alias and `-` add two. */
const MAX_ADDRESS_LENGTH = 92;

type AddressParams = Pick<AvalancheNetworkConfig, 'alias' | 'hrp'>;

const invalid = (reason: string): ValidationError =>
  new ValidationError('INVALID_ADDRESS', `not an address of this chain: ${reason}`);

/** The 20 address bytes of a compressed secp256k1 public key. */
export function addressBytesOf(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3)) {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'an Avalanche address needs a 33-byte compressed secp256k1 public key',
    );
  }
  return ripemd160(sha256(publicKey));
}

/** `X-avax1…`: the canonical form of 20 address bytes on this chain. */
export function formatAddress(bytes: Uint8Array, params: AddressParams): string {
  return `${params.alias}-${bech32.encode(params.hrp, bech32.toWords(bytes))}`;
}

/**
 * The address bytes of `address`; throws `INVALID_ADDRESS` with a fixed text that never
 * repeats the input, which may be a pasted secret.
 */
export function decodeAddress(address: string, params: AddressParams): Uint8Array {
  if (typeof address !== 'string' || address.length > MAX_ADDRESS_LENGTH) {
    throw invalid('malformed');
  }
  const dash = address.indexOf('-');
  if (dash !== -1 && address.slice(0, dash) !== params.alias) {
    throw invalid(`the chain alias is not '${params.alias}'`);
  }
  const body = dash === -1 ? address : address.slice(dash + 1);
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(body as `${string}1${string}`, 90);
  } catch {
    throw invalid('malformed bech32');
  }
  if (decoded.prefix !== params.hrp) {
    throw invalid(`the network prefix is not '${params.hrp}'`);
  }
  let bytes: Uint8Array;
  try {
    bytes = bech32.fromWords(decoded.words);
  } catch {
    throw invalid('malformed bech32');
  }
  if (bytes.length !== ADDRESS_BYTES) throw invalid('not 20 bytes');
  return bytes;
}

export function normalizeAddress(
  address: string,
  params: AddressParams,
): NormalizedAddress {
  const canonical = formatAddress(decodeAddress(address, params), params);
  return { canonical, display: canonical };
}
