/**
 * How an error names something the caller typed (a chain, network,
 * library, provider, wallet, signer, scheme, asset alias, option key or capability). What a
 * caller typed may be a pasted secret, so an error never repeats it, at any length: it lists
 * the names that would have been accepted instead, which the library or the caller's own
 * configuration defined.
 */

/** At most this many accepted names are listed; the rest are counted. */
export const MAX_LISTED_NAMES = 12;

/** `'a'`, `'a' and 'b'`, `'a', 'b' and 'c'`, or `'a', …, 'l' and 3 more`: sorted, unique. */
export function listNames(names: Iterable<string>): string {
  const sorted = [...new Set(names)].sort();
  const shown = sorted.slice(0, MAX_LISTED_NAMES).map((name) => `'${name}'`);
  const rest = sorted.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) as string}`;
}

/**
 * The text of a refusal of an unknown `what`, listing the accepted names and never the
 * caller's: `unknown network; the accepted names are 'mainnet' and 'sepolia'`.
 */
export function unknownName(what: string, accepted: Iterable<string>): string {
  const names = [...new Set(accepted)];
  if (names.length === 0) return `unknown ${what}; none is configured`;
  if (names.length === 1)
    return `unknown ${what}; the only accepted name is ${listNames(names)}`;
  return `unknown ${what}; the accepted names are ${listNames(names)}`;
}

/**
 * A value as an error may show it: quoted when it is one of `known` (a fixed word of this
 * library, such as a capability name), else `unshown`.
 */
export function knownName(
  value: unknown,
  known: readonly string[],
  unshown: string,
): string {
  return typeof value === 'string' && known.includes(value) ? `'${value}'` : unshown;
}
