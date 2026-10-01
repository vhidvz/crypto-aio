import type { ResolvedSelection, WalletConfig } from '../config/types';
import type { ChainDriver, WalletKey, WalletOptions } from '../driver/types';
import { ConfigError } from '../errors/error';
import { Address } from '../model/address';
import type { SchemeCatalog } from '../registry/schemes';
import { fromHex } from '../util/bytes';
import { signerPublicKey, signerSchemes, type SignerDeadline } from './guard';
import { parseExtendedPublicKey, type ExtendedKeyVersions } from './hd';
import type { KeyRef, Signer } from './types';

export interface ResolvedWallet {
  readonly name: string;
  readonly config: WalletConfig;
  readonly address: Address;
  /** One key per chain scheme the signer supports; `keys[0]` defines the address. */
  readonly keys: readonly WalletKey[];
  readonly options: WalletOptions;
  readonly watchOnly: boolean;
  readonly tier?: string;
  signerFor(
    keyRef?: KeyRef,
  ): { readonly id: string; readonly signer: Signer } | undefined;
  /** The signer with this id (own keys only), e.g. to cancel a ticket through its issuer. */
  signerById(id: string): { readonly id: string; readonly signer: Signer } | undefined;
}

/**
 * The wallet's extended public key as drivers receive it, `WalletOptions.hd`: plain,
 * frozen data, present only when the wallet configures a non-empty `xpub` (an empty
 * one counts as none, as in `deriveAddress`), which must be a readable PUBLIC extended key
 * (`CONFIG_INVALID` otherwise, naming no key).
 */
export interface WalletHdOptions {
  readonly xpub: string;
  /** Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`. */
  readonly xpubPath?: string;
  readonly xpubVersions?: ExtendedKeyVersions;
}

export function walletOptionsOf(config: WalletConfig): WalletOptions {
  // `hd` is the core's own key: the wallet's xpub or nothing, never a user option, since
  // a driver trusts it to validate change addresses.
  const { hd: _ignored, ...options } = config.options ?? {};
  return {
    ...options,
    ...(config.utxo ? { utxo: config.utxo } : {}),
    ...(config.ton ? { ton: config.ton } : {}),
    // A falsy `xpub` ('', null) is no xpub, as `deriveAddress` reads it.
    ...(config.xpub ? { hd: hdOptionsOf(config) } : {}),
  };
}

/**
 * The wallet's `xpubPath`, `undefined` when absent (`undefined` or `null`, as
 * `deriveAddress` reads it). One that is present but not a string is `CONFIG_INVALID` with a
 * fixed text. Wallet resolution and `deriveAddress` share this check.
 */
export function xpubPathOf(config: WalletConfig): string | undefined {
  const path: unknown = config.xpubPath;
  if (path === undefined || path === null) return undefined;
  if (typeof path !== 'string') {
    throw new ConfigError('CONFIG_INVALID', 'xpubPath must be a string');
  }
  return path;
}

function hdOptionsOf(config: WalletConfig): WalletHdOptions {
  const xpubPath = xpubPathOf(config);
  const versions = config.xpubVersions;
  // The frozen copy comes first, reading each field once, and the key is read against
  // it, so it is checked against exactly the versions a driver receives.
  const hd: WalletHdOptions = Object.freeze({
    xpub: config.xpub as string,
    ...(xpubPath !== undefined ? { xpubPath } : {}),
    // The version pair only, never other keys of the caller's object.
    ...(versions
      ? {
          xpubVersions: Object.freeze({
            private: versions.private,
            public: versions.public,
          }),
        }
      : {}),
  });
  // Only a readable, PUBLIC extended key ever reaches a driver.
  parseExtendedPublicKey(hd.xpub, hd.xpubVersions);
  return hd;
}

/**
 * A watch-only wallet's `publicKey` is checked as a signer's key is: hex of
 * exactly the length its scheme defines. Any other key fails here, never later: an
 * uncompressed secp256k1 key derives an address but never verifies a signature.
 */
function watchOnlyKey(
  name: string,
  hex: unknown,
  scheme: string,
  length: number,
): Uint8Array {
  let key: Uint8Array | undefined;
  try {
    key = typeof hex === 'string' ? fromHex(hex) : undefined;
  } catch {
    key = undefined;
  }
  if (key === undefined || key.length !== length) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `wallet '${name}': publicKey must be ${length} bytes of hex for ${scheme}`,
    );
  }
  return key;
}

export async function resolveWallet(
  selection: ResolvedSelection,
  driver: ChainDriver,
  signers: Readonly<Record<string, Signer>>,
  schemes: SchemeCatalog,
  /** Bounds each public-key read (`lifecycle.signTimeoutMs`). */
  deadline?: SignerDeadline,
): Promise<ResolvedWallet> {
  const wallet = selection.wallet;
  if (!wallet) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `no wallet selected for ${selection.chain.id}; pass { wallet } or set chains.${selection.chain.id}.wallet`,
    );
  }
  const { config } = wallet;
  const options = walletOptionsOf(config);
  const keyRef = config.keyRef;
  const keys: WalletKey[] = [];
  if (selection.signer) {
    // The signer is user-supplied code; its scheme list and keys are guarded.
    const { id, instance } = selection.signer;
    const supported = signerSchemes(id, instance);
    for (const scheme of selection.chain.schemes) {
      if (!supported.includes(scheme)) continue;
      const { publicKeyLength } = schemes.get(scheme);
      const publicKey = await signerPublicKey(
        id,
        instance,
        scheme,
        keyRef,
        publicKeyLength,
        deadline,
      );
      keys.push({ scheme, publicKey, ...(keyRef ? { keyRef } : {}) });
    }
  } else if (config.publicKey) {
    const scheme = selection.chain.schemes[0] as string;
    keys.push({
      scheme,
      publicKey: watchOnlyKey(
        wallet.name,
        config.publicKey,
        scheme,
        schemes.get(scheme).publicKeyLength,
      ),
      ...(keyRef ? { keyRef } : {}),
    });
  }
  const first = keys[0];
  const derived = first
    ? driver.address.fromPublicKey(first.publicKey, options)
    : undefined;
  const configured =
    config.address !== undefined ? driver.address.normalize(config.address) : undefined;
  if (derived && configured && derived.canonical !== configured.canonical) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `wallet '${wallet.name}': configured address does not match its public key`,
    );
  }
  const normalized = configured ?? derived;
  if (!normalized) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `wallet '${wallet.name}' needs a signer, a publicKey or an address`,
    );
  }
  const primary = selection.signer;
  return {
    name: wallet.name,
    config,
    address: new Address(selection.chain.id, normalized, driver.address.format),
    keys,
    options,
    watchOnly: !primary,
    ...(config.tier !== undefined ? { tier: config.tier } : {}),
    signerFor: (ref) => {
      // Own keys only: a key ref named `toString` routes nowhere.
      const routes = config.signers ?? {};
      const routed =
        ref?.id !== undefined && Object.hasOwn(routes, ref.id)
          ? routes[ref.id]
          : undefined;
      const id = routed ?? primary?.id;
      if (id === undefined) return undefined;
      const signer =
        id === primary?.id
          ? primary.instance
          : Object.hasOwn(signers, id)
            ? signers[id]
            : undefined;
      return signer ? { id, signer } : undefined;
    },
    signerById: (id) => {
      if (id === primary?.id) return { id, signer: primary.instance };
      const signer = Object.hasOwn(signers, id) ? signers[id] : undefined;
      return signer ? { id, signer } : undefined;
    },
  };
}
