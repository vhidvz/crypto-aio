import {
  addressBytesOf,
  decodeAddress,
  formatAddress,
  normalizeAddress,
} from '../../../src/adapters/avalanche/address';
import { cb58Decode, cb58Encode, idOf, isId } from '../../../src/adapters/avalanche/cb58';
import { toHex } from '../../../src/core/util/bytes';
import { TEST_BYTES, TEST_PUBKEY, configOf } from './support/vectors';

// avalanchejs's own formatter, the reference for the canonical form.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require('@avalabs/avalanchejs') as {
  utils: { format(alias: string, hrp: string, bytes: Uint8Array): string };
};

const X = configOf('avm');
const P = configOf('pvm');
const X_MAIN = configOf('avm', {}, 'mainnet');

describe('Avalanche addresses', () => {
  it('derives the address of a compressed public key, as avalanchejs formats it', () => {
    expect(addressBytesOf(TEST_PUBKEY)).toEqual(TEST_BYTES);
    expect(formatAddress(TEST_BYTES, X)).toBe(sdk.utils.format('X', 'fuji', TEST_BYTES));
    expect(formatAddress(TEST_BYTES, P)).toBe(sdk.utils.format('P', 'fuji', TEST_BYTES));
    expect(formatAddress(TEST_BYTES, X_MAIN)).toBe(
      sdk.utils.format('X', 'avax', TEST_BYTES),
    );
  });

  it('refuses a public key that is not 33 compressed bytes', () => {
    expect(() => addressBytesOf(new Uint8Array(65).fill(4))).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
    const odd = new Uint8Array(33).fill(1);
    expect(() => addressBytesOf(odd)).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
  });

  it('normalizes the aliased, bare and upper-case forms to the aliased lower-case one', () => {
    const canonical = formatAddress(TEST_BYTES, X);
    const bare = canonical.slice(2);
    expect(normalizeAddress(canonical, X)).toEqual({ canonical, display: canonical });
    expect(normalizeAddress(bare, X).canonical).toBe(canonical);
    expect(normalizeAddress(`X-${bare.toUpperCase()}`, X).canonical).toBe(canonical);
  });

  it.each([
    ['the other chain', (a: string) => `P-${a.slice(2)}`, "the chain alias is not 'X'"],
    ['the C-Chain alias', (a: string) => `C-${a.slice(2)}`, "the chain alias is not 'X'"],
    [
      'another network',
      () => formatAddress(TEST_BYTES, X_MAIN),
      "the network prefix is not 'fuji'",
    ],
    [
      'a bad checksum',
      (a: string) => `${a.slice(0, -1)}${a.endsWith('q') ? 'p' : 'q'}`,
      'malformed bech32',
    ],
    [
      'mixed case',
      (a: string) => `X-${a.slice(2, 8).toUpperCase()}${a.slice(8)}`,
      'malformed bech32',
    ],
    ['not 20 bytes', () => `X-fuji1${'q'.repeat(10)}`, 'malformed bech32'],
    ['too long', () => `X-${'fuji1'.padEnd(100, 'q')}`, 'malformed'],
  ])('refuses %s, naming no input (F6-R24)', (_, make, reason) => {
    const address = make(formatAddress(TEST_BYTES, X));
    expect(() => decodeAddress(address, X)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ADDRESS',
        message: `not an address of this chain: ${reason}`,
      }),
    );
  });

  it('refuses 32-byte data (an Ethereum-style key hash is 20, a contract hash is not)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bech32 } = require('@scure/base') as typeof import('@scure/base');
    const long = `X-${bech32.encode('fuji', bech32.toWords(new Uint8Array(32)))}`;
    expect(() => decodeAddress(long, X)).toThrow(
      expect.objectContaining({ message: 'not an address of this chain: not 20 bytes' }),
    );
  });
});

describe('CB58', () => {
  it('round-trips ids and checks the checksum', () => {
    const bytes = new Uint8Array(32).fill(7);
    const text = cb58Encode(bytes);
    expect(cb58Decode(text)).toEqual(bytes);
    expect(isId(text)).toBe(true);
    expect(isId(X.avaxAssetId)).toBe(true);
    const broken = `${text.slice(0, -1)}${text.endsWith('1') ? '2' : '1'}`;
    expect(cb58Decode(broken)).toBeUndefined();
    expect(isId(broken)).toBe(false);
    expect(cb58Decode('0OIl')).toBeUndefined(); // not base58
    expect(cb58Decode('1')).toBeUndefined(); // shorter than a checksum
    expect(isId(cb58Encode(new Uint8Array(20)))).toBe(false);
    expect(isId(42)).toBe(false);
  });

  it('names a transaction by the SHA-256 of its bytes', () => {
    expect(idOf(new Uint8Array([1, 2, 3]))).toBe(
      cb58Encode(
        Uint8Array.from(
          Buffer.from(
            '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
            'hex',
          ),
        ),
      ),
    );
    expect(toHex(cb58Decode(idOf(new Uint8Array())) ?? new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
