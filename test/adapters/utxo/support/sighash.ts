/**
 * An independent implementation of the three signature hashes the driver uses (legacy
 * SIGHASH_ALL, BIP143 SIGHASH_ALL, BIP341 key path SIGHASH_DEFAULT), over `@noble/hashes`
 * only, for cross-checking bitcoinjs-lib. Test-only.
 */
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { concatBytes, fromHex } from '../../../../src/core/util/bytes';

export interface TxModel {
  readonly version: number;
  readonly locktime: number;
  readonly inputs: readonly {
    readonly txid: string;
    readonly vout: number;
    readonly sequence: number;
    readonly value: bigint;
    readonly script: Uint8Array;
  }[];
  readonly outputs: readonly { readonly script: Uint8Array; readonly value: bigint }[];
}

const le32 = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
const le64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
const varint = (n: number): Uint8Array => {
  if (n >= 0xfd) throw new Error('long varints are not needed here');
  return Uint8Array.of(n);
};
const withLength = (bytes: Uint8Array): Uint8Array =>
  concatBytes(varint(bytes.length), bytes);
const dsha = (bytes: Uint8Array): Uint8Array => sha256(sha256(bytes));
const outpoint = (input: TxModel['inputs'][number]): Uint8Array =>
  concatBytes(fromHex(input.txid).reverse(), le32(input.vout));
const outputs = (tx: TxModel): Uint8Array =>
  concatBytes(...tx.outputs.map((o) => concatBytes(le64(o.value), withLength(o.script))));

/** Legacy SIGHASH_ALL: the input's script code in place, every other scriptSig empty. */
export function legacySighash(
  tx: TxModel,
  index: number,
  scriptCode: Uint8Array,
): Uint8Array {
  const ins = tx.inputs.map((input, i) =>
    concatBytes(
      outpoint(input),
      i === index ? withLength(scriptCode) : Uint8Array.of(0),
      le32(input.sequence),
    ),
  );
  return dsha(
    concatBytes(
      le32(tx.version),
      varint(tx.inputs.length),
      ...ins,
      varint(tx.outputs.length),
      outputs(tx),
      le32(tx.locktime),
      le32(1),
    ),
  );
}

/** BIP143 SIGHASH_ALL. */
export function bip143Sighash(
  tx: TxModel,
  index: number,
  scriptCode: Uint8Array,
): Uint8Array {
  const input = tx.inputs[index] as TxModel['inputs'][number];
  return dsha(
    concatBytes(
      le32(tx.version),
      dsha(concatBytes(...tx.inputs.map(outpoint))),
      dsha(concatBytes(...tx.inputs.map((i) => le32(i.sequence)))),
      outpoint(input),
      withLength(scriptCode),
      le64(input.value),
      le32(input.sequence),
      dsha(outputs(tx)),
      le32(tx.locktime),
      le32(1),
    ),
  );
}

const tagged = (tag: string, message: Uint8Array): Uint8Array => {
  const t = sha256(utf8ToBytes(tag));
  return sha256(concatBytes(t, t, message));
};

/** BIP341 key-path SIGHASH_DEFAULT (no annex). */
export function bip341Sighash(tx: TxModel, index: number): Uint8Array {
  return tagged(
    'TapSighash',
    concatBytes(
      Uint8Array.of(0x00, 0x00),
      le32(tx.version),
      le32(tx.locktime),
      sha256(concatBytes(...tx.inputs.map(outpoint))),
      sha256(concatBytes(...tx.inputs.map((i) => le64(i.value)))),
      sha256(concatBytes(...tx.inputs.map((i) => withLength(i.script)))),
      sha256(concatBytes(...tx.inputs.map((i) => le32(i.sequence)))),
      sha256(outputs(tx)),
      Uint8Array.of(0x00),
      le32(index),
    ),
  );
}
