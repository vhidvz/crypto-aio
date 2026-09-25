/**
 * Transactions and receipts into the driver model (spec §6.6, §15): native value and
 * ERC-20 `Transfer` logs as transfers, fees in the native asset, and `decoding: 'partial'`
 * whenever contract code ran, since internal transfers need traces (spec §20).
 */
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { TRANSFER_GAS } from './fees';
import type { EvmAbi, EvmReceipt, EvmTx } from './types';

const TRANSFER_SELECTOR = '0xa9059cbb';

/**
 * R50: a token `transfer` call worked only if the token logged a `Transfer` from the sender.
 * ERC-20 requires the event, and some tokens return `false` instead of reverting, so a
 * successful receipt alone would report a transfer that moved nothing.
 */
export function tokenTransferLanded(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt,
): boolean {
  if (tx.to === null || !tx.input.startsWith(TRANSFER_SELECTOR)) return true;
  return receipt.logs.some(
    (log) => log.address === tx.to && abi.decodeTransfer(log)?.from === tx.from,
  );
}

export function evmObservation(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt | null,
): DriverTxObservation {
  if (receipt) {
    const landed = receipt.status === 1 && tokenTransferLanded(abi, tx, receipt);
    return {
      seen: 'block',
      txHash: tx.hash,
      blockHeight: receipt.blockNumber,
      blockHash: receipt.blockHash,
      success: landed,
      ...(receipt.status === 0
        ? { reason: 'reverted' }
        : landed
          ? {}
          : { reason: 'token transfer failed' }),
    };
  }
  if (tx.blockHash !== null && tx.blockNumber !== null) {
    return {
      seen: 'block',
      txHash: tx.hash,
      blockHeight: tx.blockNumber,
      blockHash: tx.blockHash,
    };
  }
  return { seen: 'mempool', txHash: tx.hash };
}

/** Whether contract code ran: calldata, logs, or more execution gas than a plain transfer. */
function ranCode(tx: EvmTx, receipt: EvmReceipt): boolean {
  const executionGas = receipt.gasUsed - (receipt.gasUsedForL1 ?? 0n);
  return tx.input !== '0x' || receipt.logs.length > 0 || executionGas !== TRANSFER_GAS;
}

export function decodeTransaction(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt | null,
  timestamp?: number,
): DriverTransaction {
  const transfers: DriverTransfer[] = [];
  const executed = receipt === null || receipt.status === 1;
  const to = tx.to ?? receipt?.contractAddress ?? null;
  if (executed && tx.value > 0n && to !== null) {
    transfers.push({
      locator: 'native',
      from: [tx.from],
      to,
      asset: 'native',
      amount: tx.value,
      source: 'native',
    });
  }
  for (const log of receipt?.status === 1 ? receipt.logs : []) {
    const decoded = abi.decodeTransfer(log);
    if (!decoded) continue;
    transfers.push({
      locator: `log:${log.logIndex}`,
      from: [decoded.from],
      to: decoded.to,
      asset: { standard: 'erc20', contract: log.address },
      amount: decoded.amount,
      source: 'token-event',
    });
  }
  const decoding =
    receipt === null
      ? 'partial'
      : receipt.status === 0 || !ranCode(tx, receipt)
        ? 'complete'
        : 'partial';
  return {
    id: tx.hash,
    observation: evmObservation(abi, tx, receipt),
    ...(receipt
      ? {
          fee: [
            {
              asset: 'native' as const,
              amount: receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n),
            },
          ],
        }
      : {}),
    transfers,
    decoding,
    ...(timestamp !== undefined ? { timestamp } : {}),
    details: {
      nonce: tx.nonce,
      type: tx.type,
      gasLimit: tx.gasLimit,
      ...(receipt
        ? {
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: receipt.effectiveGasPrice,
            status: receipt.status,
          }
        : {}),
      ...(receipt?.l1Fee !== undefined ? { l1Fee: receipt.l1Fee } : {}),
    },
  };
}
