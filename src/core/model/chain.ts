import type { Capability } from './capability';
import type { OrderingKind } from './ordering';

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

export interface NativeAssetInfo {
  readonly symbol: string;
  readonly decimals: number;
  readonly name?: string;
}

export interface NetworkInfo {
  readonly id: string;
  /** Expected value of the driver's identity probe (chain id, genesis hash…). */
  readonly identity?: string;
  readonly testnet: boolean;
  readonly feeModel: string;
  readonly finality: FinalityPolicy;
  readonly defaultConfirmations: number;
  /** Recent blocks a scanner retains for rollback detection; independent of finality. */
  readonly reorgWindow: number;
  readonly maxLagBlocks?: number;
  readonly explorer?: { readonly tx: string; readonly address: string };
  readonly replacement?: { readonly minBumpPercent: number };
  readonly capabilities?: {
    readonly add?: readonly Capability[];
    readonly remove?: readonly Capability[];
  };
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ChainInfo {
  readonly id: string;
  readonly family: string;
  readonly model: 'account' | 'utxo';
  readonly ordering: OrderingKind;
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
