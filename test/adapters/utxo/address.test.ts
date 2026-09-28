import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import { bitcoin } from '../../../src/adapters/utxo/sdk';
import {
  addressFromScript,
  decodeAddress,
  dustThreshold,
  outputScript,
  taprootTweak,
  walletAddress,
  walletTypeOf,
  type AddressParams,
} from '../../../src/adapters/utxo/address';
import { nobleEcc } from '../../../src/adapters/utxo/ecc';
import { toHex } from '../../../src/core/util/bytes';
import {
  BIP173_P2WPKH,
  BIP173_PUBKEY,
  BIP341_EVEN_Y,
  BIP341_KEY_PATH,
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
/** A custom network whose base58 p2pkh addresses can start with its HRP plus "1" (M5). */
const COLLIDING: AddressParams = { bech32: 'am', pubKeyHash: 0x17, scriptHash: 0x05 };
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

  it('refuses input over 90 characters before decoding it (lesson 20)', () => {
    // The 100,000-character input comes last, so a missing cap fails fast on the others.
    for (const address of ['1'.repeat(91), `bc1${'q'.repeat(88)}`, 'z'.repeat(100_000)]) {
      const started = performance.now();
      expect(() => decodeAddress(address, MAIN)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'invalid Bitcoin address: too long',
        }),
      );
      // Base58 decoding is quadratic: 100,000 characters would block for over a minute.
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it('refuses a flipped checksum character and trailing garbage (M7)', () => {
    const p2pkh = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';
    for (const address of [
      `${BIP173_P2WPKH.slice(0, -1)}5`,
      `${p2pkh.slice(0, -1)}J`,
      `${p2pkh}z`,
      `${BIP173_P2WPKH}q`,
    ]) {
      expect(() => decodeAddress(address, MAIN)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'invalid Bitcoin address: bad checksum or encoding',
        }),
      );
    }
  });

  it('decodes regtest addresses with the regtest parameters (M7)', () => {
    expect(
      toHex(
        decodeAddress('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', REGTEST).script,
      ),
    ).toBe('0014751e76e8199196d454941c45d1b3a323f1433bd6');
    for (const type of ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const) {
      const { address, script } = walletAddress(TEST_PUBKEY, type, REGTEST);
      expect(toHex(decodeAddress(address, REGTEST).script)).toBe(toHex(script));
      expect(toHex(script)).toBe(
        toHex(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)),
      );
    }
    expect(() =>
      decodeAddress(
        'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
        REGTEST,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
  });

  it('takes the base58 path when a base58 address starts with the HRP and "1" (M5)', () => {
    // On COLLIDING, TEST_PUBKEY's p2pkh address starts with "AM1": the HRP "am" plus "1".
    const address = 'AM1TAr9Bci1FZtcFXEUnjhDG914jaZJUmj';
    const wallet = walletAddress(TEST_PUBKEY, 'p2pkh', COLLIDING);
    expect(wallet.address).toBe(address);
    const decoded = decodeAddress(address, COLLIDING);
    expect(decoded).toMatchObject({ type: 'p2pkh', canonical: address });
    expect(toHex(decoded.script)).toBe(toHex(wallet.script));
    const network = { ...bitcoin.networks.bitcoin, ...COLLIDING };
    expect(toHex(decoded.script)).toBe(
      toHex(bitcoin.address.toOutputScript(address, network)),
    );
    // The network's own bech32 addresses still take the segwit path.
    const segwit = walletAddress(TEST_PUBKEY, 'p2wpkh', COLLIDING);
    expect(decodeAddress(segwit.address, COLLIDING)).toMatchObject({
      type: 'p2wpkh',
      canonical: segwit.address,
    });
    // A single-case base58 address takes the base58 path on its characters alone: after
    // "X1", "B" and "1" are not bech32 characters. (A constructed payload, not a key.)
    const upper = 'X1BBBBBBBBBBBBBBBBBBBB111112LRNL6P';
    const params: AddressParams = { bech32: 'x', pubKeyHash: 0x4a, scriptHash: 0x05 };
    const script = `76a914${'9067847597ecadb61734921529abcf9aa0aaa07c'}88ac`;
    expect(toHex(decodeAddress(upper, params).script)).toBe(script);
    expect(
      toHex(
        bitcoin.address.toOutputScript(upper, { ...bitcoin.networks.bitcoin, ...params }),
      ),
    ).toBe(script);
  });

  it('maps each output type to its wallet type, and p2wsh cannot send (M7)', () => {
    const main = (address: string) => walletTypeOf(decodeAddress(address, MAIN));
    expect(main(BIP173_P2WPKH)).toBe('p2wpkh');
    expect(main('3P14159f73E4gFr7JterCCQh9QjiTjiZrG')).toBe('p2sh-p2wpkh');
    expect(main('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH')).toBe('p2pkh');
    expect(main(BIP86_ADDRESS)).toBe('p2tr');
    const p2wsh = decodeAddress(
      'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
      TEST,
    );
    expect(p2wsh.type).toBe('p2wsh');
    expect(() => walletTypeOf(p2wsh)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
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

  it('fits a 30-letter HRP: its p2tr address is exactly 90 characters (M4)', () => {
    const params: AddressParams = {
      bech32: 'a'.repeat(30),
      pubKeyHash: 0x00,
      scriptHash: 0x05,
    };
    const wallet = walletAddress(TEST_PUBKEY, 'p2tr', params);
    expect(wallet.address).toHaveLength(90);
    expect(toHex(decodeAddress(wallet.address, params).script)).toBe(
      toHex(wallet.script),
    );
  });
});

describe('outputScript (M2)', () => {
  it.each([
    ['p2pkh', 20, '76a914', '88ac'],
    ['p2sh', 20, 'a914', '87'],
    ['p2wpkh', 20, '0014', ''],
    ['p2wsh', 32, '0020', ''],
    ['p2tr', 32, '5120', ''],
  ] as const)('%s takes a %i-byte program and no other', (type, length, head, tail) => {
    expect(toHex(outputScript(type, new Uint8Array(length).fill(0xab)))).toBe(
      head + 'ab'.repeat(length) + tail,
    );
    for (const wrong of [0, 19, 20, 21, 31, 32, 33].filter((n) => n !== length)) {
      expect(() => outputScript(type, new Uint8Array(wrong))).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message: 'invalid Bitcoin address: the output program has the wrong length',
        }),
      );
    }
  });
});

describe('addressFromScript (the inverse of outputScript; lesson 11)', () => {
  const NETWORKS = [
    [MAIN, bitcoin.networks.bitcoin],
    [TEST, bitcoin.networks.testnet],
    [REGTEST, bitcoin.networks.regtest],
  ] as const;

  it('names the five standard scripts as bitcoinjs-lib does, on every network', () => {
    for (const [params, network] of NETWORKS) {
      const scripts = [
        ...(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const).map(
          (type) => walletAddress(TEST_PUBKEY, type, params).script,
        ),
        outputScript('p2wsh', new Uint8Array(32).fill(0x11)),
        outputScript('p2tr', hexToBytes(BIP86_OUTPUT_KEY)),
      ];
      for (const script of scripts) {
        const named = addressFromScript(script, params);
        expect(named?.canonical).toBe(bitcoin.address.fromOutputScript(script, network));
        expect(toHex(decodeAddress(named!.canonical, params).script)).toBe(toHex(script));
        expect(named).toEqual(decodeAddress(named!.canonical, params));
      }
    }
  });

  it('names the BIP350 scripts as the vectors do', () => {
    for (const [address, script] of BIP350_VALID) {
      expect(addressFromScript(hexToBytes(script), paramsOf(address))?.canonical).toBe(
        address.toLowerCase(),
      );
    }
  });

  it('leaves every other script unnamed', () => {
    const p2pkh = walletAddress(TEST_PUBKEY, 'p2pkh', MAIN).script;
    const unnamed = [
      new Uint8Array(0),
      Uint8Array.of(0x21, ...TEST_PUBKEY, 0xac), // p2pk
      Uint8Array.of(0x6a, 0x04, 1, 2, 3, 4), // OP_RETURN
      Uint8Array.of(0x51, 0x21, ...TEST_PUBKEY, 0x51, 0xae), // bare multisig
      Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(1)), // witness v2
      Uint8Array.of(0x00, 0x15, ...new Uint8Array(21).fill(1)), // v0, 21 bytes
      Uint8Array.of(0x51, 0x14, ...new Uint8Array(20).fill(1)), // v1, 20 bytes
      Uint8Array.of(0x51, 0x02, 0x4e, 0x73), // pay-to-anchor
      Uint8Array.of(...p2pkh, 0x00), // trailing byte
      Uint8Array.of(...p2pkh.slice(0, 23), 0x88, 0xad), // OP_CHECKSIGVERIFY
      Uint8Array.of(...p2pkh.slice(0, 23), 0x87, 0xac), // OP_EQUAL
      Uint8Array.of(0xa9, 0x14, ...new Uint8Array(20).fill(1), 0x88), // p2sh, EQUALVERIFY
      Uint8Array.of(0xaa, 0x14, ...new Uint8Array(20).fill(1), 0x87), // HASH256, not HASH160
      p2pkh.slice(0, 24), // cut short
      // The program of NOT_ON_CURVE (x = 5), which decodeAddress refuses too.
      Uint8Array.of(0x51, 0x20, ...new Uint8Array(31), 5),
      new Uint8Array(3_990_000).fill(0x6a),
    ];
    for (const script of unnamed) expect(addressFromScript(script, MAIN)).toBeUndefined();
  });
});

describe('the @noble/curves ECC backend (spec §15)', () => {
  it("passes bitcoinjs-lib's own verification and tweaks as BIP86 does", () => {
    // Clear bitcoinjs' cache first: it verifies a backend only when a new one is installed.
    bitcoin.initEccLib(undefined);
    expect(() => bitcoin.payments.p2tr({ internalPubkey: TEST_XONLY })).toThrow();
    expect(() => bitcoin.initEccLib({ ...nobleEcc, isXOnlyPoint: () => true })).toThrow();
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

  it('pins the tweaked key and its parity to BIP341 wallet-test-vectors (M7)', () => {
    const keyPath = hexToBytes(BIP341_KEY_PATH.internalPubkey);
    expect(toHex(taprootTweak(keyPath).tweak)).toBe(BIP341_KEY_PATH.tweak);
    expect(walletAddress(keyPath, 'p2tr', MAIN).address).toBe(BIP341_KEY_PATH.address);
    // The vector's tweaked private key signs for the tweaked key: its 03 prefix is odd y.
    const tweakedPrivkey = hexToBytes(BIP341_KEY_PATH.tweakedPrivkey);
    expect(secp256k1.getPublicKey(tweakedPrivkey, true)[0]).toBe(0x03);
    for (const vector of [BIP341_KEY_PATH, BIP341_EVEN_Y]) {
      const result = nobleEcc.xOnlyPointAddTweak(
        hexToBytes(vector.internalPubkey),
        hexToBytes(vector.tweak),
      );
      expect(result && { parity: result.parity, key: toHex(result.xOnlyPubkey) }).toEqual(
        {
          parity: vector.parity,
          key: vector.tweakedPubkey,
        },
      );
    }
  });

  it('refuses a taproot internal key that is not an x-only point (M1)', () => {
    for (const key of [
      new Uint8Array(32),
      new Uint8Array(32).fill(0xff),
      new Uint8Array(31).fill(1),
      TEST_PUBKEY,
    ]) {
      expect(() => taprootTweak(key)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ADDRESS',
          message:
            'invalid Bitcoin address: the taproot internal key is not an x-only point',
        }),
      );
    }
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

  it('is zero for an unspendable script, as Core IsUnspendable (M3)', () => {
    expect(dustThreshold(Uint8Array.of(0x6a), 3_000n)).toBe(0n);
    expect(dustThreshold(hexToBytes('6a04deadbeef'), 3_000n)).toBe(0n);
    expect(dustThreshold(new Uint8Array(10_001).fill(0x51), 3_000n)).toBe(0n);
    // 10,000 bytes is still spendable: 8 + 3 (CompactSize) + 10,000 + 148 = 10,159 bytes.
    expect(dustThreshold(new Uint8Array(10_000).fill(0x51), 3_000n)).toBe(30_477n);
    // So is an empty script: 8 + 1 + 0 + 148 = 157 bytes.
    expect(dustThreshold(new Uint8Array(0), 3_000n)).toBe(471n);
  });

  it('counts the full CompactSize of the script length (M3)', () => {
    // 8 + 1 + 252 + 148 = 409 bytes; 8 + 3 + 253 + 148 = 412 bytes.
    expect(dustThreshold(new Uint8Array(252).fill(0x51), 3_000n)).toBe(1_227n);
    expect(dustThreshold(new Uint8Array(253).fill(0x51), 3_000n)).toBe(1_236n);
  });
});
