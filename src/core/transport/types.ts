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
}

export interface CallOptions {
  readonly retry?: RetryClass;
  readonly purpose?: RequestPurpose;
  /** Independent healthy endpoints that must agree; `'proof'` uses `proofQuorum`, capped by availability. */
  readonly quorum?: number | 'proof';
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

export type EndpointState = 'healthy' | 'lagging' | 'open' | 'disabled' | 'unknown';

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
  refreshHealth(signal?: AbortSignal): Promise<void>;
  ensureFreshHealth(signal?: AbortSignal): Promise<void>;
  status(): EndpointStatus[];
  /** Highest block height ever observed (monotonic guard for monitors). */
  highestHeight(): bigint | undefined;
}

/** SDKs are configured with this origin; the transport maps it onto real endpoints. */
export const PLACEHOLDER_ORIGIN = 'https://transport.crypto-aio.invalid';
