/**
 * What coin selection spends and pays: the planned outputs of an intent (strict addresses,
 * no dust), the wallet's eligible outputs (not reserved by another live Operation, and
 * confirmed as deeply as `minInputConfirmations` asks), and the fee rate of a fee spec.
 */
import type { WalletKey, WalletOptions } from '../../core/driver/types';
import { ConfigError, ValidationError } from '../../core/errors/error';
import { isFeeSpeed, type FeeOverride, type FeeSpeed } from '../../core/model/fee';
import {
  decodeAddress,
  dustThreshold,
  walletAddress,
  walletTypeOf,
  type DecodedAddress,
  type WalletAddress,
} from './address';
import type { PlannedOutput, Spendable } from './coinselect';
import {
  ADDRESS_TYPES,
  READ,
  parseWalletOptions,
  withSignal,
  type UtxoContext,
} from './context';

export { assertNative } from './context';
import { deriveXpubChild } from '../../core/signing/hd';
import type { WalletHdOptions } from '../../core/signing/wallet';
import { rateForSpeed, rateFromOverride } from './fees';
import { listUnspent } from './reader';
import type { UtxoAddressType } from './types';

/** D25/M2: the most outputs one transfer may pay (`limits().maxOutputs`), enforced here. */
export const MAX_OUTPUTS = 1_000;

/** The intent's outputs as scripts; each must be a standard address and above dust. */
export function plannedOutputs(
  ctx: UtxoContext,
  outputs: readonly { readonly to: string; readonly amount: bigint }[],
): PlannedOutput[] {
  if (outputs.length === 0) {
    throw new ValidationError('INVALID_INTENT', 'at least one output is required');
  }
  if (outputs.length > MAX_OUTPUTS) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a transfer pays at most ${MAX_OUTPUTS} outputs`,
    );
  }
  return outputs.map((output) => {
    const { script } = decodeAddress(output.to, ctx.config.address);
    if (output.amount < dustThreshold(script, ctx.config.dustRelayFee)) {
      throw new ValidationError(
        'INVALID_AMOUNT',
        'an output is below the dust threshold and would not be relayed',
      );
    }
    return { script, value: output.amount };
  });
}

/** The sending wallet: its type (from the address; p2sh is p2sh-p2wpkh) and, with a key, its scripts. */
export interface Sender {
  readonly from: DecodedAddress;
  readonly type: UtxoAddressType;
}

export function senderOf(ctx: UtxoContext, from: string): Sender {
  const decoded = decodeAddress(from, ctx.config.address);
  return { from: decoded, type: walletTypeOf(decoded) };
}

/**
 * The wallet's scripts from its key, which must own the sending address: nothing is ever
 * built for inputs the wallet's key cannot sign (`INVALID_INTENT`).
 */
export function walletOf(
  ctx: UtxoContext,
  sender: Sender,
  keys: readonly WalletKey[],
): { readonly wallet: WalletAddress; readonly key: WalletKey } {
  const key = keys[0];
  if (!key) {
    throw new ValidationError(
      'INVALID_INTENT',
      'building a Bitcoin transaction needs the wallet public key',
    );
  }
  const wallet = walletAddress(key.publicKey, sender.type, ctx.config.address);
  if (wallet.address !== sender.from.canonical) {
    throw new ValidationError(
      'INVALID_INTENT',
      "the wallet's key does not own the sending address",
    );
  }
  return { wallet, key };
}

/** A22: how many indexes `changeAddressOf` searches on each chain of the wallet's xpub. */
export const XPUB_CHANGE_SEARCH = 20;

/**
 * A22 (with A19): whether the wallet's xpub derives `target` for the sender's address type, at
 * indexes 0–19 of its configured path (default `0/{index}`) or of the change chain
 * `1/{index}`. A bounded search: at most 40 child keys, and only after the key check failed.
 * X7: `wallet.hd` is the core's own `WalletHdOptions` (a caller's `hd` never reaches a
 * driver), and its `xpub` is always a public key. X4 (A20): an xpub of the other network
 * class (a mainnet `xpub` on a test network, or the reverse) is `CONFIG_INVALID`.
 */
function xpubDerives(
  ctx: UtxoContext,
  wallet: WalletOptions,
  type: UtxoAddressType,
  target: string,
): boolean {
  const hd = wallet.hd as WalletHdOptions | undefined;
  if (typeof hd?.xpub !== 'string' || hd.xpub.length === 0) return false;
  const network = { testnet: ctx.network.testnet };
  const templates = new Set([
    typeof hd.xpubPath === 'string' ? hd.xpubPath : '0/{index}',
    '1/{index}',
  ]);
  for (const template of templates) {
    for (let index = 0; index < XPUB_CHANGE_SEARCH; index++) {
      const path = template.replace('{index}', String(index));
      const key = deriveXpubChild(hd.xpub, path, hd.xpubVersions, network);
      if (walletAddress(key, type, ctx.config.address).address === target) return true;
    }
  }
  return false;
}

/**
 * A19: where change goes. A configured `changeAddress` must be derivable from the wallet:
 * the sending address, or any of the four wallet types of one of the wallet's keys (a
 * bounded search, at most 4 per key). Otherwise it is refused with `CONFIG_INVALID`, naming
 * no address, because a valid but mistyped address would lose every change output. The
 * wallet opts out with `allowExternalChangeAddress: true`.
 */
export function changeAddressOf(
  ctx: UtxoContext,
  wallet: WalletOptions,
  sender: Sender,
  keys: readonly WalletKey[],
): DecodedAddress {
  const { changeAddress, allowExternalChangeAddress } = parseWalletOptions(
    wallet,
    ctx.config,
  );
  if (!changeAddress) return sender.from;
  if (allowExternalChangeAddress) return changeAddress;
  const target = changeAddress.canonical;
  if (target === sender.from.canonical) return changeAddress;
  for (const key of keys) {
    for (const type of ADDRESS_TYPES) {
      let derived: string;
      try {
        derived = walletAddress(key.publicKey, type, ctx.config.address).address;
      } catch {
        continue; // e.g. an x-only key derives only p2tr
      }
      if (derived === target) return changeAddress;
    }
  }
  if (xpubDerives(ctx, wallet, sender.type, target)) return changeAddress;
  throw new ConfigError(
    'CONFIG_INVALID',
    "wallet.utxo.changeAddress is not derivable from the wallet's key; set wallet.utxo.allowExternalChangeAddress to send change elsewhere",
  );
}

/**
 * The wallet's outputs coin selection may spend. They are read as `listUnspent` reads them:
 * an output the indexer lists twice alike counts once (the funds check sums them), and two
 * listings that disagree decide nothing (retryable).
 */
export async function spendable(
  ctx: UtxoContext,
  from: string,
  exclude: readonly string[] | undefined,
  minConfirmations: number,
  signal?: AbortSignal,
): Promise<Spendable[]> {
  const [utxos, tip] = await Promise.all([
    listUnspent(ctx, from, signal),
    ctx.esplora.tipHeight(withSignal(READ, signal)),
  ]);
  const held = new Set(exclude ?? []);
  return utxos
    .filter((utxo) => {
      if (held.has(utxo.outpoint)) return false;
      if (minConfirmations === 0) return true;
      if (!utxo.confirmed) return false;
      return tip - (utxo.blockHeight as bigint) + 1n >= BigInt(minConfirmations);
    })
    .map((utxo) => ({
      outpoint: utxo.outpoint,
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
    }));
}

/** The fee rate (sat/kvB) of a speed or a `{ satPerVByte }` override. */
export async function rateOf(
  ctx: UtxoContext,
  fee: FeeSpeed | FeeOverride,
  signal?: AbortSignal,
): Promise<bigint> {
  if (isFeeSpeed(fee)) {
    const estimates = await ctx.esplora.feeEstimates(withSignal(READ, signal));
    return rateForSpeed(estimates, fee, ctx.config);
  }
  if (fee === null || typeof fee !== 'object') {
    throw new ValidationError('INVALID_INTENT', 'fee must be a speed or { satPerVByte }');
  }
  return rateFromOverride(fee, ctx.config);
}
