import {
  ConfigError,
  ProviderError,
  TimeoutError,
  ValidationError,
  isCryptoAioError,
  withContext,
  type CryptoAioError,
} from '../errors/error';
import type { EventBus } from '../events/bus';
import type { Logger } from '../events/logger';
import { redactText } from '../secret/redact';
import { REDACTED, reveal } from '../secret/secret';
import { randomId } from '../util/bytes';
import type { Clock } from '../util/clock';
import { canonicalJson } from '../util/json';
import { backoffDelay, parseRetryAfter } from './backoff';
import { CircuitBreaker } from './circuit';
import { TokenBucket } from './rate-limit';
import {
  PLACEHOLDER_ORIGIN,
  type CallOptions,
  type EndpointCall,
  type EndpointConfig,
  type EndpointState,
  type EndpointStatus,
  type HealthProbes,
  type HttpRequest,
  type RequestPurpose,
  type RetryClass,
  type Transport,
  type TransportOptions,
} from './types';

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  timeoutMs: 15_000,
  maxLagBlocks: 5,
  proofQuorum: 2,
  failureThreshold: 5,
  openMs: 30_000,
  healthIntervalMs: 15_000,
};

type ResolvedOptions = typeof DEFAULTS & { fetch?: typeof fetch };
type Mode = 'rpc' | 'json' | 'text';
type Work<T> = (endpoint: Endpoint, signal: AbortSignal) => Promise<T>;

const MAX_RETRY_AFTER_MS = 60_000;
const TIMEOUT = new Error('transport timeout');
/** N1: statuses that must never carry a body on the Response passed back to the SDK. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** #9 (probe hang): races `promise` against `signal`, rejecting with the signal's abort
 * reason if it fires first. Guards against a probe callback that ignores its own signal
 * argument and never settles on its own. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as unknown);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

interface Endpoint {
  readonly id: string;
  readonly kind: 'rpc' | 'indexer';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
  readonly priority: number;
  readonly timeoutMs?: number;
  readonly breaker: CircuitBreaker;
  readonly bucket?: TokenBucket;
  identity: 'unchecked' | 'ok' | 'mismatch';
  identityCheck?: Promise<void>;
  identityRetryAt?: number;
  /** Earliest time this endpoint may be picked again, from Retry-After or backoff (I9). */
  notBefore: number;
  height?: bigint;
  latencyMs?: number;
  failures: number;
}

export interface HttpTransportDeps {
  readonly clock: Clock;
  readonly events: EventBus;
  readonly log: Logger;
  readonly options?: TransportOptions;
  readonly id?: string;
  readonly random?: () => number;
}

const POSITIVE_MS_OPTIONS = [
  'timeoutMs',
  'baseDelayMs',
  'maxDelayMs',
  'healthIntervalMs',
] as const;

/** M4: validated at construction so bad config fails fast, never with the URL in the message. */
function validateOptions(options: TransportOptions): void {
  if (
    options.maxAttempts !== undefined &&
    (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
  ) {
    throw new ConfigError('CONFIG_INVALID', 'maxAttempts must be an integer >= 1');
  }
  for (const key of POSITIVE_MS_OPTIONS) {
    const value = options[key];
    if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
      throw new ConfigError('CONFIG_INVALID', `${key} must be a finite number > 0`);
    }
  }
}

function resolveOptions(options: TransportOptions = {}): ResolvedOptions {
  const out: ResolvedOptions = { ...DEFAULTS };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

function joinUrl(base: string, path: string, query: string): string {
  const url = new URL(base);
  if (path && path !== '/') {
    url.pathname =
      url.pathname.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
  }
  new URLSearchParams(query).forEach((value, key) => url.searchParams.append(key, value));
  return url.toString();
}

/** M3: serialized once, before any endpoint is attempted; a bigint or other non-JSON value
 * never reaches an endpoint and never counts as an endpoint failure. */
function serializeJson(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new ValidationError(
      'INVALID_INTENT',
      'request payload could not be serialized',
      {
        cause: error,
      },
    );
  }
}

/** #3 (round 4): builds the request once, before #run, so an invalid or forbidden method, a
 * GET/HEAD with a body or a bad header value is a local config error — no fetch, no breaker
 * bookkeeping, never ambiguous. The message never repeats the input. */
function buildRequest(url: string | URL, init: RequestInit, what: string): Request {
  try {
    return new Request(url, init);
  } catch {
    throw new ConfigError(
      'CONFIG_INVALID',
      `${what} has an invalid method, header or body`,
    );
  }
}

function rpcLabel(payload: unknown): string {
  if (Array.isArray(payload)) return 'batch';
  const method = (payload as { method?: unknown } | null)?.method;
  return typeof method === 'string' ? method : 'rpc';
}

/** Low-cardinality event label: method+route when a route template is given, else the bare method. */
function routeLabel(method: string, route: string | undefined): string {
  return route ? `${method} ${route}` : method;
}

const IDENTITY_FIELD_CHARS = /[^A-Za-z0-9:_.-]/g;

/** Strips everything but a safe character set and caps length, for event fields sourced from provider answers. */
function sanitizeIdentityField(value: string): string {
  const cleaned = value.replace(IDENTITY_FIELD_CHARS, '').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'invalid';
}

export class HttpTransport implements Transport {
  readonly id: string;
  readonly #endpoints: Endpoint[];
  readonly #opts: ResolvedOptions;
  /** I4/R16: errors from an attempt whose `fetch` was invoked and answered, so the request may
   * have been delivered — every such failure except HTTP 401/403/429 and JSON-RPC-level rate
   * limiting (R16: those mean the request was never actually processed). */
  readonly #maybeDelivered = new WeakSet<CryptoAioError>();
  /** #4 (round 4): identity-check failures caused only by the owning request's caller
   * aborting — they say nothing about the endpoint, so a refresh that joined one counts the
   * endpoint as not attempted rather than failed. */
  readonly #abandonedChecks = new WeakSet<object>();
  readonly #clock: Clock;
  readonly #events: EventBus;
  readonly #log: Logger;
  readonly #random: () => number;
  #probes: HealthProbes = {};
  #best: bigint | undefined;
  #highest: bigint | undefined;
  /** I2: the highest height ever verified by an identity-checked endpoint; never lowered. */
  #verifiedPeak: bigint | undefined;
  #lastHealthAt = Number.NEGATIVE_INFINITY;
  /** #3 (round 3): set after a refresh where every probe failed, so ensureFreshHealth backs
   * off instead of storming the same down endpoints on every read during an outage. */
  #nextRefreshAt = Number.NEGATIVE_INFINITY;
  #healthRun: Promise<void> | undefined;
  #rpcId = 0;

  constructor(endpoints: readonly EndpointConfig[], deps: HttpTransportDeps) {
    if (endpoints.length === 0) {
      throw new ConfigError('CONFIG_INVALID', 'a transport needs at least one endpoint');
    }
    validateOptions(deps.options ?? {});
    this.id = deps.id ?? randomId('tr');
    this.#opts = resolveOptions(deps.options);
    this.#clock = deps.clock;
    this.#events = deps.events;
    this.#log = deps.log;
    this.#random = deps.random ?? Math.random;
    const names = new Set<string>();
    this.#endpoints = endpoints.map((config, index): Endpoint => {
      const id = config.name ?? `endpoint-${index}`;
      if (names.has(id))
        throw new ConfigError('CONFIG_INVALID', `duplicate endpoint name '${id}'`);
      names.add(id);
      const url = reveal(config.url);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ConfigError('CONFIG_INVALID', `endpoint '${id}' has an invalid URL`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(
          'CONFIG_INVALID',
          `endpoint '${id}' must use http or https`,
        );
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.headers ?? {})) {
        const revealed = reveal(value);
        // #1 (round 3): validated once here (never with the value in the message) so a bad
        // header can never surface later as a per-attempt local error.
        try {
          new Headers({ [name]: revealed });
        } catch {
          throw new ConfigError(
            'CONFIG_INVALID',
            `endpoint '${id}' has an invalid value for header '${name}'`,
          );
        }
        headers[name] = revealed;
      }
      const pathAndQuery = `${parsed.pathname}${parsed.search}`;
      const secrets = [
        url,
        parsed.href,
        ...(pathAndQuery.length > 1 ? [pathAndQuery] : []),
      ];
      for (const value of Object.values(headers))
        if (value.length >= 4) secrets.push(value);
      return {
        id,
        kind: config.kind ?? 'rpc',
        url,
        headers,
        secrets: secrets.sort((a, b) => b.length - a.length),
        priority: config.priority ?? 0,
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        breaker: new CircuitBreaker(
          { failureThreshold: this.#opts.failureThreshold, openMs: this.#opts.openMs },
          this.#clock,
        ),
        ...(config.rateLimit
          ? {
              bucket: new TokenBucket(
                config.rateLimit.rps,
                config.rateLimit.burst ?? Math.max(1, Math.ceil(config.rateLimit.rps)),
                this.#clock,
              ),
            }
          : {}),
        identity: 'unchecked',
        notBefore: Number.NEGATIVE_INFINITY,
        failures: 0,
      };
    });
  }

  // rpc/rpcRaw/http are `async` on purpose (M3): serializing the body happens synchronously,
  // before any endpoint is touched, and `async` turns a bad payload into a rejected Promise
  // rather than a synchronous throw, keeping the Transport contract's `Promise<T>` honest.
  async rpc<T = unknown>(
    method: string,
    params: unknown = [],
    options: CallOptions = {},
  ): Promise<T> {
    const id = ++this.#rpcId;
    const body = serializeJson({ jsonrpc: '2.0', id, method, params });
    return this.#run(method, options, (endpoint, signal) =>
      this.#rpcOnce<T>(endpoint, method, id, body, signal),
    );
  }

  async rpcRaw(payload: unknown, options: CallOptions = {}): Promise<unknown> {
    const label = rpcLabel(payload);
    const body = serializeJson(payload);
    return this.#run(label, options, async (endpoint, signal) => {
      const { json } = await this.#exchange(
        endpoint,
        label,
        this.#jsonPost(endpoint.url, body),
        signal,
        'rpc',
      );
      return json;
    });
  }

  async http<T = unknown>(request: HttpRequest, options: CallOptions = {}): Promise<T> {
    const bodyText =
      request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : serializeJson(request.body);
    buildRequest(
      PLACEHOLDER_ORIGIN,
      {
        method: request.method,
        ...(request.headers ? { headers: request.headers } : {}),
        ...(bodyText !== undefined ? { body: bodyText } : {}),
      },
      'http request',
    );
    return this.#run(
      routeLabel(request.method, request.route),
      options,
      (endpoint, signal) => this.#httpOnce<T>(endpoint, request, bodyText, signal),
    );
  }

  createFetch(
    classify?: (url: URL, init: RequestInit | undefined) => CallOptions,
  ): typeof fetch {
    const bridged = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // M5: a relative or otherwise invalid URL is a config error; the message never
      // repeats the caller's input.
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new ConfigError('CONFIG_INVALID', 'bridged fetch requires an absolute URL');
      }
      if (url.origin !== PLACEHOLDER_ORIGIN) {
        throw new ConfigError(
          'CONFIG_INVALID',
          'bridged fetch accepts only transport placeholder URLs',
        );
      }
      // M5: a Request input keeps its own method, headers and body unless init overrides them.
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headerSource =
        init?.headers ?? (input instanceof Request ? input.headers : undefined);
      let body = init?.body ?? undefined;
      if (body === undefined && input instanceof Request && input.body) {
        // M5: a Request input's own body is preserved (read once, replayed on every retry).
        body = new Uint8Array(await input.arrayBuffer());
      } else if (body instanceof ReadableStream) {
        // M3: a stream body can only be read once; buffer it up front so every retry attempt
        // can replay the same bytes.
        body = new Uint8Array(await new Response(body).arrayBuffer());
      }
      // #1 (round 3) / #3 (round 4): the whole request is built once, here, before #run — a
      // bad SDK header value, a GET/HEAD with a body or an invalid or forbidden method fails
      // with no fetch, no breaker bookkeeping and no ambiguity tag, never as a per-attempt
      // local error. Every attempt reuses its method, headers and body bytes (headers and
      // bytes together, so e.g. a multipart boundary always matches its body).
      const template = buildRequest(
        url,
        {
          method,
          ...(headerSource !== undefined ? { headers: headerSource } : {}),
          ...(body !== undefined ? { body } : {}),
        },
        'bridged fetch request',
      );
      const payload = template.body
        ? new Uint8Array(await template.arrayBuffer())
        : undefined;
      // Bridged SDK calls have no route template; the raw path never becomes an event label.
      const label = template.method;
      const options = classify?.(url, init) ?? {};
      const signal = init?.signal ?? options.signal;
      return this.#run(
        label,
        { ...options, ...(signal ? { signal } : {}) },
        async (endpoint, deadline) => {
          // #1 (round 3): cloning an already-valid Headers instance never throws.
          const requestHeaders = new Headers(template.headers);
          for (const [name, value] of Object.entries(endpoint.headers))
            requestHeaders.set(name, value);
          const started = this.#clock.now();
          const response = await this.#fetch(
            joinUrl(endpoint.url, url.pathname, url.search),
            {
              method: template.method,
              headers: requestHeaders,
              ...(payload !== undefined ? { body: payload } : {}),
              signal: deadline,
              redirect: 'error',
            },
          );
          // M5: an error-status response body is never returned to the SDK; drain it so the
          // connection can be released instead of leaking it.
          try {
            this.#throwForStatus(endpoint, response);
          } catch (error) {
            // #7: cancel() returns a promise that can reject asynchronously; an unhandled
            // rejection here can crash the process, so it's always caught, even when body
            // is null.
            void response.body?.cancel().catch(() => undefined);
            throw error;
          }
          // I1: buffer the whole body here, while the deadline and the caller's signal are
          // still attached, and hand the SDK a fresh Response whose `url` is always '' — the
          // real endpoint URL (and any secret it carries) never reaches the SDK.
          const buffer = await response.arrayBuffer();
          this.#emitResponse(endpoint, label, started, buffer.byteLength);
          // N1: the Response constructor throws if a body is given alongside a status that
          // must never carry one.
          const responseHeaders = new Headers(response.headers);
          // #10: drop headers describing the original (possibly compressed) wire body —
          // they no longer describe this already-decoded buffer.
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
          return new Response(NULL_BODY_STATUSES.has(response.status) ? null : buffer, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        },
      );
    };
    return bridged as typeof fetch;
  }

  /** N6: least-invasive detector for "no health probe was ever configured" — mirrors the same
   * condition `ensureFreshHealth` already uses to skip probing entirely. */
  hasProbes(): boolean {
    return Boolean(this.#probes.height) || Boolean(this.#probes.identity);
  }

  setProbes(probes: HealthProbes): void {
    this.#probes = probes;
    // M12: a new probe set invalidates any previously confirmed identity.
    // #5 (round 4): ...and the health timers and stored heights. #highest stays: it is the
    // monotonic guard, rebuilt from verified endpoints only if one turns out mismatched (R19).
    this.#lastHealthAt = Number.NEGATIVE_INFINITY;
    this.#nextRefreshAt = Number.NEGATIVE_INFINITY;
    this.#best = undefined;
    for (const endpoint of this.#endpoints) {
      endpoint.identity = 'unchecked';
      endpoint.identityCheck = undefined;
      endpoint.identityRetryAt = undefined;
      endpoint.height = undefined;
    }
  }

  async ensureFreshHealth(signal?: AbortSignal): Promise<void> {
    if (!this.#probes.height && !this.#probes.identity) return;
    // I8: an in-flight refresh is awaited before the staleness check, so a second concurrent
    // caller can't slip through and read endpoint state mid-refresh (e.g. heights still
    // unset). This caller's own signal is raced against it; the shared run itself is not
    // cancelled by it.
    if (this.#healthRun) await this.#join(this.#healthRun, signal);
    if (this.#clock.now() - this.#lastHealthAt < this.#opts.healthIntervalMs) return;
    // #3 (round 3): after a fully-failed refresh, back off until #nextRefreshAt instead of
    // re-probing every down endpoint on every read during an outage. Reads in this window
    // simply see no fresh health and proceed with the existing no-eligible-endpoint semantics.
    if (this.#clock.now() < this.#nextRefreshAt) return;
    await this.refreshHealth(signal);
  }

  refreshHealth(signal?: AbortSignal): Promise<void> {
    // I8: the shared run is started at most once and is never bound to any one caller's
    // signal; each caller instead races its own signal against it via #join.
    this.#healthRun ??= this.#refresh().finally(() => {
      this.#healthRun = undefined;
    });
    return this.#join(this.#healthRun, signal);
  }

  /** I8: resolves/rejects with `run`, but also rejects early (with only THIS caller's promise)
   * if `signal` aborts first. `run` itself is left untouched either way. */
  #join(run: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return run;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      run.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  status(): EndpointStatus[] {
    return this.#endpoints.map((e) => {
      const lag =
        e.height !== undefined && this.#best !== undefined
          ? this.#best - e.height
          : undefined;
      const state: EndpointState =
        e.identity === 'mismatch'
          ? 'disabled'
          : e.breaker.state === 'open'
            ? 'open'
            : e.breaker.state === 'half-open'
              ? 'half-open'
              : this.#lagging(e)
                ? 'lagging'
                : e.height !== undefined || e.identity === 'ok'
                  ? 'healthy'
                  : 'unknown';
      return {
        id: e.id,
        kind: e.kind,
        state,
        failures: e.failures,
        ...(e.height !== undefined ? { height: e.height } : {}),
        ...(lag !== undefined ? { lag } : {}),
        ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
        ...(e.identity === 'mismatch' ? { reason: 'identity-mismatch' } : {}),
      };
    });
  }

  highestHeight(): bigint | undefined {
    return this.#highest;
  }

  get maxLagBlocks(): number {
    return this.#opts.maxLagBlocks;
  }

  // ---- request orchestration -------------------------------------------------------

  async #run<T>(label: string, options: CallOptions, work: Work<T>): Promise<T> {
    const purpose: RequestPurpose =
      options.purpose ?? (options.quorum !== undefined ? 'proof' : 'read');
    if (purpose === 'monitor' || purpose === 'proof')
      await this.ensureFreshHealth(options.signal);
    if (options.quorum !== undefined) return this.#quorum(label, purpose, options, work);
    if ((options.fanout ?? 1) > 1) return this.#fanout(label, purpose, options, work);
    return this.#withRetry(label, purpose, options, work);
  }

  async #withRetry<T>(
    label: string,
    purpose: RequestPurpose,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const retry = options.retry ?? 'safe';
    const attempts = retry === 'never-auto' ? 1 : this.#opts.maxAttempts;
    const tried = new Set<string>();
    let last: CryptoAioError | undefined;
    let mayHaveSent = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let endpoint: Endpoint;
      try {
        // #6 (round 3): the raw call-level override (possibly undefined) is passed through
        // so #pick can fall back to the endpoint's own timeoutMs, matching #attempt.
        endpoint = await this.#pick(purpose, tried, options.signal, options.timeoutMs);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (last) break;
        throw error;
      }
      tried.add(endpoint.id);
      try {
        return await this.#attempt(endpoint, label, attempt, options, work);
      } catch (error) {
        const { failure, definitive } = this.#endpointFailure(error, options);
        if (this.#maybeDelivered.has(failure)) mayHaveSent = true;
        if (definitive)
          throw this.#externalize(this.#finalize(failure, retry, mayHaveSent));
        last = failure;
        // I9: a rate-limit wait is #pick's job now; only back off for other failures.
        if (attempt + 1 < attempts && failure.code !== 'RATE_LIMITED') {
          await this.#clock.sleep(this.#delay(attempt), options.signal);
        }
      }
    }
    throw this.#externalize(this.#finalize(last as CryptoAioError, retry, mayHaveSent));
  }

  async #quorum<T>(
    label: string,
    purpose: RequestPurpose,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const requested =
      options.quorum === 'proof' ? this.#opts.proofQuorum : (options.quorum ?? 1);
    // N3 (round 2, item 5): sized from the full candidate set (breaker/identity/lag), not
    // the rate-limit-filtered eligible set — a required endpoint being rate-limited must not
    // silently shrink the quorum. A required endpoint that's rate-limited therefore fails
    // the call with a retryable error instead of resolving from fewer endpoints than needed.
    const needed = Math.max(1, Math.min(requested, this.#candidates(purpose).length));
    // #5 (round 3): if fewer endpoints are eligible right now than needed, fail fast —
    // before querying any of them — instead of querying what's available and discovering
    // the shortfall only afterward.
    if (this.#eligible(purpose).length < needed) {
      throw this.#externalize(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `quorum of ${needed} not reachable for ${label}`,
          { context: { transportId: this.id } },
        ),
      );
    }
    const results: { endpoint: Endpoint; value: T }[] = [];
    const tried = new Set<string>();
    let last: CryptoAioError | undefined;
    while (results.length < needed) {
      const endpoint = this.#eligible(purpose).find((e) => !tried.has(e.id));
      if (!endpoint) break;
      tried.add(endpoint.id);
      try {
        results.push({
          endpoint,
          value: await this.#attempt(endpoint, label, tried.size - 1, options, work),
        });
      } catch (error) {
        const { failure, definitive } = this.#endpointFailure(error, options);
        if (definitive) throw failure;
        last = failure;
      }
    }
    const first = results[0];
    if (!first || results.length < needed) {
      throw this.#externalize(
        last ??
          new ProviderError(
            'PROVIDER_UNAVAILABLE',
            `quorum of ${needed} not reachable for ${label}`,
            { context: { transportId: this.id } },
          ),
      );
    }
    const key = (value: T): string =>
      canonicalJson(options.quorumKey ? options.quorumKey(value) : value);
    const expected = key(first.value);
    if (results.some((r) => key(r.value) !== expected)) {
      const endpointIds = results.map((r) => r.endpoint.id);
      this.#events.emit('provider.inconsistent', {
        transportId: this.id,
        method: label,
        endpointIds,
      });
      throw new ProviderError('PROVIDER_INCONSISTENT', `endpoints disagree on ${label}`, {
        context: { transportId: this.id },
      });
    }
    return first.value;
  }

  async #fanout<T>(
    label: string,
    purpose: RequestPurpose,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const targets = this.#eligible(purpose).slice(0, options.fanout);
    if (targets.length === 0) throw this.#noHealthyEndpoint();
    const settled = await Promise.allSettled(
      targets.map((endpoint, index) =>
        this.#attempt(endpoint, label, index, options, work),
      ),
    );
    for (const outcome of settled)
      if (outcome.status === 'fulfilled') return outcome.value;
    if (options.signal?.aborted) throw options.signal.reason;
    const errors = settled.map(
      (outcome) => (outcome as PromiseRejectedResult).reason as CryptoAioError,
    );
    // I4: any settled attempt that reached the network makes the whole fanout ambiguous.
    const mayHaveSent = errors.some((e) => this.#maybeDelivered.has(e));
    const retry = options.retry ?? 'safe';
    const definitive = errors.find((e) => !e.retryable);
    if (definitive)
      throw this.#externalize(this.#finalize(definitive, retry, mayHaveSent));
    throw this.#externalize(
      this.#finalize(errors[0] as CryptoAioError, retry, mayHaveSent),
    );
  }

  async #attempt<T>(
    endpoint: Endpoint,
    label: string,
    attempt: number,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? endpoint.timeoutMs ?? this.#opts.timeoutMs;
    // M3/#2 (round 2): the token-bucket wait runs before the per-attempt deadline is armed,
    // with its own timeoutMs-bounded budget. A wait that times out (or that the caller
    // aborts) never touches the breaker and is never tagged ambiguous — no fetch has
    // happened yet.
    await this.#takeToken(endpoint, timeoutMs, options.signal);
    const { signal, cancel } = this.#deadline(timeoutMs, options.signal);
    const started = this.#clock.now();
    // #8 (round 2): only set once THIS attempt's own onAttempt() call ran, so only this
    // attempt may release a half-open probe slot it actually claimed.
    let ownsProbe = false;
    try {
      await this.#ensureIdentity(endpoint, signal);
      // #4 (round 3): onAttempt() itself reports whether this attempt claimed the slot.
      ownsProbe = endpoint.breaker.onAttempt();
      this.#events.emit('rpc.request', {
        transportId: this.id,
        endpointId: endpoint.id,
        method: label,
        attempt,
      });
      const value = await work(endpoint, signal);
      endpoint.breaker.onSuccess();
      endpoint.failures = 0;
      endpoint.latencyMs = this.#clock.now() - started;
      return value;
    } catch (error) {
      if (options.signal?.aborted) {
        // I7/M3/#8: only free the half-open slot if THIS attempt actually claimed it —
        // an abort during the identity check or the token wait never frees another
        // request's half-open slot.
        if (ownsProbe) endpoint.breaker.onAbandon();
        throw options.signal.reason;
      }
      const failure = this.#classify(error, endpoint, signal);
      if (failure.retryable) {
        endpoint.breaker.onFailure();
        endpoint.failures += 1;
      } else {
        // M12: a definitive answer proves the endpoint is reachable and healthy.
        endpoint.breaker.onSuccess();
        endpoint.failures = 0;
      }
      this.#events.emit('rpc.error', {
        transportId: this.id,
        endpointId: endpoint.id,
        method: label,
        latencyMs: this.#clock.now() - started,
        code: failure.code,
        retryable: failure.retryable,
      });
      throw failure;
    } finally {
      cancel();
    }
  }

  /** M3/#2 (round 2): bounds the token-bucket wait by the caller's signal and the call's
   * timeoutMs, run before the per-attempt deadline is armed. A wait that exceeds timeoutMs
   * fails with a retryable rate-limit error, without touching the breaker — no fetch has
   * happened yet, so this can never be tagged ambiguous either. */
  async #takeToken(
    endpoint: Endpoint,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<void> {
    if (!endpoint.bucket) return;
    const { signal, cancel } = this.#deadline(timeoutMs, outer);
    try {
      await endpoint.bucket.take(signal);
    } catch {
      if (outer?.aborted) throw outer.reason;
      throw new ProviderError(
        'RATE_LIMITED',
        `rate limit wait exceeded the call timeout for endpoint '${endpoint.id}'`,
        { context: this.#context(endpoint) },
      );
    } finally {
      cancel();
    }
  }

  /** Endpoints that are structurally usable for `purpose` (breaker, identity, lag/height),
   * ignoring any per-endpoint rate-limit wait (I9). */
  #candidates(purpose: RequestPurpose): Endpoint[] {
    const strict = purpose === 'monitor' || purpose === 'proof';
    const now = this.#clock.now();
    return this.#endpoints
      .filter(
        (e) =>
          e.identity !== 'mismatch' &&
          // N2 (round 2, item 4): an identity-throttled endpoint is excluded the same way a
          // rate-limited one is — never picked, and a throttle hit never reaches the breaker.
          (e.identityRetryAt === undefined || e.identityRetryAt <= now) &&
          e.breaker.canRequest() &&
          (!strict || !this.#excludedForHeight(e)),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.failures - b.failures ||
          (a.latencyMs ?? 0) - (b.latencyMs ?? 0),
      );
  }

  #eligible(purpose: RequestPurpose): Endpoint[] {
    const now = this.#clock.now();
    return this.#candidates(purpose).filter((e) => e.notBefore <= now);
  }

  #noHealthyEndpoint(): ProviderError {
    return new ProviderError('PROVIDER_UNAVAILABLE', 'no healthy endpoint available', {
      context: { transportId: this.id },
    });
  }

  /** I9: picks the best available endpoint, waiting only when every structurally-usable
   * endpoint is still rate-limited, and only until the earliest one frees up.
   * #11 (round 2): that wait is bounded by the call's timeoutMs — a wait longer than that
   * fails at once with a retryable rate-limit error instead of stalling the whole call. */
  async #pick(
    purpose: RequestPurpose,
    tried: ReadonlySet<string>,
    signal: AbortSignal | undefined,
    callTimeoutMs: number | undefined,
  ): Promise<Endpoint> {
    for (;;) {
      const eligible = this.#eligible(purpose);
      if (eligible.length > 0) {
        const untried = eligible.filter((e) => !tried.has(e.id));
        const pool = untried.length > 0 ? untried : eligible;
        return (
          pool.find((e) => !e.bucket || e.bucket.msUntilToken() === 0) ??
          (pool[0] as Endpoint)
        );
      }
      const waiting = this.#candidates(purpose);
      if (waiting.length === 0) throw this.#noHealthyEndpoint();
      const earliest = waiting.reduce((min, e) =>
        e.notBefore < min.notBefore ? e : min,
      );
      const waitMs = Math.max(0, earliest.notBefore - this.#clock.now());
      // #6 (round 3): matches #attempt's own effective-timeout resolution — the earliest
      // endpoint's own timeoutMs, when set, bounds its wait instead of only the transport
      // default.
      const boundMs = callTimeoutMs ?? earliest.timeoutMs ?? this.#opts.timeoutMs;
      if (waitMs > boundMs) {
        throw new ProviderError(
          'RATE_LIMITED',
          'endpoint rate limit wait exceeds the call timeout',
          { context: this.#context(earliest) },
        );
      }
      await this.#clock.sleep(waitMs, signal);
    }
  }

  #lagging(endpoint: Endpoint): boolean {
    return (
      endpoint.height !== undefined &&
      this.#best !== undefined &&
      this.#best - endpoint.height > BigInt(this.#opts.maxLagBlocks)
    );
  }

  /** I8: once a height probe is configured, an endpoint whose height is unknown (its probe
   * never ran or failed) is excluded from monitor/proof reads the same way a lagging one is. */
  #excludedForHeight(endpoint: Endpoint): boolean {
    if (!this.#probes.height) return false;
    if (endpoint.height === undefined) return true;
    return this.#lagging(endpoint);
  }

  /** I9: clamps Retry-After, or falls back to backoff, and records the endpoint's notBefore. */
  #applyRateLimit(endpoint: Endpoint, retryAfterMs: number | undefined): number {
    const delayMs =
      retryAfterMs !== undefined
        ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
        : backoffDelay(endpoint.failures, this.#opts, this.#random);
    endpoint.notBefore = this.#clock.now() + delayMs;
    return delayMs;
  }

  #delay(attempt: number): number {
    return backoffDelay(attempt, this.#opts, this.#random);
  }

  /** I4: `mayHaveSent` covers every attempt that was possibly delivered, not just this one;
   * once true, even a later definitive error can't rule out an earlier ambiguous attempt. */
  #finalize(
    error: CryptoAioError,
    retry: RetryClass,
    mayHaveSent: boolean,
  ): CryptoAioError {
    return retry === 'ambiguous-on-failure' && mayHaveSent
      ? withContext(error, {}, { ambiguous: true })
      : error;
  }

  /** I10: PROVIDER_MISCONFIGURED is only retryable internally, to allow failover between
   * endpoints; once every endpoint has been exhausted, the caller must see it as final. */
  #externalize(error: CryptoAioError): CryptoAioError {
    return error.code === 'PROVIDER_MISCONFIGURED' && error.retryable
      ? withContext(error, {}, { retryable: false })
      : error;
  }

  /** M9: shared retry-loop catch handling. Caller aborts propagate as-is; everything else is
   * classified as either a definitive (stop retrying) or a retryable endpoint failure. */
  #endpointFailure(
    error: unknown,
    options: CallOptions,
  ): { readonly failure: CryptoAioError; readonly definitive: boolean } {
    if (options.signal?.aborted) throw options.signal.reason;
    const failure = error as CryptoAioError;
    return { failure, definitive: !failure.retryable };
  }

  #deadline(
    ms: number,
    outer?: AbortSignal,
  ): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const onOuter = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener('abort', onOuter, { once: true });
    const timer = new AbortController();
    void this.#clock.sleep(ms, timer.signal).then(
      () => controller.abort(TIMEOUT),
      () => undefined,
    );
    return {
      signal: controller.signal,
      cancel: () => {
        timer.abort();
        outer?.removeEventListener('abort', onOuter);
      },
    };
  }

  // ---- single requests -------------------------------------------------------------

  #fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.#opts.fetch ?? globalThis.fetch)(url, init);
  }

  /** M9: the JSON-RPC POST shape is identical whether the caller goes through `rpc()` or the
   * direct per-endpoint health-probe calls. */
  #jsonPost(
    url: string,
    body: string,
  ): { method: 'POST'; url: string; headers: Record<string, string>; body: string } {
    return { method: 'POST', url, headers: { 'content-type': 'application/json' }, body };
  }

  async #rpcOnce<T>(
    endpoint: Endpoint,
    method: string,
    id: number,
    body: string,
    signal: AbortSignal,
  ): Promise<T> {
    const { json } = await this.#exchange(
      endpoint,
      method,
      this.#jsonPost(endpoint.url, body),
      signal,
      'rpc',
    );
    return this.#unwrapRpc<T>(endpoint, method, id, json);
  }

  async #httpOnce<T>(
    endpoint: Endpoint,
    request: HttpRequest,
    bodyText: string | undefined,
    signal: AbortSignal,
  ): Promise<T> {
    const query = request.query
      ? new URLSearchParams({ ...request.query }).toString()
      : '';
    const hasBody = bodyText !== undefined;
    const mode = request.responseType ?? 'json';
    const { text, json } = await this.#exchange(
      endpoint,
      routeLabel(request.method, request.route),
      {
        method: request.method,
        url: joinUrl(endpoint.url, request.path, query),
        headers: {
          ...(hasBody
            ? {
                'content-type':
                  typeof request.body === 'string' ? 'text/plain' : 'application/json',
              }
            : {}),
          ...request.headers,
        },
        ...(hasBody ? { body: bodyText } : {}),
      },
      signal,
      mode,
      // Error message text keeps the real path (unchanged, existing behaviour); only the
      // event label above is route-based to avoid leaking identifiers into events.
      `${request.method} ${request.path}`,
    );
    return (mode === 'text' ? text : json) as T;
  }

  #direct(endpoint: Endpoint, signal: AbortSignal): EndpointCall {
    return {
      rpc: <T>(method: string, params?: unknown) => {
        const id = ++this.#rpcId;
        const body = serializeJson({ jsonrpc: '2.0', id, method, params: params ?? [] });
        return this.#rpcOnce<T>(endpoint, method, id, body, signal);
      },
      http: <T>(request: HttpRequest) => {
        const bodyText =
          request.body === undefined
            ? undefined
            : typeof request.body === 'string'
              ? request.body
              : serializeJson(request.body);
        return this.#httpOnce<T>(endpoint, request, bodyText, signal);
      },
    };
  }

  async #exchange(
    endpoint: Endpoint,
    label: string,
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    },
    signal: AbortSignal,
    mode: Mode,
    errorLabel: string = label,
  ): Promise<{ text: string; json: unknown }> {
    const started = this.#clock.now();
    const response = await this.#fetch(request.url, {
      method: request.method,
      headers: { ...endpoint.headers, ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal,
      redirect: 'error',
    });
    const text = await response.text();
    this.#throwForStatus(endpoint, response);
    const context = this.#context(endpoint);
    let json: unknown;
    if (mode !== 'text' || !response.ok) {
      try {
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        if (response.ok) {
          // I4: an unparseable 2xx body is inherently ambiguous — the server accepted the
          // request but we can't tell what it said.
          throw this.#markSent(
            new ProviderError(
              'PROVIDER_UNAVAILABLE',
              `endpoint returned a non-JSON body (HTTP ${response.status})`,
              { context },
            ),
          );
        }
      }
    }
    if (!response.ok) {
      const isRpcError =
        mode === 'rpc' && json !== null && typeof json === 'object' && 'error' in json;
      if (!isRpcError) {
        if (mode === 'rpc') {
          // A 4xx in RPC mode without a JSON-RPC envelope is an endpoint-local failure,
          // not a definitive protocol answer: retry and fail over (I6b). R16: the server did
          // respond, so a later definitive failure on this call still inherits ambiguity.
          throw this.#markSent(
            new ProviderError(
              'PROVIDER_UNAVAILABLE',
              `${errorLabel} did not return a JSON-RPC envelope (HTTP ${response.status})`,
              { context },
            ),
          );
        }
        // R17 (round 2, item 6): a REST 4xx that isn't 401/403/429/408 (peeled off in
        // #throwForStatus) is a definitive, non-retryable answer from the endpoint — it
        // must not itself set mayHaveSent, though it still inherits ambiguity from an
        // earlier tagged attempt via #withRetry/#fanout's accumulated mayHaveSent.
        throw new ProviderError(
          'RPC_ERROR',
          `${errorLabel} refused (HTTP ${response.status})`,
          {
            context,
            details: {
              status: response.status,
              body: this.#scrub(endpoint, text).slice(0, 300),
            },
          },
        );
      }
    }
    this.#emitResponse(endpoint, label, started, new TextEncoder().encode(text).length);
    return { text, json };
  }

  /** M9: the `rpc.response` event is emitted identically from `#exchange` and the SDK bridge. */
  #emitResponse(
    endpoint: Endpoint,
    method: string,
    started: number,
    byteLength: number,
  ): void {
    this.#events.emit('rpc.response', {
      transportId: this.id,
      endpointId: endpoint.id,
      method,
      latencyMs: this.#clock.now() - started,
      bytes: byteLength,
    });
  }

  #throwForStatus(endpoint: Endpoint, response: Response): void {
    const context = this.#context(endpoint);
    const status = response.status;
    if (status === 408) {
      // Retryable in every mode (I6b): a request timeout is an endpoint-local failure that
      // may have reached the server before it gave up (R16).
      throw this.#markSent(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          'endpoint request timed out (HTTP 408)',
          { context },
        ),
      );
    }
    if (status === 429) {
      // R16: rate-limiting means the request was never actually processed — excluded from
      // ambiguity, like 401/403 below.
      const retryAfterMs = parseRetryAfter(
        response.headers.get('retry-after'),
        this.#clock.now(),
      );
      const delayMs = this.#applyRateLimit(endpoint, retryAfterMs);
      throw new ProviderError('RATE_LIMITED', 'endpoint rate limited (HTTP 429)', {
        context,
        details: { retryAfterMs: delayMs },
      });
    }
    if (status === 401 || status === 403) {
      // R16: credentials were rejected before any processing — excluded from ambiguity.
      throw new ProviderError(
        'PROVIDER_MISCONFIGURED',
        `endpoint rejected the credentials (HTTP ${status})`,
        {
          context,
          retryable: true,
        },
      );
    }
    if (status >= 500) {
      // I4: a 5xx is inherently ambiguous — the server may have processed the request.
      throw this.#markSent(
        new ProviderError('PROVIDER_UNAVAILABLE', `endpoint error (HTTP ${status})`, {
          context,
        }),
      );
    }
  }

  #unwrapRpc<T>(endpoint: Endpoint, method: string, id: number, json: unknown): T {
    const context = this.#context(endpoint);
    // Step 1: the body must be an object. R16: the server did respond, so this attempt may
    // have been delivered even though its answer was unusable.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw this.#markSent(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `malformed JSON-RPC response to ${method}`,
          { context },
        ),
      );
    }
    const body = json as {
      id?: unknown;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown } | null;
    };
    const hasResult = 'result' in body;
    const hasError = 'error' in body && body.error !== undefined && body.error !== null;
    const errorCode =
      hasError && typeof body.error?.code === 'number' ? body.error.code : undefined;
    // Step 2: id must match, except a null id is only valid alongside a parse/invalid-request error.
    const idIsNullForProtocolError =
      body.id === null && (errorCode === -32700 || errorCode === -32600);
    const idMatches = idIsNullForProtocolError || String(body.id) === String(id);
    // Step 3: exactly one of result/error. Any of these three problems is an endpoint-local
    // failure, not a definitive protocol answer: retry and fail over (I5). R16: same reasoning
    // as step 1 — the server responded, so this attempt may have been delivered.
    if (!idMatches || (hasResult && hasError) || (!hasResult && !hasError)) {
      throw this.#markSent(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `invalid JSON-RPC envelope for ${method}`,
          { context },
        ),
      );
    }
    // Step 4: only now classify the error or return the result.
    if (hasError) {
      const err = body.error as { code?: unknown; message?: unknown; data?: unknown };
      const code = typeof err.code === 'number' ? err.code : undefined;
      const message = this.#scrub(
        endpoint,
        typeof err.message === 'string' ? err.message : 'unknown error',
      ).slice(0, 300);
      const rawData = err.data;
      const data =
        rawData === undefined
          ? undefined
          : this.#scrub(
              endpoint,
              typeof rawData === 'string' ? rawData : JSON.stringify(rawData),
            ).slice(0, 512);
      const details = {
        rpcCode: code,
        rpcMessage: message,
        ...(data !== undefined ? { rpcData: data } : {}),
      };
      if (
        code === -32005 ||
        code === 429 ||
        /rate limit|too many requests|request limit/i.test(message)
      ) {
        // I9: no Retry-After header at the JSON-RPC level, so back off. R16: a JSON-RPC-level
        // rate limit carries the same "never processed" meaning as an HTTP 429 — excluded
        // from ambiguity for the same reason.
        const retryAfterMs = this.#applyRateLimit(endpoint, undefined);
        throw new ProviderError('RATE_LIMITED', `endpoint rate limited ${method}`, {
          context,
          details: { ...details, retryAfterMs },
        });
      }
      // A definitive JSON-RPC application error (e.g. "nonce too low") is not itself tagged:
      // the server told us exactly what happened, so a lone instance of it is never ambiguous
      // (I4). It still inherits ambiguity from an earlier possibly-delivered attempt via
      // #withRetry/#fanout's accumulated `mayHaveSent`.
      throw new ProviderError('RPC_ERROR', `${method} failed: ${message}`, {
        context,
        details,
      });
    }
    return body.result as T;
  }

  // ---- health ----------------------------------------------------------------------

  /** Same condition under which #ensureIdentity actually probes. */
  #identityProbed(): boolean {
    return (
      this.#probes.identity !== undefined && this.#probes.expectedIdentity !== undefined
    );
  }

  /** R19 (round 4): the highest known height among endpoints that may feed health heights —
   * with an identity probe configured, only endpoints whose identity is 'ok'. */
  #verifiedMaxHeight(): bigint | undefined {
    const probed = this.#identityProbed();
    let max: bigint | undefined;
    for (const e of this.#endpoints) {
      if (e.height === undefined || e.identity === 'mismatch') continue;
      if (probed && e.identity !== 'ok') continue;
      if (max === undefined || e.height > max) max = e.height;
    }
    return max;
  }

  async #ensureIdentity(endpoint: Endpoint, signal: AbortSignal): Promise<void> {
    const probe = this.#probes.identity;
    const expected = this.#probes.expectedIdentity;
    if (!probe || expected === undefined || endpoint.identity === 'ok') return;
    if (endpoint.identity === 'unchecked') {
      // A prior probe attempt failed (not a confirmed mismatch): back off until the next
      // health interval instead of re-probing on every attempt (I6a).
      if (
        endpoint.identityRetryAt !== undefined &&
        this.#clock.now() < endpoint.identityRetryAt
      ) {
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `endpoint '${endpoint.id}' identity not yet confirmed`,
          { context: this.#context(endpoint) },
        );
      }
      const shared = endpoint.identityCheck;
      if (shared) {
        // #6 (round 4): a joiner races its own signal against the shared check, the same way
        // #join does — its caller's abort or its own deadline rejects only this caller, and
        // the check runs on for its owner. Only TIMEOUT (this joiner's deadline) is wrapped;
        // a caller's abort reason and the check's own failure propagate as they are.
        try {
          await raceAbort(shared, signal);
        } catch (error) {
          if (error !== TIMEOUT) throw error;
          throw this.#identityProbeFailed(endpoint, error, signal);
        }
      } else {
        const check = this.#checkIdentity(endpoint, probe, expected, signal);
        endpoint.identityCheck = check;
        // Cleared from outside the check, once settled and only while still current: a probe
        // that throws synchronously can't leave a settled check behind, and a check replaced
        // by setProbes can't clear its successor.
        const clear = () => {
          if (endpoint.identityCheck === check) endpoint.identityCheck = undefined;
        };
        void check.then(clear, clear);
        await check;
      }
    }
    if (endpoint.identity === 'mismatch') {
      throw new ProviderError(
        'PROVIDER_MISCONFIGURED',
        `endpoint '${endpoint.id}' serves a different network than configured`,
        {
          context: this.#context(endpoint),
          retryable: true,
        },
      );
    }
  }

  /** The owner's identity probe; joiners share its promise via endpoint.identityCheck. */
  async #checkIdentity(
    endpoint: Endpoint,
    probe: NonNullable<HealthProbes['identity']>,
    expected: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      // #9 (round 2): races the probe against `signal` so a probe that ignores its own
      // signal argument can't hang #ensureIdentity forever.
      const actual = await raceAbort(probe(this.#direct(endpoint, signal)), signal);
      if (actual === expected) {
        endpoint.identity = 'ok';
        endpoint.identityRetryAt = undefined;
        return;
      }
      endpoint.identity = 'mismatch';
      // R19 (round 4): a disabled endpoint's height stops counting at once; #best and
      // #highest are rebuilt from identity-verified endpoints with known heights only. I2:
      // never below a verified peak, even while a verified endpoint's height is unknown.
      endpoint.height = undefined;
      this.#best = this.#verifiedMaxHeight();
      this.#highest = maxHeight(this.#verifiedPeak, this.#best);
      this.#events.emit('provider.misconfigured', {
        transportId: this.id,
        endpointId: endpoint.id,
        expected: sanitizeIdentityField(expected),
        actual: sanitizeIdentityField(String(actual)),
      });
      this.#log.warn('endpoint serves a different network; disabled', {
        endpointId: endpoint.id,
      });
    } catch (error) {
      // Any probe failure (a definitive RPC error, a transport error, a malformed reply) is
      // an endpoint-local failure, not a confirmed mismatch: identity stays 'unchecked' and
      // the endpoint fails over (I6a).
      // N2 (round 2, item 4): a caller abort is not a probe failure — it must not set the
      // throttle, or a single-endpoint transport could be locked out entirely.
      const callerAborted = signal.aborted && signal.reason !== TIMEOUT;
      if (!callerAborted) {
        endpoint.identityRetryAt = this.#clock.now() + this.#opts.healthIntervalMs;
      }
      const failure = this.#identityProbeFailed(endpoint, error, signal);
      if (callerAborted) this.#abandonedChecks.add(failure);
      throw failure;
    }
  }

  /** An identity probe failure as a retryable, sanitized, untagged endpoint-local error. */
  #identityProbeFailed(
    endpoint: Endpoint,
    error: unknown,
    signal: AbortSignal,
  ): ProviderError {
    return new ProviderError(
      'PROVIDER_UNAVAILABLE',
      `identity probe failed for endpoint '${endpoint.id}'`,
      {
        context: this.#context(endpoint),
        cause: this.#classify(error, endpoint, signal),
      },
    );
  }

  async #refresh(): Promise<void> {
    const probe = this.#probes.height;
    const identityProbed = this.#identityProbed();
    const targets = this.#endpoints.filter((e) => e.identity !== 'mismatch');
    // I8 round 2: only a refresh where at least one endpoint's probe(s) actually succeeded
    // counts as fresh (see #lastHealthAt below).
    let anySucceeded = false;
    // #4 (round 4): set when an endpoint was not really attempted (see #abandonedChecks).
    let anyAbandoned = false;
    await Promise.all(
      targets.map(async (endpoint) => {
        // I8: the shared run is never bound to any single caller's signal; each probe only
        // ever times out against its own deadline.
        const { signal: deadline, cancel } = this.#deadline(
          endpoint.timeoutMs ?? this.#opts.timeoutMs,
        );
        try {
          if (identityProbed) {
            // R18/item 2 (round 3): a throttled identity probe is skipped here entirely
            // rather than re-attempted and left to #ensureIdentity's own internal throttle
            // check to reject — there's no traffic behind a throttle hit, so nothing should
            // even look like an attempt.
            const identityThrottled =
              endpoint.identityRetryAt !== undefined &&
              this.#clock.now() < endpoint.identityRetryAt;
            if (!identityThrottled) await this.#ensureIdentity(endpoint, deadline);
            // R19 (round 4): only an endpoint verified 'ok' in this refresh is height-probed
            // and feeds #best/#highest/lag/anySucceeded. A throttled or still-unchecked one
            // is cleared and does not count as succeeded.
            if (endpoint.identity !== 'ok') {
              endpoint.height = undefined;
              return;
            }
          }
          if (probe) {
            endpoint.height = await raceAbort(
              probe(this.#direct(endpoint, deadline)),
              deadline,
            );
          }
          anySucceeded = true;
        } catch (error) {
          // I8 round 2 / R19: a failed identity or height probe clears the stored height
          // instead of leaving it stale, so the endpoint counts as unknown.
          endpoint.height = undefined;
          if (this.#abandonedChecks.has(error as object)) anyAbandoned = true;
          // R18 (round 3): #refresh never does breaker bookkeeping — no onAttempt, onSuccess,
          // onFailure or onAbandon. A probe failure here only affects height/identity state,
          // never endpoint.breaker or endpoint.failures. The breaker tracks request traffic.
        } finally {
          cancel();
        }
      }),
    );
    // R19 (round 4): monotonic only among identity-verified endpoints.
    const best = this.#verifiedMaxHeight();
    if (best !== undefined) {
      this.#best = best;
      this.#highest = maxHeight(this.#highest, best);
      // I2: with an identity probe, `best` came from identity-verified endpoints only.
      if (this.#identityProbed())
        this.#verifiedPeak = maxHeight(this.#verifiedPeak, best);
    }
    for (const status of this.status()) {
      // 'half-open' has no matching value in the provider.health event payload; 'unknown'
      // is likewise not worth reporting.
      if (status.state === 'unknown' || status.state === 'half-open') continue;
      this.#events.emit('provider.health', {
        transportId: this.id,
        endpointId: status.id,
        state: status.state,
        ...(status.height !== undefined ? { height: status.height.toString() } : {}),
        ...(status.lag !== undefined ? { lag: status.lag.toString() } : {}),
      });
    }
    // I8: only a completed refresh counts as fresh; #healthRun's `finally` clears the
    // in-flight marker regardless, but the staleness clock only advances here.
    // I8 round 2: if every endpoint's probe(s) failed, #lastHealthAt is left unset (rather
    // than stamped) so the next ensureFreshHealth call probes again instead of trusting a
    // fully-failed refresh as fresh for a whole healthIntervalMs.
    // #3 (round 3): but an immediate re-probe on every read during an outage is its own
    // storm, so a fully-failed refresh instead sets a short backoff.
    // #4 (round 4): a refresh with an endpoint left unattempted (a joined identity check its
    // caller aborted) never arms the backoff, so the next read re-probes it.
    if (anySucceeded) {
      this.#lastHealthAt = this.#clock.now();
    } else if (!anyAbandoned) {
      this.#nextRefreshAt =
        this.#clock.now() + Math.min(this.#opts.healthIntervalMs, 1_000);
    }
  }

  // ---- errors ----------------------------------------------------------------------

  #context(endpoint: Endpoint): { transportId: string; endpointId: string } {
    return { transportId: this.id, endpointId: endpoint.id };
  }

  /** Replaces the endpoint URL and header values with placeholders, then redacts URLs. */
  #scrub(endpoint: Endpoint, text: string): string {
    let out = text;
    for (const value of endpoint.secrets)
      out = out
        .split(value)
        .join(
          value === endpoint.url || value.startsWith('http')
            ? `<${endpoint.id}>`
            : REDACTED,
        );
    return redactText(out);
  }

  #classify(error: unknown, endpoint: Endpoint, signal: AbortSignal): CryptoAioError {
    const context = this.#context(endpoint);
    if (isCryptoAioError(error))
      return error.context.endpointId ? error : withContext(error, context);
    if (signal.aborted && signal.reason === TIMEOUT) {
      return this.#markSent(
        new TimeoutError('TIMEOUT', `request to endpoint '${endpoint.id}' timed out`, {
          context,
        }),
      );
    }
    const inner =
      error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const clean = new Error(
      this.#scrub(endpoint, inner instanceof Error ? inner.message : String(inner)),
    );
    clean.name = inner instanceof Error ? inner.name : 'Error';
    clean.stack = `${clean.name}: ${clean.message}`;
    // I4: a raw (non-CryptoAioError) throw from fetch is a network error after the call.
    return this.#markSent(
      new ProviderError(
        'PROVIDER_UNAVAILABLE',
        `request to endpoint '${endpoint.id}' failed: ${clean.message}`,
        { context, cause: clean },
      ),
    );
  }

  /** I4: tags an error as "the attempt may have reached the network", for ambiguity tracking. */
  #markSent<E extends CryptoAioError>(error: E): E {
    this.#maybeDelivered.add(error);
    return error;
  }
}

/** The higher of two optional heights. */
function maxHeight(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  return b !== undefined && b > a ? b : a;
}
