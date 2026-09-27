// Frozen end-to-end vectors (spec §17, lesson 11, M9): a known key and intent give known
// signature hashes, PSBT bytes, signed bytes and txids for every wallet type. The hashes are
// also recomputed with an independent implementation over @noble/hashes.
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { hash160, outputScript, walletAddress } from '../../../src/adapters/utxo/address';
import {
  SEQUENCE_RBF,
  assembleTx,
  buildTx,
  networkOf,
  type PlannedInput,
} from '../../../src/adapters/utxo/codec';
import type { UtxoAddressType } from '../../../src/adapters/utxo/types';
import { tweakPrivateKey } from '../../../src/core/signing/local';
import { toHex } from '../../../src/core/util/bytes';
import {
  bip143Sighash,
  bip341Sighash,
  legacySighash,
  type TxModel,
} from './support/sighash';
import { fundingTx } from './support/tx';
import { OTHER_PUBKEY, REGTEST, TEST_KEY, TEST_PUBKEY } from './support/vectors';

const NETWORK = networkOf(REGTEST);
const PAYEE = walletAddress(OTHER_PUBKEY, 'p2wpkh', REGTEST);
const hex = (bytes: Uint8Array) => toHex(bytes);
const digestOf = (text: string) => toHex(sha256(utf8ToBytes(text)));

/** Vectors frozen when this plan was written (sha256 of the PSBT and of the signed hex). */
const FROZEN: Record<
  UtxoAddressType,
  { digests: string[]; psbt: string; signed: string; txid: string }
> = {
  p2wpkh: {
    digests: [
      '5ca8fb0e6012f41c6f20f14c69ef06aef67c4e365d83ab5b2c54b142349464fc',
      '561ede5956b8b7d298ded405290c2c706df30f27beddba5feb59cde536fac035',
    ],
    psbt: '6ed889f3c9150f0465d2711064cc08167f09cc86f3d87bed9fdb2492850238ca',
    signed: '84ca51d6f5753ed0d8df86d1bdc897c9d1f1f3b8d1cc574d582e8b6520e029fa',
    txid: 'f967143748c193fe4839881b7bc311e044583f6782475be66c1bab5e6b7f0b95',
  },
  'p2sh-p2wpkh': {
    digests: [
      '9e4b2d329d6bac162aa98efedb2ad010866f926653fbd4538436aec6f1c4b9b9',
      '659e30b0950465448c5784389a8a1481f0a4bebca77d849d3e9bce0ba3b11f91',
    ],
    psbt: 'c8407e561d644d6c2bfb7436490be23a1b2fe534f33134f8d1e89a315e9f611d',
    signed: '55532da5cd463dbc6034ea9acd327df2acb818b46c6408ceca1620031050f3a8',
    txid: 'adc4039057e5c98c4f74dc573814cc137b67480a81a192bdb91d1a1cfdc2cf12',
  },
  p2pkh: {
    digests: [
      '6964d56e76e04340bd8a6625489e8c68c860663f24e090285e95c826bdc71a6d',
      'c3e9dba8a211c3b02049e6bb103eb594ba24169528c111ee4d5a24a233f1826d',
    ],
    psbt: '1239a1b13d07974acb1e2176ee6c58a18a7356fb26dbec9bd20f49702ab44b96',
    signed: '67f4197222825aeb46a8e69e6cd06eb8fc4a0054afa92be05f1ec8db74629987',
    txid: '23333502a3b2b807b69dc7a41402337f6b9d257472a98c2ab3634c7d7ec56394',
  },
  p2tr: {
    digests: [
      '177205ad062b52e378d2ad5b5dd5221f7330ff17b23be15265bb98e637e96de7',
      '512989ed9c350ac5df8e0492d43239df1096103c8f885c4fd64074bd956340fb',
    ],
    psbt: '2f6d65f013dec1e49cb8a6a77564d530db8d3dc1a0661cf1bfc371df80714a79',
    signed: '31b015ebf19267bca6374b6add58e883bb7d546f6d841b5127e72f8ffa0b04c4',
    txid: 'a7d991f2f9710b6524c45384ae65378321699447e20599c11bcfc5586764a52f',
  },
};

function vector(type: UtxoAddressType) {
  const wallet = walletAddress(TEST_PUBKEY, type, REGTEST);
  const funding = [
    fundingTx(wallet.script, 50_000n, 1),
    fundingTx(wallet.script, 70_000n, 2),
  ];
  const inputs: PlannedInput[] = funding.map((tx) => ({
    outpoint: `${tx.getId()}:0`,
    txid: tx.getId(),
    vout: 0,
    value: tx.outs[0]!.value,
    ...(type === 'p2tr' ? {} : { prevTxHex: tx.toHex() }),
  }));
  const outputs = [
    { script: PAYEE.script, value: 100_000n },
    { script: wallet.script, value: 19_000n },
  ];
  const built = buildTx(NETWORK, wallet, inputs, outputs, SEQUENCE_RBF);
  const signatures = built.digests.map((digest, index) => {
    if (type === 'p2tr') {
      const key = tweakPrivateKey(TEST_KEY, wallet.tweak as Uint8Array);
      return {
        requestId: `in:${index}`,
        bytes: schnorr.sign(digest, key, new Uint8Array(32)),
      };
    }
    const sig = secp256k1.sign(digest, TEST_KEY, { lowS: true });
    return {
      requestId: `in:${index}`,
      bytes: sig.toCompactRawBytes(),
      recovery: sig.recovery,
    };
  });
  const requests = built.digests.map((payload, index) => ({
    id: `in:${index}`,
    scheme: type === 'p2tr' ? 'secp256k1-schnorr' : 'secp256k1-ecdsa',
    payload,
    payloadKind: 'digest' as const,
    publicKey: type === 'p2tr' ? (wallet.outputKey as Uint8Array) : wallet.publicKey,
  }));
  const signed = assembleTx(built.psbt, NETWORK, requests, signatures);
  const model: TxModel = {
    version: 2,
    locktime: 0,
    inputs: inputs.map((i) => ({ ...i, sequence: SEQUENCE_RBF, script: wallet.script })),
    outputs,
  };
  const independent = inputs.map((_, index) =>
    type === 'p2pkh'
      ? legacySighash(model, index, wallet.script)
      : type === 'p2tr'
        ? bip341Sighash(model, index)
        : bip143Sighash(model, index, outputScript('p2pkh', hash160(wallet.publicKey))),
  );
  return { built, signed, independent };
}

describe.each(['p2wpkh', 'p2sh-p2wpkh', 'p2pkh', 'p2tr'] as const)(
  'the frozen %s vector',
  (type) => {
    it('matches the independent signature hashes', () => {
      const { built, independent } = vector(type);
      expect(built.digests.map(hex)).toEqual(independent.map(hex));
    });

    it('produces the frozen PSBT, signed bytes and txid', () => {
      const { built, signed } = vector(type);
      expect({
        digests: built.digests.map(hex),
        psbt: digestOf(built.psbt),
        signed: digestOf(signed.hex),
        txid: signed.txid,
      }).toEqual(FROZEN[type]);
    });
  },
);
