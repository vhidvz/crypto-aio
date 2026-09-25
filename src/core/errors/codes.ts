export type ErrorCategory =
  | 'config'
  | 'unsupported'
  | 'validation'
  | 'provider'
  | 'chain'
  | 'signing'
  | 'state'
  | 'timeout';

interface CodeDefinition {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
}

/** Frozen (M1), with every entry: the table is shared by every error and every caller. */
export const ERROR_CODES = deepFreezeCodes({
  CONFIG_INVALID: { category: 'config', retryable: false },
  DEPENDENCY_MISSING: { category: 'config', retryable: false },
  INCOMPATIBLE_SELECTION: { category: 'config', retryable: false },
  UNSUPPORTED_CAPABILITY: { category: 'unsupported', retryable: false },
  INVALID_ADDRESS: { category: 'validation', retryable: false },
  INVALID_AMOUNT: { category: 'validation', retryable: false },
  ASSET_RESOLUTION: { category: 'validation', retryable: false },
  INVALID_INTENT: { category: 'validation', retryable: false },
  PROVIDER_UNAVAILABLE: { category: 'provider', retryable: true },
  RATE_LIMITED: { category: 'provider', retryable: true },
  PROVIDER_MISCONFIGURED: { category: 'provider', retryable: false },
  PROVIDER_INCONSISTENT: { category: 'provider', retryable: true },
  RPC_ERROR: { category: 'provider', retryable: false },
  INSUFFICIENT_FUNDS: { category: 'chain', retryable: false },
  NONCE_CONFLICT: { category: 'chain', retryable: false },
  NONCE_TOO_HIGH: { category: 'chain', retryable: false },
  FEE_TOO_LOW: { category: 'chain', retryable: false },
  TX_REFUSED: { category: 'chain', retryable: false },
  TX_REJECTED: { category: 'chain', retryable: false },
  TX_REVERTED: { category: 'chain', retryable: false },
  TX_EXPIRED: { category: 'chain', retryable: false },
  TX_REPLACED: { category: 'chain', retryable: false },
  SIGNER_UNAVAILABLE: { category: 'signing', retryable: false },
  SIGNING_FAILED: { category: 'signing', retryable: false },
  SIGNATURE_MISMATCH: { category: 'signing', retryable: false },
  POLICY_REJECTED: { category: 'signing', retryable: false },
  KEY_NOT_EXPORTABLE: { category: 'signing', retryable: false },
  IDEMPOTENCY_CONFLICT: { category: 'state', retryable: false },
  FENCING: { category: 'state', retryable: false },
  VERSION_CONFLICT: { category: 'state', retryable: true },
  INVALID_TRANSITION: { category: 'state', retryable: false },
  NOT_FOUND: { category: 'state', retryable: false },
  SEQUENCE_BUSY: { category: 'state', retryable: true },
  /** R27: the outcome may have happened (e.g. a delivered broadcast) but was not recorded. */
  STATE_UNRECORDED: { category: 'state', retryable: true },
  SCANNER_REORG_TOO_DEEP: { category: 'state', retryable: false },
  TIMEOUT: { category: 'timeout', retryable: true },
} as const satisfies Record<string, CodeDefinition>);

function deepFreezeCodes<T extends Record<string, CodeDefinition>>(codes: T): T {
  for (const definition of Object.values(codes)) Object.freeze(definition);
  return Object.freeze(codes);
}

export type ErrorCode = keyof typeof ERROR_CODES;

export type CodesOf<C extends ErrorCategory> = {
  [K in ErrorCode]: (typeof ERROR_CODES)[K]['category'] extends C ? K : never;
}[ErrorCode];
