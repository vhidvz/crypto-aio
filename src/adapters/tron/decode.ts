/**
 * Chain transactions into `DriverTransaction`s, and the verdict of our own transfers.
 * - General decoding (reads, scans, history) reports execution as the chain does (lesson
 *   15, R68): a TRX transfer is `native`, and so is the TRX a contract call sends; each
 *   TRC-20 `Transfer` log is a `token-event` (`log:<i>`); contract execution is `partial`
 *   (value may move without a log), a failed transaction moved nothing and is `complete`, and
 *   a contract type this model does not carry is `none` (D11).
 * - The verdict of our own Attempts (observe with an ordering, and the proofs; lessons 7 and
 *   15) also requires on-chain evidence that value moved: a TRC-20 `transfer(to, amount)`
 *   counts only with a `Transfer(owner, to, any positive amount)` log from the called
 *   contract.
 * - Verdict fields are read strictly (lesson 6): a missing, ill-typed or contradicting one
 *   is a malformed answer (retryable), which decides nothing, never a default. Decoding stays
 *   lenient on what the chain accepts: an unknown contract type, a memo of any size or bytes.
 * - `readRaw`'s `timestamp` and `feeLimit` are display only: no verdict or amount uses them.
 * Failure reasons are fixed literals (R24).
 */
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { fromHex } from '../../core/util/bytes';
import { TRANSFER_TOPIC, decodeTransferCall, decodeTransferLog } from './abi';
import { toBase58Address } from './address';
import { malformed, notServable, type TronTxInfo, type TronTxJson } from './http';
import type { TronCodec, TronContract, TronRawData } from './types';

export interface TxVerdict {
  readonly success: boolean;
  readonly reason?: string;
}

/** VM receipt results with a reason of their own; any other failure is generic. */
const FAILURE_REASONS: ReadonlyMap<string, string> = new Map([
  ['OUT_OF_ENERGY', 'out of energy'],
  ['REVERT', 'reverted'],
]);

/** A contract call that also sends TRX or a TRC-10 token: never a plain TRC-20 transfer. */
function carriesValue(contract: TronContract): boolean {
  return (
    contract.type === 'TriggerSmartContract' &&
    (contract.callValue !== undefined ||
      contract.callTokenValue !== undefined ||
      contract.tokenId !== undefined)
  );
}

/**
 * The chain's own verdict, from strictly read fields (no evidence check). The VM writes a
 * receipt result for every call it runs (`TransactionTrace.setResult`), `ret[0].contractRet`
 * repeats it, and the info's `FAILED` is set exactly when the call did not succeed
 * (`TransactionUtil.buildTransactionInfoInstance`, GreatVoyage-v4.8.2.2 `d5c3d1d1`). Other
 * contracts carry no receipt result: java-tron never includes one whose execution failed,
 * and blocks from 2018 carry no `ret` at all (mainnet block 2,000,000), so inclusion is
 * their success unless the node reports a failure.
 */
function executed(raw: TronRawData | null, tx: TronTxJson, info: TronTxInfo): TxVerdict {
  // Bound to the id asked for: another transaction's receipt decides nothing.
  if (info.id !== tx.id) throw malformed('transaction info');
  const vm = raw
    ? raw.contract.type === 'TriggerSmartContract'
    : info.receiptResult !== undefined;
  if (vm) {
    const result = info.receiptResult;
    if (result === undefined) throw malformed('receipt result');
    if (tx.contractRet !== undefined && tx.contractRet !== result) {
      throw malformed('contractRet');
    }
    if (result !== 'SUCCESS') {
      return {
        success: false,
        reason: FAILURE_REASONS.get(result) ?? 'contract execution failed',
      };
    }
    if (info.failed) throw malformed('result');
    return { success: true };
  }
  if (info.failed || (tx.contractRet !== undefined && tx.contractRet !== 'SUCCESS')) {
    return { success: false, reason: 'execution failed' };
  }
  return { success: true };
}

type Evidence = 'landed' | 'absent' | 'unreadable';

/**
 * What the called token logged for a TRC-20 `transfer(to, …)` (lessons 7 and 15, the
 * controller's final wording). `landed`: a `Transfer` from the sender to that recipient of
 * any positive amount, from the called contract. `unreadable`: nothing landed, and the
 * contract logged a `Transfer` event that does not read as one (its value indexed, say).
 * A call with a value, or with data that is not a canonical `transfer`, is `absent`.
 */
function transferEvidence(raw: TronRawData, info: TronTxInfo): Evidence {
  const { contract } = raw;
  if (contract.type !== 'TriggerSmartContract') return 'landed';
  if (carriesValue(contract)) return 'absent';
  const call = decodeTransferCall(contract.data);
  if (call === null) return 'absent';
  const emitter = contract.contract.slice(2);
  let unreadable = false;
  for (const log of info.logs) {
    if (log.address !== emitter) continue;
    const event = decodeTransferLog(log);
    if (event === null) {
      if (log.topics[0] === TRANSFER_TOPIC) unreadable = true;
    } else if (
      event.from === contract.owner &&
      event.to === call.to &&
      event.amount > 0n
    ) {
      return 'landed';
    }
  }
  return unreadable ? 'unreadable' : 'absent';
}

/**
 * Lessons 7 and 15 (clarified): a TRC-20 `transfer(to, …)` counts only if the called token
 * contract logged a `Transfer` from the sender to that recipient. Any positive amount counts:
 * a fee-on-transfer token (Tron USDT has a dormant fee switch) logs less than the call's
 * amount, and requiring the exact amount would prove a transfer that moved `failed`. A call
 * that also sends TRX or a TRC-10 token, or whose data is not a canonical `transfer`, is never
 * a plain TRC-20 transfer. Decoding reports the amounts that actually moved.
 */
export function transferLanded(raw: TronRawData, info: TronTxInfo): boolean {
  return transferEvidence(raw, info) === 'landed';
}

/** The chain's own view of an included transaction (no evidence check, lesson 15). */
export function chainVerdict(
  codec: TronCodec,
  tx: TronTxJson,
  info: TronTxInfo,
): TxVerdict {
  return executed(codec.readRaw(tx.rawHex), tx, info);
}

/**
 * The verdict of our own included transaction (observe with an ordering, `includedFinal`).
 * The driver built it, so its bytes read, its call is a canonical `transfer` that sends no
 * value, a node's answer for it carries `contractRet`, and a TRX transfer in a block executed;
 * anything else contradicts the signed transaction or the chain's rules and decides nothing
 * (lesson 18, widened), as does a token `Transfer` event that does not read.
 */
export function verdictOf(codec: TronCodec, tx: TronTxJson, info: TronTxInfo): TxVerdict {
  const raw = codec.readRaw(tx.rawHex);
  if (raw === null) throw malformed('raw_data_hex');
  if (tx.contractRet === undefined) throw malformed('contractRet');
  if (carriesValue(raw.contract)) throw malformed('call value');
  // M1 (F4-R10): an included TransferContract executed (java-tron never includes one that
  // failed), so any other answer on our own is impossible: a false `failed` on a proof path
  // would invite a second payment. The chain's view reports what the node says (lesson 15).
  if (
    raw.contract.type === 'TransferContract' &&
    (tx.contractRet !== 'SUCCESS' || info.failed)
  ) {
    throw malformed('contractRet');
  }
  // M2 (F4-R10): our own TRC-20 call is a canonical `transfer(to, amount)` (the builder
  // writes nothing else), so other call data contradicts the signed transaction.
  if (
    raw.contract.type === 'TriggerSmartContract' &&
    decodeTransferCall(raw.contract.data) === null
  ) {
    throw malformed('call data');
  }
  const chain = executed(raw, tx, info);
  if (!chain.success) return chain;
  const evidence = transferEvidence(raw, info);
  if (evidence === 'unreadable') throw malformed('Transfer log');
  return evidence === 'landed'
    ? chain
    : { success: false, reason: 'token transfer not evidenced' };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The memo (`raw_data.data`) as text: `undefined` without one, `null` when its bytes are not
 * UTF-8 (replacement characters would make two different memos read the same). Any size the
 * chain accepts reads: the driver's own 256-byte cap applies to what it writes.
 */
function memoOf(raw: TronRawData): string | null | undefined {
  if (raw.data === undefined) return undefined;
  try {
    return UTF8.decode(fromHex(raw.data));
  } catch {
    return null;
  }
}

/** A canonical `T…` address, or `null` for bytes that are not one (never thrown). */
function base58(hex: string): string | null {
  try {
    return toBase58Address(hex);
  } catch {
    return null;
  }
}

/**
 * Any transaction as the chain reports it. `info` and `blockHash` come together for an
 * included transaction; `pending` marks one the node holds in its pool.
 */
export function decodeTransaction(
  codec: TronCodec,
  tx: TronTxJson,
  info: TronTxInfo | null,
  blockHash: string | undefined,
  pending = false,
): DriverTransaction {
  if (info !== null && blockHash === undefined) throw notServable();
  const raw = codec.readRaw(tx.rawHex);
  const chain = info ? executed(raw, tx, info) : undefined;
  const observation: DriverTxObservation =
    info && chain && blockHash !== undefined
      ? {
          seen: 'block',
          txHash: tx.id,
          blockHeight: info.blockNumber,
          blockHash,
          success: chain.success,
          ...(chain.reason ? { reason: chain.reason } : {}),
        }
      : pending
        ? { seen: 'mempool', txHash: tx.id }
        : { seen: 'none' };
  const memo = raw ? memoOf(raw) : undefined;
  const owner = raw ? base58(raw.contract.owner) : null;
  const transfers: DriverTransfer[] = [];
  let decoding: DriverTransaction['decoding'] = 'complete';
  /** A movement with the memo; `null` (an address that does not read) is left out. */
  const add = (transfer: Omit<DriverTransfer, 'memo'> | null): void => {
    if (!transfer) decoding = 'partial';
    else transfers.push(typeof memo === 'string' ? { ...transfer, memo } : transfer);
  };
  const native = (to: string, amount: bigint) => {
    const recipient = base58(to);
    add(
      owner && recipient
        ? {
            locator: 'native',
            from: [owner],
            to: recipient,
            asset: 'native',
            amount,
            source: 'native',
          }
        : null,
    );
  };
  if (raw === null) {
    decoding = 'none';
  } else if (!info) {
    decoding = 'partial';
  } else if (chain?.success) {
    if (memo === null) decoding = 'partial';
    const { contract } = raw;
    if (contract.type === 'TransferContract') {
      native(contract.to, contract.amount);
    } else {
      // Value can move without a log (internal transfers), and a TRC-10 value has no asset
      // here: a contract call is partial.
      decoding = 'partial';
      if (contract.callValue !== undefined) native(contract.contract, contract.callValue);
      info.logs.forEach((log, index) => {
        const event = decodeTransferLog(log);
        if (!event) return;
        const from = base58(event.from);
        const to = base58(event.to);
        const token = base58(`41${log.address}`);
        add(
          from && to && token
            ? {
                locator: `log:${index}`,
                from: [from],
                to,
                asset: { standard: 'trc20', contract: token },
                amount: event.amount,
                source: 'token-event',
              }
            : null,
        );
      });
    }
  }
  const call = raw?.contract.type === 'TriggerSmartContract' ? raw.contract : undefined;
  return {
    id: tx.id,
    observation,
    ...(info ? { fee: [{ asset: 'native' as const, amount: info.fee }] } : {}),
    transfers,
    decoding,
    // The block's time: the client-set `raw_data.timestamp` is display only.
    ...(info ? { timestamp: info.blockTimestamp } : {}),
    details: {
      contract: raw?.contract.type ?? 'unknown',
      ...(owner ? { owner } : {}),
      ...(tx.contractRet !== undefined ? { result: tx.contractRet } : {}),
      ...(info?.receiptResult !== undefined ? { receipt: info.receiptResult } : {}),
      ...(raw?.feeLimit !== undefined ? { feeLimit: BigInt(raw.feeLimit) } : {}),
      ...(call?.callValue !== undefined ? { callValue: call.callValue } : {}),
      ...(call?.callTokenValue !== undefined
        ? { callTokenValue: call.callTokenValue }
        : {}),
      ...(call?.tokenId !== undefined ? { tokenId: call.tokenId } : {}),
    },
  };
}
