/**
 * The `@ton/ton` library module (the family shape: the client module exports the loadable
 * factory). The native client is a `TonClient` whose `httpAdapter` posts to the transport
 * (spec §11), off the driver's own request path (D1). SDKs are required by their bare peer
 * names (R80).
 */
import { TonClient } from '@ton/ton';
import type { DisposableNativeClient } from '../../core/driver/types';
import { PLACEHOLDER_ORIGIN, type Transport } from '../../core/transport/types';
import { BROADCAST, READ } from './api';
import { tonDriverFactory } from './driver';
import type { TonCallTags } from './types';

type HttpAdapter = NonNullable<ConstructorParameters<typeof TonClient>[0]['httpAdapter']>;

/**
 * The tags of a native request: plain reads, except a toncenter `send*` method, which is a
 * broadcast (M3, as EVM's native client): a failure after the transport may have delivered
 * it is `ambiguous`, never an invitation to sign again with a new seqno.
 */
const tagsOf = (body: unknown): TonCallTags => {
  const method =
    body !== null && typeof body === 'object'
      ? (body as { readonly method?: unknown }).method
      : undefined;
  return typeof method === 'string' && method.startsWith('send') ? BROADCAST : READ;
};

/**
 * A fresh `TonClient` over `transport` on every call (R34); `crypto-aio/native` only. The
 * client holds only a placeholder URL and no key (secrets stay in the transport), and
 * nothing to close.
 */
export function tonNativeClient(transport: Transport): DisposableNativeClient {
  const httpAdapter = (async (config: { data?: unknown }) => {
    const body =
      typeof config.data === 'string'
        ? (JSON.parse(config.data) as unknown)
        : config.data;
    const data = await transport.http(
      { method: 'POST', path: '/jsonRPC', body, route: '/jsonRPC' },
      tagsOf(body),
    );
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  }) as unknown as HttpAdapter;
  return {
    client: new TonClient({ endpoint: `${PLACEHOLDER_ORIGIN}/jsonRPC`, httpAdapter }),
  };
}

/** The `@ton/ton` adapter's driver factory; the manifest's `load()` returns it. */
export const tonLibraryDriverFactory = tonDriverFactory(tonNativeClient);
