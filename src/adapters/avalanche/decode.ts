/**
 * An Avalanche transaction as the core reads it (spec §6.6), from its signed bytes.
 * - Transfers: each plain AVAX output of the transaction's own outputs (its base outputs,
 *   on this chain) to one address, unlocked, threshold 1: `out:<index>`, the output's index
 *   in its UTXO id. The senders are the addresses the signatures recover to.
 * - `decoding: 'complete'` only for a BaseTx or ImportTx whose every output is such a
 *   transfer. An export (value leaves for another chain), a staking or subnet transaction,
 *   a reward, another asset, a locked or multi-owner output, or a type this SDK cannot read
 *   is `partial`; bytes that do not parse are `none`.
 * - `details.signers`: the addresses that signed it, whatever it did.
 * - The fee is the AVAX the transaction burns. A memo that is UTF-8 text becomes the
 *   transfers' memo; the raw memo is in `details.memo` (hex).
 */
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { toHex } from '../../core/util/bytes';
import { formatAddress } from './address';
import { idOf } from './cb58';
import { parseSignedTx, sdkContext, signersOf } from './codec';
import type { AvalancheNetworkConfig } from './network';
import { TYPES, avalanche, type SdkTransferOutput } from './sdk';

const COMPLETE_TYPES = new Set([
  'avm.BaseTx',
  'pvm.BaseTx',
  'avm.ImportTx',
  'pvm.ImportTx',
]);

const utf8 = new TextDecoder('utf-8', { fatal: true });

function memoText(memo: Uint8Array): string | undefined {
  if (memo.length === 0) return undefined;
  try {
    return utf8.decode(memo);
  } catch {
    return undefined;
  }
}

/** The AVAX `tx` burns, or `undefined` when the SDK cannot say. */
function burnedAvax(
  tx: Parameters<typeof avalanche.utils.getBurnedAmountByTx>[0],
  config: AvalancheNetworkConfig,
): bigint | undefined {
  try {
    const burned = avalanche.utils
      .getBurnedAmountByTx(tx, sdkContext(config))
      .get(config.avaxAssetId);
    return burned !== undefined && burned >= 0n ? burned : undefined;
  } catch {
    return undefined;
  }
}

export function decodeTransaction(
  bytes: Uint8Array,
  config: AvalancheNetworkConfig,
  observation: DriverTxObservation,
): DriverTransaction {
  const raw = { encoding: 'hex' as const, data: toHex(bytes) };
  let parsed: ReturnType<typeof parseSignedTx>;
  try {
    parsed = parseSignedTx(bytes, config);
  } catch {
    // A transaction type this SDK version cannot read: known only by its id.
    return {
      id: idOf(bytes),
      observation,
      transfers: [],
      decoding: 'none',
      raw,
      details: { type: 'unknown' },
    };
  }
  const { tx } = parsed;
  const base = tx.baseTx;
  const from = signersOf(parsed).map((address) => formatAddress(address, config));
  const memoBytes = base?.memo.bytes ?? new Uint8Array();
  const memo = memoText(memoBytes);
  const transfers: DriverTransfer[] = [];
  let complete = COMPLETE_TYPES.has(tx._type) && base !== undefined;
  base?.outputs.forEach((output, index) => {
    const owners =
      output.output._type === TYPES.transferOutput
        ? (output.output as SdkTransferOutput).outputOwners
        : undefined;
    if (
      output.assetId.toString() !== config.avaxAssetId ||
      owners === undefined ||
      owners.locktime.value() !== 0n ||
      owners.threshold.value() !== 1 ||
      owners.addrs.length !== 1
    ) {
      complete = false;
      return;
    }
    transfers.push({
      locator: `out:${index}`,
      from,
      to: formatAddress(owners.addrs[0]?.toBytes() as Uint8Array, config),
      asset: 'native',
      amount: output.amount(),
      source: 'native',
      ...(memo !== undefined ? { memo } : {}),
    });
  });
  const fee = burnedAvax(tx, config);
  return {
    id: parsed.id,
    observation,
    ...(fee !== undefined && fee > 0n
      ? { fee: [{ asset: 'native' as const, amount: fee }] }
      : {}),
    transfers,
    decoding: complete ? 'complete' : 'partial',
    raw,
    details: {
      type: tx._type,
      signers: from,
      ...(memoBytes.length > 0 ? { memo: toHex(memoBytes) } : {}),
    },
  };
}
