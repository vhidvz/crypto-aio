import { hexToBytes } from '@noble/hashes/utils';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import {
  decodeAddress,
  dustThreshold,
  taprootTweak,
  walletAddress,
  type AddressParams,
} from '../../../src/adapters/utxo/address';
import { nobleEcc } from '../../../src/adapters/utxo/ecc';
import { toHex } from '../../../src/core/util/bytes';
import {
  BIP173_P2WPKH,
  BIP173_PUBKEY,
  BIP350_INVALID,
  BIP350_REFUSED,
  BIP350_VALID,
  BIP86_ADDRESS,
  BIP86_INTERNAL_KEY,
  BIP86_OUTPUT_KEY,
  TEST_PUBKEY,
  TEST_XONLY,
} from './support/vectors';

const MAIN: AddressParams = { bech32: 'bc', pubKeyHash: 0x00, scriptHash: 0x05 };
const TEST: AddressParams = { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4 };
const REGTEST: AddressParams = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4 };
const paramsOf = (address: string) =>
  address.toLowerCase().startsWith('tb1') ? TEST : MAIN;

beforeAll(() => bitcoin.initEccLib(nobleEcc));

describe('decodeAddress (strict, lesson 4)', () => {
  it.each(BIP350_VALID)('decodes %s to its BIP350 script', (address, script) => {
    const decoded = decodeAddress(address, paramsOf(address));
    expect(toHex(decoded.script)).toBe(script);
    expect(decoded.canonical).toBe(address.toLowerCase());
  });

  it.each([...BIP350_INVALID, ...BIP350_REFUSED])('refuses %s', (address) => {
    expect(() => decodeAddress(address, paramsOf(address))).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
  });

  it('refuses another network, whitespace and junk, naming no address', () => {
    const cases: [string, AddressParams][] = [
      [BIP173_P2WPKH, TEST],
      ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', MAIN],
      ['1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH', TEST],
      ['mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', MAIN],
      [` ${BIP173_P2WPKH}`, MAIN],
      ['', MAIN],
      ['0x1234', MAIN],
    ];
    for (const [address, params] of cases) {
      let error: unknown;
      try {
        decodeAddress(address, params);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: 'INVALID_ADDRESS' });
      if (address.trim()) expect((error as Error).message).not.toContain(address.trim());
    }
  });

  it('agrees with bitcoinjs-lib on every accepted address', () => {
    const accepted = [
      ...BIP350_VALID.map(([address]) => address),
      '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      '3P14159f73E4gFr7JterCCQh9QjiTjiZrG',
      'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
      '2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc',
    ];
    for (const address of accepted) {
      const params = /^(tb1|m|n|2)/i.test(address) ? TEST : MAIN;
      const network =
        params === TEST ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
      expect(toHex(decodeAddress(address, params).script)).toBe(
        toHex(bitcoin.address.toOutputScript(address, network)),
      );
    }
  });
});

describe('walletAddress (independent of bitcoinjs-lib, lesson 11)', () => {
  it('matches BIP173 and BIP86', () => {
    expect(walletAddress(hexToBytes(BIP173_PUBKEY), 'p2wpkh', MAIN).address).toBe(
      BIP173_P2WPKH,
    );
    const taproot = walletAddress(hexToBytes(BIP86_INTERNAL_KEY), 'p2tr', MAIN);
    expect(taproot.address).toBe(BIP86_ADDRESS);
    expect(toHex(taproot.outputKey as Uint8Array)).toBe(BIP86_OUTPUT_KEY);
  });

  it('matches bitcoinjs-lib payments for every wallet type and network', () => {
    const cases: [AddressParams, (typeof bitcoin.networks)['bitcoin']][] = [
      [MAIN, bitcoin.networks.bitcoin],
      [TEST, bitcoin.networks.testnet],
      [REGTEST, bitcoin.networks.regtest],
    ];
    for (const [params, network] of cases) {
      const pubkey = TEST_PUBKEY;
      expect(walletAddress(pubkey, 'p2wpkh', params).address).toBe(
        bitcoin.payments.p2wpkh({ pubkey, network }).address,
      );
      expect(walletAddress(pubkey, 'p2pkh', params).address).toBe(
        bitcoin.payments.p2pkh({ pubkey, network }).address,
      );
      expect(walletAddress(pubkey, 'p2sh-p2wpkh', params).address).toBe(
        bitcoin.payments.p2sh({
          redeem: bitcoin.payments.p2wpkh({ pubkey, network }),
          network,
        }).address,
      );
      expect(walletAddress(pubkey, 'p2tr', params).address).toBe(
        bitcoin.payments.p2tr({ internalPubkey: TEST_XONLY, network }).address,
      );
      expect(walletAddress(TEST_XONLY, 'p2tr', params).address).toBe(
        walletAddress(pubkey, 'p2tr', params).address,
      );
    }
  });

  it('refuses private-key-sized, uncompressed and off-curve keys (R58)', () => {
    const uncompressed = new Uint8Array(65).fill(4);
    const offCurve = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0xff)]);
    for (const [key, type] of [
      [TEST_XONLY, 'p2wpkh'],
      [TEST_XONLY, 'p2pkh'],
      [uncompressed, 'p2pkh'],
      [offCurve, 'p2wpkh'],
      [new Uint8Array(32).fill(0xff), 'p2tr'],
    ] as const) {
      expect(() => walletAddress(key, type, MAIN)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    }
  });
});

describe('the @noble/curves ECC backend (spec §15)', () => {
  it("passes bitcoinjs-lib's own verification and tweaks as BIP86 does", () => {
    expect(() => bitcoin.initEccLib(nobleEcc)).not.toThrow();
    const internal = hexToBytes(BIP86_INTERNAL_KEY);
    const { tweak } = taprootTweak(internal);
    expect(
      toHex(
        nobleEcc.xOnlyPointAddTweak(internal, tweak)?.xOnlyPubkey ?? new Uint8Array(),
      ),
    ).toBe(BIP86_OUTPUT_KEY);
    expect(nobleEcc.isXOnlyPoint(new Uint8Array(32))).toBe(false);
    expect(nobleEcc.xOnlyPointAddTweak(new Uint8Array(32), tweak)).toBeNull();
    expect(
      nobleEcc.xOnlyPointAddTweak(internal, new Uint8Array(32).fill(0xff)),
    ).toBeNull();
  });
});

describe('dustThreshold (Bitcoin Core GetDustThreshold at 3,000 sat/kvB)', () => {
  it.each([
    ['p2pkh', '76a914' + '00'.repeat(20) + '88ac', 546n],
    ['p2sh', 'a914' + '00'.repeat(20) + '87', 540n],
    ['p2wpkh', '0014' + '00'.repeat(20), 294n],
    ['p2wsh', '0020' + '00'.repeat(32), 330n],
    ['p2tr', '5120' + '00'.repeat(32), 330n],
  ])('%s is dust below %s', (_type, script, dust) => {
    expect(dustThreshold(hexToBytes(script), 3_000n)).toBe(dust);
  });
});
