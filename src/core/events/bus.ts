import { isCryptoAioError } from '../errors/error';
import type { Clock } from '../util/clock';
import type { Logger } from './logger';
import type { AioEvent, AioEventName, AioEvents } from './types';

type AnyHandler = (event: AioEvent) => void;

export class EventBus {
  readonly #handlers = new Map<AioEventName, Set<AnyHandler>>();
  readonly #any = new Set<AnyHandler>();

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  on<E extends AioEventName>(type: E, handler: (event: AioEvent<E>) => void): () => void {
    const set = this.#handlers.get(type) ?? new Set<AnyHandler>();
    this.#handlers.set(type, set);
    const h = handler as unknown as AnyHandler;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  onAny(handler: (event: AioEvent) => void): () => void {
    this.#any.add(handler);
    return () => {
      this.#any.delete(handler);
    };
  }

  emit<E extends AioEventName>(type: E, payload: AioEvents[E]): void {
    const event = { ...payload, type, at: this.clock.now() } as AioEvent;
    for (const handler of [...(this.#handlers.get(type) ?? []), ...this.#any]) {
      try {
        handler(event);
      } catch (error) {
        // The code only; a handler's error message may carry anything.
        this.log.warn('event handler threw', {
          type,
          code: isCryptoAioError(error) ? error.code : 'UNKNOWN',
        });
      }
    }
  }
}
