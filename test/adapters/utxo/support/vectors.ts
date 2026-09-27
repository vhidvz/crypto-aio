/**
 * Test keys and frozen vectors for the UTXO family. The BIP vectors are quoted from the
 * BIPs (Plan 3 appendix); everything else is cross-checked against bitcoinjs-lib in tests.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { toHex } from '../../../../src/core/util/bytes';

/** Address parameters of regtest (the scripted node's network). */
export const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4 } as const;

/** A test-only key: sha256('crypto-aio/utxo test key'). Never fund it on a real network. */
export const TEST_KEY = sha256(utf8ToBytes('crypto-aio/utxo test key'));
export const TEST_PUBKEY = secp256k1.getPublicKey(TEST_KEY, true);
export const TEST_XONLY = schnorr.getPublicKey(TEST_KEY);

/** A second key (a stranger's), sha256('crypto-aio/utxo other key'). */
export const OTHER_KEY = sha256(utf8ToBytes('crypto-aio/utxo other key'));
export const OTHER_PUBKEY = secp256k1.getPublicKey(OTHER_KEY, true);

export function testSigner(id = 'hot') {
  return localSigner({ id, secp256k1: secret(toHex(TEST_KEY)) });
}

/** BIP173: the compressed generator point and its mainnet p2wpkh address. */
export const BIP173_PUBKEY =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const BIP173_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

/** BIP86: m/86'/0'/0'/0/0 of the "abandon … about" mnemonic. */
export const BIP86_INTERNAL_KEY =
  'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115';
export const BIP86_OUTPUT_KEY =
  'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c';
export const BIP86_ADDRESS =
  'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';

/** BIP350: valid addresses and their output scripts. */
export const BIP350_VALID: readonly (readonly [string, string])[] = [
  [
    'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
    '0014751e76e8199196d454941c45d1b3a323f1433bd6',
  ],
  [
    'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
    '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
  ],
  [
    'tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy',
    '0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433',
  ],
  [
    'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c',
    '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433',
  ],
  [
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  ],
];

/** A bech32m v1 address whose 32-byte program (x = 5) is not a curve point. */
export const NOT_ON_CURVE =
  'bc1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzs2jkusy';

/**
 * Well-formed addresses this library refuses on purpose: BIP350's witness versions and
 * program lengths it cannot know are spendable (v1 with 40 bytes, v16, v2), and a v1 program
 * that is not a curve point (sending there burns the coins).
 */
export const BIP350_REFUSED: readonly string[] = [
  'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y',
  'BC1SW50QGDZ25J',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
  NOT_ON_CURVE,
];

/** BIP350: invalid addresses. */
export const BIP350_INVALID: readonly string[] = [
  'tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
  'tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf',
  'BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
  'tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47',
  'bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4',
  'BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R',
  'bc1pw5dgrnzv',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav',
  'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf',
  'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
  'bc1gmk9yu',
];

/**
 * BIP341 wallet-test-vectors.json, keyPathSpending input 0 (no script tree; the same key as
 * scriptPubKey[0]). `tweakedPrivkey` signs for the tweaked key: its compressed public key
 * starts with 03, so the tweaked key has odd y (parity 1).
 */
export const BIP341_KEY_PATH = {
  internalPubkey: 'd6889cb081036e0faefa3a35157ad71086b123b2b144b649798b494c300a961d',
  tweak: 'b86e7be8f39bab32a6f2c0443abbc210f0edac0e2c53d501b36b64437d9c6c70',
  tweakedPrivkey: '2405b971772ad26915c8dcdf10f238753a9b837e5f8e6a86fd7c0cce5b7296d9',
  tweakedPubkey: '53a1f6e454df1aa2776a2814a721372d6258050de330b3c6d10ee8f4e0dda343',
  parity: 1,
  address: 'bc1p2wsldez5mud2yam29q22wgfh9439spgduvct83k3pm50fcxa5dps59h4z5',
} as const;

/**
 * BIP341 wallet-test-vectors.json, scriptPubKey[2]: its control block starts with c0, so
 * the tweaked key has even y (parity 0).
 */
export const BIP341_EVEN_Y = {
  internalPubkey: '93478e9488f956df2396be2ce6c5cced75f900dfa18e7dabd2428aae78451820',
  tweak: '6af9e28dbf9d6aaf027696e2598a5b3d056f5fd2355a7fd5a37a0e5008132d30',
  tweakedPubkey: 'e4d810fd50586274face62b8a807eb9719cef49c04177cc6b76a9a4251d5450e',
  parity: 0,
} as const;
