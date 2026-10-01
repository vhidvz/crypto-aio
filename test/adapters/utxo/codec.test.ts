import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import { hash160, outputScript, walletAddress } from '../../../src/adapters/utxo/address';
import {
  SEQUENCE_RBF,
  SIGHASH_ALL,
  SIGHASH_DEFAULT,
  assembleTx,
  buildTx,
  canonicalTwinTxid,
  isPreviousTxRefusal,
  networkOf,
  previousTxOf,
  signaturesFromPsbt,
  txidOfHex,
  viewPsbt,
  type PlannedInput,
  type PreviousTx,
} from '../../../src/adapters/utxo/codec';
import {
  bitcoin,
  useNobleEcc,
  type Psbt,
  type Transaction,
} from '../../../src/adapters/utxo/sdk';
import type { UtxoAddressType } from '../../../src/adapters/utxo/types';
import { secp256k1Ecdsa, secp256k1Schnorr } from '../../../src/core/registry/schemes';
import { tweakPrivateKey } from '../../../src/core/signing/local';
import type { SignatureBundle, SigningRequest } from '../../../src/core/signing/types';
import { concatBytes, toHex } from '../../../src/core/util/bytes';
import {
  compactSize,
  fundingTx,
  malleate,
  manyOutputs,
  nativeSigner,
  nativeTaprootSigner,
  txidOfStripped,
} from './support/tx';
import { OTHER_KEY, OTHER_PUBKEY, TEST_KEY, TEST_PUBKEY } from './support/vectors';
import { thrown } from '../../helpers';
import { base64 as scureBase64 } from '@scure/base';

/** A previous transaction, as the Esplora client decodes it (F3-R14). */
const previousOf = (tx: Transaction): PreviousTx =>
  previousTxOf(tx.toHex()) as PreviousTx;

const PARAMS = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4 };
const NETWORK = networkOf(PARAMS);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', PARAMS);

function setup(type: UtxoAddressType) {
  const wallet = walletAddress(TEST_PUBKEY, type, PARAMS);
  const funding = [
    fundingTx(wallet.script, 50_000n, 1),
    fundingTx(wallet.script, 70_000n, 2),
  ];
  const inputs: PlannedInput[] = funding.map((tx) => ({
    outpoint: `${tx.getId()}:0`,
    txid: tx.getId(),
    vout: 0,
    value: tx.outs[0]!.value,
    ...(type === 'p2pkh' ? { prevTx: previousOf(tx) } : {}),
  }));
  const outputs = [
    { script: PAYEE.script, value: 100_000n },
    { script: wallet.script, value: 19_000n },
  ];
  const built = buildTx(NETWORK, wallet, inputs, outputs, SEQUENCE_RBF);
  const requests: SigningRequest[] = built.digests.map((digest, index) => ({
    id: `in:${index}`,
    scheme: type === 'p2tr' ? 'secp256k1-schnorr' : 'secp256k1-ecdsa',
    payload: digest,
    payloadKind: 'digest',
    publicKey: type === 'p2tr' ? (wallet.outputKey as Uint8Array) : wallet.publicKey,
    ...(wallet.tweak ? { params: { tweak: wallet.tweak } } : {}),
  }));
  const sign = (): SignatureBundle[] =>
    requests.map((request) => {
      if (request.scheme === 'secp256k1-schnorr') {
        const key = tweakPrivateKey(TEST_KEY, wallet.tweak as Uint8Array);
        return {
          requestId: request.id,
          bytes: schnorr.sign(request.payload, key, new Uint8Array(32)),
        };
      }
      const sig = secp256k1.sign(request.payload, TEST_KEY, { lowS: true });
      return {
        requestId: request.id,
        bytes: sig.toCompactRawBytes(),
        recovery: sig.recovery,
      };
    });
  return { wallet, inputs, outputs, built, requests, sign };
}

beforeAll(() => useNobleEcc());

describe('signature hashes (BIP143, BIP341 vectors)', () => {
  it('computes the BIP143 native P2WPKH sighash with the p2pkh script code', () => {
    const tx = bitcoin.Transaction.fromHex(
      '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000',
    );
    const pubkey = hexToBytes(
      '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357',
    );
    const scriptCode = outputScript('p2pkh', hash160(pubkey));
    expect(toHex(scriptCode)).toBe('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac');
    expect(toHex(tx.hashForWitnessV0(1, scriptCode, 600_000_000n, SIGHASH_ALL))).toBe(
      'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670',
    );
  });

  it('computes the BIP341 key-path SIGHASH_DEFAULT sighash', () => {
    const tx = bitcoin.Transaction.fromHex(
      '02000000097de20cbff686da83a54981d2b9bab3586f4ca7e48f57f5b55963115f3b334e9c010000000000000000d7b7cab57b1393ace2d064f4d4a2cb8af6def61273e127517d44759b6dafdd990000000000fffffffff8e1f583384333689228c5d28eac13366be082dc57441760d957275419a418420000000000fffffffff0689180aa63b30cb162a73c6d2a38b7eeda2a83ece74310fda0843ad604853b0100000000feffffffaa5202bdf6d8ccd2ee0f0202afbbb7461d9264a25e5bfd3c5a52ee1239e0ba6c0000000000feffffff956149bdc66faa968eb2be2d2faa29718acbfe3941215893a2a3446d32acd050000000000000000000e664b9773b88c09c32cb70a2a3e4da0ced63b7ba3b22f848531bbb1d5d5f4c94010000000000000000e9aa6b8e6c9de67619e6a3924ae25696bb7b694bb677a632a74ef7eadfd4eabf0000000000ffffffffa778eb6a263dc090464cd125c466b5a99667720b1c110468831d058aa1b82af10100000000ffffffff0200ca9a3b000000001976a91406afd46bcdfd22ef94ac122aa11f241244a37ecc88ac807840cb0000000020ac9a87f5594be208f8532db38cff670c450ed2fea8fcdefcc9a663f78bab962b0065cd1d',
    );
    const spent: [string, bigint][] = [
      [
        '512053a1f6e454df1aa2776a2814a721372d6258050de330b3c6d10ee8f4e0dda343',
        420_000_000n,
      ],
      [
        '5120147c9c57132f6e7ecddba9800bb0c4449251c92a1e60371ee77557b6620f3ea3',
        462_000_000n,
      ],
      ['76a914751e76e8199196d454941c45d1b3a323f1433bd688ac', 294_000_000n],
      [
        '5120e4d810fd50586274face62b8a807eb9719cef49c04177cc6b76a9a4251d5450e',
        504_000_000n,
      ],
      [
        '512091b64d5324723a985170e4dc5a0f84c041804f2cd12660fa5dec09fc21783605',
        630_000_000n,
      ],
      ['00147dd65592d0ab2fe0d0257d571abf032cd9db93dc', 378_000_000n],
      [
        '512075169f4001aa68f15bbed28b218df1d0a62cbbcf1188c6665110c293c907b831',
        672_000_000n,
      ],
      [
        '5120712447206d7a5238acc7ff53fbe94a3b64539ad291c7cdbc490b7577e4b17df5',
        546_000_000n,
      ],
      [
        '512077e30a5522dd9f894c3f8b8bd4c4b2cf82ca7da8a3ea6a239655c39c050ab220',
        588_000_000n,
      ],
    ];
    const digest = tx.hashForWitnessV1(
      4,
      spent.map(([script]) => hexToBytes(script)),
      spent.map(([, value]) => value),
      SIGHASH_DEFAULT,
    );
    expect(toHex(digest)).toBe(
      '4f900a0bae3f1446fd48490c2958b5a023228f01661cda3496a11da502a7f7ef',
    );
  });
});

describe('buildTx and assembleTx', () => {
  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh'] as const)(
    '%s: assembles exactly what bitcoinjs-lib signs natively',
    (type) => {
      const { built, requests, sign } = setup(type);
      const ours = assembleTx(built.psbt, NETWORK, requests, sign());
      const native = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      native.signAllInputs(nativeSigner(TEST_KEY));
      native.finalizeAllInputs();
      expect(ours.hex).toBe(native.extractTransaction(true).toHex());
      expect(built.txid).toBe(type === 'p2pkh' ? undefined : ours.txid);
    },
  );

  it('p2tr: signs the BIP341 digest with the tweaked key, as bitcoinjs-lib does', () => {
    const { built, requests, sign, wallet } = setup('p2tr');
    const signatures = sign();
    for (const [index, request] of requests.entries()) {
      expect(
        secp256k1Schnorr.verify({
          publicKey: request.publicKey,
          payload: request.payload,
          signature: signatures[index]!.bytes,
        }),
      ).toBe(true);
    }
    const ours = assembleTx(built.psbt, NETWORK, requests, signatures);
    expect(ours.txid).toBe(built.txid);
    const native = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    native.signAllInputs(nativeTaprootSigner(TEST_KEY, wallet.tweak as Uint8Array));
    native.finalizeAllInputs();
    expect(ours.hex).toBe(native.extractTransaction(true).toHex());
  });

  it('keeps inputs, values and outputs readable from the stored PSBT', () => {
    const { built, inputs, outputs } = setup('p2pkh');
    const view = viewPsbt(built.psbt, NETWORK);
    expect(view.inputs.map((i) => [i.outpoint, i.value, i.sequence])).toEqual(
      inputs.map((i) => [i.outpoint, i.value, SEQUENCE_RBF]),
    );
    expect(view.outputs.map((o) => [toHex(o.script), o.value])).toEqual(
      outputs.map((o) => [toHex(o.script), o.value]),
    );
  });

  it('refuses a p2pkh input whose previous transaction does not match', () => {
    const wallet = walletAddress(TEST_PUBKEY, 'p2pkh', PARAMS);
    const funding = fundingTx(wallet.script, 50_000n, 1);
    const other = fundingTx(wallet.script, 50_000n, 2);
    const input = {
      outpoint: `${funding.getId()}:0`,
      txid: funding.getId(),
      vout: 0,
      value: 50_000n,
    };
    for (const prevTx of [previousOf(other), undefined]) {
      expect(() =>
        buildTx(
          NETWORK,
          wallet,
          [{ ...input, ...(prevTx ? { prevTx } : {}) }],
          [],
          SEQUENCE_RBF,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT' }));
    }
    expect(previousTxOf('zz')).toBeUndefined();
    // Another value, or an output the transaction does not have (F3-R14 (a)).
    for (const wrong of [
      { ...input, value: 60_000n },
      { ...input, vout: 1, outpoint: `${funding.getId()}:1` },
    ]) {
      const refusal = thrown(() =>
        buildTx(
          NETWORK,
          wallet,
          [{ ...wrong, prevTx: previousOf(funding) }],
          [],
          SEQUENCE_RBF,
        ),
      );
      expect(refusal).toMatchObject({ code: 'INVALID_INTENT' });
      expect(isPreviousTxRefusal(refusal)).toBe(true);
    }
  });

  it('carries the verified previous transaction for segwit v0 inputs (M15), never for p2tr', () => {
    for (const type of ['p2wpkh', 'p2sh-p2wpkh', 'p2tr'] as const) {
      const wallet = walletAddress(TEST_PUBKEY, type, PARAMS);
      const funding = fundingTx(wallet.script, 50_000n, 1);
      const input = {
        outpoint: `${funding.getId()}:0`,
        txid: funding.getId(),
        vout: 0,
        value: 50_000n,
        prevTx: previousOf(funding),
      };
      const built = buildTx(
        NETWORK,
        wallet,
        [input],
        [{ script: PAYEE.script, value: 40_000n }],
        SEQUENCE_RBF,
      );
      const psbt = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      expect(psbt.data.inputs[0]?.witnessUtxo?.value).toBe(50_000n);
      expect(psbt.data.inputs[0]?.nonWitnessUtxo !== undefined).toBe(type !== 'p2tr');
      const wrongScript = fundingTx(PAYEE.script, 50_000n, 1);
      expect(() =>
        buildTx(
          NETWORK,
          wallet,
          [
            {
              ...input,
              txid: wrongScript.getId(),
              outpoint: `${wrongScript.getId()}:0`,
              prevTx: previousOf(wrongScript),
            },
          ],
          [{ script: PAYEE.script, value: 40_000n }],
          SEQUENCE_RBF,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_INTENT' }));
    }
  });

  it('fails with SIGNING_FAILED when a signature is missing', () => {
    const { built, requests, sign } = setup('p2wpkh');
    expect(() => assembleTx(built.psbt, NETWORK, requests, sign().slice(1))).toThrow(
      expect.objectContaining({ code: 'SIGNING_FAILED' }),
    );
  });
});

describe('canonicalTwinTxid (C2: a miner-malleated p2pkh copy)', () => {
  const signedP2pkh = () => {
    const { built, requests, sign } = setup('p2pkh');
    return assembleTx(built.psbt, NETWORK, requests, sign());
  };
  const keyHash = hash160(TEST_PUBKEY);

  it.each(['high-s', 'pushdata1', 'junk-push', 'op-nop'] as const)(
    'recovers our txid from the %s variant',
    (kind) => {
      const ours = signedP2pkh();
      const copy = malleate(ours.hex, kind);
      expect(txidOfHex(copy)).not.toBe(ours.txid);
      expect(canonicalTwinTxid(copy, keyHash)).toBe(ours.txid);
    },
  );

  it('keeps our own txid, and never matches another payment or a witness spend', () => {
    const ours = signedP2pkh();
    expect(canonicalTwinTxid(ours.hex, keyHash)).toBe(ours.txid);
    const { inputs } = setup('p2pkh');
    const other = bitcoin.Psbt.fromBase64(
      buildTx(
        NETWORK,
        walletAddress(TEST_PUBKEY, 'p2pkh', PARAMS),
        inputs,
        [{ script: PAYEE.script, value: 110_000n }],
        SEQUENCE_RBF,
      ).psbt,
      { network: NETWORK },
    );
    other.signAllInputs(nativeSigner(TEST_KEY)).finalizeAllInputs();
    const otherHex = other.extractTransaction(true).toHex();
    expect(canonicalTwinTxid(otherHex, keyHash)).not.toBe(ours.txid);
    const { built, requests, sign } = setup('p2wpkh');
    const witness = assembleTx(built.psbt, NETWORK, requests, sign());
    expect(canonicalTwinTxid(witness.hex, keyHash)).toBeUndefined();
    expect(canonicalTwinTxid('zz', keyHash)).toBeUndefined();
  });
});

describe('signaturesFromPsbt (P3-B)', () => {
  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh'] as const)(
    '%s: takes the partial or final signatures that verify against our requests',
    (type) => {
      const { built, requests } = setup(type);
      const partial = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      partial.signAllInputs(nativeSigner(TEST_KEY));
      const fromPartial = signaturesFromPsbt(
        built.psbt,
        partial.toBase64(),
        NETWORK,
        requests,
      );
      partial.finalizeAllInputs();
      const fromFinal = signaturesFromPsbt(
        built.psbt,
        partial.toBase64(),
        NETWORK,
        requests,
      );
      expect(fromFinal).toEqual(fromPartial);
      expect(fromPartial).toHaveLength(2);
      for (const bundle of fromPartial) {
        const request = requests.find((r) => r.id === bundle.requestId)!;
        expect(
          secp256k1Ecdsa.verify({
            publicKey: request.publicKey,
            payload: request.payload,
            signature: bundle.bytes,
            ...(bundle.recovery !== undefined ? { recovery: bundle.recovery } : {}),
          }),
        ).toBe(true);
      }
    },
  );

  it('p2tr: takes the key-path signature', () => {
    const { built, requests, wallet } = setup('p2tr');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeTaprootSigner(TEST_KEY, wallet.tweak as Uint8Array));
    const bundles = signaturesFromPsbt(built.psbt, signed.toBase64(), NETWORK, requests);
    expect(bundles.map((b) => b.bytes.length)).toEqual([64, 64]);
  });

  it('returns a partial set for a half-signed PSBT', () => {
    const { built, requests } = setup('p2wpkh');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signInput(1, nativeSigner(TEST_KEY));
    expect(
      signaturesFromPsbt(built.psbt, signed.toBase64(), NETWORK, requests).map(
        (b) => b.requestId,
      ),
    ).toEqual(['in:1']);
  });

  it('refuses a tampered transaction, another sighash type and junk (INVALID_INTENT)', () => {
    const { built, requests, wallet } = setup('p2wpkh');
    const tampered = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    tampered.addOutput({ script: PAYEE.script, value: 1_000n });
    const none = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    none.updateInput(0, {
      partialSig: [
        {
          pubkey: wallet.publicKey,
          signature: bitcoin.script.signature.encode(
            secp256k1
              .sign(requests[0]!.payload, TEST_KEY, { lowS: true })
              .toCompactRawBytes(),
            0x02,
          ),
        },
      ],
    });
    for (const signed of [tampered.toBase64(), none.toBase64(), 'not a psbt']) {
      expect(() => signaturesFromPsbt(built.psbt, signed, NETWORK, requests)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });
});

describe('signaturesFromPsbt: a signed PSBT is untrusted', () => {
  const refused = (
    stored: string,
    signed: string,
    requests: readonly SigningRequest[],
    reason: string,
  ) =>
    expect(() => signaturesFromPsbt(stored, signed, NETWORK, requests)).toThrow(
      expect.objectContaining({
        code: 'INVALID_INTENT',
        message: `the signed PSBT ${reason}`,
      }),
    );
  /** Our PSBT, signed by bitcoinjs-lib (partial signatures), as a fresh copy to tamper with. */
  const signedCopy = (type: UtxoAddressType) => {
    const prepared = setup(type);
    const psbt = bitcoin.Psbt.fromBase64(prepared.built.psbt, { network: NETWORK });
    psbt.signAllInputs(
      type === 'p2tr'
        ? nativeTaprootSigner(TEST_KEY, prepared.wallet.tweak as Uint8Array)
        : nativeSigner(TEST_KEY),
    );
    return {
      ...prepared,
      psbt: bitcoin.Psbt.fromBase64(psbt.toBase64(), { network: NETWORK }),
    };
  };
  const input = (psbt: Psbt, index = 0) => psbt.data.inputs[index]!;
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  /** A serialized witness stack (BIP144), items under 253 bytes. */
  const witness = (...items: Uint8Array[]) =>
    concatBytes(
      Uint8Array.of(items.length),
      ...items.flatMap((item) => [Uint8Array.of(item.length), item]),
    );
  const der = (payload: Uint8Array, key: Uint8Array, hashType = SIGHASH_ALL) =>
    bitcoin.script.signature.encode(
      secp256k1.sign(payload, key, { lowS: true }).toCompactRawBytes(),
      hashType,
    );

  it('refuses an oversized PSBT before decoding it (lesson 20)', () => {
    // p2tr: no room for a previous transaction a coordinator may add (F3-R5).
    const { built, requests, psbt, wallet } = signedCopy('p2tr');
    input(psbt).tapBip32Derivation = [
      {
        masterFingerprint: new Uint8Array(4),
        pubkey: wallet.publicKey,
        path: `m${'/0'.repeat(25_000)}`,
        leafHashes: [],
      },
    ];
    const storedLength = bitcoin.Psbt.fromBase64(built.psbt).toBuffer().length;
    const fromBuffer = jest.spyOn(bitcoin.Psbt, 'fromBuffer');
    try {
      for (const signed of [psbt.toBase64(), 'A'.repeat(100_000)]) {
        fromBuffer.mockClear();
        refused(built.psbt, signed, requests, 'is too large');
        // Only our stored PSBT reached the decoder.
        expect(fromBuffer.mock.calls.map(([bytes]) => bytes.length)).toEqual([
          storedLength,
        ]);
      }
    } finally {
      fromBuffer.mockRestore();
    }
  });

  it('accepts key origins a signer or coordinator adds', () => {
    const { built, requests, psbt } = signedCopy('p2wpkh');
    const origin = {
      masterFingerprint: Uint8Array.of(1, 2, 3, 4),
      pubkey: TEST_PUBKEY,
      path: "m/84'/1'/0'/0/0",
    };
    psbt.updateInput(0, { bip32Derivation: [origin] });
    psbt.updateOutput(1, { bip32Derivation: [origin] });
    psbt.updateGlobal({
      globalXpub: [
        {
          extendedPubkey: concatBytes(new Uint8Array(45), TEST_PUBKEY),
          masterFingerprint: origin.masterFingerprint,
          path: "m/84'/1'/0'",
        },
      ],
    });
    expect(
      signaturesFromPsbt(built.psbt, psbt.toBase64(), NETWORK, requests),
    ).toHaveLength(2);
  });

  it('refuses non-canonical base64, trailing bytes, a truncated PSBT and a duplicate key', () => {
    const { built, requests, psbt } = signedCopy('p2wpkh');
    const good = psbt.toBase64();
    const bytes = psbt.toBuffer();
    const sig = input(psbt).partialSig![0]!.signature;
    const pair = `2202${toHex(TEST_PUBKEY)}${sig.length.toString(16)}${toHex(sig)}`;
    expect(toHex(bytes)).toContain(pair);
    expect([...bytes.slice(0, 7)]).toEqual([0x70, 0x73, 0x62, 0x74, 0xff, 0x01, 0x00]);
    expect(bytes[7]).toBeLessThan(0xfd);
    // Node's Buffer decoder skips what it cannot read; the round trip refuses it all (F3-R7).
    const unpadded = good.endsWith('=') ? [good.replace(/=+$/, '')] : [];
    for (const signed of [
      `${good.slice(0, 20)}\n${good.slice(20)}`,
      good.replace(/\+/g, '-').replace(/\//g, '_'),
      `${good.slice(0, 8)}*${good.slice(8)}`,
      `${good.slice(0, 8)}====${good.slice(8)}`,
      `${good}AAAA`.slice(0, good.length + 3),
      ...unpadded,
      base64(concatBytes(bytes, Uint8Array.of(0x00))),
      base64(concatBytes(bytes, Uint8Array.of(0x01, 0x02, 0x03))),
      base64(bytes.slice(0, -1)),
      // The unsigned transaction's length as a non-minimal CompactSize (0xfd, 2 bytes).
      base64(
        concatBytes(bytes.slice(0, 7), Uint8Array.of(0xfd, bytes[7]!, 0), bytes.slice(8)),
      ),
      base64(hexToBytes(toHex(bytes).replace(pair, pair + pair))),
    ]) {
      refused(built.psbt, signed, requests, 'does not decode');
    }
  });

  it('refuses unknown fields at every level, and fields a signer does not add', () => {
    // 0xef is a key type no BIP defines (0xfc, proprietary, is allowed: M1).
    const unknown = { key: Uint8Array.of(0xef, 0x00), value: Uint8Array.of(0x01) };
    const tamper: ((psbt: Psbt) => void)[] = [
      (psbt) => psbt.addUnknownKeyValToGlobal(unknown),
      (psbt) => psbt.addUnknownKeyValToInput(0, unknown),
      (psbt) => psbt.addUnknownKeyValToOutput(0, unknown),
      (psbt) => {
        input(psbt).witnessScript = Uint8Array.of(0x51);
      },
      (psbt) => {
        input(psbt).porCommitment = 'reserves';
      },
      (psbt) => {
        input(psbt).tapLeafScript = [
          {
            leafVersion: 0xc0,
            script: Uint8Array.of(0x51),
            controlBlock: concatBytes(Uint8Array.of(0xc0), TEST_PUBKEY.slice(1)),
          },
        ];
      },
    ];
    for (const change of tamper) {
      const { built, requests, psbt } = signedCopy('p2wpkh');
      change(psbt);
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a field a signer does not add',
      );
    }
    const { built, requests, psbt } = signedCopy('p2tr');
    input(psbt).tapMerkleRoot = new Uint8Array(32);
    refused(
      built.psbt,
      psbt.toBase64(),
      requests,
      'carries a field a signer does not add',
    );
  });

  it('refuses a changed previous output, redeem script or internal key, or an added previous transaction', () => {
    const cases: [
      UtxoAddressType,
      (psbt: Psbt, wallet: ReturnType<typeof setup>['wallet']) => void,
    ][] = [
      [
        'p2wpkh',
        (psbt) => {
          input(psbt).witnessUtxo = {
            script: input(psbt).witnessUtxo!.script,
            value: 1n,
          };
        },
      ],
      [
        'p2wpkh',
        (psbt) => {
          input(psbt).witnessUtxo = { script: PAYEE.script, value: 50_000n };
        },
      ],
      [
        'p2pkh',
        (psbt, wallet) => {
          input(psbt).nonWitnessUtxo = fundingTx(wallet.script, 50_000n, 3).toBuffer();
        },
      ],
      [
        'p2sh-p2wpkh',
        (psbt) => {
          input(psbt).redeemScript = outputScript('p2wpkh', hash160(OTHER_PUBKEY));
        },
      ],
      [
        'p2tr',
        (psbt) => {
          input(psbt).tapInternalKey = OTHER_PUBKEY.slice(1);
        },
      ],
      [
        'p2tr',
        (psbt, wallet) => {
          input(psbt).nonWitnessUtxo = fundingTx(wallet.script, 50_000n, 1).toBuffer();
        },
      ],
    ];
    for (const [type, change] of cases) {
      const { built, requests, psbt, wallet } = signedCopy(type);
      change(psbt, wallet);
      refused(built.psbt, psbt.toBase64(), requests, 'changes the prepared transaction');
    }
  });

  it('refuses a signature for another key, of the other scheme, or on a script path', () => {
    {
      const { built, requests, psbt } = signedCopy('p2wpkh');
      input(psbt).partialSig!.push({
        pubkey: OTHER_PUBKEY,
        signature: der(requests[0]!.payload, OTHER_KEY),
      });
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a signature for another key',
      );
    }
    {
      const { built, requests, psbt } = signedCopy('p2tr');
      input(psbt).partialSig = [
        { pubkey: TEST_PUBKEY, signature: der(requests[0]!.payload, TEST_KEY) },
      ];
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a signature of another scheme',
      );
    }
    {
      const { built, requests, psbt } = signedCopy('p2wpkh');
      input(psbt, 1).tapKeySig = new Uint8Array(64);
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a signature of another scheme',
      );
    }
    {
      const { built, requests, psbt, wallet } = signedCopy('p2tr');
      input(psbt).tapScriptSig = [
        {
          pubkey: wallet.outputKey as Uint8Array,
          leafHash: new Uint8Array(32),
          signature: new Uint8Array(64),
        },
      ];
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a field a signer does not add',
      );
    }
  });

  it('refuses a final script of another shape', () => {
    const finalized = (type: UtxoAddressType) => {
      const copy = signedCopy(type);
      copy.psbt.finalizeAllInputs();
      return copy;
    };
    const cases: [UtxoAddressType, (psbt: Psbt) => void][] = [
      [
        'p2wpkh',
        (psbt) => {
          const sig = der(setup('p2wpkh').requests[0]!.payload, TEST_KEY);
          input(psbt).finalScriptWitness = witness(sig, OTHER_PUBKEY);
        },
      ],
      [
        'p2wpkh',
        (psbt) => {
          const sig = der(setup('p2wpkh').requests[0]!.payload, TEST_KEY);
          input(psbt).finalScriptWitness = witness(sig, TEST_PUBKEY, Uint8Array.of(7));
        },
      ],
      [
        'p2wpkh',
        (psbt) => {
          input(psbt).finalScriptSig = Uint8Array.of(0x51);
        },
      ],
      [
        'p2sh-p2wpkh',
        (psbt) => {
          input(psbt).finalScriptSig = bitcoin.script.compile([
            outputScript('p2wpkh', hash160(OTHER_PUBKEY)),
          ]);
        },
      ],
      [
        'p2pkh',
        (psbt) => {
          const [sig, key] = bitcoin.script.decompile(
            input(psbt).finalScriptSig!,
          ) as Uint8Array[];
          input(psbt).finalScriptSig = bitcoin.script.compile([
            sig!,
            key!,
            Uint8Array.of(7),
          ]);
        },
      ],
      [
        'p2pkh',
        (psbt) => {
          input(psbt).finalScriptWitness = witness(Uint8Array.of(7));
        },
      ],
      [
        'p2tr',
        (psbt) => {
          const [sig] = [input(psbt).finalScriptWitness!.slice(2, 66)];
          input(psbt).finalScriptWitness = witness(sig!, Uint8Array.of(0x50, 0x01));
        },
      ],
      [
        'p2tr',
        (psbt) => {
          input(psbt).finalScriptSig = Uint8Array.of(0x51);
        },
      ],
    ];
    for (const [type, change] of cases) {
      const { built, requests, psbt } = finalized(type);
      change(psbt);
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'carries a final script of another shape',
      );
    }
  });

  it('refuses any sighash type but the one each input type signs with', () => {
    {
      const { built, requests, psbt } = signedCopy('p2wpkh');
      input(psbt).sighashType = 0x02;
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'uses a sighash type other than SIGHASH_ALL',
      );
    }
    {
      const { built, requests, psbt } = signedCopy('p2wpkh');
      psbt.finalizeAllInputs();
      input(psbt).finalScriptWitness = witness(
        der(requests[0]!.payload, TEST_KEY, 0x81),
        TEST_PUBKEY,
      );
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'uses a sighash type other than SIGHASH_ALL',
      );
    }
    {
      const { built, requests, psbt } = signedCopy('p2tr');
      input(psbt).sighashType = SIGHASH_ALL;
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'uses a sighash type other than SIGHASH_DEFAULT',
      );
    }
    {
      const { built, requests, psbt } = signedCopy('p2tr');
      input(psbt).tapKeySig = concatBytes(
        input(psbt).tapKeySig!,
        Uint8Array.of(SIGHASH_ALL),
      );
      refused(
        built.psbt,
        psbt.toBase64(),
        requests,
        'uses a sighash type other than SIGHASH_DEFAULT',
      );
    }
    // A signer that states the sighash type it used, when it is the right one, is fine.
    const { built, requests } = setup('p2wpkh');
    const stated = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    stated.updateInput(0, { sighashType: SIGHASH_ALL });
    stated.signInput(0, nativeSigner(TEST_KEY));
    expect(
      signaturesFromPsbt(built.psbt, stated.toBase64(), NETWORK, requests).map(
        (b) => b.requestId,
      ),
    ).toEqual(['in:0']);
  });

  it('needs one signing request per input', () => {
    const { built, requests, psbt } = signedCopy('p2wpkh');
    expect(() =>
      signaturesFromPsbt(built.psbt, psbt.toBase64(), NETWORK, requests.slice(1)),
    ).toThrow(expect.objectContaining({ code: 'SIGNING_FAILED' }));
  });
});

describe('Core-coordinated signing (F3-R5)', () => {
  const origin = {
    masterFingerprint: Uint8Array.of(1, 2, 3, 4),
    path: "m/84'/1'/0'/1/0",
  };
  const reparse = (psbt: Psbt) =>
    bitcoin.Psbt.fromBase64(psbt.toBase64(), { network: NETWORK });
  const signerOf = (type: UtxoAddressType, wallet: ReturnType<typeof setup>['wallet']) =>
    type === 'p2tr'
      ? nativeTaprootSigner(TEST_KEY, wallet.tweak as Uint8Array)
      : nativeSigner(TEST_KEY);
  /** A funding transaction whose input carries a witness (every other fixture has none). */
  const witnessFunding = (
    script: Uint8Array,
    value: bigint,
    salt: number,
  ): Transaction => {
    const tx = fundingTx(script, value, salt);
    tx.setWitness(0, [Uint8Array.of(0x01, 0x02, 0x03)]);
    return tx;
  };
  /** Bitcoin Core's `non_witness_utxo`: the transaction without its witness (TX_NO_WITNESS). */
  const stripped = (tx: Transaction): Uint8Array => {
    const copy = tx.clone();
    copy.ins.forEach((_, index) => copy.setWitness(index, []));
    return copy.toBuffer();
  };
  /** `setup(type)`'s transaction, built with previous transactions that carry a witness. */
  const withPrevious = (type: UtxoAddressType) => {
    const base = setup(type);
    const funding = [
      witnessFunding(base.wallet.script, 50_000n, 1),
      witnessFunding(base.wallet.script, 70_000n, 2),
    ];
    const inputs = base.inputs.map((i, index) => ({
      ...i,
      prevTx: previousOf(funding[index]!),
    }));
    const built = buildTx(NETWORK, base.wallet, inputs, base.outputs, SEQUENCE_RBF);
    expect(built.digests).toEqual(base.built.digests);
    return { ...base, funding, built };
  };
  /** What Core's UpdatePSBTOutput adds to our change output (index 1). */
  const coreChangeFields = (
    psbt: Psbt,
    type: UtxoAddressType,
    wallet: ReturnType<typeof setup>['wallet'],
  ) => {
    const change = psbt.data.outputs[1]!;
    if (type === 'p2tr') {
      change.tapInternalKey = wallet.publicKey;
      change.tapBip32Derivation = [
        { ...origin, pubkey: wallet.publicKey, leafHashes: [] },
      ];
      return;
    }
    if (wallet.redeemScript) change.redeemScript = wallet.redeemScript;
    change.bip32Derivation = [{ ...origin, pubkey: TEST_PUBKEY }];
  };
  const ecdsaRequests = (digests: readonly Uint8Array[]): SigningRequest[] =>
    digests.map((payload, index) => ({
      id: `in:${index}`,
      scheme: 'secp256k1-ecdsa',
      payload,
      payloadKind: 'digest',
      publicKey: TEST_PUBKEY,
    }));
  const refusedAs = (
    stored: string,
    signed: Psbt,
    requests: readonly SigningRequest[],
    reason: string,
  ) =>
    expect(() =>
      signaturesFromPsbt(stored, signed.toBase64(), NETWORK, requests),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_INTENT',
        message: `the signed PSBT ${reason}`,
      }),
    );

  it('stores a previous transaction without its witness, as Core writes it (I1a)', () => {
    for (const type of ['p2wpkh', 'p2sh-p2wpkh', 'p2pkh'] as const) {
      const { built, funding } = withPrevious(type);
      const psbt = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      psbt.data.inputs.forEach((i, index) => {
        expect(toHex(i.nonWitnessUtxo!)).toBe(toHex(stripped(funding[index]!)));
      });
    }
  });

  it.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const)(
    '%s: accepts a Core round trip (previous transactions with or without the witness, change-output fields), partial or final (I1a, I1b)',
    (type) => {
      const { built, requests, wallet, funding } = withPrevious(type);
      for (const previous of [stripped, (tx: Transaction) => tx.toBuffer()]) {
        for (const finalize of [false, true]) {
          const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
          signed.signAllInputs(signerOf(type, wallet));
          if (finalize) signed.finalizeAllInputs();
          const core = reparse(signed);
          if (type !== 'p2tr') {
            core.data.inputs.forEach((i, index) => {
              i.nonWitnessUtxo = previous(funding[index]!);
            });
          }
          coreChangeFields(core, type, wallet);
          expect(
            signaturesFromPsbt(built.psbt, core.toBase64(), NETWORK, requests).map(
              (b) => b.requestId,
            ),
          ).toEqual(['in:0', 'in:1']);
        }
      }
    },
  );

  it('accepts and ignores every script field Core may add to an output (I1b)', () => {
    const { built, requests, wallet } = setup('p2wpkh');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeSigner(TEST_KEY));
    const tr = walletAddress(TEST_PUBKEY, 'p2tr', PARAMS);
    const fields: ((psbt: Psbt) => void)[] = [
      (psbt) => {
        psbt.data.outputs[0]!.redeemScript = outputScript(
          'p2wpkh',
          hash160(OTHER_PUBKEY),
        );
      },
      (psbt) => {
        psbt.data.outputs[0]!.witnessScript = Uint8Array.of(0x51);
      },
      (psbt) => {
        psbt.data.outputs[1]!.tapInternalKey = tr.publicKey;
      },
      (psbt) => {
        psbt.data.outputs[1]!.tapTree = {
          leaves: [{ depth: 0, leafVersion: 0xc0, script: Uint8Array.of(0x51) }],
        };
      },
      (psbt) => {
        psbt.data.outputs[1]!.tapBip32Derivation = [
          { ...origin, pubkey: tr.publicKey, leafHashes: [] },
        ];
      },
    ];
    expect(wallet.type).toBe('p2wpkh');
    for (const add of fields) {
      const copy = reparse(signed);
      add(copy);
      expect(
        signaturesFromPsbt(built.psbt, copy.toBase64(), NETWORK, requests),
      ).toHaveLength(2);
    }
  });

  it('accepts a previous transaction a coordinator adds to a segwit v0 input, by its txid (I1c)', () => {
    for (const type of ['p2wpkh', 'p2sh-p2wpkh'] as const) {
      const { built, requests, wallet } = setup(type);
      const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      signed.signAllInputs(nativeSigner(TEST_KEY));
      const added = reparse(signed);
      added.data.inputs[0]!.nonWitnessUtxo = witnessFunding(
        wallet.script,
        50_000n,
        1,
      ).toBuffer();
      added.data.inputs[1]!.nonWitnessUtxo = stripped(
        fundingTx(wallet.script, 70_000n, 2),
      );
      expect(
        signaturesFromPsbt(built.psbt, added.toBase64(), NETWORK, requests),
      ).toHaveLength(2);
      const other = reparse(signed);
      other.data.inputs[0]!.nonWitnessUtxo = fundingTx(
        wallet.script,
        50_000n,
        3,
      ).toBuffer();
      refusedAs(built.psbt, other, requests, 'changes the prepared transaction');
      for (const junk of [
        Uint8Array.of(1, 2, 3),
        concatBytes(fundingTx(wallet.script, 50_000n, 1).toBuffer(), Uint8Array.of(0)),
      ]) {
        const bad = reparse(signed);
        bad.data.inputs[0]!.nonWitnessUtxo = junk;
        refusedAs(built.psbt, bad, requests, 'does not decode');
      }
    }
    // Taproot commits to every amount: a previous transaction is never added there.
    const { built, requests, wallet } = setup('p2tr');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeTaprootSigner(TEST_KEY, wallet.tweak as Uint8Array));
    const added = reparse(signed);
    added.data.inputs[0]!.nonWitnessUtxo = fundingTx(
      wallet.script,
      50_000n,
      1,
    ).toBuffer();
    refusedAs(built.psbt, added, requests, 'changes the prepared transaction');
  });

  it('refuses an added previous transaction whose output is not the one our PSBT spends (I1c)', () => {
    const wallet = walletAddress(TEST_PUBKEY, 'p2wpkh', PARAMS);
    // An indexer said 50,000; the authentic previous transaction pays 60,000.
    const funding = fundingTx(wallet.script, 60_000n, 7);
    const built = buildTx(
      NETWORK,
      wallet,
      [
        {
          outpoint: `${funding.getId()}:0`,
          txid: funding.getId(),
          vout: 0,
          value: 50_000n,
        },
      ],
      [{ script: PAYEE.script, value: 40_000n }],
      SEQUENCE_RBF,
    );
    const requests = ecdsaRequests(built.digests);
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeSigner(TEST_KEY));
    const added = reparse(signed);
    added.data.inputs[0]!.nonWitnessUtxo = funding.toBuffer();
    refusedAs(built.psbt, added, requests, 'changes the prepared transaction');
  });

  it('takes our own previous transactions byte for byte, without decoding them again (F3-R7)', () => {
    const { built, requests, wallet, funding } = withPrevious('p2wpkh');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(signerOf('p2wpkh', wallet));
    const ours = funding.map((tx) => stripped(tx).length);
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    const scure = jest.spyOn(scureBase64, 'decode');
    try {
      expect(
        signaturesFromPsbt(built.psbt, signed.toBase64(), NETWORK, requests),
      ).toHaveLength(2);
      expect(
        fromBuffer.mock.calls.filter(([bytes]) => ours.includes(bytes.length)),
      ).toEqual([]);
      // A coordinator's other copy (with the witness) is not ours: it is read, and bound to
      // the outpoint's txid, by the linear reader (F3-R24 F2), never by bitcoinjs.
      const core = reparse(signed);
      core.data.inputs[0]!.nonWitnessUtxo = funding[0]!.toBuffer();
      fromBuffer.mockClear();
      expect(
        signaturesFromPsbt(built.psbt, core.toBase64(), NETWORK, requests),
      ).toHaveLength(2);
      expect(
        fromBuffer.mock.calls.filter(
          ([bytes]) => bytes.length === funding[0]!.byteLength(),
        ),
      ).toHaveLength(0);
      core.data.inputs[0]!.nonWitnessUtxo = funding[1]!.toBuffer();
      refusedAs(built.psbt, core, requests, 'changes the prepared transaction');
      // Node's Buffer decodes the base64 (checked by a round trip), not the pure-JS decoder.
      expect(scure).not.toHaveBeenCalled();
    } finally {
      fromBuffer.mockRestore();
      scure.mockRestore();
    }
  });

  it('bounds what coordinators may add, in all, to one block (F3-R7)', () => {
    // 50 segwit inputs without their previous transactions (M15 off): 100,000 bytes of room
    // each would be 5 MB; in all it is one block (4,000,000 bytes).
    const wallet = walletAddress(TEST_PUBKEY, 'p2wpkh', PARAMS);
    const inputs = Array.from({ length: 50 }, (_, index) => {
      const funding = fundingTx(wallet.script, 10_000n, 100 + index);
      return {
        outpoint: `${funding.getId()}:0`,
        txid: funding.getId(),
        vout: 0,
        value: 10_000n,
      };
    });
    const built = buildTx(
      NETWORK,
      wallet,
      inputs,
      [{ script: PAYEE.script, value: 400_000n }],
      SEQUENCE_RBF,
    );
    const requests = ecdsaRequests(built.digests);
    const maps = 1 + 50 + 1;
    const room = maps * 4_096 + 4_000_000;
    const text = 'A'.repeat(built.psbt.length + Math.ceil(room / 3) * 4 + 4);
    refusedAs(built.psbt, { toBase64: () => text } as Psbt, requests, 'is too large');
  });

  it('reads what a coordinator adds, and the unsigned transaction it carries, without bitcoinjs (F3-R24 F2)', () => {
    // 40 segwit inputs without their previous transactions: 4 MB of room in all.
    const wallet = walletAddress(TEST_PUBKEY, 'p2wpkh', PARAMS);
    const inputs = Array.from({ length: 40 }, (_, index) => {
      const funding = fundingTx(wallet.script, 10_000n, 200 + index);
      return {
        outpoint: `${funding.getId()}:0`,
        txid: funding.getId(),
        vout: 0,
        value: 10_000n,
      };
    });
    const built = buildTx(
      NETWORK,
      wallet,
      inputs,
      [{ script: PAYEE.script, value: 300_000n }],
      SEQUENCE_RBF,
    );
    const requests = ecdsaRequests(built.digests);
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    const large = (bytes: Uint8Array) => bytes.length > 50_000;
    try {
      // An added previous transaction of 10,000 outputs that is not the outpoint's.
      const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
      signed.signAllInputs(nativeSigner(TEST_KEY));
      const added = reparse(signed);
      added.data.inputs[0]!.nonWitnessUtxo = manyOutputs(10_000).bytes;
      refusedAs(built.psbt, added, requests, 'changes the prepared transaction');
      // A PSBT whose unsigned transaction is 20,000 outputs, not ours (bitcoinjs: seconds).
      const hostile = manyOutputs(20_000).bytes;
      const psbt = concatBytes(
        Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff, 0x01, 0x00),
        compactSize(hostile.length),
        hostile,
        new Uint8Array(1 + 40 + 1),
      );
      const started = performance.now();
      refusedAs(
        built.psbt,
        { toBase64: () => Buffer.from(psbt).toString('base64') } as Psbt,
        requests,
        'is not the prepared transaction',
      );
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(fromBuffer.mock.calls.filter(([bytes]) => large(bytes))).toEqual([]);
    } finally {
      fromBuffer.mockRestore();
    }
  });

  it('has room for a large previous transaction a coordinator adds (I1c)', () => {
    const wallet = walletAddress(TEST_PUBKEY, 'p2wpkh', PARAMS);
    // A batch payout: our output first, then 1,000 others (about 31 KB).
    const funding = fundingTx(wallet.script, 50_000n, 8);
    for (let i = 0; i < 1_000; i++) funding.addOutput(PAYEE.script, 1_000n);
    const built = buildTx(
      NETWORK,
      wallet,
      [
        {
          outpoint: `${funding.getId()}:0`,
          txid: funding.getId(),
          vout: 0,
          value: 50_000n,
        },
      ],
      [{ script: PAYEE.script, value: 40_000n }],
      SEQUENCE_RBF,
    );
    const requests = ecdsaRequests(built.digests);
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeSigner(TEST_KEY));
    const added = reparse(signed);
    added.data.inputs[0]!.nonWitnessUtxo = funding.toBuffer();
    expect(funding.toBuffer().length).toBeGreaterThan(30_000);
    expect(
      signaturesFromPsbt(built.psbt, added.toBase64(), NETWORK, requests),
    ).toHaveLength(1);
  });

  it('accepts PSBT version 0 and proprietary keys at every level, and refuses another version (M1)', () => {
    const { built, requests } = setup('p2wpkh');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeSigner(TEST_KEY));
    const proprietary = {
      key: Uint8Array.of(0xfc, 0x05, 0x63, 0x6f, 0x72, 0x65, 0x21, 0x00),
      value: Uint8Array.of(0x01),
    };
    const accepted = reparse(signed)
      .addUnknownKeyValToGlobal({ key: Uint8Array.of(0xfb), value: new Uint8Array(4) })
      .addUnknownKeyValToGlobal(proprietary)
      .addUnknownKeyValToInput(0, proprietary)
      .addUnknownKeyValToOutput(1, proprietary);
    expect(
      signaturesFromPsbt(built.psbt, accepted.toBase64(), NETWORK, requests),
    ).toHaveLength(2);
    for (const version of [
      { key: Uint8Array.of(0xfb), value: Uint8Array.of(2, 0, 0, 0) },
      { key: Uint8Array.of(0xfb), value: Uint8Array.of(0, 0, 0, 0, 0) },
      { key: Uint8Array.of(0xfb, 0x00), value: new Uint8Array(4) },
    ]) {
      refusedAs(
        built.psbt,
        reparse(signed).addUnknownKeyValToGlobal(version),
        requests,
        'carries a field a signer does not add',
      );
    }
  });

  it('trims ASCII whitespace around the base64, and only there (M2)', () => {
    const { built, requests } = setup('p2wpkh');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeSigner(TEST_KEY));
    const good = signed.toBase64();
    for (const text of [`${good}\n`, `\r\n\t ${good} \n`, `${good}\v\f`]) {
      expect(signaturesFromPsbt(built.psbt, text, NETWORK, requests)).toHaveLength(2);
    }
    for (const text of [
      `${good.slice(0, 8)} ${good.slice(8)}`,
      `${String.fromCharCode(0xa0)}${good}`,
    ]) {
      expect(() => signaturesFromPsbt(built.psbt, text, NETWORK, requests)).toThrow(
        expect.objectContaining({ message: 'the signed PSBT does not decode' }),
      );
    }
  });

  it('p2tr: takes the key-path signatures from a finalized PSBT (M4)', () => {
    const { built, requests, wallet } = setup('p2tr');
    const signed = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    signed.signAllInputs(nativeTaprootSigner(TEST_KEY, wallet.tweak as Uint8Array));
    signed.finalizeAllInputs();
    const bundles = signaturesFromPsbt(built.psbt, signed.toBase64(), NETWORK, requests);
    expect(bundles.map((b) => b.requestId)).toEqual(['in:0', 'in:1']);
    for (const bundle of bundles) {
      const request = requests.find((r) => r.id === bundle.requestId)!;
      expect(
        secp256k1Schnorr.verify({
          publicKey: request.publicKey,
          payload: request.payload,
          signature: bundle.bytes,
        }),
      ).toBe(true);
    }
  });
});

describe('buildTx range checks (lesson 19)', () => {
  const MAX_MONEY = 2_100_000_000_000_000n;
  const wallet = walletAddress(TEST_PUBKEY, 'p2wpkh', PARAMS);
  const txid = '11'.repeat(32);
  const input = { outpoint: `${txid}:0`, txid, vout: 0, value: 50_000n };
  const output = { script: PAYEE.script, value: 40_000n };
  const build = (i: PlannedInput, o = output, sequence = SEQUENCE_RBF) =>
    buildTx(NETWORK, wallet, [i], [o], sequence);

  it('refuses an outpoint listed twice with a fixed text (M3)', () => {
    expect(() =>
      buildTx(NETWORK, wallet, [input, { ...input }], [output], SEQUENCE_RBF),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_INTENT',
        message: 'an input outpoint is listed twice',
      }),
    );
  });

  it('accepts every field at its maximum', () => {
    expect(
      build({ ...input, vout: 0xffffffff }, output, 0xffffffff).digests,
    ).toHaveLength(1);
    expect(
      build({ ...input, value: MAX_MONEY }, { ...output, value: MAX_MONEY }).digests,
    ).toHaveLength(1);
  });

  it.each([
    [
      'a vout over 32 bits',
      { ...input, vout: 0x1_0000_0000 },
      output,
      SEQUENCE_RBF,
      'INVALID_INTENT',
    ],
    ['a negative vout', { ...input, vout: -1 }, output, SEQUENCE_RBF, 'INVALID_INTENT'],
    [
      'a fractional vout',
      { ...input, vout: 0.5 },
      output,
      SEQUENCE_RBF,
      'INVALID_INTENT',
    ],
    [
      'a txid that is not 32 bytes of hex',
      { ...input, txid: 'zz'.repeat(32) },
      output,
      SEQUENCE_RBF,
      'INVALID_INTENT',
    ],
    ['a sequence over 32 bits', input, output, 0x1_0000_0000, 'INVALID_INTENT'],
    ['a negative sequence', input, output, -1, 'INVALID_INTENT'],
    [
      'an input value over MAX_MONEY',
      { ...input, value: MAX_MONEY + 1n },
      output,
      SEQUENCE_RBF,
      'INVALID_AMOUNT',
    ],
    [
      'a negative input value',
      { ...input, value: -1n },
      output,
      SEQUENCE_RBF,
      'INVALID_AMOUNT',
    ],
    [
      'an output value over MAX_MONEY',
      input,
      { ...output, value: MAX_MONEY + 1n },
      SEQUENCE_RBF,
      'INVALID_AMOUNT',
    ],
    [
      'a negative output value',
      input,
      { ...output, value: -1n },
      SEQUENCE_RBF,
      'INVALID_AMOUNT',
    ],
  ] as const)('refuses %s with a fixed text', (_, i, o, sequence, code) => {
    let caught: unknown;
    try {
      build(i, o, sequence);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(expect.objectContaining({ code }));
    expect((caught as Error).message).not.toMatch(/\d{4,}|zz/);
  });
});

describe('untrusted transaction hex (lesson 20)', () => {
  const signed = () => {
    const { built, requests, sign } = setup('p2pkh');
    return assembleTx(built.psbt, NETWORK, requests, sign());
  };
  const keyHash = hash160(TEST_PUBKEY);
  const undecodable = expect.objectContaining({
    code: 'INVALID_INTENT',
    message: 'a transaction does not decode',
  });

  it('refuses trailing junk and non-hex, and reads either case', () => {
    const ours = signed();
    for (const hex of [
      `${ours.hex}zz`,
      `${ours.hex}00`,
      `0x${ours.hex}`,
      `${ours.hex}0`,
    ]) {
      expect(() => txidOfHex(hex)).toThrow(undecodable);
      expect(canonicalTwinTxid(hex, keyHash)).toBeUndefined();
    }
    expect(txidOfHex(ours.hex.toUpperCase())).toBe(ours.txid);
  });

  it('refuses a transaction larger than a block before decoding it', () => {
    const huge = '00'.repeat(4_000_001);
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    try {
      expect(() => txidOfHex(huge)).toThrow(undecodable);
      expect(canonicalTwinTxid(huge, keyHash)).toBeUndefined();
      const wallet = walletAddress(TEST_PUBKEY, 'p2pkh', PARAMS);
      const funding = fundingTx(wallet.script, 50_000n, 1);
      expect(previousTxOf(huge)).toBeUndefined();
      // Nothing larger than a block reached the decoder.
      expect(fromBuffer.mock.calls.filter(([bytes]) => bytes.length > 4_000_000)).toEqual(
        [],
      );
      // A previous transaction with trailing junk does not decode either.
      expect(previousTxOf(`${funding.toHex()}zz`)).toBeUndefined();
      expect(previousTxOf(`${funding.toHex()}00`)).toBeUndefined();
      expect(previousTxOf(funding.toHex())?.txid).toBe(funding.getId());
    } finally {
      fromBuffer.mockRestore();
    }
  });

  it('reads untrusted transaction bytes in one linear pass, never through bitcoinjs (F3-R24 F2)', () => {
    // bitcoinjs' decoder is quadratic in the inputs and outputs: 53 s for 92,500 outputs.
    const decodable = manyOutputs(110_000, 2_900_000); // 3.9 MB, a chain's million bytes
    const tooLarge = manyOutputs(433_000); // 3.9 MB without witness: no chain holds it
    const fromBuffer = jest.spyOn(bitcoin.Transaction, 'fromBuffer');
    try {
      for (const { bytes } of [decodable, tooLarge]) {
        const hex = toHex(bytes);
        const started = performance.now();
        previousTxOf(hex);
        try {
          txidOfHex(hex);
        } catch {
          // refused: over the million bytes a chain allows
        }
        canonicalTwinTxid(hex, keyHash);
        expect(performance.now() - started).toBeLessThan(5_000);
      }
      expect(previousTxOf(toHex(decodable.bytes))?.txid).toBe(
        txidOfStripped(decodable.stripped),
      );
      expect(toHex(previousTxOf(toHex(decodable.bytes))!.bytes)).toBe(
        toHex(decodable.stripped),
      );
      expect(previousTxOf(toHex(tooLarge.bytes))).toBeUndefined();
      expect(() => txidOfHex(toHex(tooLarge.bytes))).toThrow(undecodable);
      expect(fromBuffer).not.toHaveBeenCalled();
    } finally {
      fromBuffer.mockRestore();
    }
  });

  it("viewPsbt refuses a previous transaction that is not the outpoint's", () => {
    const { built } = setup('p2pkh');
    const psbt = bitcoin.Psbt.fromBase64(built.psbt, { network: NETWORK });
    psbt.data.inputs[0]!.nonWitnessUtxo = fundingTx(PAYEE.script, 1n, 9).toBuffer();
    expect(() => viewPsbt(psbt.toBase64(), NETWORK)).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });
});
