import { Address as SdkAddress } from '@ton/core';
import {
  createTonAddressCodec,
  crc16,
  friendlyAddress,
  parseTonAddress,
  rawAddress,
} from '../../../src/adapters/ton/address';
import { intentHash } from '../../../src/core/model/intent';
import { MASTERCHAIN_FRIENDLY, TEST_WALLETS, USDT_MASTER } from './support/vectors';

const mainnet = createTonAddressCodec({
  testnet: false,
  fromPublicKey: () => TEST_WALLETS.v4r2.basechain,
});
const testnet = createTonAddressCodec({
  testnet: true,
  fromPublicKey: () => TEST_WALLETS.v4r2.basechain,
});

describe('TON addresses: accepted forms', () => {
  it('normalizes raw addresses to lower case, bounceable by default', () => {
    for (const input of [
      USDT_MASTER.raw,
      USDT_MASTER.raw.toUpperCase().replace('0X', '0x'),
    ]) {
      expect(mainnet.normalize(input)).toEqual({
        canonical: USDT_MASTER.raw,
        display: USDT_MASTER.raw,
        variant: { bounceable: true },
      });
    }
    expect(mainnet.normalize(TEST_WALLETS.v4r2.masterchain).canonical).toBe(
      TEST_WALLETS.v4r2.masterchain,
    );
  });

  it('keeps the friendly text as display and its bounce flag as the variant (spec §6.4)', () => {
    const cases = [
      [USDT_MASTER.bounceable, { bounceable: true }],
      [USDT_MASTER.nonBounceable, { bounceable: false }],
      [USDT_MASTER.standardAlphabet, { bounceable: true }],
      [USDT_MASTER.testBounceable, { bounceable: true }],
      [USDT_MASTER.testNonBounceable, { bounceable: false }],
    ] as const;
    for (const [input, variant] of cases) {
      expect(testnet.normalize(input)).toEqual({
        canonical: USDT_MASTER.raw,
        display: input,
        variant,
      });
    }
    expect(mainnet.normalize(MASTERCHAIN_FRIENDLY).canonical).toBe(
      TEST_WALLETS.v4r2.masterchain,
    );
  });

  it('refuses a testnet-only address on mainnet, and accepts both flags on testnet', () => {
    expect(() => mainnet.normalize(USDT_MASTER.testNonBounceable)).toThrow(
      expect.objectContaining({
        code: 'INVALID_ADDRESS',
        message: expect.stringMatching(/testnet-only/),
      }),
    );
    expect(mainnet.validate(USDT_MASTER.testBounceable)).toBe(false);
    expect(testnet.validate(USDT_MASTER.bounceable)).toBe(true);
    expect(testnet.validate(USDT_MASTER.testBounceable)).toBe(true);
  });

  it('renders any form through format(), and the display by default', () => {
    const address = mainnet.normalize(USDT_MASTER.bounceable);
    const format = mainnet.format!;
    expect(format(address)).toBe(USDT_MASTER.bounceable);
    expect(format(address, { bounceable: false })).toBe(USDT_MASTER.nonBounceable);
    expect(format(address, { urlSafe: false })).toBe(USDT_MASTER.standardAlphabet);
    expect(format(address, { raw: true })).toBe(USDT_MASTER.raw);
    expect(
      testnet.format!(testnet.normalize(USDT_MASTER.raw), { bounceable: false }),
    ).toBe(USDT_MASTER.testNonBounceable);
    // The flags the variant leaves out (test-only, alphabet) come from the caller's text.
    const shown = (value: string, options: Record<string, unknown>) =>
      testnet.format!(testnet.normalize(value), options);
    expect(shown(USDT_MASTER.testBounceable, { bounceable: false })).toBe(
      USDT_MASTER.testNonBounceable,
    );
    expect(shown(USDT_MASTER.bounceable, { bounceable: false })).toBe(
      USDT_MASTER.nonBounceable,
    );
    expect(shown(USDT_MASTER.standardAlphabet, { bounceable: false })).toBe(
      USDT_MASTER.nonBounceable.replace(/-/g, '+').replace(/_/g, '/'),
    );
    expect(shown(USDT_MASTER.nonBounceable, { testOnly: true })).toBe(
      USDT_MASTER.testNonBounceable,
    );
  });

  it('shows a wallet as wallets do: non-bounceable, flagged on testnet', () => {
    expect(mainnet.fromPublicKey(new Uint8Array(32))).toEqual({
      canonical: TEST_WALLETS.v4r2.basechain,
      display: expect.stringMatching(/^UQ/),
      variant: { bounceable: false },
    });
    expect(testnet.fromPublicKey(new Uint8Array(32))).toEqual({
      canonical: TEST_WALLETS.v4r2.basechain,
      display: expect.stringMatching(/^0Q/),
      variant: { bounceable: false },
    });
  });

  it('hashes every spelling of one recipient alike: the variant is the bounce flag only (P25-R13)', () => {
    const hashTo = (value: string): string => {
      const to = testnet.normalize(value);
      return intentHash('ton', 'testnet', {
        assetId: 'ton:testnet/native',
        asset: 'native',
        outputs: [{ to: to.canonical, amount: 1n, variant: { ...to.variant } }],
        from: TEST_WALLETS.v4r2.basechain,
        fee: 'normal',
      });
    };
    const bounceable = hashTo(USDT_MASTER.raw);
    for (const spelling of [
      USDT_MASTER.raw.toUpperCase().replace('0X', '0x'),
      USDT_MASTER.bounceable,
      USDT_MASTER.standardAlphabet,
      USDT_MASTER.testBounceable,
    ]) {
      expect(hashTo(spelling)).toBe(bounceable);
    }
    const nonBounceable = hashTo(USDT_MASTER.nonBounceable);
    expect(hashTo(USDT_MASTER.testNonBounceable)).toBe(nonBounceable);
    // The bounce flag changes what the transfer does, so it changes the hash.
    expect(nonBounceable).not.toBe(bounceable);
  });

  it('computes the CRC16-XMODEM check value', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x31c3);
  });
});

describe('TON addresses: strictness (lesson 4)', () => {
  const hex = USDT_MASTER.raw.slice(2);
  const bytes = Buffer.from(
    USDT_MASTER.bounceable.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  const reencode = (mutate: (b: Buffer) => void): string => {
    const copy = Buffer.from(bytes);
    mutate(copy);
    return copy.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  };
  const workchainOne = reencode((b) => {
    b[1] = 0x01;
    const crc = crc16(b.subarray(0, 34));
    b[34] = crc >> 8;
    b[35] = crc & 0xff;
  });
  const mixedAlphabet = `${USDT_MASTER.bounceable.slice(0, 10)}+${USDT_MASTER.bounceable.slice(11)}`;

  it('rejects everything but the two canonical forms', () => {
    const invalid = [
      '',
      ` ${USDT_MASTER.raw}`,
      `${USDT_MASTER.raw}\n`,
      `1:${hex}`,
      `00:${hex}`,
      `+0:${hex}`,
      `-0:${hex}`,
      `0:${hex.slice(1)}`,
      `0:${hex}0`,
      `0:${hex.slice(1)}g`,
      `0x${hex}`,
      USDT_MASTER.bounceable.slice(1),
      `${USDT_MASTER.bounceable}=`,
      reencode((b) => {
        b[35] = (b[35] as number) ^ 1;
      }),
      reencode((b) => {
        b[0] = 0x12;
      }),
      workchainOne,
      mixedAlphabet,
    ];
    for (const value of invalid) {
      expect([value, parseTonAddress(value)]).toEqual([value, null]);
      expect(mainnet.validate(value)).toBe(false);
      expect(() => mainnet.normalize(value)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    }
  });

  it('refuses an input longer than either form before decoding it (lesson 20)', () => {
    const huge = [
      'A'.repeat(100_000),
      `0:${'a'.repeat(99_998)}`,
      `${USDT_MASTER.bounceable}${'A'.repeat(100_000 - 48)}`,
    ];
    for (const value of huge) {
      expect(value.length).toBe(100_000);
      expect(parseTonAddress(value)).toBeNull();
      expect(mainnet.validate(value)).toBe(false);
      expect(() => testnet.normalize(value)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'not a TON address',
        }),
      );
    }
    // The longest accepted text is a masterchain raw address: `-1:` and 64 hex digits.
    expect(TEST_WALLETS.v4r2.masterchain).toHaveLength(67);
    expect(parseTonAddress(TEST_WALLETS.v4r2.masterchain)).not.toBeNull();
    expect(parseTonAddress(`${TEST_WALLETS.v4r2.masterchain}0`)).toBeNull();
  });

  it('is stricter than @ton/core, which accepts these', () => {
    for (const lenient of [`1:${hex}`, `00:${hex}`, `+0:${hex}`, workchainOne]) {
      expect(() => SdkAddress.parse(lenient)).not.toThrow();
      expect(parseTonAddress(lenient)).toBeNull();
    }
  });

  it('never pads or truncates a hash that is not 32 bytes', () => {
    const flags = { bounceable: true, testOnly: false, urlSafe: true };
    for (const size of [0, 31, 33]) {
      const hash = new Uint8Array(size).fill(7);
      expect(() => rawAddress(0, hash)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
      expect(() => friendlyAddress(0, hash, flags)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    }
  });

  it('agrees with @ton/core on every address it accepts', () => {
    const accepted = [
      USDT_MASTER.raw,
      USDT_MASTER.bounceable,
      USDT_MASTER.nonBounceable,
      USDT_MASTER.testBounceable,
      USDT_MASTER.testNonBounceable,
      USDT_MASTER.standardAlphabet,
      MASTERCHAIN_FRIENDLY,
      TEST_WALLETS.v5r1.mainnetMasterchain,
    ];
    for (const value of accepted) {
      const ours = parseTonAddress(value);
      const sdk = SdkAddress.parse(value);
      expect(ours?.workchain).toBe(sdk.workChain);
      expect(Buffer.from(ours?.hash ?? []).equals(sdk.hash)).toBe(true);
      if (SdkAddress.isFriendly(value)) {
        const flags = SdkAddress.parseFriendly(value);
        expect([ours?.bounceable, ours?.testOnly]).toEqual([
          flags.isBounceable,
          flags.isTestOnly,
        ]);
        expect(
          friendlyAddress(sdk.workChain as 0 | -1, sdk.hash, {
            bounceable: flags.isBounceable,
            testOnly: flags.isTestOnly,
            urlSafe: ours?.urlSafe ?? true,
          }),
        ).toBe(value);
      }
    }
  });
});
