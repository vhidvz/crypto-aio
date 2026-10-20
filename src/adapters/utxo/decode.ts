/**
 * Esplora transactions as `DriverTransaction`s (SDK-free). Every output whose script has an
 * address is a `vout:<n>` transfer from the input addresses; an output this
 * library cannot name that carries value (a future witness version, a bare script) makes the
 * decoding `partial`. Addresses are derived from the scripts, never taken from the server's
 * `scriptpubkey_address`, which a server could leave out (making a deposit `partial`) or
 * change (crediting another address). A Bitcoin transaction that is in a block has executed:
 * `success` is `true` (general decoding reports the chain as it is).
 */
import type {
  DriverTransaction,
  DriverTransfer,
  DriverTxObservation,
} from '../../core/driver/types';
import { fromHex } from '../../core/util/bytes';
import { addressFromScript, type AddressParams } from './address';
import type { EsploraOutput, EsploraStatus, EsploraTx } from './types';

/**
 * Esplora's name for an output script's type, from the script itself: rust-bitcoin's
 * predicates in Blockstream electrs' order (`TxOutValue::new`), so a transaction read from a
 * block's own bytes decodes as Blockstream's page of it would. mempool/electrs names a few
 * more (`anchor`, `multisig`, and `op_return` for any provably unspendable script); a scan
 * names them all the one way, whatever server it reads.
 */
export function scriptType(script: Uint8Array): string {
  const n = script.length;
  const at = (i: number): number | undefined => script[i];
  if (n === 0) return 'empty';
  if (at(0) === 0x6a) return 'op_return';
  if (((n === 35 && at(0) === 33) || (n === 67 && at(0) === 65)) && at(n - 1) === 0xac) {
    return 'p2pk';
  }
  if (
    n === 25 &&
    at(0) === 0x76 &&
    at(1) === 0xa9 &&
    at(2) === 0x14 &&
    at(23) === 0x88 &&
    at(24) === 0xac
  ) {
    return 'p2pkh';
  }
  if (n === 23 && at(0) === 0xa9 && at(1) === 0x14 && at(22) === 0x87) return 'p2sh';
  if (n === 22 && at(0) === 0x00 && at(1) === 0x14) return 'v0_p2wpkh';
  if (n === 34 && at(0) === 0x00 && at(1) === 0x20) return 'v0_p2wsh';
  if (n === 34 && at(0) === 0x51 && at(1) === 0x20) return 'v1_p2tr';
  return 'unknown';
}

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

/** The canonical address an output's script pays on this network, or `undefined`. */
function addressOf(output: EsploraOutput, params: AddressParams): string | undefined {
  return addressFromScript(fromHex(output.script), params)?.canonical;
}

export function decodeTransaction(
  tx: EsploraTx,
  params: AddressParams,
): DriverTransaction {
  const coinbase = tx.vin.some((input) => input.coinbase);
  const senders = tx.vin.map((input) =>
    input.prevout ? addressOf(input.prevout, params) : undefined,
  );
  const recipients = tx.vout.map((output) => addressOf(output, params));
  const from = [
    ...new Set(senders.filter((address): address is string => address !== undefined)),
  ];
  const transfers: DriverTransfer[] = [];
  let partial = false;
  tx.vout.forEach((output, n) => {
    const to = recipients[n];
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
      vin: tx.vin.map((input, n) => {
        const address = senders[n];
        return {
          txid: input.txid,
          vout: input.vout,
          coinbase: input.coinbase,
          sequence: input.sequence,
          ...(input.prevout
            ? {
                value: input.prevout.value,
                ...(address !== undefined ? { address } : {}),
              }
            : {}),
        };
      }),
      vout: tx.vout.map((output, n) => {
        const address = recipients[n];
        return {
          n,
          value: output.value,
          type: output.type,
          ...(address !== undefined ? { address } : {}),
        };
      }),
    },
  };
}
