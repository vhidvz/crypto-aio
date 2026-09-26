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
import { ABI_WORD, ADDRESS_WORD } from './client';
import { TRANSFER_GAS } from './fees';
import { POLYGON_FEE_LOG, POLYGON_TRANSFER_LOG, type EvmNetworkConfig } from './network';
import type { EvmAbi, EvmLog, EvmReceipt, EvmTx } from './types';

const TRANSFER_SELECTOR = '0xa9059cbb';

/**
 * R89: the recipient (lower-cased) and amount of an ERC-20 `transfer(address,uint256)`
 * call: the selector, then two ABI words. `null` for any other calldata.
 */
function transferCall(
  input: string,
): { readonly to: string; readonly amount: bigint } | null {
  const to = `0x${input.slice(10, 74)}`;
  const amount = `0x${input.slice(74)}`;
  if (
    !input.startsWith(TRANSFER_SELECTOR) ||
    !ADDRESS_WORD.test(to) ||
    !ABI_WORD.test(amount)
  ) {
    return null;
  }
  return { to: `0x${to.slice(26)}`.toLowerCase(), amount: BigInt(amount) };
}

/**
 * R50, R89 (the board's phantom-success rule, final wording): a token `transfer` call worked
 * only if the token logged a `Transfer` from the sender to the call's recipient, of a
 * positive amount whenever the call asked for one. ERC-20 requires the event, and some tokens
 * return `false` instead of reverting, so a successful receipt alone would report a transfer
 * that moved nothing; a log to anyone else, or of nothing, pays the recipient nothing either.
 * A fee-on-transfer token logs less than asked, and still counts. The call's arguments come
 * from its signed calldata. R68: only verdicts on our own transactions apply it
 * (`evmObservation`, `includedFinal`), never the decoder.
 */
export function tokenTransferLanded(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt,
): boolean {
  if (tx.to === null || !tx.input.startsWith(TRANSFER_SELECTOR)) return true;
  const call = transferCall(tx.input);
  if (!call) return false;
  return receipt.logs.some((log) => {
    const transfer = log.address === tx.to ? abi.decodeTransfer(log) : null;
    return (
      transfer !== null &&
      transfer.from === tx.from &&
      transfer.to.toLowerCase() === call.to &&
      (call.amount === 0n || transfer.amount > 0n)
    );
  });
}

/** What the chain reports: where the transaction is, and its receipt's status. */
export function chainObservation(
  tx: EvmTx,
  receipt: EvmReceipt | null,
): DriverTxObservation {
  if (receipt) {
    return {
      seen: 'block',
      txHash: tx.hash,
      blockHeight: receipt.blockNumber,
      blockHash: receipt.blockHash,
      success: receipt.status === 1,
      ...(receipt.status === 0 ? { reason: 'reverted' } : {}),
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

/**
 * The verdict on one of our own transactions (R68): the chain's status, and a successful
 * token `transfer` that logged no transfer to its recipient is `success: false` (R50, R89).
 */
export function evmObservation(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt | null,
): DriverTxObservation {
  const observation = chainObservation(tx, receipt);
  if (!receipt || receipt.status === 0 || tokenTransferLanded(abi, tx, receipt)) {
    return observation;
  }
  return { ...observation, success: false, reason: 'token transfer failed' };
}

/** bor's fee log (R69) or native transfer log (R70), from the MRC20 predeploy. */
const isPolygonSystemLog = (log: EvmLog): boolean =>
  log.address.toLowerCase() === POLYGON_FEE_LOG.address &&
  (log.topics[0] === POLYGON_FEE_LOG.topic ||
    log.topics[0] === POLYGON_TRANSFER_LOG.topic);

/**
 * Whether contract code ran: calldata, logs, or more execution gas than a plain transfer.
 * On Polygon PoS, a plain transfer (no calldata, exactly 21,000 execution gas) also
 * carries bor's system logs, which are no sign of code (R69, R70): its value is `tx.value`.
 */
function ranCode(tx: EvmTx, receipt: EvmReceipt, polygonSystemLogs: boolean): boolean {
  const executionGas = receipt.gasUsed - (receipt.gasUsedForL1 ?? 0n);
  if (tx.input !== '0x' || executionGas !== TRANSFER_GAS) return true;
  const logs = polygonSystemLogs
    ? receipt.logs.filter((log) => !isPolygonSystemLog(log))
    : receipt.logs;
  return logs.length > 0;
}

/**
 * Any transaction as the chain reports it (R68): the receipt's status, never the R50
 * verdict, so a third party's call that shares the `transfer` selector is not misreported.
 * Pass the network's config so bor's system logs do not make a plain Polygon transfer
 * `partial`.
 */
export function decodeTransaction(
  abi: EvmAbi,
  tx: EvmTx,
  receipt: EvmReceipt | null,
  timestamp?: number,
  network: Pick<EvmNetworkConfig, 'polygonSystemLogs'> = { polygonSystemLogs: false },
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
      : receipt.status === 0 || !ranCode(tx, receipt, network.polygonSystemLogs)
        ? 'complete'
        : 'partial';
  return {
    id: tx.hash,
    observation: chainObservation(tx, receipt),
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
