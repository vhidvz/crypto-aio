/**
 * The TRC-20 calls and events the driver uses, SDK-free: TRC-20 is ERC-20's ABI on the
 * TVM, with 20-byte addresses in ABI words (the `41` prefix dropped). Selectors are pinned
 * by a keccak-256 test.
 */
import { ValidationError } from '../../core/errors/error';
import { bytesToUtf8, fromHex } from '../../core/util/bytes';
import { toHexAddress } from './address';

export const SELECTORS = Object.freeze({
  transfer: 'a9059cbb',
  balanceOf: '70a08231',
  decimals: '313ce567',
  symbol: '95d89b41',
});

/** `keccak256("Transfer(address,address,uint256)")`, without `0x`. */
export const TRANSFER_TOPIC =
  'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const UINT256_MAX = (1n << 256n) - 1n;

function word(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function addressWord(address: string): string {
  return toHexAddress(address).slice(2).padStart(64, '0');
}

/** Lesson 19: an amount outside `uint256` is refused with a fixed text, never wrapped. */
export function encodeTransfer(to: string, amount: bigint): string {
  if (amount < 0n || amount > UINT256_MAX) {
    throw new ValidationError('INVALID_AMOUNT', 'amount does not fit in a uint256');
  }
  return `${SELECTORS.transfer}${addressWord(to)}${word(amount)}`;
}

export function encodeBalanceOf(owner: string): string {
  return `${SELECTORS.balanceOf}${addressWord(owner)}`;
}

/**
 * The (to, amount) of `transfer(address,uint256)` call data built the canonical way (12
 * zero bytes before the address); `null` for anything else.
 */
export function decodeTransferCall(
  data: string,
): { readonly to: string; readonly amount: bigint } | null {
  // Lesson 20: a fixed length (selector + two words), checked before any other work.
  if (data.length !== 136) return null;
  const hex = data.toLowerCase();
  if (!/^a9059cbb[0-9a-f]{128}$/.test(hex)) return null;
  const toWord = hex.slice(8, 72);
  if (!toWord.startsWith('0'.repeat(24))) return null;
  return { to: `41${toWord.slice(24)}`, amount: BigInt(`0x${hex.slice(72)}`) };
}

/** Throws on data that is not exactly one ABI `uint256` word. */
export function decodeUint256(data: string): bigint {
  if (!/^[0-9a-fA-F]{64}$/.test(data)) throw new TypeError('not one uint256 word');
  return BigInt(`0x${data}`);
}

/** Throws on data that is not an ABI `string` (offset 32, length, padded UTF-8). */
export function decodeString(data: string): string {
  if (!/^(?:[0-9a-fA-F]{64}){2,}$/.test(data)) throw new TypeError('not an ABI string');
  if (BigInt(`0x${data.slice(0, 64)}`) !== 32n) throw new TypeError('bad string offset');
  const length = BigInt(`0x${data.slice(64, 128)}`);
  const available = BigInt((data.length - 128) / 2);
  if (length > available || available - length >= 32n) {
    throw new TypeError('bad string length');
  }
  const bytes = fromHex(data.slice(128, 128 + Number(length) * 2));
  return bytesToUtf8(bytes);
}

/**
 * A TRC-20 `Transfer` log's parties (`41…` hex) and amount; `null` for any other log. Tron
 * logs carry hex without `0x`, and `address` is the 20-byte emitter.
 */
export function decodeTransferLog(log: {
  readonly topics: readonly string[];
  readonly data: string;
}): { readonly from: string; readonly to: string; readonly amount: bigint } | null {
  if (log.topics.length !== 3) return null;
  const [topic, from, to] = log.topics.map((t) => t.toLowerCase());
  if (topic !== TRANSFER_TOPIC) return null;
  const party = (value: string | undefined): string | null =>
    value !== undefined && /^0{24}[0-9a-f]{40}$/.test(value)
      ? `41${value.slice(24)}`
      : null;
  const sender = party(from);
  const recipient = party(to);
  if (sender === null || recipient === null || !/^[0-9a-fA-F]{64}$/.test(log.data)) {
    return null;
  }
  return { from: sender, to: recipient, amount: BigInt(`0x${log.data}`) };
}
