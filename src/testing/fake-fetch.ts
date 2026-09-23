export interface FakeRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  json<T = Record<string, unknown>>(): T;
}

export type FakeReply =
  | Response
  | {
      readonly status?: number;
      readonly json?: unknown;
      readonly text?: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export type FakeHandler = (
  request: FakeRequest,
  signal: AbortSignal | undefined,
) => FakeReply | Promise<FakeReply>;

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Scripted fetch: routes by longest URL prefix; unknown hosts fail like a DNS error. */
export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  readonly #routes: { prefix: string; handler: FakeHandler }[] = [];

  route(prefix: string, handler: FakeHandler): this {
    this.#routes.push({ prefix, handler });
    this.#routes.sort((a, b) => b.prefix.length - a.prefix.length);
    return this;
  }

  callsTo(prefix: string): RecordedCall[] {
    return this.calls.filter((call) => call.url.startsWith(prefix));
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const body =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : undefined;
    const method = init?.method ?? 'GET';
    this.calls.push({
      url: url.href,
      method,
      headers: Object.fromEntries(headers.entries()),
      ...(body !== undefined ? { body } : {}),
    });
    const route = this.#routes.find((r) => url.href.startsWith(r.prefix));
    if (!route) {
      throw new TypeError('fetch failed', {
        cause: new Error(`getaddrinfo ENOTFOUND ${url.host}`),
      });
    }
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const reply = await route.handler(
      { url, method, headers, body, json: <T>() => JSON.parse(body ?? 'null') as T },
      signal,
    );
    if (reply instanceof Response) return reply;
    const text =
      reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json));
    return new Response(text, {
      status: reply.status ?? 200,
      headers: {
        'content-type': reply.text !== undefined ? 'text/plain' : 'application/json',
        'content-length': String(text.length),
        ...reply.headers,
      },
    });
  }) as typeof fetch;
}

/** A reply that never arrives; rejects with the abort reason when the request is aborted. */
export function hang(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

export function rpcResult(request: FakeRequest, result: unknown): FakeReply {
  return { json: { jsonrpc: '2.0', id: request.json<{ id: unknown }>().id, result } };
}

export function rpcError(request: FakeRequest, code: number, message: string): FakeReply {
  return {
    json: {
      jsonrpc: '2.0',
      id: request.json<{ id: unknown }>().id,
      error: { code, message },
    },
  };
}
