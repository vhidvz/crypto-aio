/**
 * Strict TON addresses (spec §6.4), SDK-free. Two forms are accepted, nothing else:
 * - raw: `0:<64 hex>` or `-1:<64 hex>` (hex in either case; canonical is lower case);
 * - user-friendly: 48 base64 characters, either all standard (`+/`) or all URL-safe
 *   (`-_`) alphabet, decoding to tag · workchain · 32-byte hash · CRC16-XMODEM.
 * `@ton/core` is laxer (an unanchored hex test, any `parseInt` workchain, mixed base64
 * alphabets, workchain bytes other than 0x00/0xff, a thrown string on a bad tag), so every
 * address reaches the SDK only in the canonical raw form produced here (lesson 4).
 * Canonical is the raw form; `display` keeps the caller's text; `variant` keeps only the
 * flag that decides bounce behaviour (spec §6.4; a raw address is bounceable, as in
 * `@ton/core`). The variant is part of the intent hash (P25-R13), so the encoding-only
 * flags (test-only, alphabet) stay out of it: every spelling of one recipient with the same
 * bounce flag hashes the same.
 */
import type { AddressCodec, WalletOptions } from '../../core/driver/types';
import { ValidationError } from '../../core/errors/error';
import type { NormalizedAddress } from '../../core/model/address';

export type TonWorkchain = 0 | -1;

/** The flags a user-friendly TON address carries (TEP-2). */
export type TonAddressVariant = {
  readonly bounceable: boolean;
  readonly testOnly: boolean;
  readonly urlSafe: boolean;
};

export type ParsedTonAddress = TonAddressVariant & {
  readonly workchain: TonWorkchain;
  /** 32 bytes. */
  readonly hash: Uint8Array;
  readonly form: 'raw' | 'friendly';
};

const RAW = /^(0|-1):([0-9a-fA-F]{64})$/;
const FRIENDLY_STANDARD = /^[A-Za-z0-9+/]{48}$/;
const FRIENDLY_URL_SAFE = /^[A-Za-z0-9_-]{48}$/;
const BOUNCEABLE = 0x11;
const NON_BOUNCEABLE = 0x51;
const TEST_ONLY = 0x80;
const HASH_BYTES = 32;
/** Lesson 20: the longest form, `-1:` and 64 hex digits; anything longer is not decoded. */
const MAX_ADDRESS_LENGTH = 67;

/** CRC16-XMODEM (polynomial 0x1021, initial 0), as TEP-2 specifies for the checksum. */
export function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** An account id is exactly 32 bytes: never padded or truncated into another address. */
function assertHash(hash: Uint8Array): void {
  if (hash.length !== HASH_BYTES) {
    throw new ValidationError('INVALID_ADDRESS', 'a TON address hash is 32 bytes');
  }
}

/** `0:<hex>` / `-1:<hex>`, lower case: the canonical form. */
export function rawAddress(workchain: TonWorkchain, hash: Uint8Array): string {
  assertHash(hash);
  return `${workchain}:${toHex(hash)}`;
}

/** The user-friendly form (TEP-2) with the given flags. */
export function friendlyAddress(
  workchain: TonWorkchain,
  hash: Uint8Array,
  flags: TonAddressVariant,
): string {
  assertHash(hash);
  const bytes = new Uint8Array(36);
  bytes[0] =
    (flags.bounceable ? BOUNCEABLE : NON_BOUNCEABLE) | (flags.testOnly ? TEST_ONLY : 0);
  bytes[1] = workchain === -1 ? 0xff : 0x00;
  bytes.set(hash, 2);
  const crc = crc16(bytes.subarray(0, 34));
  bytes[34] = crc >> 8;
  bytes[35] = crc & 0xff;
  const text = Buffer.from(bytes).toString('base64');
  return flags.urlSafe ? text.replace(/\+/g, '-').replace(/\//g, '_') : text;
}

function parseFriendly(value: string): ParsedTonAddress | null {
  const urlSafe = FRIENDLY_URL_SAFE.test(value);
  if (!urlSafe && !FRIENDLY_STANDARD.test(value)) return null;
  const bytes = Buffer.from(
    urlSafe ? value.replace(/-/g, '+').replace(/_/g, '/') : value,
    'base64',
  );
  if (bytes.length !== 36) return null;
  const tag = bytes[0] as number;
  const testOnly = (tag & TEST_ONLY) !== 0;
  const flag = tag & ~TEST_ONLY;
  if (flag !== BOUNCEABLE && flag !== NON_BOUNCEABLE) return null;
  const wc = bytes[1];
  if (wc !== 0x00 && wc !== 0xff) return null;
  const crc = crc16(bytes.subarray(0, 34));
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return null;
  return {
    workchain: wc === 0xff ? -1 : 0,
    hash: new Uint8Array(bytes.subarray(2, 34)),
    form: 'friendly',
    bounceable: flag === BOUNCEABLE,
    testOnly,
    // A 48-character text in the shared alphabet (no `+/-_`) is both; call it URL-safe.
    urlSafe: urlSafe,
  };
}

/** Parses either form strictly; `null` for anything else. */
export function parseTonAddress(value: string): ParsedTonAddress | null {
  if (typeof value !== 'string' || value.length > MAX_ADDRESS_LENGTH) return null;
  const raw = RAW.exec(value);
  if (raw) {
    return {
      workchain: raw[1] === '-1' ? -1 : 0,
      hash: new Uint8Array(Buffer.from(raw[2] as string, 'hex')),
      form: 'raw',
      bounceable: true,
      testOnly: false,
      urlSafe: true,
    };
  }
  return parseFriendly(value);
}

export interface TonAddressCodecOptions {
  /** Mainnet refuses testnet-only addresses (TEP-2); testnet accepts both flags. */
  readonly testnet: boolean;
  /** The wallet address for a public key and wallet identity (needs the SDK). */
  readonly fromPublicKey: (publicKey: Uint8Array, wallet?: WalletOptions) => string;
}

export function createTonAddressCodec(options: TonAddressCodecOptions): AddressCodec {
  const parse = (value: string): ParsedTonAddress => {
    const parsed = parseTonAddress(value);
    if (!parsed) throw new ValidationError('INVALID_ADDRESS', 'not a TON address');
    if (parsed.testOnly && !options.testnet) {
      throw new ValidationError(
        'INVALID_ADDRESS',
        'a testnet-only TON address cannot be used on mainnet',
      );
    }
    return parsed;
  };
  const normalize = (value: string): NormalizedAddress => {
    const parsed = parse(value);
    const canonical = rawAddress(parsed.workchain, parsed.hash);
    // P25-R13: only the semantic bounce flag is hashed. A raw address carries no flags and
    // is bounceable, as in `@ton/core`.
    return parsed.form === 'raw'
      ? { canonical, display: canonical, variant: { bounceable: true } }
      : { canonical, display: value, variant: { bounceable: parsed.bounceable } };
  };
  return {
    validate: (value) => {
      try {
        parse(value);
        return true;
      } catch {
        return false;
      }
    },
    normalize,
    fromPublicKey: (publicKey, wallet) => {
      const parsed = parse(options.fromPublicKey(publicKey, wallet));
      // A wallet address as wallets show it: non-bounceable, flagged on testnet.
      const flags = { bounceable: false, testOnly: options.testnet, urlSafe: true };
      return {
        canonical: rawAddress(parsed.workchain, parsed.hash),
        display: friendlyAddress(parsed.workchain, parsed.hash, flags),
        variant: { bounceable: false },
      };
    },
    format: (address, formatOptions) => {
      const parsed = parseTonAddress(address.canonical);
      if (!parsed) return address.display;
      if (formatOptions?.raw === true) return address.canonical;
      if (formatOptions === undefined || Object.keys(formatOptions).length === 0) {
        return address.display;
      }
      // The variant holds the bounce flag only; the caller's own text keeps the others.
      const shown = parseTonAddress(address.display);
      const spelled = shown?.form === 'friendly' ? shown : undefined;
      const pick = (key: keyof TonAddressVariant, fallback: boolean): boolean => {
        const value = formatOptions[key];
        return typeof value === 'boolean' ? value : fallback;
      };
      const bounceable = address.variant?.bounceable;
      return friendlyAddress(parsed.workchain, parsed.hash, {
        bounceable: pick(
          'bounceable',
          typeof bounceable === 'boolean' ? bounceable : true,
        ),
        testOnly: pick('testOnly', spelled?.testOnly ?? options.testnet),
        urlSafe: pick('urlSafe', spelled?.urlSafe ?? true),
      });
    },
  };
}
