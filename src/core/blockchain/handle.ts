import { describeSelection } from '../config/resolve';
import type { HandleConfig, HandleOptions } from '../config/types';
import { containerOf } from '../container/internals';
import type { DriverLimits, WalletOptions } from '../driver/types';
import {
  ConfigError,
  UnsupportedCapabilityError,
  ValidationError,
} from '../errors/error';
import { Address } from '../model/address';
import { Amount } from '../model/amount';
import type { AssetInfo, AssetRef } from '../model/asset';
import type { Capability } from '../model/capability';
import type { FeeEstimate } from '../model/fee';
import type { ChainId, ExtOf, LibraryOf, NetworkOf } from '../model/ids';
import { toStoredIntent, type TransferIntent } from '../model/intent';
import type { Block, Transaction, TxStatus } from '../model/transaction';
import { normalizeIntent } from '../lifecycle/intent';
import { deriveXpubChild } from '../signing/hd';
import { walletOptionsOf } from '../signing/wallet';
import type { EndpointStatus } from '../transport/types';
import { fromHex } from '../util/bytes';
import { defaultBlockchain } from './default-ref';
import { bindInternals, internalsOf, type HandleInternals } from './internal';
import {
  statusFromObservation,
  toAddress,
  toBlock,
  toFeeEstimate,
  toTransaction,
  type MappingContext,
} from './mapping';

export interface Balance {
  readonly address: Address;
  readonly asset: AssetInfo;
  readonly amount: Amount;
}

export interface NetworkStatus {
  readonly chain: string;
  readonly network: string;
  readonly height: bigint;
  readonly finalizedHeight: bigint;
  readonly endpoints: readonly EndpointStatus[];
  readonly indexers: readonly EndpointStatus[];
}

/** Immutable handle bound to one chain, network, library, provider set and wallet. */
export class Blockchain<C extends ChainId = ChainId> {
  /** @internal Use `CryptoAio#blockchain` or `Blockchain.create`. */
  constructor(internals: HandleInternals) {
    bindInternals(this, internals);
    Object.freeze(this);
  }

  /** Creates a handle on the default container (see `configure`). */
  static create<C extends ChainId>(config: HandleConfig<C>): Blockchain<C> {
    return defaultBlockchain(config as HandleOptions) as unknown as Blockchain<C>;
  }

  get chain(): C {
    return internalsOf(this).selection.chain.id as C;
  }

  get network(): NetworkOf<C> {
    return internalsOf(this).selection.network.id as NetworkOf<C>;
  }

  get library(): LibraryOf<C> {
    return internalsOf(this).selection.library as LibraryOf<C>;
  }

  /** Frozen, redacted snapshot of the resolved configuration. */
  get config(): Readonly<Record<string, unknown>> {
    return describeSelection(internalsOf(this).selection);
  }

  get capabilities(): ReadonlySet<Capability> {
    return internalsOf(this).selection.capabilities;
  }

  supports(capability: Capability): boolean {
    return internalsOf(this).selection.capabilities.has(capability);
  }

  /** Returns a NEW handle; this handle and operations started from it are unaffected. */
  with(overrides: Partial<Omit<HandleConfig<C>, 'chain'>>): Blockchain<C> {
    const { selection, container } = internalsOf(this);
    return container.blockchain({
      ...selection.handle,
      ...overrides,
      chain: this.chain,
    } as HandleConfig<C>);
  }

  /** Loads the adapter and connects its transport; fails fast on missing dependencies. */
  async ready(): Promise<this> {
    await internalsOf(this).pooled();
    return this;
  }

  async limits(): Promise<DriverLimits> {
    const { driver } = await internalsOf(this).pooled();
    const wallet = internalsOf(this).selection.wallet;
    const options: WalletOptions = wallet ? walletOptionsOf(wallet.config) : {};
    return (
      driver.limits?.(options) ?? {
        maxOutputs: this.supports('batch-transfer') ? Number.MAX_SAFE_INTEGER : 1,
      }
    );
  }

  async validateAddress(address: string): Promise<boolean> {
    return (await this.mapping()).driver.address.validate(address);
  }

  async normalizeAddress(address: string): Promise<Address> {
    return toAddress(await this.mapping(), address);
  }

  async addressFromPublicKey(
    publicKey: Uint8Array | string,
    options: WalletOptions = {},
  ): Promise<Address> {
    const { driver, selection } = await this.mapping();
    const bytes = typeof publicKey === 'string' ? fromHex(publicKey) : publicKey;
    return new Address(
      selection.chain.id,
      driver.address.fromPublicKey(bytes, options),
      driver.address.format,
    );
  }

  async walletAddress(): Promise<Address> {
    return (await internalsOf(this).wallet()).address;
  }

  /** Derives a deposit address from the wallet's xpub (capability `hd-public-derivation`). */
  async deriveAddress(wallet: string, index: number): Promise<Address> {
    if (!this.supports('hd-public-derivation')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${this.chain} does not support public derivation`,
      );
    }
    if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
      throw new ValidationError(
        'INVALID_INTENT',
        'derivation index must be an integer in [0, 2^31)',
      );
    }
    const internals = internalsOf(this);
    const config = containerOf(internals.container).effective().wallets[wallet];
    if (!config?.xpub)
      throw new ConfigError('CONFIG_INVALID', `wallet '${wallet}' has no xpub`);
    const path = (config.xpubPath ?? '0/{index}').replace('{index}', String(index));
    const publicKey = deriveXpubChild(config.xpub, path, config.xpubVersions);
    return this.addressFromPublicKey(publicKey, walletOptionsOf(config));
  }

  async resolveAsset(asset?: AssetRef | string): Promise<AssetInfo> {
    const m = await this.mapping();
    return m.assets.resolve(m.selection, m.driver, asset);
  }

  async getBalance(address: string, asset?: AssetRef | string): Promise<Balance> {
    const m = await this.mapping();
    const target = toAddress(m, address);
    const info = await m.assets.resolve(m.selection, m.driver, asset);
    const base = await m.driver.reader.getBalance(target.canonical, info.ref);
    return { address: target, asset: info, amount: Amount.fromBase(base, info) };
  }

  async getBalances(
    address: string,
    assets: readonly (AssetRef | string)[],
  ): Promise<Balance[]> {
    return Promise.all(assets.map((asset) => this.getBalance(address, asset)));
  }

  async estimateFee(intent: TransferIntent): Promise<FeeEstimate> {
    const m = await this.mapping();
    const internals = internalsOf(this);
    const wallet = internals.selection.wallet ? await internals.wallet() : undefined;
    const from = intent.from !== undefined ? toAddress(m, intent.from) : wallet?.address;
    if (!from)
      throw new ValidationError(
        'INVALID_INTENT',
        'estimateFee needs a wallet or intent.from',
      );
    const normalized = await normalizeIntent(m, intent, from);
    const draft = await m.driver.builder.estimateFee(toStoredIntent(normalized), {
      from: from.canonical,
      keys: wallet?.keys ?? [],
      wallet: wallet?.options ?? {},
    });
    return toFeeEstimate(m, draft);
  }

  async getTransaction(id: string): Promise<Transaction | null> {
    const m = await this.mapping();
    const tx = await m.driver.reader.getTransaction(id);
    if (!tx) return null;
    const [head, finalized] = await Promise.all([
      m.driver.reader.getBlockHeight(),
      m.driver.reader.getFinalizedHeight(),
    ]);
    return toTransaction(m, tx, head, finalized);
  }

  async getTransactionStatus(id: string): Promise<TxStatus> {
    const { driver } = await this.mapping();
    const [observation, head, finalized] = await Promise.all([
      driver.reader.observe(
        { id, idKind: 'tx-hash', canonical: true },
        undefined,
        undefined,
      ),
      driver.reader.getBlockHeight(),
      driver.reader.getFinalizedHeight(),
    ]);
    return statusFromObservation(observation, head, finalized);
  }

  async getBlockHeight(): Promise<bigint> {
    return (await this.mapping()).driver.reader.getBlockHeight();
  }

  async getBlock(ref: bigint | string): Promise<Block | null> {
    const block = await (await this.mapping()).driver.reader.getBlock(ref);
    return block ? toBlock(block) : null;
  }

  async getNetworkStatus(): Promise<NetworkStatus> {
    const pooled = await internalsOf(this).pooled();
    await pooled.transport.refreshHealth();
    if (pooled.indexer) await pooled.indexer.refreshHealth();
    const [height, finalizedHeight] = await Promise.all([
      pooled.driver.reader.getBlockHeight(),
      pooled.driver.reader.getFinalizedHeight(),
    ]);
    return {
      chain: this.chain,
      network: this.network,
      height,
      finalizedHeight,
      endpoints: pooled.transport.status(),
      indexers: pooled.indexer?.status() ?? [],
    };
  }

  /** Typed family extensions: `bc.ext.<family>.<method>(...)` (async, loads the adapter on demand). */
  get ext(): ExtOf<C> {
    const internals = internalsOf(this);
    const where = `${internals.selection.chain.id}/${internals.selection.library}`;
    return new Proxy(
      {},
      {
        get: (_target, family) => {
          if (typeof family !== 'string' || family === 'then') return undefined;
          return new Proxy(
            {},
            {
              get: (_inner, method) => {
                if (typeof method !== 'string' || method === 'then') return undefined;
                return async (...args: unknown[]) => {
                  const { driver } = await internals.pooled();
                  const fn = driver.ext?.[family]?.[method] as
                    ((...a: unknown[]) => Promise<unknown>) | undefined;
                  if (typeof fn !== 'function') {
                    throw new UnsupportedCapabilityError(
                      'UNSUPPORTED_CAPABILITY',
                      `ext.${family}.${method} is not available on ${where}`,
                    );
                  }
                  return fn(...args);
                };
              },
            },
          );
        },
      },
    ) as ExtOf<C>;
  }

  /** @internal */
  protected async mapping(): Promise<MappingContext> {
    const internals = internalsOf(this);
    const { driver } = await internals.pooled();
    return {
      selection: internals.selection,
      driver,
      assets: containerOf(internals.container).runtime.assets,
    };
  }
}
