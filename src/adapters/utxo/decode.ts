/**
 * Esplora transactions as `DriverTransaction`s (SDK-free). Every output with an address is a
 * `vout:<n>` transfer from the input addresses (spec §6.6); an output this library cannot
 * name that carries value (a future witness version, a bare script) makes the decoding
 * `partial`. A Bitcoin transaction that is in a block has executed: `success` is `true`
 * (lesson 15: general decoding reports the chain as it is).
 */
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import { toHex } from '../../core/util/bytes';
import { decodeAddress, type AddressParams, type DecodedAddress } from './address';
import type { EsploraOutput, EsploraStatus, EsploraTx } from './types';

export function observationOf(txid: string, status: EsploraStatus): DriverTxObservation {
  return status.confirmed
    ? {
        seen: 'block',
        txHash: txid,
        blockHeight: status.blockHeight as bigint,
        blockHash: status.blockHash as string,
        success: true,
      }
    : { seen: 'mempool', txHash: txid };
}

/**
 * The canonical address of an output, or `undefined` when it has none on this network. The
 * server derives the address from the script; one that names another script is malformed
 * (lesson 6), so a transfer is never credited to an address the output does not pay.
 */
function addressOf(output: EsploraOutput, params: AddressParams): string | undefined {
  if (output.address === undefined) return undefined;
  let decoded: DecodedAddress;
  try {
    decoded = decodeAddress(output.address, params);
  } catch {
    return undefined;
  }
  if (toHex(decoded.script) !== output.script) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'malformed Esplora answer: an output address does not match its script',
    );
  }
  return decoded.canonical;
}

export function decodeTransaction(
  tx: EsploraTx,
  params: AddressParams,
): DriverTransaction {
  const coinbase = tx.vin.some((input) => input.coinbase);
  const from = [
    ...new Set(
      tx.vin.flatMap((input) => {
        const address = input.prevout ? addressOf(input.prevout, params) : undefined;
        return address ? [address] : [];
      }),
    ),
  ];
  const transfers: DriverTransfer[] = [];
  let partial = false;
  tx.vout.forEach((output, n) => {
    const to = addressOf(output, params);
    if (to === undefined) {
      if (output.value > 0n) partial = true;
      return;
    }
    transfers.push({
      locator: `vout:${n}`,
      from,
      to,
      asset: 'native',
      amount: output.value,
      source: 'native',
    });
  });
  return {
    id: tx.txid,
    observation: observationOf(tx.txid, tx.status),
    ...(coinbase ? {} : { fee: [{ asset: 'native' as const, amount: tx.fee }] }),
    transfers,
    decoding: partial ? 'partial' : 'complete',
    ...(tx.status.blockTime !== undefined ? { timestamp: tx.status.blockTime } : {}),
    details: {
      version: tx.version,
      locktime: tx.locktime,
      weight: tx.weight,
      vin: tx.vin.map((input) => ({
        txid: input.txid,
        vout: input.vout,
        coinbase: input.coinbase,
        sequence: input.sequence,
        ...(input.prevout
          ? {
              value: input.prevout.value,
              ...(input.prevout.address !== undefined
                ? { address: input.prevout.address }
                : {}),
            }
          : {}),
      })),
      vout: tx.vout.map((output, n) => ({
        n,
        value: output.value,
        type: output.type,
        ...(output.address !== undefined ? { address: output.address } : {}),
      })),
    },
  };
}
