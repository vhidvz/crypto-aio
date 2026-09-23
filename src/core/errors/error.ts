import { ERROR_CODES, type CodesOf, type ErrorCategory, type ErrorCode } from './codes';

export type { CodesOf, ErrorCategory, ErrorCode } from './codes';

export type ErrorContextValue = string | number | boolean | undefined;
export type ErrorContext = Readonly<Record<string, ErrorContextValue>>;

export interface CryptoAioErrorOptions {
  readonly cause?: unknown;
  readonly context?: ErrorContext;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly ambiguous?: boolean;
}

export interface SerializedError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly context: ErrorContext;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class CryptoAioError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly ambiguous: boolean;
  readonly context: ErrorContext;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: CryptoAioErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    const definition = ERROR_CODES[code];
    this.code = code;
    this.category = definition.category;
    this.retryable = options.retryable ?? definition.retryable;
    this.ambiguous = options.ambiguous ?? false;
    this.context = Object.freeze({ ...options.context });
    if (options.details) this.details = Object.freeze({ ...options.details });
  }

  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      ambiguous: this.ambiguous,
      context: this.context,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class ConfigError extends CryptoAioError {
  constructor(code: CodesOf<'config'>, message: string, options?: CryptoAioErrorOptions) {
    super(code, message, options);
  }
}
export class UnsupportedCapabilityError extends CryptoAioError {
  constructor(
    code: CodesOf<'unsupported'>,
    message: string,
    options?: CryptoAioErrorOptions,
  ) {
    super(code, message, options);
  }
}
export class ValidationError extends CryptoAioError {
  constructor(
    code: CodesOf<'validation'>,
    message: string,
    options?: CryptoAioErrorOptions,
  ) {
    super(code, message, options);
  }
}
export class ProviderError extends CryptoAioError {
  constructor(
    code: CodesOf<'provider'>,
    message: string,
    options?: CryptoAioErrorOptions,
  ) {
    super(code, message, options);
  }
}
export class ChainError extends CryptoAioError {
  constructor(code: CodesOf<'chain'>, message: string, options?: CryptoAioErrorOptions) {
    super(code, message, options);
  }
}
export class SigningError extends CryptoAioError {
  constructor(
    code: CodesOf<'signing'>,
    message: string,
    options?: CryptoAioErrorOptions,
  ) {
    super(code, message, options);
  }
}
export class StateError extends CryptoAioError {
  constructor(code: CodesOf<'state'>, message: string, options?: CryptoAioErrorOptions) {
    super(code, message, options);
  }
}
export class TimeoutError extends CryptoAioError {
  constructor(
    code: CodesOf<'timeout'>,
    message: string,
    options?: CryptoAioErrorOptions,
  ) {
    super(code, message, options);
  }
}

type AnyErrorConstructor = new (
  code: ErrorCode,
  message: string,
  options?: CryptoAioErrorOptions,
) => CryptoAioError;

const BY_CATEGORY: Record<ErrorCategory, AnyErrorConstructor> = {
  config: ConfigError as AnyErrorConstructor,
  unsupported: UnsupportedCapabilityError as AnyErrorConstructor,
  validation: ValidationError as AnyErrorConstructor,
  provider: ProviderError as AnyErrorConstructor,
  chain: ChainError as AnyErrorConstructor,
  signing: SigningError as AnyErrorConstructor,
  state: StateError as AnyErrorConstructor,
  timeout: TimeoutError as AnyErrorConstructor,
};

export function createError(
  code: ErrorCode,
  message: string,
  options?: CryptoAioErrorOptions,
): CryptoAioError {
  const Ctor = BY_CATEGORY[ERROR_CODES[code].category];
  return new Ctor(code, message, options);
}

export function isCryptoAioError(
  value: unknown,
  code?: ErrorCode,
): value is CryptoAioError {
  return value instanceof CryptoAioError && (code === undefined || value.code === code);
}

/** Returns a copy of `error` (same class) with merged context and optional flag overrides. */
export function withContext(
  error: CryptoAioError,
  context: ErrorContext,
  overrides: { readonly ambiguous?: boolean; readonly retryable?: boolean } = {},
): CryptoAioError {
  const Ctor = error.constructor as AnyErrorConstructor;
  return new Ctor(error.code, error.message, {
    cause: error.cause,
    context: { ...error.context, ...context },
    ...(error.details ? { details: error.details } : {}),
    retryable: overrides.retryable ?? error.retryable,
    ambiguous: overrides.ambiguous ?? error.ambiguous,
  });
}
