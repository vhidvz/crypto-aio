/**
 * The one place that loads `@avalabs/avalanchejs`, at run time with `require()` (its 5.x
 * package is an ES module with a CommonJS build). Its type declarations re-export their own
 * modules without file extensions, which TypeScript cannot follow under `node16`
 * resolution, so the part of the SDK this library uses is declared here instead: the codec
 * managers, the transaction builders, the P-Chain fee calculator and the serializable
 * classes the driver reads. The tests run every declared member against the real package.
 * Loaded only through the manifest's `load()`.
 */

/** A serializable avalanchejs object; `_type` names its class (e.g. `avm.BaseTx`). */
export interface SdkSerializable {
  readonly _type: string;
}

export interface SdkId {
  toString(): string;
  toBytes(): Uint8Array;
}

export interface SdkInt {
  value(): number;
}

export interface SdkBigInt {
  value(): bigint;
}

export interface SdkAddress {
  toBytes(): Uint8Array;
}

export interface SdkOutputOwners {
  readonly locktime: SdkBigInt;
  readonly threshold: SdkInt;
  readonly addrs: readonly SdkAddress[];
}

/** A `secp256k1fx.TransferOutput`. */
export interface SdkTransferOutput extends SdkSerializable {
  readonly outputOwners: SdkOutputOwners;
  amount(): bigint;
}

export interface SdkTransferableOutput extends SdkSerializable {
  readonly assetId: SdkId;
  readonly output: SdkSerializable;
  amount(): bigint;
}

export interface SdkUtxoId {
  readonly txID: SdkId;
  readonly outputIdx: SdkInt;
}

export interface SdkTransferableInput extends SdkSerializable {
  readonly utxoID: SdkUtxoId;
  readonly assetId: SdkId;
  amount(): bigint;
  sigIndicies(): number[];
}

export interface SdkUtxo extends SdkSerializable {
  readonly utxoId: SdkUtxoId;
  readonly assetId: SdkId;
  readonly output: SdkSerializable;
  /** Its bytes without the codec version, in `codec`. */
  toBytes(codec: unknown): Uint8Array;
}

/** The `avax.BaseTx` every X-Chain and most P-Chain transactions carry. */
export interface SdkBaseTx {
  readonly NetworkId: SdkInt;
  readonly BlockchainId: SdkId;
  readonly outputs: readonly SdkTransferableOutput[];
  readonly inputs: readonly SdkTransferableInput[];
  readonly memo: { readonly bytes: Uint8Array };
}

/** An unsigned transaction of any type (`avm.*`, `pvm.*`). */
export interface SdkTransaction extends SdkSerializable {
  readonly vm: string;
  readonly baseTx?: SdkBaseTx;
  getSigIndices(): number[][];
}

export interface SdkCredential extends SdkSerializable {
  /** Each signature as hex (65 bytes: r, s, recovery id). */
  getSignatures(): string[];
}

export interface SdkSignedTx {
  readonly unsignedTx: SdkTransaction;
  getCredentials(): SdkCredential[];
  toBytes(): Uint8Array;
}

/** A builder's result. */
export interface SdkUnsignedTx {
  getTx(): SdkTransaction;
  toBytes(): Uint8Array;
}

export interface SdkManager {
  getDefaultCodec(): unknown;
  unpack<T>(bytes: Uint8Array, unpacker: SdkUnpacker<T>): T;
  unpackTransaction(bytes: Uint8Array): SdkTransaction;
  packCodec(serializable: SdkSerializable): Uint8Array;
}

/** A class `Manager.unpack` reads (`Utxo`, `avaxSerial.SignedTx`). */
export interface SdkUnpacker<T> {
  fromBytes(bytes: Uint8Array, codec: unknown): [T, Uint8Array];
}

export interface SdkDimensions {
  readonly 0: number;
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
}

/** avalanchejs's `Context`: what its builders need to know about the network. */
export interface SdkContext {
  readonly networkID: number;
  readonly hrp: string;
  readonly xBlockchainID: string;
  readonly pBlockchainID: string;
  readonly cBlockchainID: string;
  readonly avaxAssetID: string;
  readonly baseTxFee: bigint;
  readonly createAssetTxFee: bigint;
  readonly platformFeeConfig: {
    readonly weights: SdkDimensions;
    readonly maxCapacity: bigint;
    readonly maxPerSecond: bigint;
    readonly targetPerSecond: bigint;
    readonly minPrice: bigint;
    readonly excessConversionConstant: bigint;
  };
}

export interface SdkFeeState {
  readonly capacity: bigint;
  readonly excess: bigint;
  readonly price: bigint;
  readonly timestamp: string;
}

export interface SdkSignature extends SdkSerializable {
  toString(): string;
}

/** The members of `@avalabs/avalanchejs` this library calls. */
export interface AvalancheSdk {
  readonly Utxo: SdkUnpacker<SdkUtxo>;
  readonly avaxSerial: {
    readonly SignedTx: SdkUnpacker<SdkSignedTx> &
      (new (tx: SdkTransaction, credentials: SdkSerializable[]) => SdkSignedTx);
  };
  readonly Credential: new (signatures: SdkSignature[]) => SdkCredential;
  readonly Signature: new (bytes: Uint8Array) => SdkSignature;
  readonly TransferableOutput: {
    fromNative(
      assetId: string,
      amount: bigint,
      addresses: readonly Uint8Array[],
      locktime?: bigint,
      threshold?: number,
    ): SdkTransferableOutput;
  };
  readonly Common: {
    createDimensions(dimensions: {
      bandwidth: number;
      dbRead: number;
      dbWrite: number;
      compute: number;
    }): SdkDimensions;
  };
  readonly utils: {
    getManagerForVM(vm: 'AVM' | 'PVM'): SdkManager;
    getBurnedAmountByTx(tx: SdkTransaction, context: SdkContext): Map<string, bigint>;
  };
  readonly avm: {
    newBaseTx(
      context: SdkContext,
      fromAddressesBytes: readonly Uint8Array[],
      utxos: readonly SdkUtxo[],
      outputs: readonly SdkTransferableOutput[],
      options: {
        readonly changeAddresses: readonly Uint8Array[];
        readonly memo: Uint8Array;
        readonly minIssuanceTime: bigint;
      },
    ): SdkUnsignedTx;
  };
  readonly pvm: {
    newBaseTx(
      props: {
        readonly feeState: SdkFeeState;
        readonly fromAddressesBytes: readonly Uint8Array[];
        readonly changeAddressesBytes: readonly Uint8Array[];
        readonly outputs: readonly SdkTransferableOutput[];
        readonly utxos: readonly SdkUtxo[];
        readonly memo: Uint8Array;
        readonly minIssuanceTime: bigint;
      },
      context: SdkContext,
    ): SdkUnsignedTx;
    calculateFee(tx: SdkTransaction, weights: SdkDimensions, price: bigint): bigint;
  };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const avalanche = require('@avalabs/avalanchejs') as AvalancheSdk;

/** The serializable class names the driver tells apart. */
export const TYPES = Object.freeze({
  transferOutput: 'secp256k1fx.TransferOutput',
  stakeableLockOut: 'pvm.StakeableLockOut',
  credential: 'secp256k1fx.Credential',
});
