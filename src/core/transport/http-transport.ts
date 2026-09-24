import {
  ConfigError,
  ProviderError,
  TimeoutError,
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
  readonly #clock: Clock;
  readonly #events: EventBus;
  readonly #log: Logger;
  readonly #random: () => number;
  #probes: HealthProbes = {};
  #best: bigint | undefined;
  #highest: bigint | undefined;
  #lastHealthAt = Number.NEGATIVE_INFINITY;
  #healthRun: Promise<void> | undefined;
  #rpcId = 0;

  constructor(endpoints: readonly EndpointConfig[], deps: HttpTransportDeps) {
    if (endpoints.length === 0) {
      throw new ConfigError('CONFIG_INVALID', 'a transport needs at least one endpoint');
    }
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
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.headers ?? {}))
        headers[name] = reveal(value);
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
        failures: 0,
      };
    });
  }

  rpc<T = unknown>(
    method: string,
    params: unknown = [],
    options: CallOptions = {},
  ): Promise<T> {
    return this.#run(method, options, (endpoint, signal) =>
      this.#rpcOnce<T>(endpoint, method, params, signal),
    );
  }

  rpcRaw(payload: unknown, options: CallOptions = {}): Promise<unknown> {
    const label = rpcLabel(payload);
    return this.#run(label, options, async (endpoint, signal) => {
      const { json } = await this.#exchange(
        endpoint,
        label,
        {
          method: 'POST',
          url: endpoint.url,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        signal,
        'rpc',
      );
      return json;
    });
  }

  http<T = unknown>(request: HttpRequest, options: CallOptions = {}): Promise<T> {
    return this.#run(
      routeLabel(request.method, request.route),
      options,
      (endpoint, signal) => this.#httpOnce<T>(endpoint, request, signal),
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
      const url = new URL(raw);
      if (url.origin !== PLACEHOLDER_ORIGIN) {
        throw new ConfigError(
          'CONFIG_INVALID',
          'bridged fetch accepts only transport placeholder URLs',
        );
      }
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = init?.body ?? undefined;
      // Bridged SDK calls have no route template; the raw path never becomes an event label.
      const label = method;
      const options = classify?.(url, init) ?? {};
      const signal = init?.signal ?? options.signal;
      return this.#run(
        label,
        { ...options, ...(signal ? { signal } : {}) },
        async (endpoint, deadline) => {
          const headers = new Headers(init?.headers);
          for (const [name, value] of Object.entries(endpoint.headers))
            headers.set(name, value);
          const started = this.#clock.now();
          const response = await this.#fetch(
            joinUrl(endpoint.url, url.pathname, url.search),
            {
              method,
              headers,
              ...(body !== undefined ? { body } : {}),
              signal: deadline,
              redirect: 'error',
            },
          );
          this.#throwForStatus(endpoint, response);
          this.#events.emit('rpc.response', {
            transportId: this.id,
            endpointId: endpoint.id,
            method: label,
            latencyMs: this.#clock.now() - started,
            bytes: Number(response.headers.get('content-length') ?? 0),
          });
          return response;
        },
      );
    };
    return bridged as typeof fetch;
  }

  setProbes(probes: HealthProbes): void {
    this.#probes = probes;
  }

  async ensureFreshHealth(signal?: AbortSignal): Promise<void> {
    if (!this.#probes.height && !this.#probes.identity) return;
    if (this.#clock.now() - this.#lastHealthAt < this.#opts.healthIntervalMs) return;
    await this.refreshHealth(signal);
  }

  refreshHealth(signal?: AbortSignal): Promise<void> {
    this.#healthRun ??= this.#refresh(signal).finally(() => {
      this.#healthRun = undefined;
    });
    return this.#healthRun;
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
    for (let attempt = 0; attempt < attempts; attempt++) {
      let endpoint: Endpoint;
      try {
        endpoint = this.#pick(purpose, tried);
      } catch (error) {
        if (last) break;
        throw error;
      }
      tried.add(endpoint.id);
      try {
        return await this.#attempt(endpoint, label, attempt, options, work);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failure = error as CryptoAioError;
        if (!failure.retryable) throw failure;
        last = failure;
        if (attempt + 1 < attempts)
          await this.#clock.sleep(this.#delay(attempt, failure), options.signal);
      }
    }
    throw this.#finalize(last as CryptoAioError, retry);
  }

  async #quorum<T>(
    label: string,
    purpose: RequestPurpose,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const requested =
      options.quorum === 'proof' ? this.#opts.proofQuorum : (options.quorum ?? 1);
    const needed = Math.max(1, Math.min(requested, this.#eligible(purpose).length));
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
        if (options.signal?.aborted) throw error;
        const failure = error as CryptoAioError;
        if (!failure.retryable) throw failure;
        last = failure;
      }
    }
    const first = results[0];
    if (!first || results.length < needed) {
      throw (
        last ??
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `quorum of ${needed} not reachable for ${label}`,
          {
            context: { transportId: this.id },
          },
        )
      );
    }
    const expected = canonicalJson(first.value);
    if (results.some((r) => canonicalJson(r.value) !== expected)) {
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
    if (targets.length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'no healthy endpoint available', {
        context: { transportId: this.id },
      });
    }
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
    const definitive = errors.find((e) => !e.retryable);
    if (definitive) throw definitive;
    throw this.#finalize(errors[0] as CryptoAioError, options.retry ?? 'safe');
  }

  async #attempt<T>(
    endpoint: Endpoint,
    label: string,
    attempt: number,
    options: CallOptions,
    work: Work<T>,
  ): Promise<T> {
    const { signal, cancel } = this.#deadline(
      options.timeoutMs ?? endpoint.timeoutMs ?? this.#opts.timeoutMs,
      options.signal,
    );
    const started = this.#clock.now();
    try {
      await this.#ensureIdentity(endpoint, signal);
      await endpoint.bucket?.take(signal);
      endpoint.breaker.onAttempt();
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
      if (options.signal?.aborted) throw options.signal.reason;
      const failure = this.#classify(error, endpoint, signal);
      if (failure.retryable) {
        endpoint.breaker.onFailure();
        endpoint.failures += 1;
      } else {
        endpoint.breaker.onSuccess();
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

  #eligible(purpose: RequestPurpose): Endpoint[] {
    const strict = purpose === 'monitor' || purpose === 'proof';
    return this.#endpoints
      .filter(
        (e) =>
          e.identity !== 'mismatch' &&
          e.breaker.canRequest() &&
          (!strict || !this.#lagging(e)),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.failures - b.failures ||
          (a.latencyMs ?? 0) - (b.latencyMs ?? 0),
      );
  }

  #pick(purpose: RequestPurpose, tried: ReadonlySet<string>): Endpoint {
    const eligible = this.#eligible(purpose);
    if (eligible.length === 0) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'no healthy endpoint available', {
        context: { transportId: this.id },
      });
    }
    const untried = eligible.filter((e) => !tried.has(e.id));
    const pool = untried.length > 0 ? untried : eligible;
    return (
      pool.find((e) => !e.bucket || e.bucket.msUntilToken() === 0) ??
      (pool[0] as Endpoint)
    );
  }

  #lagging(endpoint: Endpoint): boolean {
    return (
      endpoint.height !== undefined &&
      this.#best !== undefined &&
      this.#best - endpoint.height > BigInt(this.#opts.maxLagBlocks)
    );
  }

  #delay(attempt: number, failure: CryptoAioError): number {
    const retryAfter = failure.details?.retryAfterMs;
    if (typeof retryAfter === 'number') return Math.min(retryAfter, MAX_RETRY_AFTER_MS);
    return backoffDelay(attempt, this.#opts, this.#random);
  }

  #finalize(error: CryptoAioError, retry: RetryClass): CryptoAioError {
    return retry === 'ambiguous-on-failure' && error.retryable
      ? withContext(error, {}, { ambiguous: true })
      : error;
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

  async #rpcOnce<T>(
    endpoint: Endpoint,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<T> {
    const id = ++this.#rpcId;
    const { json } = await this.#exchange(
      endpoint,
      method,
      {
        method: 'POST',
        url: endpoint.url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      },
      signal,
      'rpc',
    );
    return this.#unwrapRpc<T>(endpoint, method, id, json);
  }

  async #httpOnce<T>(
    endpoint: Endpoint,
    request: HttpRequest,
    signal: AbortSignal,
  ): Promise<T> {
    const query = request.query
      ? new URLSearchParams({ ...request.query }).toString()
      : '';
    const hasBody = request.body !== undefined;
    const bodyText =
      typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
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
      rpc: <T>(method: string, params?: unknown) =>
        this.#rpcOnce<T>(endpoint, method, params ?? [], signal),
      http: <T>(request: HttpRequest) => this.#httpOnce<T>(endpoint, request, signal),
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
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            `endpoint returned a non-JSON body (HTTP ${response.status})`,
            {
              context,
            },
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
          // not a definitive protocol answer: retry and fail over (I6b).
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            `${errorLabel} did not return a JSON-RPC envelope (HTTP ${response.status})`,
            { context },
          );
        }
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
    this.#events.emit('rpc.response', {
      transportId: this.id,
      endpointId: endpoint.id,
      method: label,
      latencyMs: this.#clock.now() - started,
      bytes: new TextEncoder().encode(text).length,
    });
    return { text, json };
  }

  #throwForStatus(endpoint: Endpoint, response: Response): void {
    const context = this.#context(endpoint);
    const status = response.status;
    if (status === 408) {
      // Retryable in every mode (I6b): a request timeout is an endpoint-local failure.
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'endpoint request timed out (HTTP 408)',
        { context },
      );
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get('retry-after'),
        this.#clock.now(),
      );
      throw new ProviderError('RATE_LIMITED', 'endpoint rate limited (HTTP 429)', {
        context,
        ...(retryAfterMs !== undefined ? { details: { retryAfterMs } } : {}),
      });
    }
    if (status === 401 || status === 403) {
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
      throw new ProviderError('PROVIDER_UNAVAILABLE', `endpoint error (HTTP ${status})`, {
        context,
      });
    }
  }

  #unwrapRpc<T>(endpoint: Endpoint, method: string, id: number, json: unknown): T {
    const context = this.#context(endpoint);
    // Step 1: the body must be an object.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        `malformed JSON-RPC response to ${method}`,
        { context },
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
    // failure, not a definitive protocol answer: retry and fail over (I5).
    if (!idMatches || (hasResult && hasError) || (!hasResult && !hasError)) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        `invalid JSON-RPC envelope for ${method}`,
        { context },
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
        throw new ProviderError('RATE_LIMITED', `endpoint rate limited ${method}`, {
          context,
          details,
        });
      }
      throw new ProviderError('RPC_ERROR', `${method} failed: ${message}`, {
        context,
        details,
      });
    }
    return body.result as T;
  }

  // ---- health ----------------------------------------------------------------------

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
      endpoint.identityCheck ??= (async () => {
        try {
          const actual = await probe(this.#direct(endpoint, signal));
          if (actual === expected) {
            endpoint.identity = 'ok';
            endpoint.identityRetryAt = undefined;
            return;
          }
          endpoint.identity = 'mismatch';
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
          // Any probe failure (a definitive RPC error, a transport error, a malformed
          // reply) is an endpoint-local failure, not a confirmed mismatch: identity stays
          // 'unchecked' and the endpoint fails over (I6a).
          endpoint.identityRetryAt = this.#clock.now() + this.#opts.healthIntervalMs;
          const cause = this.#classify(error, endpoint, signal);
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            `identity probe failed for endpoint '${endpoint.id}'`,
            { context: this.#context(endpoint), cause },
          );
        } finally {
          endpoint.identityCheck = undefined;
        }
      })();
      await endpoint.identityCheck;
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

  async #refresh(signal?: AbortSignal): Promise<void> {
    this.#lastHealthAt = this.#clock.now();
    const probe = this.#probes.height;
    const targets = this.#endpoints.filter((e) => e.identity !== 'mismatch');
    await Promise.all(
      targets.map(async (endpoint) => {
        const { signal: deadline, cancel } = this.#deadline(
          endpoint.timeoutMs ?? this.#opts.timeoutMs,
          signal,
        );
        try {
          await this.#ensureIdentity(endpoint, deadline);
          if (probe) endpoint.height = await probe(this.#direct(endpoint, deadline));
        } catch (error) {
          if (signal?.aborted) return;
          const failure = this.#classify(error, endpoint, deadline);
          if (failure.code !== 'PROVIDER_MISCONFIGURED') {
            endpoint.breaker.onFailure();
            endpoint.failures += 1;
          }
        } finally {
          cancel();
        }
      }),
    );
    const heights = this.#endpoints
      .filter((e) => e.identity !== 'mismatch' && e.height !== undefined)
      .map((e) => e.height as bigint);
    if (heights.length > 0) {
      this.#best = heights.reduce((max, h) => (h > max ? h : max));
      if (this.#highest === undefined || this.#best > this.#highest)
        this.#highest = this.#best;
    }
    for (const status of this.status()) {
      if (status.state === 'unknown') continue;
      this.#events.emit('provider.health', {
        transportId: this.id,
        endpointId: status.id,
        state: status.state,
        ...(status.height !== undefined ? { height: status.height.toString() } : {}),
        ...(status.lag !== undefined ? { lag: status.lag.toString() } : {}),
      });
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
      return new TimeoutError(
        'TIMEOUT',
        `request to endpoint '${endpoint.id}' timed out`,
        { context },
      );
    }
    const inner =
      error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const clean = new Error(
      this.#scrub(endpoint, inner instanceof Error ? inner.message : String(inner)),
    );
    clean.name = inner instanceof Error ? inner.name : 'Error';
    clean.stack = `${clean.name}: ${clean.message}`;
    return new ProviderError(
      'PROVIDER_UNAVAILABLE',
      `request to endpoint '${endpoint.id}' failed: ${clean.message}`,
      {
        context,
        cause: clean,
      },
    );
  }
}
