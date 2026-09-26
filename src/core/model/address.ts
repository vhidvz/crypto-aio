export interface NormalizedAddress {
  readonly canonical: string;
  readonly display: string;
  /**
   * Chain-specific meaning of a recipient address. It reaches drivers in
   * `DriverOutput.variant` and is part of the intent hash, so it must hold only JSON scalars
   * (strings, finite numbers, booleans, `null`) under string keys, and should contain only
   * semantic fields that change what the transfer does (for example TON's `bounceable`),
   * never encoding-only choices such as a display alphabet. Omit it, or leave it empty,
   * when the address has no such meaning: an empty variant is no variant.
   */
  readonly variant?: Readonly<Record<string, unknown>>;
}

export type AddressFormatter = (
  address: NormalizedAddress,
  options?: Readonly<Record<string, unknown>>,
) => string;

/** A chain-bound address. Equality uses `canonical`; `variant` keeps chain-specific meaning. */
export class Address implements NormalizedAddress {
  readonly chain: string;
  readonly canonical: string;
  readonly display: string;
  readonly variant?: Readonly<Record<string, unknown>>;
  readonly #format?: AddressFormatter;

  constructor(chain: string, normalized: NormalizedAddress, format?: AddressFormatter) {
    this.chain = chain;
    this.canonical = normalized.canonical;
    this.display = normalized.display;
    if (normalized.variant) this.variant = Object.freeze({ ...normalized.variant });
    this.#format = format;
    Object.freeze(this);
  }

  format(options?: Readonly<Record<string, unknown>>): string {
    return this.#format ? this.#format(this, options) : this.display;
  }

  equals(other: Address | NormalizedAddress | string): boolean {
    if (typeof other === 'string') return other === this.canonical;
    if (other instanceof Address && other.chain !== this.chain) return false;
    return other.canonical === this.canonical;
  }

  toString(): string {
    return this.display;
  }

  toJSON(): {
    chain: string;
    canonical: string;
    display: string;
    variant?: Readonly<Record<string, unknown>>;
  } {
    return {
      chain: this.chain,
      canonical: this.canonical,
      display: this.display,
      ...(this.variant ? { variant: this.variant } : {}),
    };
  }
}
