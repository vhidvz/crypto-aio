import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { HARDENED_OFFSET, HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { ConfigError } from '../errors/error';

export interface PathSegment {
  readonly index: number;
  readonly hardened: boolean;
}

export interface ExtendedKeyVersions {
  readonly private: number;
  readonly public: number;
}

const KNOWN_VERSIONS: Readonly<Record<string, ExtendedKeyVersions>> = {
  xpub: { private: 0x0488ade4, public: 0x0488b21e },
  tpub: { private: 0x04358394, public: 0x043587cf },
};

/**
 * A20 (SLIP-0132): whether each registered Bitcoin extended PUBLIC key version belongs to a
 * test network (`tpub`, `upub`, `vpub`, `Upub`, `Vpub`) or to mainnet (`xpub`, `ypub`,
 * `zpub`, `Ypub`, `Zpub`).
 */
const TESTNET_VERSION: ReadonlyMap<number, boolean> = new Map([
  [0x0488b21e, false], // xpub
  [0x049d7cb2, false], // ypub
  [0x04b24746, false], // zpub
  [0x0295b43f, false], // Ypub
  [0x02aa7ed3, false], // Zpub
  [0x043587cf, true], // tpub
  [0x044a5262, true], // upub
  [0x045f1cf6, true], // vpub
  [0x024289ef, true], // Upub
  [0x02575483, true], // Vpub
]);

export function mnemonicToSeed(phrase: string, passphrase = ''): Uint8Array {
  const normalized = phrase.trim().normalize('NFKD').split(/\s+/).join(' ');
  if (!validateMnemonic(normalized, wordlist)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'invalid BIP39 mnemonic (checksum or word list mismatch)',
    );
  }
  return mnemonicToSeedSync(normalized, passphrase);
}

export function parsePath(path: string): PathSegment[] {
  const parts = path.trim().split('/');
  if (parts[0] !== 'm') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `derivation path must start with 'm': ${path}`,
    );
  }
  return parts.slice(1).map((part) => {
    const hardened = /['hH]$/.test(part);
    const digits = hardened ? part.slice(0, -1) : part;
    if (!/^\d+$/.test(digits))
      throw new ConfigError(
        'CONFIG_INVALID',
        `invalid path segment '${part}' in ${path}`,
      );
    const index = Number(digits);
    if (index >= 2 ** 31)
      throw new ConfigError('CONFIG_INVALID', `path index out of range in ${path}`);
    return { index, hardened };
  });
}

export function deriveSecp256k1(seed: Uint8Array, path: string): Uint8Array {
  const segments = parsePath(path);
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const segment of segments) {
      node = node.deriveChild(
        segment.hardened ? segment.index + HARDENED_OFFSET : segment.index,
      );
    }
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', `could not derive a private key at ${path}`, {
      cause,
    });
  }
  const key = node.privateKey;
  if (!key)
    throw new ConfigError('CONFIG_INVALID', `could not derive a private key at ${path}`);
  return key;
}

/** SLIP-10 ed25519 derivation (hardened segments only). */
export function deriveEd25519(seed: Uint8Array, path: string): Uint8Array {
  let digest = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  let key = digest.slice(0, 32);
  let chainCode = digest.slice(32);
  for (const segment of parsePath(path)) {
    if (!segment.hardened) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `ed25519 (SLIP-10) supports hardened derivation only: ${path}`,
      );
    }
    const data = new Uint8Array(37);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, (segment.index | 0x80000000) >>> 0);
    digest = hmac(sha512, chainCode, data);
    key = digest.slice(0, 32);
    chainCode = digest.slice(32);
  }
  return key;
}

/**
 * Non-hardened child public key (33-byte compressed) from an extended PUBLIC key. A20: with
 * `network`, a key whose SLIP-0132 version belongs to the other network class (a mainnet
 * `xpub`/`zpub` on a test network, a `tpub`/`vpub` on mainnet) is `CONFIG_INVALID`; a
 * version outside the Bitcoin SLIP-0132 table has no known class and is not checked. Pass
 * it for chains whose extended keys carry a network class (UTXO chains).
 */
export function deriveXpubChild(
  xpub: string,
  relativePath: string,
  versions?: ExtendedKeyVersions,
  network?: { readonly testnet: boolean },
): Uint8Array {
  const prefix = xpub.slice(0, 4);
  const selected = versions ?? KNOWN_VERSIONS[prefix];
  if (!selected) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `unsupported extended key prefix '${prefix}'; pass xpubVersions for this format`,
    );
  }
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(xpub, selected);
  } catch (cause) {
    throw new ConfigError('CONFIG_INVALID', 'invalid extended public key', { cause });
  }
  if (node.privateKey) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'expected an extended PUBLIC key; never configure private extended keys',
    );
  }
  // The key parsed with `selected`, so its version is `selected.public`.
  const testnet = TESTNET_VERSION.get(selected.public);
  if (network && testnet !== undefined && testnet !== network.testnet) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `the extended public key is for ${testnet ? 'a test network' : 'mainnet'}, but the network is ${network.testnet ? 'a test network' : 'mainnet'}`,
    );
  }
  const path = relativePath.startsWith('m') ? relativePath : `m/${relativePath}`;
  let child: HDKey;
  try {
    child = node.derive(path);
  } catch (cause) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `cannot derive '${relativePath}' from an xpub (hardened segments need the private key)`,
      { cause },
    );
  }
  if (!child.publicKey)
    throw new ConfigError('CONFIG_INVALID', `no public key at '${relativePath}'`);
  return child.publicKey;
}
