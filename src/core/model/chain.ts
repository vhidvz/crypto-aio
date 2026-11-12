import type { Capability } from './capability';
import type { OrderingKind } from './ordering';

/**
 * When a block is final: after a number of confirmations, at the chain's `finalized` tag,
 * when solidified (Tron), at the `finalized` commitment (Solana), or once the masterchain
 * commits it (TON).
 */
export type FinalityPolicy =
  | { readonly kind: 'confirmations'; readonly confirmations: number }
  | {
      readonly kind: 'tag';
      readonly tag: 'finalized';
      readonly fallbackConfirmations: number;
    }
  | { readonly kind: 'solidified' }
  | { readonly kind: 'commitment'; readonly level: 'finalized' }
  | { readonly kind: 'masterchain' };

/** A chain's native coin. */
export interface NativeAssetInfo {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
}

/** One network of a chain, as built in or as a plugin registers it. */
export interface NetworkInfo {
  readonly id: string;
  /** Expected value of the driver's identity probe (chain id, genesis hash…). */
  readonly identity?: string;
  readonly testnet: boolean;
  /** How the family prices fees, such as `evm-1559`, `evm-legacy` or `utxo`. */
  readonly feeModel: string;
  readonly finality: FinalityPolicy;
  /** The default target of `waitForConfirmation`; at least 1. */
  readonly defaultConfirmations: number;
  /** Recent blocks a scanner retains for rollback detection; independent of finality. */
  readonly reorgWindow: number;
  /** This network's lag tolerance, when neither `chains.<id>` nor `transport` sets one. */
  readonly maxLagBlocks?: number;
  /** Explorer URL templates, with `{id}` and `{address}` placeholders. */
  readonly explorer?: { readonly tx: string; readonly address: string };
  /** The least fee increase, in percent, a node accepts for a replacement. */
  readonly replacement?: { readonly minBumpPercent: number };
  /** Capabilities this network adds to or removes from its manifest's. */
  readonly capabilities?: {
    readonly add?: readonly Capability[];
    readonly remove?: readonly Capability[];
  };
  /** Family-specific network settings; each network page lists its family's. */
  readonly params?: Readonly<Record<string, unknown>>;
}

/** A chain, as built in or as a plugin registers it. */
export interface ChainInfo {
  readonly id: string;
  /** The chain family whose drivers serve it, such as `evm` or `utxo`. */
  readonly family: string;
  readonly model: 'account' | 'utxo';
  /** How its transactions are ordered; its drivers must order the same way. */
  readonly ordering: OrderingKind;
  /** The signature schemes its wallets sign with. */
  readonly schemes: readonly string[];
  readonly nativeAsset: NativeAssetInfo;
  readonly defaultNetwork: string;
  readonly networks: Readonly<Record<string, NetworkInfo>>;
  /**
   * Whether the chain's extended public keys carry their network class (SLIP-0132: `xpub`
   * on mainnet, `tpub` on test networks), so `deriveAddress` refuses a key of the other
   * class. Default: `true` for `utxo`-model chains, `false` for account-model ones.
   */
  readonly xpubNetworkClass?: boolean;
}

/** The explorer URL of a transaction or an address, when the network has a template. */
export function explorerUrl(
  network: NetworkInfo,
  kind: 'tx' | 'address',
  value: string,
): string | undefined {
  const template = network.explorer?.[kind];
  return template?.replace(
    kind === 'tx' ? '{id}' : '{address}',
    encodeURIComponent(value),
  );
}
