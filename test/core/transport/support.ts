import { EventBus } from '../../../src/core/events/bus';
import { noopLogger, type Logger } from '../../../src/core/events/logger';
import type { AioEvent } from '../../../src/core/events/types';
import { HttpTransport } from '../../../src/core/transport/http-transport';
import type { EndpointConfig, TransportOptions } from '../../../src/core/transport/types';
import { FakeClock } from '../../../src/testing/fake-clock';
import type { FakeFetch } from '../../../src/testing/fake-fetch';

export function setup(
  endpoints: EndpointConfig[],
  fake: FakeFetch,
  options: TransportOptions = {},
  log: Logger = noopLogger,
) {
  const clock = new FakeClock();
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = new HttpTransport(endpoints, {
    clock,
    events,
    log,
    id: 'tr',
    random: () => 0.5,
    options: { fetch: fake.fetch, baseDelayMs: 10, maxDelayMs: 100, ...options },
  });
  return { transport, clock, seen };
}
