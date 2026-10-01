import type { Secret } from '../secret/secret';

export type RetryClass = 'safe' | 'ambiguous-on-failure' | 'never-auto';
export type RequestPurpose = 'read' | 'monitor' | 'proof' | 'broadcast';

export interface EndpointConfig {
  readonly name?: string;
  readonly url: string | Secret<string>;
  readonly kind?: 'rpc' | 'indexer';
  readonly headers?: Readonly<Record<string, string | Secret<string>>>;
  readonly priority?: number;
  readonly rateLimit?: { readonly rps: number; readonly burst?: number };
  readonly timeoutMs?: number;
}

export interface TransportOptions {
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly maxLagBlocks?: number;
  readonly proofQuorum?: number;
  readonly failureThreshold?: number;
  readonly openMs?: number;
  readonly healthIntervalMs?: number;
  /**
   * The most bytes one answer may carry (default 64 MiB). A longer answer, by its declared
   * length or as it arrives, is cancelled and fails as a retryable `PROVIDER_UNAVAILABLE`,
   * so one endpoint can never make a call hold unbounded memory.
   */
  readonly maxResponseBytes?: number;
}

export interface CallOptions {
  readonly retry?: RetryClass;
  readonly purpose?: RequestPurpose;
  /**
   * Independent endpoints that must agree; `'proof'` uses `proofQuorum`, capped by the
   * endpoints the quorum counts. A proof quorum (`'proof'` under any purpose, or any quorum
   * for a monitor or proof purpose) with probes configured counts every endpoint not proven
   * mismatched until three health refreshes in a row, at most one per `healthIntervalMs`,
   * fail its probes or find its requests failing (its circuit breaker not closed), even
   * while it cannot answer, so a shortfall decides nothing (a retryable
   * `PROVIDER_UNAVAILABLE`); any other quorum counts the usable endpoints. An endpoint out
   * of a proof quorum's count never answers toward the read: while its circuit breaker is
   * half-open it is tried alongside the others (the read waits for that trial, up to its
   * timeout, unless the endpoint has no rate-limit token free), and its disagreement or
   * refusal can only block the read. In a proof quorum, a definitive error decides only when
   * every endpoint asked returns an equivalent one: the same error code, HTTP status and
   * JSON-RPC code, and for a JSON-RPC code each server defines (-32000 to -32099, and
   * -32603) the same message. Otherwise the read is a retryable `PROVIDER_INCONSISTENT`.
   */
  readonly quorum?: number | 'proof';
  /**
   * The part of each endpoint's result that must agree under `quorum` (default: the whole
   * result). Lets a caller compare consensus facts only, e.g. a block's number, hash and
   * parent hash, not fields that node implementations format differently. The call still
   * resolves with the first endpoint's whole result. A key that throws on any result counts
   * as a disagreement (a retryable `PROVIDER_INCONSISTENT`).
   */
  readonly quorumKey?: (result: unknown) => unknown;
  /**
   * Parse JSON answers with exact integers: an integer outside the safe range becomes a
   * `bigint` instead of a rounded number (`rpc`, `rpcRaw` and `http`; health probes always
   * parse plainly). A quorum key sees the revived values.
   */
  readonly exactIntegers?: boolean;
  /** Send to this many endpoints concurrently (raw-transaction broadcasts). */
  readonly fanout?: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly responseType?: 'json' | 'text';
  /**
   * Low-cardinality template label used for event and log method fields instead of the
   * raw path, e.g. `'/address/:address/utxo'`. Must contain no identifiers (addresses,
   * hashes, ids). When omitted, events fall back to the bare HTTP method.
   */
  readonly route?: string;
}

/** Single-attempt calls against one specific endpoint (used by health probes). */
export interface EndpointCall {
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  http<T = unknown>(request: HttpRequest): Promise<T>;
}

export interface HealthProbes {
  readonly identity?: (call: EndpointCall) => Promise<string>;
  readonly expectedIdentity?: string;
  readonly height?: (call: EndpointCall) => Promise<bigint>;
}

export type EndpointState =
  'healthy' | 'lagging' | 'open' | 'half-open' | 'disabled' | 'unknown';

export interface EndpointStatus {
  readonly id: string;
  readonly kind: 'rpc' | 'indexer';
  readonly state: EndpointState;
  readonly failures: number;
  readonly height?: bigint;
  readonly lag?: bigint;
  readonly latencyMs?: number;
  readonly reason?: string;
}

export interface Transport {
  readonly id: string;
  rpc<T = unknown>(method: string, params?: unknown, options?: CallOptions): Promise<T>;
  /** Posts an arbitrary JSON-RPC payload (single or batch) and returns the parsed body. */
  rpcRaw(payload: unknown, options?: CallOptions): Promise<unknown>;
  http<T = unknown>(request: HttpRequest, options?: CallOptions): Promise<T>;
  /** fetch-compatible function for SDKs; only `PLACEHOLDER_ORIGIN` URLs are accepted. */
  createFetch(
    classify?: (url: URL, init: RequestInit | undefined) => CallOptions,
  ): typeof fetch;
  setProbes(probes: HealthProbes): void;
  /** Whether any health probe (`identity` and/or `height`) has ever been configured via
   * `setProbes`. A transport with none configured can never mark an endpoint 'healthy' or
   * 'lagging' — its endpoints stay 'unknown' forever, which callers like `Blockchain.ready()`
   * treat as acceptable only in that case. */
  hasProbes(): boolean;
  refreshHealth(signal?: AbortSignal): Promise<void>;
  ensureFreshHealth(signal?: AbortSignal): Promise<void>;
  status(): EndpointStatus[];
  /**
   * Highest verified block height: a high-water mark (the stale-view guard of monitors
   * and scanners). It drops in two cases only: a height taken before an identity probe
   * existed stops counting once its endpoint turns out to serve another network, and a
   * peak that no verified endpoint comes within `maxLagBlocks` of for three health
   * refreshes in a row falls back to the verified best, so one forged far-future head
   * cannot keep every view stale until restart.
   */
  highestHeight(): bigint | undefined;
  /**
   * The lag tolerance in effect (`TransportOptions.maxLagBlocks`). The driver pool
   * resolves it in this order: the chain's `maxLagBlocks` config, else the root
   * `transport.maxLagBlocks`, else the plugin network's own, else the built-in default.
   * An endpoint further behind is lagging, and a view further behind `highestHeight()` is
   * stale.
   */
  readonly maxLagBlocks: number;
}

/** SDKs are configured with this origin; the transport maps it onto real endpoints. */
export const PLACEHOLDER_ORIGIN = 'https://transport.crypto-aio.invalid';
