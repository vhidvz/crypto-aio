import type { ResolvedSelection } from '../config/types';
import type { ChainDriver } from '../driver/types';
import { StateError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import type { Catalogs } from '../registry/plugin';
import { HttpTransport } from '../transport/http-transport';
import type { Transport, TransportOptions } from '../transport/types';
import { randomId } from '../util/bytes';
import type { Clock } from '../util/clock';

export interface PooledDriver {
  readonly driver: ChainDriver;
  readonly transport: Transport;
  readonly indexer?: Transport;
}

export interface DriverPoolDeps {
  readonly catalogs: () => Catalogs;
  readonly clock: Clock;
  readonly events: EventBus;
  readonly log: Logger;
  readonly transport: () => TransportOptions;
}

/** Shares one driver + transport per (chain, network, library, provider credentials, options). */
export class DriverPool {
  readonly #entries = new Map<string, Promise<PooledDriver>>();
  #closed = false;

  constructor(private readonly deps: DriverPoolDeps) {}

  get(selection: ResolvedSelection): Promise<PooledDriver> {
    if (this.#closed) {
      return Promise.reject(
        new StateError('INVALID_TRANSITION', 'driver pool is closed'),
      );
    }
    let entry = this.#entries.get(selection.poolKey);
    if (!entry) {
      entry = this.#create(selection);
      this.#entries.set(selection.poolKey, entry);
      entry.catch(() => {
        // Only evict THIS entry: a concurrent get() may already have replaced it (e.g. a
        // retry after this one failed), and that newer entry must survive.
        if (this.#entries.get(selection.poolKey) === entry) {
          this.#entries.delete(selection.poolKey);
        }
      });
    }
    return entry;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(
      entries.map(async (entry) => (await entry).driver.close?.()),
    );
  }

  async #create(selection: ResolvedSelection): Promise<PooledDriver> {
    const factory = await this.deps.catalogs().adapters.load(selection.manifest);
    const options: TransportOptions = {
      ...this.deps.transport(),
      ...(selection.network.maxLagBlocks !== undefined
        ? { maxLagBlocks: selection.network.maxLagBlocks }
        : {}),
    };
    // `poolKey` fingerprints revealed provider URLs and must stay an in-memory map key
    // only (never persisted, emitted or logged); the transport's public id — which flows
    // into every rpc.*/provider.* event — is generated independently of it.
    const id = randomId('tr');
    const shared = {
      clock: this.deps.clock,
      events: this.deps.events,
      log: this.deps.log.child('transport'),
      options,
    };
    const transport = new HttpTransport(
      selection.providers.flatMap((p) => p.endpoints),
      { ...shared, id },
    );
    const indexer =
      selection.indexers.length > 0
        ? new HttpTransport(
            selection.indexers.flatMap((p) => p.endpoints),
            { ...shared, id: `${id}_idx` },
          )
        : undefined;
    const driver = await factory.create({
      chain: selection.chain,
      network: selection.network,
      library: selection.library,
      transport,
      ...(indexer ? { indexer } : {}),
      clock: this.deps.clock,
      log: this.deps.log.child(selection.chain.id),
      options: selection.options,
    });
    return { driver, transport, ...(indexer ? { indexer } : {}) };
  }
}
