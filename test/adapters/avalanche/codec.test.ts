import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import {
  buildBaseTx,
  parseSignedTx,
  parseUnsignedTx,
  parseUtxo,
  syntheticUtxo,
  utxoKeyOf,
  type FeePlan,
} from '../../../src/adapters/avalanche/codec';
import { decodeTransaction } from '../../../src/adapters/avalanche/decode';
import { avalanche, type SdkUnsignedTx } from '../../../src/adapters/avalanche/sdk';
import { toHex } from '../../../src/core/util/bytes';
import { signWith } from './support/node';
import { OTHER_BYTES, TEST_BYTES, TEST_KEY, configOf, type Vm } from './support/vectors';
import { formatAddress } from '../../../src/adapters/avalanche/address';

// The whole SDK, for transaction types this library never builds.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = require('@avalabs/avalanchejs');

const X = configOf('avm');
const P = configOf('pvm');
const STATIC: FeePlan = { model: 'static', txFee: 1_000_000n };
const block = { seen: 'block' as const, blockHeight: 1n, blockHash: 'h', success: true };

function utxoOf(vm: Vm, amount: bigint, owner = TEST_BYTES) {
  return syntheticUtxo(owner, amount, vm === 'avm' ? X : P);
}

describe('unspent outputs', () => {
  it.each(['avm', 'pvm'] as Vm[])('builds and reads a synthetic %s output', (vm) => {
    const utxo = utxoOf(vm, 123n);
    expect(utxo).toMatchObject({
      outputIndex: 0,
      assetId: (vm === 'avm' ? X : P).avaxAssetId,
      amount: 123n,
      locktime: 0n,
      threshold: 1,
      plain: true,
    });
    expect(utxo.owners).toEqual([TEST_BYTES]);
  });

  it('refuses bytes that are not exactly one output', () => {
    const utxo = utxoOf('avm', 5n);
    const bytes = new Uint8Array([
      ...(utxo.sdk.toBytes(
        avalanche.utils.getManagerForVM('AVM').getDefaultCodec(),
      ) as Uint8Array),
    ]);
    expect(() => parseUtxo(new Uint8Array([0, 0, ...bytes, 7]), X)).toThrow('malformed');
    expect(() => parseUtxo(new Uint8Array([0, 0, 1]), X)).toThrow('malformed');
    expect(() => utxoKeyOf(new Uint8Array(10))).toThrow('malformed');
  });

  it('reads a stake-locked P-Chain output as owned but not plain', () => {
    const inner = new sdk.TransferOutput(
      new sdk.BigIntPr(9n),
      sdk.OutputOwners.fromNative([TEST_BYTES], 0n, 1),
    );
    const locked = new sdk.pvmSerial.StakeableLockOut(
      new sdk.BigIntPr(4_000_000_000n),
      inner,
    );
    const utxo = new sdk.Utxo(
      sdk.avaxSerial.UTXOID.fromNative(
        sdk.utils.base58check.encode(new Uint8Array(32)),
        1,
      ),
      sdk.Id.fromString(P.avaxAssetId),
      locked,
    );
    const manager = sdk.utils.getManagerForVM('PVM');
    const bytes = new Uint8Array([0, 0, ...utxo.toBytes(manager.getDefaultCodec())]);
    expect(parseUtxo(bytes, P)).toMatchObject({
      amount: 9n,
      locktime: 4_000_000_000n,
      plain: false,
      owners: [TEST_BYTES],
    });
  });
});

describe('BaseTx building is checked before use', () => {
  const build = (vm: Vm, fee: FeePlan) =>
    buildBaseTx({
      config: vm === 'avm' ? X : P,
      from: TEST_BYTES,
      utxos: [utxoOf(vm, 10_000_000n)],
      outputs: [{ to: OTHER_BYTES, amount: 1_000n }],
      memo: new Uint8Array(),
      minIssuanceTime: 1_790_000_000n,
      fee,
    });

  it('builds an exact X-Chain transfer with change', () => {
    expect(build('avm', STATIC)).toMatchObject({
      fee: 1_000_000n,
      change: 10_000_000n - 1_000n - 1_000_000n,
      outputs: 2,
    });
  });

  it('maps the SDK running out of capacity to a retryable refusal', () => {
    const fee: FeePlan = {
      model: 'dynamic',
      price: 1n,
      state: { capacity: 10n, excess: 0n, price: 1n, timestamp: '' },
      weights: [1, 1000, 1000, 4],
    };
    expect(() => build('pvm', fee)).toThrow(
      expect.objectContaining({ code: 'TX_REFUSED', retryable: true }),
    );
  });

  describe('a misbehaving SDK', () => {
    const original = avalanche.avm;
    afterEach(() => {
      (avalanche as { avm: unknown }).avm = original;
    });

    /** Builds with the real SDK, then lets `tamper` swap the transaction it returns. */
    function tampered(tamper: (unsigned: SdkUnsignedTx) => SdkUnsignedTx) {
      (avalanche as { avm: unknown }).avm = {
        ...original,
        newBaseTx: (...args: Parameters<typeof original.newBaseTx>) =>
          tamper(original.newBaseTx(...args)),
      };
    }

    /** A real unsigned BaseTx paying `outputs` from `utxos`, as the SDK would build it. */
    function real(
      outputs: readonly { to: Uint8Array; amount: bigint }[],
      fee = 1_000_000n,
    ) {
      return original.newBaseTx(
        {
          networkID: 5,
          hrp: 'fuji',
          xBlockchainID: X.blockchainId,
          pBlockchainID: '',
          cBlockchainID: '',
          avaxAssetID: X.avaxAssetId,
          baseTxFee: fee,
          createAssetTxFee: 0n,
          platformFeeConfig: {
            weights: avalanche.Common.createDimensions({
              bandwidth: 0,
              dbRead: 0,
              dbWrite: 0,
              compute: 0,
            }),
            maxCapacity: 0n,
            maxPerSecond: 0n,
            targetPerSecond: 0n,
            minPrice: 0n,
            excessConversionConstant: 0n,
          },
        },
        [TEST_BYTES],
        [utxoOf('avm', 10_000_000n).sdk],
        outputs.map((o) =>
          avalanche.TransferableOutput.fromNative(X.avaxAssetId, o.amount, [o.to]),
        ),
        { changeAddresses: [TEST_BYTES], memo: new Uint8Array(), minIssuanceTime: 0n },
      );
    }

    it.each([
      [
        'pays an address not asked for',
        () => real([{ to: TEST_BYTES.map((b) => b ^ 1), amount: 1_000n }]),
      ],
      ['leaves out an intended output', () => real([{ to: OTHER_BYTES, amount: 999n }])],
      [
        'burns another fee',
        () => real([{ to: OTHER_BYTES, amount: 1_000n }], 2_000_000n),
      ],
    ])('refuses a transaction that %s', (_, make) => {
      tampered(() => make());
      expect(() => build('avm', STATIC)).toThrow('the built transaction is wrong');
    });
  });
});

describe('transactions as the core reads them', () => {
  const faucetPay = (vm: Vm, memo: Uint8Array) => {
    const config = vm === 'avm' ? X : P;
    const utx =
      vm === 'avm'
        ? avalanche.avm.newBaseTx(
            {
              networkID: 5,
              hrp: 'fuji',
              xBlockchainID: X.blockchainId,
              pBlockchainID: '',
              cBlockchainID: '',
              avaxAssetID: X.avaxAssetId,
              baseTxFee: 1_000_000n,
              createAssetTxFee: 0n,
              platformFeeConfig: undefined as never,
            },
            [TEST_BYTES],
            [utxoOf('avm', 10_000_000n).sdk],
            [
              avalanche.TransferableOutput.fromNative(config.avaxAssetId, 5n, [
                OTHER_BYTES,
              ]),
              avalanche.TransferableOutput.fromNative(
                config.avaxAssetId,
                6n,
                [OTHER_BYTES, TEST_BYTES],
                0n,
                2,
              ),
            ],
            { changeAddresses: [TEST_BYTES], memo, minIssuanceTime: 0n },
          )
        : undefined;
    return signWith((utx as SdkUnsignedTx).toBytes(), TEST_KEY, vm);
  };

  it('decodes plain outputs as transfers and a multi-owner one as undecoded value', () => {
    const bytes = faucetPay('avm', new TextEncoder().encode('ref-9'));
    const tx = decodeTransaction(bytes, X, block);
    expect(tx.decoding).toBe('partial');
    const to = formatAddress(OTHER_BYTES, X);
    expect(tx.transfers.filter((t) => t.to === to).map((t) => t.amount)).toEqual([5n]);
    expect(tx.transfers.every((t) => t.memo === 'ref-9')).toBe(true);
    expect(tx.transfers[0]?.from).toEqual([formatAddress(TEST_BYTES, X)]);
    expect(tx.details).toMatchObject({
      type: 'avm.BaseTx',
      memo: toHex(new TextEncoder().encode('ref-9')),
    });
    expect(tx.fee).toEqual([{ asset: 'native', amount: 1_000_000n }]);
  });

  it('keeps a memo that is not text in the details only', () => {
    const tx = decodeTransaction(
      faucetPay('avm', new Uint8Array([0xff, 0xfe])),
      X,
      block,
    );
    expect(tx.transfers.every((t) => t.memo === undefined)).toBe(true);
    expect(tx.details.memo).toBe('fffe');
  });

  it('reads an export as partial: value leaves for another chain', () => {
    const exported = sdk.avm.newExportTx(
      {
        networkID: 5,
        hrp: 'fuji',
        xBlockchainID: X.blockchainId,
        pBlockchainID: P.blockchainId,
        cBlockchainID: P.blockchainId,
        avaxAssetID: X.avaxAssetId,
        baseTxFee: 1_000_000n,
        createAssetTxFee: 0n,
      },
      P.blockchainId,
      [TEST_BYTES],
      [utxoOf('avm', 10_000_000n).sdk],
      [sdk.TransferableOutput.fromNative(X.avaxAssetId, 4_000_000n, [TEST_BYTES])],
    );
    const bytes = signWith(exported.toBytes(), TEST_KEY, 'avm');
    const tx = decodeTransaction(bytes, X, block);
    expect(tx.decoding).toBe('partial');
    expect(tx.details.type).toBe('avm.ExportTx');
    expect(tx.fee).toEqual([{ asset: 'native', amount: 1_000_000n }]);
  });

  it('reads bytes this SDK cannot parse as undecoded', () => {
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 99]);
    const tx = decodeTransaction(bytes, X, block);
    expect(tx).toMatchObject({
      decoding: 'none',
      transfers: [],
      details: { type: 'unknown' },
    });
    expect(() => parseSignedTx(bytes, X)).toThrow('malformed');
    expect(() => parseUnsignedTx(bytes, X)).toThrow('not an unsigned transaction');
  });

  it('names the senders by the addresses their signatures recover to, once each', () => {
    const bytes = faucetPay('avm', new Uint8Array());
    const parsed = parseSignedTx(bytes, X);
    const sig = secp256k1.sign(sha256(parsed.unsignedBytes), TEST_KEY, { lowS: true });
    expect(sig.recovery === 0 || sig.recovery === 1).toBe(true);
    const tx = decodeTransaction(bytes, X, block);
    expect(tx.details.signers).toEqual([formatAddress(TEST_BYTES, X)]);
  });
});
