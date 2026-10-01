/**
 * Avalanche bytes through avalanchejs: unspent outputs, signed transactions, BaseTx
 * building and credential assembly.
 * - Every parse is a round trip: bytes that do not re-encode to themselves are not taken.
 * - A transaction signs one digest, the SHA-256 of its unsigned bytes; every input's
 *   credential carries the same 65-byte recoverable signature (r, s, recovery id).
 * - A built transaction is checked before it is used (defence in depth against the SDK):
 *   its network and chain, that it spends only the outputs offered, pays every intended
 *   output exactly, sends the rest back to the sender, and burns exactly the expected fee.
 * - A transaction's senders are the addresses its signatures recover to, for every input,
 *   imported ones included.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { ChainError, ProviderError, ValidationError } from '../../core/errors/error';
import { equalBytes, fromHex, toHex } from '../../core/util/bytes';
import { malformed } from './api';
import { cb58Decode, cb58Encode, idOf } from './cb58';
import type { AvalancheNetworkConfig } from './network';
import {
  TYPES,
  avalanche,
  type SdkContext,
  type SdkFeeState,
  type SdkOutputOwners,
  type SdkSignedTx,
  type SdkTransaction,
  type SdkTransferOutput,
  type SdkUtxo,
} from './sdk';
import type { FeeWeights } from './api';

/** AvalancheGo's mempool refuses a transaction of more bytes (`MaxTxSize`, 64 KiB). */
export const MAX_TX_BYTES = 64 * 1024;
/** A secp256k1 credential of one signature: type id, count and the signature. */
const CREDENTIAL_BYTES = 4 + 4 + 65;
/** `avax.MaxMemoSize`. */
export const MAX_MEMO_BYTES = 256;

const vmName = (config: Pick<AvalancheNetworkConfig, 'vm'>): 'AVM' | 'PVM' =>
  config.vm === 'avm' ? 'AVM' : 'PVM';

/** A reservation key: `txID:outputIndex`. */
export const utxoKey = (txId: string, outputIndex: number): string =>
  `${txId}:${outputIndex}`;

/** The `utxoId` of raw UTXO bytes: codec (2), txID (32), output index (4) lead them all. */
export function utxoKeyOf(bytes: Uint8Array): string {
  if (bytes.length < 38) throw malformed('utxo');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return utxoKey(cb58Encode(bytes.subarray(2, 34)), view.getUint32(34));
}

/** An unspent output, read from the node's bytes. */
export interface ParsedUtxo {
  readonly utxoId: string;
  readonly txId: string;
  readonly outputIndex: number;
  readonly assetId: string;
  readonly amount: bigint;
  readonly locktime: bigint;
  readonly threshold: number;
  readonly owners: readonly Uint8Array[];
  /** A `secp256k1fx.TransferOutput` (not stake-locked, minted or an NFT). */
  readonly plain: boolean;
  readonly sdk: SdkUtxo;
}

const hasAmount = (value: unknown): value is { amount(): bigint } =>
  typeof (value as { amount?: unknown }).amount === 'function';

function ownersOf(output: { readonly _type: string }): SdkOutputOwners | undefined {
  if (output._type === TYPES.transferOutput) {
    return (output as SdkTransferOutput).outputOwners;
  }
  if (output._type === TYPES.stakeableLockOut) {
    const inner = (output as unknown as { transferOut: { _type: string } }).transferOut;
    return inner._type === TYPES.transferOutput
      ? (inner as SdkTransferOutput).outputOwners
      : undefined;
  }
  return undefined;
}

export function parseUtxo(
  bytes: Uint8Array,
  config: Pick<AvalancheNetworkConfig, 'vm'>,
): ParsedUtxo {
  const manager = avalanche.utils.getManagerForVM(vmName(config));
  let utxo: SdkUtxo;
  try {
    utxo = manager.unpack(bytes, avalanche.Utxo);
  } catch {
    throw malformed('utxo');
  }
  const reencoded = (() => {
    try {
      return new Uint8Array([0, 0, ...utxo.toBytes(manager.getDefaultCodec())]);
    } catch {
      throw malformed('utxo');
    }
  })();
  if (!equalBytes(reencoded, bytes)) throw malformed('utxo');
  const owners = ownersOf(utxo.output);
  const plain = utxo.output._type === TYPES.transferOutput;
  const amount = hasAmount(utxo.output) ? utxo.output.amount() : 0n;
  const locktime =
    utxo.output._type === TYPES.stakeableLockOut
      ? (utxo.output as unknown as { getLocktime(): bigint }).getLocktime()
      : (owners?.locktime.value() ?? 0n);
  const txId = utxo.utxoId.txID.toString();
  const outputIndex = utxo.utxoId.outputIdx.value();
  return {
    utxoId: utxoKey(txId, outputIndex),
    txId,
    outputIndex,
    assetId: utxo.assetId.toString(),
    amount,
    locktime,
    threshold: owners?.threshold.value() ?? 0,
    owners: owners?.addrs.map((a) => a.toBytes()) ?? [],
    plain,
    sdk: utxo,
  };
}

/** Whether a transfer from `from` may spend `utxo`: plain AVAX, unlocked, `from` alone signs. */
export function spendableBy(
  utxo: ParsedUtxo,
  from: Uint8Array,
  config: Pick<AvalancheNetworkConfig, 'avaxAssetId'>,
): boolean {
  return (
    utxo.plain &&
    utxo.assetId === config.avaxAssetId &&
    utxo.amount > 0n &&
    utxo.locktime === 0n &&
    utxo.threshold === 1 &&
    utxo.owners.some((owner) => equalBytes(owner, from))
  );
}

/** Signed transaction bytes, parsed; their unsigned part re-encoded. */
export interface ParsedTx {
  readonly id: string;
  readonly signed: SdkSignedTx;
  readonly tx: SdkTransaction;
  readonly unsignedBytes: Uint8Array;
}

export function parseSignedTx(
  bytes: Uint8Array,
  config: Pick<AvalancheNetworkConfig, 'vm'>,
): ParsedTx {
  const manager = avalanche.utils.getManagerForVM(vmName(config));
  let signed: SdkSignedTx;
  let reencoded: Uint8Array;
  let unsignedBytes: Uint8Array;
  try {
    signed = manager.unpack(bytes, avalanche.avaxSerial.SignedTx);
    reencoded = signed.toBytes();
    unsignedBytes = manager.packCodec(signed.unsignedTx);
  } catch {
    throw malformed('transaction');
  }
  if (
    !equalBytes(reencoded, bytes) ||
    !equalBytes(bytes.subarray(0, unsignedBytes.length), unsignedBytes)
  ) {
    throw malformed('transaction');
  }
  return { id: idOf(bytes), signed, tx: signed.unsignedTx, unsignedBytes };
}

/** The unsigned transaction in `bytes` (a prepared payload), re-encoded exactly. */
export function parseUnsignedTx(
  bytes: Uint8Array,
  config: Pick<AvalancheNetworkConfig, 'vm'>,
): SdkTransaction {
  const manager = avalanche.utils.getManagerForVM(vmName(config));
  let tx: SdkTransaction;
  try {
    tx = manager.unpackTransaction(bytes);
    if (!equalBytes(manager.packCodec(tx), bytes)) throw new Error('not exact');
  } catch {
    throw new ValidationError(
      'INVALID_INTENT',
      'not an unsigned transaction of this chain',
    );
  }
  return tx;
}

/** `r ‖ s ‖ v`: a 64-byte compact signature and its recovery id, as credentials hold them. */
export function credentialSignature(compact: Uint8Array, recovery: number): Uint8Array {
  const out = new Uint8Array(65);
  out.set(compact, 0);
  out[64] = recovery;
  return out;
}

/** The signed bytes: every input's credential carries `signature` once per signer index. */
export function assembleSigned(
  unsignedBytes: Uint8Array,
  signature: Uint8Array,
  config: Pick<AvalancheNetworkConfig, 'vm'>,
): Uint8Array {
  const tx = parseUnsignedTx(unsignedBytes, config);
  const credentials = tx
    .getSigIndices()
    .map(
      (indices) =>
        new avalanche.Credential(indices.map(() => new avalanche.Signature(signature))),
    );
  return new avalanche.avaxSerial.SignedTx(tx, credentials).toBytes();
}

/** The 20-byte address a 65-byte signature over `digest` recovers to, if any. */
function signerOf(signature: Uint8Array, digest: Uint8Array): Uint8Array | undefined {
  if (signature.length !== 65 || (signature[64] as number) > 3) return undefined;
  try {
    const publicKey = secp256k1.Signature.fromCompact(signature.subarray(0, 64))
      .addRecoveryBit(signature[64] as number)
      .recoverPublicKey(digest)
      .toRawBytes(true);
    return ripemd160(sha256(publicKey));
  } catch {
    return undefined;
  }
}

/** The addresses that signed `parsed`, once each, in credential order. */
export function signersOf(parsed: ParsedTx): Uint8Array[] {
  const digest = sha256(parsed.unsignedBytes);
  const found = new Map<string, Uint8Array>();
  for (const credential of parsed.signed.getCredentials()) {
    if (credential._type !== TYPES.credential) continue;
    for (const hex of credential.getSignatures()) {
      const address = signerOf(fromHex(hex.replace(/^0x/, '')), digest);
      if (address) found.set(toHex(address), address);
    }
  }
  return [...found.values()];
}

/** avalanchejs's `Context` for this network; `fees` fills the fee fields the builder reads. */
export function sdkContext(
  config: AvalancheNetworkConfig,
  fees: { readonly txFee?: bigint; readonly weights?: FeeWeights } = {},
): SdkContext {
  const [bandwidth, dbRead, dbWrite, compute] = fees.weights ?? [0, 0, 0, 0];
  return {
    networkID: config.networkId,
    hrp: config.hrp,
    xBlockchainID: config.vm === 'avm' ? config.blockchainId : '',
    pBlockchainID: config.vm === 'pvm' ? config.blockchainId : '',
    cBlockchainID: '',
    avaxAssetID: config.avaxAssetId,
    baseTxFee: fees.txFee ?? 0n,
    createAssetTxFee: 0n,
    platformFeeConfig: {
      weights: avalanche.Common.createDimensions({ bandwidth, dbRead, dbWrite, compute }),
      maxCapacity: 0n,
      maxPerSecond: 0n,
      targetPerSecond: 0n,
      minPrice: 0n,
      excessConversionConstant: 0n,
    },
  };
}

export type FeePlan =
  | { readonly model: 'static'; readonly txFee: bigint }
  | {
      readonly model: 'dynamic';
      readonly price: bigint;
      readonly state: SdkFeeState;
      readonly weights: FeeWeights;
    };

export interface PlannedOutput {
  readonly to: Uint8Array;
  readonly amount: bigint;
}

export interface BuiltTx {
  /** The unsigned bytes (codec version and transaction). */
  readonly bytes: Uint8Array;
  readonly inputs: readonly string[];
  readonly fee: bigint;
  /** P-Chain: the gas the transaction uses. */
  readonly gas?: bigint;
  readonly change: bigint;
  readonly outputs: number;
}

/** The absurd-fee guard: no transfer ever pays more than `options.maxFee`. */
export function assertSaneFee(
  fee: bigint,
  config: Pick<AvalancheNetworkConfig, 'maxFee'>,
): void {
  if (fee > config.maxFee) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the fee exceeds the configured maximum (options.maxFee)',
    );
  }
}

const insufficient = (required: bigint, available: bigint): ChainError =>
  new ChainError('INSUFFICIENT_FUNDS', 'insufficient funds for this transfer', {
    details: { required: required.toString(), available: available.toString() },
  });

/**
 * A BaseTx from `from` paying `outputs`, spending the first of `utxos` (in their order)
 * that cover the outputs and the fee, with change back to `from`. Checked before it is
 * returned.
 */
export function buildBaseTx(args: {
  readonly config: AvalancheNetworkConfig;
  readonly from: Uint8Array;
  readonly utxos: readonly ParsedUtxo[];
  readonly outputs: readonly PlannedOutput[];
  readonly memo: Uint8Array;
  readonly minIssuanceTime: bigint;
  readonly fee: FeePlan;
}): BuiltTx {
  const { config, from, utxos, fee } = args;
  const outputs = args.outputs.map((o) =>
    avalanche.TransferableOutput.fromNative(config.avaxAssetId, o.amount, [o.to], 0n, 1),
  );
  const sdkUtxos = utxos.map((u) => u.sdk);
  let tx: SdkTransaction;
  let bytes: Uint8Array;
  try {
    const unsigned =
      fee.model === 'static'
        ? avalanche.avm.newBaseTx(
            sdkContext(config, { txFee: fee.txFee }),
            [from],
            sdkUtxos,
            outputs,
            {
              changeAddresses: [from],
              memo: args.memo,
              minIssuanceTime: args.minIssuanceTime,
            },
          )
        : avalanche.pvm.newBaseTx(
            {
              feeState: { ...fee.state, price: fee.price },
              fromAddressesBytes: [from],
              changeAddressesBytes: [from],
              outputs,
              utxos: sdkUtxos,
              memo: args.memo,
              minIssuanceTime: args.minIssuanceTime,
            },
            sdkContext(config, { weights: fee.weights }),
          );
    tx = unsigned.getTx();
    bytes = unsigned.toBytes();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const available = utxos.reduce((sum, u) => sum + u.amount, 0n);
    const paid = args.outputs.reduce((sum, o) => sum + o.amount, 0n);
    if (/insufficient funds/i.test(message)) throw insufficient(paid, available);
    if (/exceeds capacity/i.test(message)) {
      throw new ChainError(
        'TX_REFUSED',
        'the P-Chain has no gas capacity for this transaction now; retry later',
        { retryable: true },
      );
    }
    throw error;
  }
  return checkBuilt({ ...args, tx, bytes });
}

const sameOwners = (owners: SdkOutputOwners, address: Uint8Array): boolean =>
  owners.locktime.value() === 0n &&
  owners.threshold.value() === 1 &&
  owners.addrs.length === 1 &&
  equalBytes(owners.addrs[0]?.toBytes() ?? new Uint8Array(), address);

const sdkMismatch = (what: string): ProviderError =>
  new ProviderError('PROVIDER_UNAVAILABLE', `the built transaction is wrong: ${what}`, {
    retryable: false,
  });

function checkBuilt(args: {
  readonly config: AvalancheNetworkConfig;
  readonly from: Uint8Array;
  readonly utxos: readonly ParsedUtxo[];
  readonly outputs: readonly PlannedOutput[];
  readonly memo: Uint8Array;
  readonly fee: FeePlan;
  readonly tx: SdkTransaction;
  readonly bytes: Uint8Array;
}): BuiltTx {
  const { config, from, tx, fee } = args;
  const base = tx.baseTx;
  if (!base) throw sdkMismatch('no base transaction');
  if (
    base.NetworkId.value() !== config.networkId ||
    base.BlockchainId.toString() !== config.blockchainId
  ) {
    throw sdkMismatch('another network or chain');
  }
  if (!equalBytes(base.memo.bytes, args.memo)) throw sdkMismatch('the memo');
  const offered = new Map(args.utxos.map((u) => [u.utxoId, u]));
  const inputs: string[] = [];
  let spent = 0n;
  for (const input of base.inputs) {
    const key = utxoKey(input.utxoID.txID.toString(), input.utxoID.outputIdx.value());
    const utxo = offered.get(key);
    if (!utxo || inputs.includes(key) || input.amount() !== utxo.amount) {
      throw sdkMismatch('an input that was not offered');
    }
    inputs.push(key);
    spent += utxo.amount;
  }
  // Every intended output exactly once; every other output is change to the sender.
  const pending = [...args.outputs];
  let paid = 0n;
  let change = 0n;
  for (const output of base.outputs) {
    if (
      output.assetId.toString() !== config.avaxAssetId ||
      output.output._type !== TYPES.transferOutput
    ) {
      throw sdkMismatch('an output that is not plain AVAX');
    }
    const owners = (output.output as SdkTransferOutput).outputOwners;
    const amount = output.amount();
    const index = pending.findIndex(
      (p) => p.amount === amount && sameOwners(owners, p.to),
    );
    if (index !== -1) {
      pending.splice(index, 1);
      paid += amount;
    } else if (sameOwners(owners, from)) {
      change += amount;
    } else {
      throw sdkMismatch('an output to an address not asked for');
    }
  }
  if (pending.length > 0) throw sdkMismatch('an intended output is missing');
  const burned = spent - paid - change;
  let gas: bigint | undefined;
  let expected: bigint;
  if (fee.model === 'static') {
    expected = fee.txFee;
  } else {
    const weights = avalanche.Common.createDimensions({
      bandwidth: fee.weights[0],
      dbRead: fee.weights[1],
      dbWrite: fee.weights[2],
      compute: fee.weights[3],
    });
    expected = avalanche.pvm.calculateFee(tx, weights, fee.price);
    gas = expected / (fee.price === 0n ? 1n : fee.price);
  }
  if (burned !== expected) throw sdkMismatch('it burns another fee');
  assertSaneFee(burned, config);
  const signedSize = args.bytes.length + 4 + base.inputs.length * CREDENTIAL_BYTES;
  if (signedSize > MAX_TX_BYTES) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the transaction would exceed 64 KiB; send fewer outputs or consolidate small outputs first',
    );
  }
  return {
    bytes: args.bytes,
    inputs: [...inputs].sort(),
    fee: burned,
    ...(gas !== undefined ? { gas } : {}),
    change,
    outputs: base.outputs.length,
  };
}

/**
 * An output that does not exist: `amount` of AVAX owned by `owner`, at a zero transaction
 * id. Fee estimates build with it when the wallet's outputs do not cover a transfer, so the
 * estimate still names the fee of a one-input transaction. Never spent.
 */
export function syntheticUtxo(
  owner: Uint8Array,
  amount: bigint,
  config: Pick<AvalancheNetworkConfig, 'vm' | 'avaxAssetId'>,
): ParsedUtxo {
  const asset = cb58Decode(config.avaxAssetId) as Uint8Array;
  const bytes = new Uint8Array(2 + 32 + 4 + 32 + 4 + 8 + 8 + 4 + 4 + 20);
  const view = new DataView(bytes.buffer);
  bytes.set(asset, 38);
  view.setUint32(70, 7); // secp256k1fx.TransferOutput, in both chains' codecs
  view.setBigUint64(74, amount);
  view.setUint32(90, 1); // threshold
  view.setUint32(94, 1); // one owner
  bytes.set(owner, 98);
  return parseUtxo(bytes, config);
}
