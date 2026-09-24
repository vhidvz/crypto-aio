import type { AdapterManifest } from '../driver/types';
import type { Logger } from '../events/logger';
import type { Capability } from '../model/capability';
import type { ChainInfo, NetworkInfo } from '../model/chain';
import type { ChainId, LibraryOf, NetworkOf } from '../model/ids';
import type { Plugin } from '../registry/plugin';
import type { Secret } from '../secret/secret';
import type { ExtendedKeyVersions } from '../signing/hd';
import type { KeyRef, Signer, SigningContext } from '../signing/types';
import type { Stores } from '../store/types';
import type { EndpointConfig, TransportOptions } from '../transport/types';
import type { Clock } from '../util/clock';

export type ProviderConfig =
  | {
      readonly preset: string;
      readonly apiKey?: string | Secret<string>;
      readonly options?: Readonly<Record<string, unknown>>;
    }
  | { readonly endpoints: readonly EndpointConfig[] };

export type ProviderRef = string | ProviderConfig;

export interface WalletConfig {
  readonly signer?: string;
  /** Routes requests to signers by `keyRef.id` (multi-party wallets). */
  readonly signers?: Readonly<Record<string, string>>;
  readonly address?: string;
  /** Hex public key for watch-only wallets that still prepare transactions. */
  readonly publicKey?: string;
  readonly xpub?: string;
  readonly xpubVersions?: ExtendedKeyVersions;
  /** Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`. */
  readonly xpubPath?: string;
  readonly keyRef?: KeyRef;
  /** Metadata only (passed to signing context); no built-in behaviour. */
  readonly tier?: string;
  readonly chains?: readonly string[];
  readonly utxo?: Readonly<Record<string, unknown>>;
  readonly ton?: Readonly<Record<string, unknown>>;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ChainDefaults {
  readonly network?: string;
  readonly library?: string;
  readonly provider?: ProviderRef | readonly ProviderRef[];
  readonly indexer?: ProviderRef | readonly ProviderRef[];
  readonly wallet?: string;
  readonly signer?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly confirmations?: number;
}

export interface LifecycleOptions {
  readonly pollIntervalMs?: number;
  readonly droppedGracePeriodMs?: number;
  readonly rebroadcastIntervalMs?: number;
  readonly leaseMs?: number;
  readonly claimLeaseMs?: number;
  readonly waitTimeoutMs?: number;
  readonly requireIdempotencyKey?: boolean;
  readonly broadcastFanout?: number;
}

export interface Hooks {
  /** Throw to veto signing (policy engines, approvals). Runs before every signing request. */
  readonly beforeSign?: (ctx: SigningContext) => void | Promise<void>;
}

export interface ScopeOptions {
  readonly chains?: Readonly<Record<string, ChainDefaults>>;
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  readonly signers?: Readonly<Record<string, Signer>>;
  readonly wallets?: Readonly<Record<string, WalletConfig>>;
  readonly hooks?: Hooks;
  readonly lifecycle?: LifecycleOptions;
}

export interface AioOptions extends ScopeOptions {
  /** Root-only: drivers and transports are shared by all scopes of a root container. */
  readonly transport?: TransportOptions;
  /** Prefixes every store key; tenants sharing a database must use distinct namespaces. */
  readonly namespace?: string;
  /** Environment source for routing config; `false` disables it. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | false;
  readonly profile?: string;
  readonly stores?: Partial<Stores>;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly plugins?: readonly Plugin[];
}

export interface HandleOptions {
  readonly chain: string;
  readonly network?: string;
  readonly library?: string;
  readonly provider?: ProviderRef | readonly ProviderRef[];
  readonly indexer?: ProviderRef | readonly ProviderRef[];
  readonly wallet?: string;
  readonly signer?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly confirmations?: number;
}

export type HandleConfig<C extends ChainId> = Omit<
  HandleOptions,
  'chain' | 'network' | 'library'
> & {
  readonly chain: C;
  readonly network?: NetworkOf<C>;
  readonly library?: LibraryOf<C>;
};

export interface EffectiveOptions {
  readonly chains: Readonly<Record<string, ChainDefaults>>;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly signers: Readonly<Record<string, Signer>>;
  readonly wallets: Readonly<Record<string, WalletConfig>>;
  readonly hooks: Hooks;
  readonly lifecycle: LifecycleOptions;
}

export interface ResolvedProvider {
  readonly name: string;
  readonly endpoints: readonly EndpointConfig[];
  readonly production: boolean;
}

export interface ResolvedSelection {
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly library: string;
  readonly manifest: AdapterManifest;
  readonly providers: readonly ResolvedProvider[];
  readonly indexers: readonly ResolvedProvider[];
  readonly wallet?: { readonly name: string; readonly config: WalletConfig };
  readonly signer?: { readonly id: string; readonly instance: Signer };
  readonly options: Readonly<Record<string, unknown>>;
  readonly confirmations: number;
  readonly capabilities: ReadonlySet<Capability>;
  readonly providerNames: readonly string[];
  readonly indexerNames: readonly string[];
  /** Identity of the shared driver/transport (includes credential fingerprints). */
  readonly poolKey: string;
  /** Hash recorded in each Operation's ExecutionContext. */
  readonly configHash: string;
  /** The merged handle options, used by `with()`. */
  readonly handle: HandleOptions;
}
