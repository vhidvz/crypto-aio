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
import { parseJson, quorumJson } from '../util/json';
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
/** P25-R22: the counted endpoints' verdict: agreeing answers, or one refusal they all gave. */
type Decided<T> =
  | { readonly results: readonly { readonly endpoint: Endpoint; readonly value: T }[] }
  | { readonly refusal: CryptoAioError; readonly endpoints: readonly Endpoint[] };
/** P25-R22: what a recovering endpoint's trial request came back with. */
type TrialOutcome<T> =
  | { readonly endpoint: Endpoint; readonly kind: 'answer'; readonly value: T }
  | { readonly endpoint: Endpoint; readonly kind: 'refusal' | 'failed' };

const MAX_RETRY_AFTER_MS = 60_000;
/** A24/P25-R8: consecutive failed health refreshes (identity or height probe, or, P25-R21,
 * failing requests) after which an endpoint stops counting toward a proof quorum's size (a
 * sustained outage, not a hiccup). */
const HEALTH_MISS_LIMIT = 3;
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
  /** A24/P25-R8: health refreshes in a row whose identity or height probe failed, or
   * (P25-R21) that found the endpoint's requests failing; 0 once a refresh's probes succeed
   * while its requests do not fail (a caller-aborted identity check is neither, N1). */
  healthMisses: number;
  /** P25-R10/I2: when the last counted miss was recorded; at most one counts per interval. */
  lastMissAt?: number;
  latencyMs?: number;
  failures: number;
  /** P25-R6/M1: tokens this endpoint's probes have taken from its bucket, ever. */
  probeTokens: number;
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

/**
 * Whether every quorum result matches the first under `quorumJson`, compared whole or, with
 * a `quorumKey`, on the key's projection. M2: a key that throws (or projects something
 * `quorumJson` rejects) counts as a disagreement, never a foreign error. P25-R21/M1:
 * `quorumJson`, not `canonicalJson`, so an object shaped like a bigint tag never agrees with
 * a revived bigint.
 */
function quorumAgrees(
  values: readonly unknown[],
  quorumKey: ((result: unknown) => unknown) | undefined,
): boolean {
  const agree = (key: (value: unknown) => string): boolean => {
    const expected = key(values[0]);
    return values.every((value) => key(value) === expected);
  };
  if (!quorumKey) return agree(quorumJson);
  try {
    return agree((value) => quorumJson(quorumKey(value)));
  } catch {
    return false;
  }
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
  /** P25-R10: identity-check failures caused by the owning request's own deadline (possibly
   * a caller-shortened `timeoutMs`); a refresh that joined one learned nothing under its
   * own deadline, so it is no health miss. */
  readonly #timedOutChecks = new WeakSet<object>();
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
  /** P25-R23, P25-R25: set as a trial answers or refuses (its breaker closed), so the next
   * health check refreshes at once and the endpoint rejoins the count by the ordinary rules.
   * A refresh clears it when it starts, so one already running when the flag was set (and
   * which may have read the breaker before it closed) does not count. */
  #refreshDue = false;
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
        healthMisses: 0,
        failures: 0,
        probeTokens: 0,
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
      this.#rpcOnce<T>(endpoint, method, id, body, signal, options.exactIntegers),
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
        label,
        options.exactIntegers,
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
      (endpoint, signal) =>
        this.#httpOnce<T>(endpoint, request, bodyText, signal, options.exactIntegers),
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
      endpoint.healthMisses = 0;
      endpoint.lastMissAt = undefined;
    }
  }

  async ensureFreshHealth(signal?: AbortSignal): Promise<void> {
    if (!this.#probes.height && !this.#probes.identity) return;
    // I8: an in-flight refresh is awaited before the staleness check, so a second concurrent
    // caller can't slip through and read endpoint state mid-refresh (e.g. heights still
    // unset). This caller's own signal is raced against it; the shared run itself is not
    // cancelled by it.
    if (this.#healthRun) await this.#join(this.#healthRun, signal);
    if (!this.#refreshDue) {
      if (this.#clock.now() - this.#lastHealthAt < this.#opts.healthIntervalMs) return;
      // #3 (round 3): after a fully-failed refresh, back off until #nextRefreshAt instead
      // of re-probing every down endpoint on every read during an outage. Reads in this
      // window simply see no fresh health and proceed with the existing
      // no-eligible-endpoint semantics.
      if (this.#clock.now() < this.#nextRefreshAt) return;
    }
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
    // P25-R10/I3: a proof quorum under purpose 'read' counts endpoints by health too, so it
    // keeps health fresh as well; otherwise a dead endpoint would never miss and stall it.
    if (purpose === 'monitor' || purpose === 'proof' || options.quorum === 'proof')
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
    const proof = isProofQuorum(purpose, options);
    const { sized, inRange } = this.#quorumCandidates(purpose, proof);
    // P25-R22: only the endpoints the quorum counts answer toward it. A recovering endpoint
    // (out of the count, its breaker half-open) is tried alongside them, from the start, so
    // it is tried even when too few counted endpoints can answer; its answer only blocks.
    const counted: ReadonlySet<Endpoint> = new Set(sized);
    const trial = proof ? this.#trial(label, inRange, counted, options, work) : undefined;
    let decided: Decided<T>;
    try {
      decided = await this.#decide(label, purpose, proof, counted, options, work);
    } catch (error) {
      await trial;
      throw error;
    }
    const outcome = await trial;
    // The caller aborted while the trial ran: the read ends as any aborted read does.
    if (options.signal?.aborted) throw options.signal.reason;
    if (outcome && outcome.kind !== 'failed') {
      const agrees =
        outcome.kind === 'answer' &&
        'results' in decided &&
        quorumAgrees(
          [...decided.results.map((r) => r.value), outcome.value],
          options.quorumKey,
        );
      if (!agrees) {
        const asked =
          'results' in decided
            ? decided.results.map((r) => r.endpoint)
            : decided.endpoints;
        throw this.#inconsistent(
          label,
          [...asked, outcome.endpoint].map((e) => e.id),
        );
      }
    }
    if ('refusal' in decided) throw decided.refusal;
    return (decided.results[0] as { readonly value: T }).value;
  }

  /**
   * The counted endpoints' verdict (P25-R22: no other endpoint answers toward it): their
   * agreeing answers, or the definitive error they all returned alike (P25-R10). Anything
   * else throws: too few answers, a disagreement, or (outside a proof quorum) the first
   * definitive error.
   */
  async #decide<T>(
    label: string,
    purpose: RequestPurpose,
    proof: boolean,
    counted: ReadonlySet<Endpoint>,
    options: CallOptions,
    work: Work<T>,
  ): Promise<Decided<T>> {
    const requested =
      options.quorum === 'proof' ? this.#opts.proofQuorum : (options.quorum ?? 1);
    // N3 (round 2, item 5): sized from the full candidate set, not the rate-limit-filtered
    // eligible set — a required endpoint being rate-limited must not silently shrink the
    // quorum. A required endpoint that's rate-limited therefore fails the call with a
    // retryable error instead of resolving from fewer endpoints than needed.
    // A14/P25-R8/P25-R9: nor may lag, an unknown height, an unconfirmed identity or an open
    // breaker shrink a proof quorum (#quorumCandidates), so one liar is never alone.
    const needed = Math.max(1, Math.min(requested, counted.size));
    const eligible = (): Endpoint[] => {
      const now = this.#clock.now();
      return this.#quorumCandidates(purpose, proof).inRange.filter(
        (e) => e.notBefore <= now && counted.has(e),
      );
    };
    // #5 (round 3): if fewer endpoints are eligible right now than needed, fail fast —
    // before querying any of them — instead of querying what's available and discovering
    // the shortfall only afterward. A14: this is also where lag that leaves too few
    // endpoints decides nothing (retryable).
    if (eligible().length < needed) {
      throw this.#externalize(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `quorum of ${needed} not reachable for ${label}`,
          { context: { transportId: this.id } },
        ),
      );
    }
    const results: { endpoint: Endpoint; value: T }[] = [];
    // P25-R10: under a proof quorum, one endpoint's definitive error is its answer, not
    // yet the quorum's: it is kept, and the other endpoints are still asked.
    const refusals: { endpoint: Endpoint; error: CryptoAioError }[] = [];
    const tried = new Set<string>();
    let last: CryptoAioError | undefined;
    while (results.length + refusals.length < needed) {
      const endpoint = eligible().find((e) => !tried.has(e.id));
      if (!endpoint) break;
      tried.add(endpoint.id);
      try {
        results.push({
          endpoint,
          value: await this.#attempt(endpoint, label, tried.size - 1, options, work),
        });
      } catch (error) {
        const { failure, definitive } = this.#endpointFailure(error, options);
        if (!definitive) last = failure;
        else if (proof) refusals.push({ endpoint, error: failure });
        else throw failure;
      }
    }
    if (results.length + refusals.length < needed) {
      throw this.#externalize(
        last ??
          new ProviderError(
            'PROVIDER_UNAVAILABLE',
            `quorum of ${needed} not reachable for ${label}`,
            { context: { transportId: this.id } },
          ),
      );
    }
    const [refusal] = refusals;
    if (refusal) {
      // P25-R10: a definitive error decides only when every endpoint of the quorum returned
      // an equivalent one; a refusal against an answer, or unlike refusals, decide nothing.
      if (
        results.length === 0 &&
        refusals.every((r) => sameRefusal(r.error, refusal.error))
      ) {
        return { refusal: refusal.error, endpoints: refusals.map((r) => r.endpoint) };
      }
      throw this.#inconsistent(
        label,
        [...results, ...refusals].map((r) => r.endpoint.id),
      );
    }
    if (
      results.length === 0 ||
      !quorumAgrees(
        results.map((r) => r.value),
        options.quorumKey,
      )
    ) {
      throw this.#inconsistent(
        label,
        results.map((r) => r.endpoint.id),
      );
    }
    return { results };
  }

  /**
   * P25-R22: the trial of a recovering endpoint, one per read: among the in-range endpoints
   * the quorum does not count (health misses) whose breaker is half-open, the first by
   * priority, then name. Its request is an ordinary attempt (its rate limit, identity check
   * and breaker bookkeeping, so an answer closes the breaker and a failure counts against
   * it), except that it never waits for a rate-limit token (P25-R23): with none free now,
   * it is not sent this read (a failure). The read waits for a trial it sent, up to the
   * call's timeout. Each concurrent proof read in a half-open window may send its own
   * trial. Never rejects: the outcome is an answer, a refusal (a definitive error) or a
   * failure, which the verdict ignores.
   */
  #trial<T>(
    label: string,
    inRange: readonly Endpoint[],
    counted: ReadonlySet<Endpoint>,
    options: CallOptions,
    work: Work<T>,
  ): Promise<TrialOutcome<T>> | undefined {
    const now = this.#clock.now();
    const [endpoint] = inRange
      .filter(
        (e) => !counted.has(e) && e.breaker.state === 'half-open' && e.notBefore <= now,
      )
      .sort(
        (a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (!endpoint) return undefined;
    // P25-R23, P25-R25: an answer or a refusal closed the endpoint's breaker, so the next
    // health check refreshes at once and it rejoins the count by the ordinary rules. Set
    // here, as the trial settles, not when the read does: whatever becomes of the counted
    // endpoints (a failure, the caller's abort, a slow answer), no later read finds the
    // endpoint closed but still out of the count, so its veto never lapses.
    return this.#attempt(endpoint, label, 0, options, work, false).then(
      (value): TrialOutcome<T> => {
        this.#refreshDue = true;
        return { endpoint, kind: 'answer', value };
      },
      (error: unknown): TrialOutcome<T> => {
        const refused =
          !options.signal?.aborted && isCryptoAioError(error) && !error.retryable;
        if (refused) this.#refreshDue = true;
        return { endpoint, kind: refused ? 'refusal' : 'failed' };
      },
    );
  }

  /** A quorum whose endpoints disagree: a retryable `PROVIDER_INCONSISTENT`, announced. */
  #inconsistent(label: string, endpointIds: string[]): ProviderError {
    this.#events.emit('provider.inconsistent', {
      transportId: this.id,
      method: label,
      endpointIds,
    });
    return new ProviderError('PROVIDER_INCONSISTENT', `endpoints disagree on ${label}`, {
      context: { transportId: this.id },
    });
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
    /** P25-R23: false for a trial, which never waits for a rate-limit token. */
    waitForToken = true,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? endpoint.timeoutMs ?? this.#opts.timeoutMs;
    // A17: a first-use identity probe takes its own token (#direct), so it runs before this
    // request takes one: the probe and the request never leave back to back. When it fails,
    // the request takes no token, and the failure is thrown inside the `try` below, where
    // the check always ran, so its message, cause and breaker bookkeeping are unchanged.
    const identityFailure = await this.#identityFirst(
      endpoint,
      timeoutMs,
      options.signal,
    );
    // M3/#2 (round 2): the token-bucket wait runs before the per-attempt deadline is armed,
    // with its own timeoutMs-bounded budget. A wait that times out (or that the caller
    // aborts) never touches the breaker and is never tagged ambiguous — no fetch has
    // happened yet.
    if (identityFailure === undefined) {
      await this.#takeToken(endpoint, timeoutMs, options.signal, waitForToken);
    }
    const { signal, cancel } = this.#deadline(timeoutMs, options.signal);
    const started = this.#clock.now();
    // #8 (round 2): only set once THIS attempt's own onAttempt() call ran, so only this
    // attempt may release a half-open probe slot it actually claimed.
    let ownsProbe = false;
    try {
      if (identityFailure !== undefined) throw identityFailure;
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

  /**
   * A17: runs a pending first-use identity check under its own deadline, before the request
   * takes its token, and returns its failure (M2) for `#attempt` to throw where the check
   * always ran. Only the caller's abort propagates from here.
   */
  async #identityFirst(
    endpoint: Endpoint,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<unknown> {
    if (!this.#identityProbed() || endpoint.identity !== 'unchecked') return undefined;
    const { signal, cancel } = this.#deadline(timeoutMs, outer);
    try {
      await this.#ensureIdentity(endpoint, signal);
      return undefined;
    } catch (error) {
      if (outer?.aborted) throw outer.reason;
      return error;
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
    wait = true,
  ): Promise<void> {
    if (!endpoint.bucket) return;
    if (!wait) {
      // P25-R23: with no token free now, no wait: the same retryable RATE_LIMITED, before
      // any fetch or breaker bookkeeping.
      if (endpoint.bucket.tryTakeNow()) return;
      throw new ProviderError(
        'RATE_LIMITED',
        `no rate limit token free for endpoint '${endpoint.id}'`,
        { context: this.#context(endpoint) },
      );
    }
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
    // M4: a single proof read measures lag as a quorum read does, against the corroborated
    // height, so one over-reporting endpoint never leaves itself the only candidate.
    if (purpose === 'proof') return this.#quorumCandidates(purpose, true).inRange;
    const strict = purpose === 'monitor';
    return this.#usable().filter((e) => !strict || !this.#excludedForHeight(e));
  }

  /**
   * A quorum read's endpoints: `sized`, which the quorum's size counts, and `inRange`, the
   * only ones asked.
   *
   * `sized` (A14/A24, handoff N5; P25-R8, R9, R10, R11): for a proof quorum (`proof`, see
   * `isProofQuorum`) whose refreshes can see a dead endpoint (a height probe, or an
   * identity probe with an expected identity), every endpoint not proven mismatched,
   * whatever its height, identity state (confirmed, not yet checked or identity-throttled)
   * or breaker state, until `HEALTH_MISS_LIMIT` health refreshes in a row, at most one per
   * `healthIntervalMs`, failed its identity or height probe or (P25-R21) found its requests
   * failing (breaker not closed, or failures in a row at `failureThreshold`): a sustained
   * outage. Such an endpoint cannot be asked, so it makes the read decide nothing rather
   * than letting fewer endpoints decide it. It counts again once it serves requests and a
   * later refresh succeeds; meanwhile it never answers toward the quorum, and only its
   * half-open trial (P25-R22, `#trial`) can block a read. Otherwise (no such probe, or
   * another quorum) it is the usable endpoints (the prior, weaker rule).
   *
   * `inRange`: the usable endpoints (breaker, identity, throttle). For a monitor or proof
   * purpose with a height probe, only those with a known height (only a confirmed endpoint
   * has one, R19) at most `maxLagBlocks` behind the corroborated height, the second-highest
   * known height, so one endpoint that over-reports its head never marks honest ones as
   * lagging. With two known heights the corroborated height is the lower one, so the lag
   * filter excludes neither: it takes three endpoints to exclude a lagging one, and a proof
   * read should be anchored to a height (asked at an explicit block), so a lagging endpoint
   * disagrees or errs instead of answering for an older state.
   */
  #quorumCandidates(
    purpose: RequestPurpose,
    proof: boolean,
  ): {
    readonly sized: Endpoint[];
    readonly inRange: Endpoint[];
  } {
    const usable = this.#usable();
    // P25-R10/I1, P25-R11: when no refresh can see a dead endpoint (no probe, or only an
    // identity probe without an expected identity, where #refresh does no I/O), nothing
    // ever records a miss, so counting endpoints that cannot answer would stall proofs for
    // good; the count is then the usable endpoints (the prior, weaker rule: a liar can
    // prove alone once the honest endpoints' breakers open). Families set probes (R19).
    const sized =
      proof && (this.#probes.height !== undefined || this.#identityProbed())
        ? this.#endpoints.filter(
            (e) => e.identity !== 'mismatch' && e.healthMisses < HEALTH_MISS_LIMIT,
          )
        : usable;
    const strict = purpose === 'monitor' || purpose === 'proof';
    if (!strict || !this.#probes.height) return { sized, inRange: usable };
    const known = usable.filter((e) => e.height !== undefined);
    const reference = corroboratedHeight(known);
    const lag = BigInt(this.#opts.maxLagBlocks);
    const inRange =
      reference === undefined
        ? known
        : known.filter((e) => reference - (e.height as bigint) <= lag);
    return { sized, inRange };
  }

  /** Endpoints that pass the identity, identity-throttle and breaker filters, best first. */
  #usable(): Endpoint[] {
    const now = this.#clock.now();
    return this.#endpoints
      .filter(
        (e) =>
          e.identity !== 'mismatch' &&
          // N2 (round 2, item 4): an identity-throttled endpoint is excluded the same way a
          // rate-limited one is — never picked, and a throttle hit never reaches the breaker.
          (e.identityRetryAt === undefined || e.identityRetryAt <= now) &&
          e.breaker.canRequest(),
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
    exactIntegers = false,
  ): Promise<T> {
    const { json } = await this.#exchange(
      endpoint,
      method,
      this.#jsonPost(endpoint.url, body),
      signal,
      'rpc',
      method,
      exactIntegers,
    );
    return this.#unwrapRpc<T>(endpoint, method, id, json);
  }

  async #httpOnce<T>(
    endpoint: Endpoint,
    request: HttpRequest,
    bodyText: string | undefined,
    signal: AbortSignal,
    exactIntegers = false,
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
      exactIntegers,
    );
    return (mode === 'text' ? text : json) as T;
  }

  /**
   * The probes' single-attempt calls. A17: each request first takes a token from the
   * endpoint's own bucket, bounded by the probe's deadline (`signal`), so probes and
   * requests share one rate limit and a rate-limited endpoint never answers a probe 429.
   * The probe takes it with priority, ahead of requests already waiting (M1), so a queue of
   * requests never starves it past its deadline into an unknown height.
   */
  #direct(endpoint: Endpoint, signal: AbortSignal): EndpointCall {
    return {
      rpc: async <T>(method: string, params?: unknown) => {
        const id = ++this.#rpcId;
        const body = serializeJson({ jsonrpc: '2.0', id, method, params: params ?? [] });
        await this.#probeToken(endpoint, signal);
        return this.#rpcOnce<T>(endpoint, method, id, body, signal);
      },
      http: async <T>(request: HttpRequest) => {
        const bodyText =
          request.body === undefined
            ? undefined
            : typeof request.body === 'string'
              ? request.body
              : serializeJson(request.body);
        await this.#probeToken(endpoint, signal);
        return this.#httpOnce<T>(endpoint, request, bodyText, signal);
      },
    };
  }

  /** A17: a probe call's token, taken with priority; P25-R6/M1 counts it for #refresh. */
  async #probeToken(endpoint: Endpoint, signal: AbortSignal): Promise<void> {
    if (!endpoint.bucket) return;
    await endpoint.bucket.take(signal, true);
    endpoint.probeTokens += 1;
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
    exactIntegers = false,
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
        json = text.length > 0 ? parseJson(text, exactIntegers) : null;
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
              typeof rawData === 'string' ? rawData : stringifyData(rawData),
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
      this.#disable(endpoint, expected, actual);
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
      else if (signal.aborted) this.#timedOutChecks.add(failure);
      throw failure;
    }
  }

  /**
   * P25-R10/I2: records a genuine failed health refresh, at most one per `healthIntervalMs`,
   * so a caller that refreshes often (`refreshHealth`, `getNetworkStatus`) never turns one
   * hiccup into three misses and the endpoint's exclusion from a proof quorum's count.
   */
  #recordMiss(endpoint: Endpoint): void {
    const now = this.#clock.now();
    if (
      endpoint.lastMissAt !== undefined &&
      now - endpoint.lastMissAt < this.#opts.healthIntervalMs
    ) {
      return;
    }
    endpoint.healthMisses += 1;
    endpoint.lastMissAt = now;
  }

  /**
   * P25-R21/I1: whether the endpoint's requests are failing: its circuit breaker is not
   * closed (open or half-open), or its consecutive request failures reached the breaker's
   * `failureThreshold`. Read only; `#refresh` still never does breaker bookkeeping (R18).
   */
  #failingRequests(endpoint: Endpoint): boolean {
    return (
      endpoint.breaker.state !== 'closed' ||
      endpoint.failures >= this.#opts.failureThreshold
    );
  }

  /** A proven identity mismatch: the endpoint serves a different network and is disabled. */
  #disable(endpoint: Endpoint, expected: string, actual: unknown): void {
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
  }

  /**
   * P25-R10/I1: with no height probe, the identity probe is a confirmed endpoint's only
   * health signal, so `#refresh` re-runs it (under the refresh's own deadline), or a dead
   * endpoint would never miss and a proof quorum would count it for good. A different
   * answer disables the endpoint as a first check does; a failure is a health miss only,
   * never an identity throttle, so a confirmed endpoint stays in service for requests.
   */
  async #reconfirmIdentity(endpoint: Endpoint, signal: AbortSignal): Promise<void> {
    const probe = this.#probes.identity;
    const expected = this.#probes.expectedIdentity;
    if (!probe || expected === undefined) return;
    const actual = await raceAbort(probe(this.#direct(endpoint, signal)), signal);
    if (actual !== expected) this.#disable(endpoint, expected, actual);
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
    this.#refreshDue = false;
    const probe = this.#probes.height;
    const identityProbed = this.#identityProbed();
    const targets = this.#endpoints.filter((e) => e.identity !== 'mismatch');
    const tokensBefore = targets.map((e) => e.probeTokens);
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
            // P25-R10/I1: with no height probe, a confirmed identity is re-probed as the
            // endpoint's health signal. A skipped (throttled) one is neither a miss nor a
            // success.
            if (!identityThrottled) {
              if (!probe && endpoint.identity === 'ok')
                await this.#reconfirmIdentity(endpoint, deadline);
              else await this.#ensureIdentity(endpoint, deadline);
            }
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
          // P25-R8: identity and height failures feed one counter, which a refresh whose
          // probes all succeeded (with no height probe, the identity alone) resets.
          // P25-R21/I1: unless the endpoint's requests fail: then its answered probes are a
          // miss too, so an endpoint that answers probes but no request leaves a proof
          // quorum's count as a probe-dead one does, while a shorter outage still counts.
          if (this.#failingRequests(endpoint)) {
            this.#recordMiss(endpoint);
          } else {
            endpoint.healthMisses = 0;
            endpoint.lastMissAt = undefined;
          }
          anySucceeded = true;
        } catch (error) {
          // I8 round 2 / R19: a failed identity or height probe clears the stored height
          // instead of leaving it stale, so the endpoint counts as unknown.
          endpoint.height = undefined;
          // A24/N1, P25-R10: only a failure under this refresh's own deadline is a miss. A
          // joined identity check that its request's caller aborted, or that the request's
          // own (possibly caller-shortened) deadline ended while this refresh's had not,
          // learned nothing here, so it counts as not attempted. The height probe itself
          // runs only under this refresh's own deadline (I8).
          const foreign =
            this.#abandonedChecks.has(error as object) ||
            (this.#timedOutChecks.has(error as object) && !deadline.aborted);
          if (foreign) anyAbandoned = true;
          else this.#recordMiss(endpoint);
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
    // P25-R6/M1: the backoff is floored at the time each endpoint's bucket needs to refill
    // the tokens this refresh's probes took from it plus one, so repeated failing probes
    // (which take their tokens with priority) never take every token of a slow bucket. The
    // extra token keeps a window where only requests may take one: without it, a refresh
    // that starts as a token refills ties with the requests waiting for it.
    if (anySucceeded) {
      this.#lastHealthAt = this.#clock.now();
    } else if (!anyAbandoned) {
      let refillMs = 0;
      targets.forEach((e, i) => {
        const taken = e.probeTokens - (tokensBefore[i] ?? e.probeTokens);
        if (e.bucket && taken > 0)
          refillMs = Math.max(refillMs, e.bucket.refillMs(taken + 1));
      });
      this.#nextRefreshAt =
        this.#clock.now() +
        Math.max(Math.min(this.#opts.healthIntervalMs, 1_000), refillMs);
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

/**
 * A12: JSON-RPC error data as text; a revived `bigint` is written as a decimal string, and
 * a top-level one as its bare digits, as a plain number would be.
 */
function stringifyData(data: unknown): string {
  if (typeof data === 'bigint') return data.toString();
  return JSON.stringify(data, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/**
 * P25-R10/I3: whether a quorum read is held to the proof rules (P25-R8/R9 sizing, and a
 * definitive error decides only when the whole quorum returns it alike): every
 * `quorum: 'proof'` read, whatever its purpose (EVM token metadata is read under 'read'
 * and cached), and any quorum read under a monitor or proof purpose.
 */
function isProofQuorum(purpose: RequestPurpose, options: CallOptions): boolean {
  return options.quorum === 'proof' || purpose === 'monitor' || purpose === 'proof';
}

/**
 * P25-R10, P25-R21/I2: whether two definitive errors are the same answer: the same code, the
 * same HTTP status (`details.status`) and the same JSON-RPC code (`details.rpcCode`), each
 * possibly absent from both, and for an implementation-defined JSON-RPC code, the same
 * message text (`details.rpcMessage`). Anything else is a different answer. Only this
 * boolean leaves here: no message text reaches an error, event or log.
 */
function sameRefusal(a: CryptoAioError, b: CryptoAioError): boolean {
  const left = a.details ?? {};
  const right = b.details ?? {};
  if (
    a.code !== b.code ||
    left.status !== right.status ||
    left.rpcCode !== right.rpcCode
  ) {
    return false;
  }
  return !implementationDefined(left.rpcCode) || left.rpcMessage === right.rpcMessage;
}

/**
 * P25-R21/I2: a JSON-RPC error code whose meaning each server defines (-32000 to -32099, and
 * -32603, "internal error"), so one code can stand for unlike errors, such as a revert and
 * a missing header.
 */
function implementationDefined(code: unknown): boolean {
  return (
    typeof code === 'number' && ((code <= -32000 && code >= -32099) || code === -32603)
  );
}

/** A14: the highest height at least two endpoints have reached (the second-highest). */
function corroboratedHeight(endpoints: readonly Endpoint[]): bigint | undefined {
  const heights = endpoints
    .map((e) => e.height)
    .filter((h): h is bigint => h !== undefined)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return heights[1];
}

/** The higher of two optional heights. */
function maxHeight(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  if (a === undefined) return b;
  return b !== undefined && b > a ? b : a;
}
