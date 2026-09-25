import { describeSelection, resolveSelection } from '../config/resolve';
import type { HandleConfig, HandleOptions } from '../config/types';
import { containerOf } from '../container/internals';
import type { BroadcastResult, DriverLimits, WalletOptions } from '../driver/types';
import {
  ConfigError,
  ProviderError,
  UnsupportedCapabilityError,
  ValidationError,
} from '../errors/error';
import { Address } from '../model/address';
import { Amount } from '../model/amount';
import type { AssetInfo, AssetRef } from '../model/asset';
import type { Capability } from '../model/capability';
import type { FeeEstimate, FeeOverride, FeeSpeed } from '../model/fee';
import type { ChainId, ExtOf, LibraryOf, NetworkOf } from '../model/ids';
import { toStoredIntent, type TransferIntent } from '../model/intent';
import type { Block, RawTx, Transaction, TxStatus } from '../model/transaction';
import {
  PRE_SIGNING_STATES,
  withLifecycleDefaults,
  type OperationEngine,
  type OperationTarget,
  type ReadTarget,
  type TransferOptions,
} from '../lifecycle/engine';
import { normalizeIntent } from '../lifecycle/intent';
import type {
  ConfirmationResult,
  Monitor,
  TxStatusEvent,
  WaitOptions,
} from '../lifecycle/monitor';
import { loadObservations } from '../lifecycle/observations';
import {
  toView,
  type OperationView,
  type PreparedOperation,
  type Submission,
} from '../lifecycle/views';
import { Scanner, type ScannerOptions } from '../observe/scanner';
import { deriveXpubChild } from '../signing/hd';
import type { SignatureBundle } from '../signing/types';
import { resolveWallet, walletOptionsOf } from '../signing/wallet';
import type { OperationRecord } from '../store/types';
import type { EndpointState, EndpointStatus } from '../transport/types';
import { fromHex } from '../util/bytes';
import { defaultBlockchain } from './default-ref';
import { bindInternals, internalsOf, type HandleInternals } from './internal';
import {
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

  /** A fresh copy on every read; mutating the result never affects `supports()`. */
  get capabilities(): ReadonlySet<Capability> {
    return new Set(internalsOf(this).selection.capabilities);
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

  /**
   * Loads the adapter, connects its transport and validates it's actually usable; fails fast
   * on a missing dependency (`DEPENDENCY_MISSING`), an invalid wallet (surfaced by resolving
   * it), or a provider that can't serve reads: `PROVIDER_UNAVAILABLE` when no configured
   * endpoint is usable, `PROVIDER_MISCONFIGURED` (non-retryable) when every endpoint's
   * identity mismatches the configured network. An endpoint is usable when it's 'healthy',
   * 'lagging' or 'half-open' (N6: the breaker is willing to try it), or 'unknown' while the
   * transport has no health probes configured at all — nothing could ever have marked it
   * healthy/lagging in that case, so 'unknown' is simply its steady state.
   */
  async ready(): Promise<this> {
    const internals = internalsOf(this);
    const pooled = await internals.pooled();
    await pooled.transport.refreshHealth();
    const statuses = pooled.transport.status();
    if (statuses.length > 0 && statuses.every((s) => s.state === 'disabled')) {
      throw new ProviderError(
        'PROVIDER_MISCONFIGURED',
        `every endpoint for ${this.chain} serves a different network than configured`,
        { retryable: false },
      );
    }
    const usable = (state: EndpointState): boolean =>
      state === 'healthy' ||
      state === 'lagging' ||
      state === 'half-open' ||
      (state === 'unknown' && !pooled.transport.hasProbes());
    if (!statuses.some((s) => usable(s.state))) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        `no healthy endpoint for ${this.chain}`,
      );
    }
    if (internals.selection.wallet) await internals.wallet();
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

  /** Address of the handle's own selected wallet, or of another configured `wallet` by name
   * (spec §5.2) — resolved fresh against this handle's driver, without switching the handle.
   * N1 (round 2): re-resolved through `resolveSelection` (not `resolveWallet` directly) so a
   * named wallet gets the same `wallet.chains` enablement check, unknown-signer validation and
   * signer-scheme compatibility check that the handle's own wallet got at construction. */
  async walletAddress(wallet?: string): Promise<Address> {
    const internals = internalsOf(this);
    const selection = internals.selection;
    if (wallet === undefined || wallet === selection.wallet?.name) {
      return (await internals.wallet()).address;
    }
    const container = containerOf(internals.container);
    const effective = container.effective();
    // N1: an own-property check, so a wallet literally named 'constructor' (or any other
    // Object.prototype key) can never be mistaken for one that exists.
    if (!Object.hasOwn(effective.wallets, wallet)) {
      throw new ConfigError('CONFIG_INVALID', `unknown wallet '${wallet}'`);
    }
    const { driver } = await internals.pooled();
    const resolved = resolveSelection({
      handle: { ...selection.handle, wallet, signer: undefined },
      effective,
      catalogs: container.runtime.catalogs,
    });
    const resolvedWallet = await resolveWallet(
      resolved,
      driver,
      effective.signers,
      container.runtime.catalogs.schemes,
    );
    return resolvedWallet.address;
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

  /** Status of a managed Operation (by id, Attempt ref or tx hash) or of any transaction id. */
  async getTransactionStatus(id: string): Promise<TxStatus> {
    return (await this.monitor().status(await this.readTarget(), id)).status;
  }

  /**
   * Resolves once `confirmations` (default: the handle's) are reached. With
   * `finality: 'final'`, a managed Operation (by id, Attempt ref or tx hash) resolves on
   * **proven** finality (finalized data confirmed by quorum proof reads); a transaction the
   * library does not manage resolves on **observed** finality (one endpoint's view of a
   * block at or below the finalized height). Rejects with the chain error when the
   * Operation fails, expires or is replaced (`TX_REVERTED` for an unmanaged transaction
   * that reverted), with `TIMEOUT` (retryable, state unchanged) when time runs out, and
   * with the reason of an aborted `signal`.
   */
  async waitForConfirmation(
    ref: string,
    options: WaitOptions = {},
  ): Promise<ConfirmationResult> {
    const { status, record } = await this.monitor().waitFor(
      await this.readTarget(),
      ref,
      options,
    );
    return { status, ...(record ? { operation: await this.view(record) } : {}) };
  }

  /** Yields each status change until the Operation is terminal (or the transaction is final). */
  watch(
    ref: string,
    options: { readonly pollIntervalMs?: number; readonly signal?: AbortSignal } = {},
  ): AsyncIterable<TxStatusEvent> {
    const readTarget = () => this.readTarget();
    const monitor = () => this.monitor();
    const view = (record: OperationRecord) => this.view(record);
    return {
      async *[Symbol.asyncIterator]() {
        const target = await readTarget();
        for await (const snapshot of monitor().watch(target, ref, options)) {
          yield {
            status: snapshot.status,
            ...(snapshot.record ? { operation: await view(snapshot.record) } : {}),
          };
        }
      },
    };
  }

  async getBlockHeight(): Promise<bigint> {
    return (await this.mapping()).driver.reader.getBlockHeight();
  }

  async getBlock(ref: bigint | string): Promise<Block | null> {
    const block = await (await this.mapping()).driver.reader.getBlock(ref);
    return block ? toBlock(block) : null;
  }

  /**
   * Reorg-aware, at-least-once block scanner (capability `block-scan`): `ack()` each event
   * to commit the cursor before asking for the next. Invalid options throw `CONFIG_INVALID`.
   */
  scanner(options: ScannerOptions): Scanner {
    if (!this.supports('block-scan')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${this.chain} does not support block scanning`,
      );
    }
    const internals = internalsOf(this);
    const container = containerOf(internals.container);
    const { runtime } = container;
    return new Scanner(
      {
        load: async () => {
          // One pooled entry, so the driver and its transport always belong together.
          const { driver, transport } = await internals.pooled();
          const blocks = driver.blocks;
          if (!blocks)
            throw new UnsupportedCapabilityError(
              'UNSUPPORTED_CAPABILITY',
              `${this.chain} driver has no block source`,
            );
          const mapping = {
            selection: internals.selection,
            driver,
            assets: runtime.assets,
          };
          return { mapping, blocks, transport };
        },
        cursors: runtime.stores.cursors,
        events: runtime.events,
        clock: runtime.clock,
        namespace: runtime.namespace,
        defaults: {
          reorgWindow: internals.selection.network.reorgWindow,
          pollIntervalMs: withLifecycleDefaults(container.effective().lifecycle)
            .pollIntervalMs,
        },
      },
      options,
    );
  }

  /** Indexer-backed transaction history of an address (capability `address-history`). */
  async history(
    address: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<{ readonly items: readonly Transaction[]; readonly next?: string }> {
    if (!this.supports('address-history')) {
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${this.chain} has no address history (configure an indexer)`,
      );
    }
    const { cursor, limit = 50 } = options;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ConfigError('CONFIG_INVALID', 'history limit must be a positive integer');
    }
    if (cursor !== undefined && typeof cursor !== 'string') {
      throw new ConfigError('CONFIG_INVALID', 'history cursor must be a string');
    }
    const m = await this.mapping();
    const source = m.driver.history;
    if (!source)
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        `${this.chain} driver has no history source`,
      );
    const page = await source.list(toAddress(m, address).canonical, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
    });
    const [head, finalized] = await Promise.all([
      m.driver.reader.getBlockHeight(),
      m.driver.reader.getFinalizedHeight(),
    ]);
    return {
      items: await Promise.all(
        page.items.map((tx) => toTransaction(m, tx, head, finalized)),
      ),
      ...(page.next !== undefined ? { next: page.next } : {}),
    };
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

  /** Builds and persists the unsigned transaction (reserving nonce/inputs) for offline or async signing. */
  async prepareTransfer(
    intent: TransferIntent,
    options: TransferOptions = {},
  ): Promise<PreparedOperation> {
    const target = await this.target();
    return this.prepared(target, await this.engine().prepare(target, intent, options));
  }

  /**
   * Idempotent transfer. Throws the mapped chain error when the Operation stalls or fails;
   * throws an `ambiguous` error (with `context.operationId`) when the broadcast outcome is
   * unknown. Retry with the same `idempotencyKey` in both cases.
   */
  async transfer(
    intent: TransferIntent,
    options: TransferOptions = {},
  ): Promise<Submission> {
    const target = await this.target();
    return this.submission(await this.engine().transfer(target, intent, options));
  }

  async submitSignatures(
    operationId: string,
    signatures: readonly SignatureBundle[],
  ): Promise<Submission> {
    return this.submission(
      await this.engine().submitSignatures(await this.target(), operationId, signatures),
    );
  }

  /** Resends the active Attempt's stored raw transaction (e.g. after topping up a stalled wallet). */
  async rebroadcast(operationId: string): Promise<Submission> {
    return this.submission(
      await this.engine().rebroadcast(await this.target(), operationId),
    );
  }

  /**
   * Replaces a pending transfer with a higher-fee, mutually exclusive Attempt (capability
   * `replace-fee`; a synchronous signer). If the node refuses it, the original stays live
   * and active, and the node's error is thrown.
   *
   * Idempotent per fee spec: repeating the call with the same `fee` (the same speed name,
   * or an equal override) returns the replacement it already made, resending it if its
   * broadcast was never recorded or it was refused; nothing is signed again, and a refusal
   * is thrown, never reported as a success. To bump again, pass another spec, such as a
   * higher explicit override.
   *
   * While that replacement is stored but not yet sent, another fee spec (or a cancel) is
   * refused with `INVALID_TRANSITION`: repeat the same spec, or call `rebroadcast`, first.
   */
  async replace(
    operationId: string,
    options: { readonly fee: FeeSpeed | FeeOverride },
  ): Promise<Submission> {
    return this.submission(
      await this.engine().replace(await this.target(), operationId, options.fee),
    );
  }

  /**
   * Tries to cancel with a conflicting Attempt (capability `cancel`); the outcome is
   * `cancelled` only if the cancel wins at finality, and the original may still win. The
   * cancel pays the network's minimum bump over the highest earlier cancel, or `options.fee`
   * (refused below that bump).
   *
   * Repeating the call while a cancel is pending resends it if its broadcast was never
   * recorded, and returns it while a node holds it or once it is on chain, so concurrent and
   * retried calls create one cancel. Only a cancel the node refused or dropped is bumped by
   * a repeat, one step at a time; when the node's minimum fee is more than one bump away,
   * pass `options.fee`, which always builds a new cancel while none is on chain.
   *
   * While a replacement is stored but not yet sent, a cancel is refused with
   * `INVALID_TRANSITION`: repeat that replacement's fee, or call `rebroadcast`, first.
   */
  async cancel(
    operationId: string,
    options: { readonly fee?: FeeSpeed | FeeOverride } = {},
  ): Promise<Submission> {
    return this.submission(
      await this.engine().cancel(await this.target(), operationId, options.fee),
    );
  }

  /** Expiry-based chains: re-issues an Operation whose earlier Attempts are provably expired. */
  async rebuild(operationId: string): Promise<Submission> {
    return this.submission(await this.engine().rebuild(await this.target(), operationId));
  }

  /**
   * Broadcasts an externally signed transaction WITHOUT creating an Operation: no idempotency,
   * persistence or monitoring. Prefer prepareTransfer + submitSignatures for managed flows.
   */
  async broadcast(raw: RawTx): Promise<BroadcastResult> {
    const { driver } = await internalsOf(this).pooled();
    return driver.broadcaster.broadcast({
      raw,
      ref: { id: '', idKind: 'tx-hash', canonical: false },
    });
  }

  /** Abandons an Operation that has no signed transaction yet and releases its reservation. */
  async abandon(operationId: string): Promise<OperationView> {
    return this.view(await this.engine().abandon(await this.target(), operationId));
  }

  async getOperation(operationId: string): Promise<OperationView | null> {
    const record = await this.engine().get(operationId);
    return record ? this.view(record) : null;
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
                  // M9: own-property checks at both levels, so a name inherited from
                  // Object.prototype (`constructor`, `toString`, ...) can never be mistaken
                  // for a real family method.
                  const familyExt =
                    driver.ext && Object.hasOwn(driver.ext, family)
                      ? driver.ext[family]
                      : undefined;
                  const fn =
                    familyExt && Object.hasOwn(familyExt, method)
                      ? (familyExt[method] as (...a: unknown[]) => Promise<unknown>)
                      : undefined;
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

  /** @internal */
  protected engine(): OperationEngine {
    const internals = internalsOf(this);
    internals.assertOpen();
    return containerOf(internals.container).engine();
  }

  /** @internal */
  protected monitor(): Monitor {
    return containerOf(internalsOf(this).container).monitor();
  }

  /** @internal */
  protected async readTarget(): Promise<ReadTarget> {
    const internals = internalsOf(this);
    return { selection: internals.selection, pooled: await internals.pooled() };
  }

  /** @internal */
  protected async target(): Promise<OperationTarget> {
    const internals = internalsOf(this);
    const [pooled, wallet] = await Promise.all([internals.pooled(), internals.wallet()]);
    return {
      selection: internals.selection,
      pooled,
      wallet,
      assets: containerOf(internals.container).runtime.assets,
    };
  }

  /** @internal */
  protected async view(record: OperationRecord): Promise<OperationView> {
    const { runtime } = containerOf(internalsOf(this).container);
    return toView(record, await loadObservations(runtime.stores.operations, record));
  }

  /** @internal */
  protected async submission(record: OperationRecord): Promise<Submission> {
    const view = await this.view(record);
    return {
      ...view,
      operationId: view.id,
      ...(view.activeAttempt ? { attempt: view.activeAttempt } : {}),
      wait: (options?: WaitOptions) => this.waitForConfirmation(view.id, options),
    };
  }

  /**
   * @internal Signing material only while the Operation awaits signatures: an idempotent
   * repeat of an abandoned Operation returns its view alone.
   */
  protected async prepared(
    target: OperationTarget,
    record: OperationRecord,
  ): Promise<PreparedOperation> {
    const operation = await this.view(record);
    const unsigned = record.unsigned;
    if (!unsigned || !PRE_SIGNING_STATES.has(record.state)) return { operation };
    const fee = await toFeeEstimate(
      {
        selection: target.selection,
        driver: target.pooled.driver,
        assets: target.assets,
      },
      unsigned.fee,
    );
    return {
      operation,
      unsigned: {
        payload: unsigned.payload,
        signingRequests: unsigned.signingRequests,
        ...(unsigned.expectedRef ? { expectedRef: unsigned.expectedRef } : {}),
        fee,
      },
    };
  }
}
