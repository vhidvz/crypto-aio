import type { ResolvedSelection, WalletConfig } from '../config/types';
import type { ChainDriver, WalletKey, WalletOptions } from '../driver/types';
import { ConfigError } from '../errors/error';
import { Address } from '../model/address';
import { fromHex } from '../util/bytes';
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

export function walletOptionsOf(config: WalletConfig): WalletOptions {
  return {
    ...config.options,
    ...(config.utxo ? { utxo: config.utxo } : {}),
    ...(config.ton ? { ton: config.ton } : {}),
  };
}

export async function resolveWallet(
  selection: ResolvedSelection,
  driver: ChainDriver,
  signers: Readonly<Record<string, Signer>>,
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
    for (const scheme of selection.chain.schemes) {
      if (!selection.signer.instance.schemes.includes(scheme)) continue;
      const publicKey = await selection.signer.instance.getPublicKey(scheme, keyRef);
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
