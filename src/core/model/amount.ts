import { ValidationError } from '../errors/error';
import type { AssetId, AssetInfo } from './asset';

export type AmountInput = bigint | string | Amount;

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_AMOUNT', message);
}

/** An exact, non-negative quantity of one asset in base units. Never floating point. */
export class Amount {
  private constructor(
    readonly base: bigint,
    readonly asset: AssetInfo,
  ) {
    Object.freeze(this);
  }

  static fromBase(base: bigint, asset: AssetInfo): Amount {
    if (typeof base !== 'bigint') throw invalid('base amount must be a bigint');
    if (base < 0n) throw invalid('amounts cannot be negative');
    return new Amount(base, asset);
  }

  static parse(value: string, asset: AssetInfo): Amount {
    if (typeof value !== 'string' || !DECIMAL.test(value)) {
      throw invalid(
        `'${String(value)}' is not a plain decimal string (expected digits with an optional fractional part, e.g. "1.25")`,
      );
    }
    const { decimals, symbol } = asset.metadata;
    const [whole = '0', fraction = ''] = value.split('.');
    if (fraction.length > decimals) {
      throw invalid(
        `'${value}' has ${fraction.length} fractional digits but ${symbol} has ${decimals} decimals`,
      );
    }
    const scale = 10n ** BigInt(decimals);
    const fractional = fraction.length > 0 ? BigInt(fraction.padEnd(decimals, '0')) : 0n;
    return new Amount(BigInt(whole) * scale + fractional, asset);
  }

  static from(input: unknown, asset: AssetInfo): Amount {
    if (input instanceof Amount) {
      if (input.asset.id !== asset.id) {
        throw invalid(
          `amount is denominated in '${input.asset.id}', expected '${asset.id}'`,
        );
      }
      return input;
    }
    if (typeof input === 'bigint') return Amount.fromBase(input, asset);
    if (typeof input === 'string') return Amount.parse(input, asset);
    if (typeof input === 'number') {
      throw invalid(
        'JavaScript numbers are not accepted for amounts; use a bigint (base units) or a decimal string',
      );
    }
    throw invalid(
      `unsupported amount input of type ${input === null ? 'null' : typeof input}`,
    );
  }

  get decimals(): number {
    return this.asset.metadata.decimals;
  }

  isZero(): boolean {
    return this.base === 0n;
  }

  toDecimalString(): string {
    const decimals = this.decimals;
    if (decimals === 0) return this.base.toString();
    const digits = this.base.toString().padStart(decimals + 1, '0');
    const whole = digits.slice(0, -decimals);
    const fraction = digits.slice(-decimals).replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  }

  format(): string {
    return `${this.toDecimalString()} ${this.asset.metadata.symbol}`;
  }

  plus(other: Amount): Amount {
    this.assertSameAsset(other);
    return new Amount(this.base + other.base, this.asset);
  }

  minus(other: Amount): Amount {
    this.assertSameAsset(other);
    if (other.base > this.base) throw invalid('result would be negative');
    return new Amount(this.base - other.base, this.asset);
  }

  compare(other: Amount): -1 | 0 | 1 {
    this.assertSameAsset(other);
    return this.base < other.base ? -1 : this.base > other.base ? 1 : 0;
  }

  equals(other: Amount): boolean {
    return other.asset.id === this.asset.id && other.base === this.base;
  }

  toJSON(): { base: string; asset: AssetId } {
    return { base: this.base.toString(), asset: this.asset.id };
  }

  toString(): string {
    return this.format();
  }

  private assertSameAsset(other: Amount): void {
    if (other.asset.id !== this.asset.id) {
      throw invalid(`cannot combine '${this.asset.id}' with '${other.asset.id}'`);
    }
  }
}
