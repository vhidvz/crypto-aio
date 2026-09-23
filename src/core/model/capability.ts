export const KNOWN_CAPABILITIES = [
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
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];
export type Capability = KnownCapability | (string & {});
