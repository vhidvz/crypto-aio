/**
 * The capabilities the library names; `bc.supports(capability)` tells which a handle has.
 * `contract-read` is reserved: no built-in family has it. A minor release may add names.
 */
export const KNOWN_CAPABILITIES = Object.freeze([
  'tokens',
  'memo',
  'batch-transfer',
  'replace-fee',
  'cancel',
  'block-scan',
  'address-history',
  'finality-tag',
  'hd-public-derivation',
  'contract-read',
  'fee-market-1559',
  'expiry',
] as const);

/** One of `KNOWN_CAPABILITIES`. */
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];
/** A capability: a known one, or a name a plugin defines. */
export type Capability = KnownCapability | (string & {});
