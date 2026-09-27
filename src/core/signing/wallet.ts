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
 * A22: the wallet's extended public key as drivers receive it, `WalletOptions.hd`: plain,
 * frozen data (R11), present only when the wallet configures a non-empty `xpub` (an empty
 * one counts as none, as in `deriveAddress`), which must be a readable PUBLIC extended key
 * (A26: `CONFIG_INVALID` otherwise, naming no key).
 */
export interface WalletHdOptions {
  readonly xpub: string;
  /** Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`. */
  readonly xpubPath?: string;
  readonly xpubVersions?: ExtendedKeyVersions;
}

export function walletOptionsOf(config: WalletConfig): WalletOptions {
  // A22: `hd` is the core's own key: the wallet's xpub or nothing, never a user option.
  const { hd: _ignored, ...options } = config.options ?? {};
  return {
    ...options,
    ...(config.utxo ? { utxo: config.utxo } : {}),
    ...(config.ton ? { ton: config.ton } : {}),
    // M3: a falsy `xpub` ('', null) is no xpub, as `deriveAddress` reads it.
    ...(config.xpub ? { hd: hdOptionsOf(config) } : {}),
  };
}

function hdOptionsOf(config: WalletConfig): WalletHdOptions {
  const { xpubPath, xpubVersions } = config;
  const xpub = config.xpub as string;
  // A26: only a readable, PUBLIC extended key ever reaches a driver.
  parseExtendedPublicKey(xpub, xpubVersions);
  return Object.freeze({
    xpub,
    ...(xpubPath !== undefined ? { xpubPath } : {}),
    // M5: the version pair only, never other keys of the caller's object.
    ...(xpubVersions
      ? {
          xpubVersions: Object.freeze({
            private: xpubVersions.private,
            public: xpubVersions.public,
          }),
        }
      : {}),
  });
}

export async function resolveWallet(
  selection: ResolvedSelection,
  driver: ChainDriver,
  signers: Readonly<Record<string, Signer>>,
  schemes: SchemeCatalog,
  /** R32: bounds each public-key read (`lifecycle.signTimeoutMs`). */
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
    // R9.3: the signer is user-supplied code; its scheme list and keys are guarded.
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
      publicKey: fromHex(config.publicKey),
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
      const routed = ref?.id !== undefined ? config.signers?.[ref.id] : undefined;
      const id = routed ?? primary?.id;
      if (id === undefined) return undefined;
      const signer = id === primary?.id ? primary.instance : signers[id];
      return signer ? { id, signer } : undefined;
    },
    signerById: (id) => {
      if (id === primary?.id) return { id, signer: primary.instance };
      const signer = Object.hasOwn(signers, id) ? signers[id] : undefined;
      return signer ? { id, signer } : undefined;
    },
  };
}
