/**
 * The secret fragments of one endpoint's configuration, and the scrubber that
 * removes them from every text an error, a `details` field or a `cause` may carry. A
 * provider that refuses a key often echoes the bare key back ("invalid api key <KEY>"),
 * without the URL or header around it, so removing only the whole URL or header value is
 * not enough.
 */
import { redactText } from './redact';
import { REDACTED } from './secret';

/**
 * The shortest fragment scrubbed on its own. Every built-in keyed preset's key is at least
 * 32 characters (Alchemy, Infura, Ankr, TronGrid, toncenter), while the ordinary words of an
 * endpoint URL are shorter than 8 (`v2`, `v3`, `api`, `rpc`, `eth`, `bsc`, `solana`,
 * `jsonRPC`, `mainnet`). Those words also occur inside node texts the drivers classify
 * ("method not found" holds `eth`, a JSON-RPC body holds `jsonrpc`), so scrubbing them would
 * change a verdict's input. A secret shorter than 8 characters is still removed wherever
 * the whole URL, the whole header value or the whole `Scheme token` appears.
 */
export const MIN_FRAGMENT_LENGTH = 8;

/** A whole header value shorter than this is left alone. */
const MIN_VALUE_LENGTH = 4;

/** `Scheme token` in an `Authorization`-style value (RFC 9110 §11.4). */
const AUTH_VALUE = /^\s*[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+(\S+)\s*$/;

export interface EndpointSecrets {
  /** The endpoint URL as configured and as parsed: an error shows its placeholder. */
  readonly urls: readonly string[];
  /** Every other text to remove: fragments and whole header values. */
  readonly fragments: readonly string[];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function base64Text(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined;
  const value = Buffer.from(text, 'base64').toString('utf8');
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

/**
 * The URL forms and fragments of one endpoint: the URL as given and as parsed; its path and
 * query together; each userinfo part, path segment, query value and fragment (raw and
 * percent-decoded); each header value whole; the token after an auth scheme, and for
 * `Basic` the decoded `user:password` and password. Fragments shorter than
 * `MIN_FRAGMENT_LENGTH` are left out. The input is trusted configuration (its URL already
 * parsed by the transport).
 */
export function endpointSecrets(
  url: string,
  headers: Readonly<Record<string, string>>,
): EndpointSecrets {
  const parsed = new URL(url);
  const urls = [...new Set([url, parsed.href])];
  const fragments = new Set<string>();
  const add = (text: string, min = MIN_FRAGMENT_LENGTH) => {
    for (const form of [text, decoded(text)]) if (form.length >= min) fragments.add(form);
  };
  add(`${parsed.pathname}${parsed.search}`, 2);
  add(parsed.username);
  add(parsed.password);
  for (const segment of parsed.pathname.split('/')) add(segment);
  for (const pair of parsed.search.replace(/^\?/, '').split('&')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const value = pair.slice(at + 1);
    add(value);
    add(value.replace(/\+/g, ' '));
  }
  add(parsed.hash.replace(/^#/, ''));
  for (const value of Object.values(headers)) {
    add(value, MIN_VALUE_LENGTH);
    const token = AUTH_VALUE.exec(value)?.[1];
    if (token === undefined) continue;
    add(token);
    const basic = /^\s*basic\s/i.test(value) ? base64Text(token) : undefined;
    if (basic !== undefined) {
      add(basic);
      add(basic.slice(basic.indexOf(':') + 1));
    }
  }
  return { urls, fragments: [...fragments] };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text with every secret of `secrets` replaced, case-insensitively and longest first: a
 * URL form by `placeholder`, anything else by `[REDACTED]`; then any other URL redacted.
 * With `limit`, only the first `limit` characters come back, and only a bounded prefix is
 * read, since a provider's text is untrusted and may be huge: long enough that a secret
 * starting before the cut is removed whole.
 */
export function createScrubber(
  placeholder: string,
  secrets: EndpointSecrets,
): (text: string, limit?: number) => string {
  const all = [...secrets.urls, ...secrets.fragments].sort((a, b) => b.length - a.length);
  const longest = all[0]?.length ?? 0;
  const urls = new Set(secrets.urls.map((form) => form.toLowerCase()));
  const pattern =
    all.length > 0 ? new RegExp(all.map(escape).join('|'), 'gi') : undefined;
  return (text, limit) => {
    const input = limit === undefined ? text : text.slice(0, limit + longest);
    const replaced = pattern
      ? input.replace(pattern, (match) =>
          urls.has(match.toLowerCase()) ? placeholder : REDACTED,
        )
      : input;
    const out = redactText(replaced);
    return limit === undefined ? out : out.slice(0, limit);
  };
}
