import type { AdapterManifest } from '../driver/types';
import type { Logger } from '../events/logger';
import type { Capability } from '../model/capability';
import type { ChainInfo, NetworkInfo } from '../model/chain';
import type { ChainId, LibraryOf, NetworkOf } from '../model/ids';
import type { AssetRegistration } from '../registry/assets';
import type { Plugin } from '../registry/plugin';
import type { Secret } from '../secret/secret';
import type { ExtendedKeyVersions } from '../signing/hd';
import type { KeyRef, Signer, SigningContext } from '../signing/types';
import type { Stores } from '../store/types';
import type { EndpointConfig, TransportOptions } from '../transport/types';
import type { Clock } from '../util/clock';

/**
 * A provider: a preset by name with its API key (wrap it in `secret()`) and the preset's
 * own options, or your own endpoints.
 */
export type ProviderConfig =
  | {
      readonly preset: string;
      readonly apiKey?: string | Secret<string>;
      readonly options?: Readonly<Record<string, unknown>>;
    }
  | { readonly endpoints: readonly EndpointConfig[] };

/** A provider by the name it has in `providers`, or given inline. */
export type ProviderRef = string | ProviderConfig;

/**
 * A wallet: which key sends, through which signer. Without a signer it is watch-only: it
 * reads, and with `publicKey` it prepares transactions for signing elsewhere.
 */
export interface WalletConfig {
  /** The name of the signer (in `signers`) that holds the key. */
  readonly signer?: string;
  /** Routes requests to signers by `keyRef.id` (multi-party wallets). */
  readonly signers?: Readonly<Record<string, string>>;
  /** The address of a watch-only wallet. */
  readonly address?: string;
  /** Hex public key for watch-only wallets that still prepare transactions. */
  readonly publicKey?: string;
  /** An extended public key, for deposit addresses from `deriveAddress`. */
  readonly xpub?: string;
  /** The version bytes of a non-standard `xpub`. */
  readonly xpubVersions?: ExtendedKeyVersions;
  /** Child path template relative to the xpub; `{index}` is replaced. Default `0/{index}`. */
  readonly xpubPath?: string;
  /** Which key of the signer, such as a derivation path for a mnemonic signer. */
  readonly keyRef?: KeyRef;
  /** Metadata only (passed to signing context); no built-in behaviour. */
  readonly tier?: string;
  /** The chains this wallet may be used on. */
  readonly chains?: readonly string[];
  /**
   * Bitcoin wallet settings (`UtxoWalletOptions` from `crypto-aio/utxo`). A plain record
   * through 1.x; the family type names the shape it accepts.
   */
  readonly utxo?: Readonly<Record<string, unknown>>;
  /**
   * TON wallet settings (`TonWalletIdentity` from `crypto-aio/ton`). A plain record
   * through 1.x; the family type names the shape it accepts.
   */
  readonly ton?: Readonly<Record<string, unknown>>;
  /** Further family wallet options. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Per-chain defaults (`chains.<id>`); a handle can set the same fields but `maxLagBlocks`. */
export interface ChainDefaults {
  /** Defaults to the chain's default network. */
  readonly network?: string;
  /** The SDK library, such as `ethers`; defaults to the chain's first. */
  readonly library?: string;
  /** Several providers fail over and cross-check proofs. */
  readonly provider?: ProviderRef | readonly ProviderRef[];
  /** The indexer providers, for the families that read one. */
  readonly indexer?: ProviderRef | readonly ProviderRef[];
  /** The wallet that sends. */
  readonly wallet?: string;
  /** Overrides the wallet's signer. */
  readonly signer?: string;
  /** The family's own options; a family refuses keys it does not know (`CONFIG_INVALID`). */
  readonly options?: Readonly<Record<string, unknown>>;
  /** The default target of `waitForConfirmation`. */
  readonly confirmations?: number;
  /**
   * This chain's lag tolerance, in blocks. It wins over the root
   * `transport.maxLagBlocks`, which wins over the plugin network's own, which wins over
   * the transport's built-in default. An endpoint further behind the best known height is
   * lagging, and a monitor or scanner view further behind is stale.
   */
  readonly maxLagBlocks?: number;
}

/** Timing and safety of transfers and workers. */
export interface LifecycleOptions {
  /** How often waits and workers observe an Operation (default 5 000 ms). */
  readonly pollIntervalMs?: number;
  /** How long an unseen transaction waits before it counts as dropped and is resent (default 120 000 ms). */
  readonly droppedGracePeriodMs?: number;
  /** The least time between resends of one Attempt (default 60 000 ms). */
  readonly rebroadcastIntervalMs?: number;
  /** The time-to-live of a wallet's address lease, held while a slot is reserved and signed (default 30 000 ms). */
  readonly leaseMs?: number;
  /**
   * How long a transfer waits for its wallet's address lease while another Operation of
   * the wallet holds it, before it fails with `SEQUENCE_BUSY` (default: `leaseMs`). The
   * holder keeps the lease while its signer works, for up to `signTimeoutMs`, so raise this
   * to queue transfers behind a slow signer instead of failing them.
   */
  readonly leaseWaitMs?: number;
  /** How long a worker's claim on an Operation lasts (default 60 000 ms). */
  readonly claimLeaseMs?: number;
  /** The default timeout of `waitForConfirmation` (default 600 000 ms). */
  readonly waitTimeoutMs?: number;
  /** Whether a transfer without an idempotency key is an error (default `false`; set it in production). */
  readonly requireIdempotencyKey?: boolean;
  /** How many endpoints each broadcast goes to (default 1). */
  readonly broadcastFanout?: number;
  /**
   * How long `transfer` and `submitSignatures` wait for the `beforeSign` hook and the
   * signer(s) (default 120 000 ms). The wallet's address lease is kept alive meanwhile. On
   * timeout nothing is written: the Operation stays `prepared` with its reservation, and a
   * repeat asks again. Signers that need longer should answer `pending` with a ticket.
   */
  readonly signTimeoutMs?: number;
}

/** The container's hooks into the transfer lifecycle. */
export interface Hooks {
  /**
   * Throw to veto signing (policy engines, approvals). Runs before every signing request.
   * It may run more than once per Operation: once per concurrent caller, and again when a
   * `prepared` Operation is repeated. Make it idempotent; `ctx.operationId` identifies the
   * Operation. It runs while the wallet's address lease is held, so keep it short. In
   * `transfer` and `submitSignatures` the lease is kept alive for up to
   * `lifecycle.signTimeoutMs`; in `prepareTransfer` a hook running longer than
   * `lifecycle.leaseMs` can lose the lease to another transfer. A veto after that writes
   * nothing; the Operation stays `prepared` and is vetoed again on its next repeat.
   */
  readonly beforeSign?: (ctx: SigningContext) => void | Promise<void>;
}

/** What `aio.scope(overrides)` can override, over its parent's options. */
export interface ScopeOptions {
  /** Per-chain defaults, by chain id. */
  readonly chains?: Readonly<Record<string, ChainDefaults>>;
  /** Named providers. */
  readonly providers?: Readonly<Record<string, ProviderConfig>>;
  /** Named signers, from `localSigner` or `callbackSigner`. */
  readonly signers?: Readonly<Record<string, Signer>>;
  /** Named wallets. */
  readonly wallets?: Readonly<Record<string, WalletConfig>>;
  readonly hooks?: Hooks;
  readonly lifecycle?: LifecycleOptions;
}

/** The options of `new CryptoAio(options)` and `configure(options)`. */
export interface AioOptions extends ScopeOptions {
  /** Root-only: drivers and transports are shared by all scopes of a root container. */
  readonly transport?: TransportOptions;
  /** Prefixes every store key; tenants sharing a database must use distinct namespaces. */
  readonly namespace?: string;
  /** Environment source for routing config; `false` disables it. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | false;
  /** The environment profile to read (default: `CRYPTO_AIO_ENV`). */
  readonly profile?: string;
  /**
   * The stores; each one left out is an in-memory store, which loses everything when the
   * process ends. Production needs all four durable, shared by every process.
   */
  readonly stores?: Partial<Stores>;
  /** Where logs go (default: a `debug`-based logger). */
  readonly logger?: Logger;
  /** The time source (default: the system clock); `FakeClock` in tests. */
  readonly clock?: Clock;
  /** Root-only: extra chain families, networks, presets and tokens. */
  readonly plugins?: readonly Plugin[];
  /**
   * Tokens to register on this root container, as a plugin's `assets` would: their decimals
   * and symbol, and aliases such as `USDC`. A registered token's decimals scale its amounts
   * instead of what the chain says, so give each only from a source you trust; a token
   * whose chain gives no decimals can be sent only once they are registered.
   */
  readonly assets?: readonly AssetRegistration[];
}

/**
 * What a handle is for (`aio.blockchain(options)`, `bc.with(overrides)`): a chain and, over
 * its `chains.<id>` defaults, the same fields as `ChainDefaults` but `maxLagBlocks`.
 * `options` stays a plain record through 1.x; each family's options are listed on its
 * network page.
 */
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

/** `HandleOptions` typed for chain `C`: its networks and libraries by name. */
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
  /** The per-chain `maxLagBlocks` from the `chains` config, when set. */
  readonly maxLagBlocks?: number;
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
