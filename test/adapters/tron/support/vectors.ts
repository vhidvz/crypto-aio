import { secp256k1 } from '@noble/curves/secp256k1';
import type { TronRawData } from '../../../../src/adapters/tron/types';

/** A well-known test key (never funded anywhere real) and its Tron account. */
export const KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
export const KEY_ADDRESS = 'TE2H9hWjzYdwzDFRJfx9BFhr4MmjH1CHaz';
export const KEY_HEX = '412c7536e3605d9c16a7a3d7b1898e529396a65c23';
export const KEY_PUBLIC = secp256k1.getPublicKey(KEY, true);
export const RECIPIENT = 'TEpYZAv4zzwchQvzCNAS7t9PdGSGZgbhUa';
export const RECIPIENT_HEX = '413535353535353535353535353535353535353535';
export const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

const COMMON = {
  refBlockBytes: '4a2c',
  refBlockHash: '8d1c0e6f2a3b4c5d',
  expiration: 1_790_000_060_000,
  timestamp: 1_790_000_000_000,
} as const;

/** Frozen vectors, generated once with tronweb 6.5.1 (`txJsonToPb`, `signTransaction`). */
export const VECTORS: readonly {
  readonly name: string;
  readonly raw: TronRawData;
  readonly rawHex: string;
  readonly txId: string;
  /** tronweb's 65-byte signature: r ‖ s ‖ (recovery + 27). */
  readonly signature: string;
  /** The signed `Transaction` protobuf that `/wallet/broadcasthex` takes. */
  readonly signed: string;
}[] = [
  {
    name: 'TRX transfer with a memo',
    raw: {
      ...COMMON,
      data: '696e766f696365203432',
      contract: {
        type: 'TransferContract',
        owner: KEY_HEX,
        to: RECIPIENT_HEX,
        amount: 1_500_000n,
      },
    },
    rawHex:
      '0a024a2c22088d1c0e6f2a3b4c5d40e0acc5a28c34520a696e766f6963652034325a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15412c7536e3605d9c16a7a3d7b1898e529396a65c23121541353535353535353535353535353535353535353518e0c65b7080d8c1a28c34',
    txId: '1d7b47bf6c7b132c291307b684af0930029ce01a285ad8f01e3ab814633c5318',
    signature:
      'c26af3f71868f43d065273ccda9075bef817897fc68420c8a2a7816c8ecff853737de99b0324032c90928fa5cd726c1d2b0f85052406278581287834462a764c1b',
    signed:
      '0a91010a024a2c22088d1c0e6f2a3b4c5d40e0acc5a28c34520a696e766f6963652034325a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a15412c7536e3605d9c16a7a3d7b1898e529396a65c23121541353535353535353535353535353535353535353518e0c65b7080d8c1a28c341241c26af3f71868f43d065273ccda9075bef817897fc68420c8a2a7816c8ecff853737de99b0324032c90928fa5cd726c1d2b0f85052406278581287834462a764c1b',
  },
  {
    name: 'TRC-20 transfer with a fee limit',
    raw: {
      ...COMMON,
      feeLimit: 30_000_000,
      contract: {
        type: 'TriggerSmartContract',
        owner: KEY_HEX,
        contract: USDT_HEX,
        data:
          'a9059cbb0000000000000000000000003535353535353535353535353535353535353535' +
          '00000000000000000000000000000000000000000000000000000000002625a0',
      },
    },
    rawHex:
      '0a024a2c22088d1c0e6f2a3b4c5d40e0acc5a28c345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15412c7536e3605d9c16a7a3d7b1898e529396a65c23121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000353535353535353535353535353535353535353500000000000000000000000000000000000000000000000000000000002625a07080d8c1a28c3490018087a70e',
    txId: '46f24ba48a7951ec538f55a4ed2e0b30b04a4982995c96c04d1bfb58f97af48d',
    signature:
      '34f89c2837b2fae4c33963b93a79f5e08a2a26e78026a6f9cb5854c9845a545f3d3143ca43ed33e8ad24c863f1bc36d884792389def5568bb45aa55a7853bf0f1b',
    signed:
      '0ad3010a024a2c22088d1c0e6f2a3b4c5d40e0acc5a28c345aae01081f12a9010a31747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e54726967676572536d617274436f6e747261637412740a15412c7536e3605d9c16a7a3d7b1898e529396a65c23121541a614f803b6fd780986a42c78ec9c7f77e6ded13c2244a9059cbb000000000000000000000000353535353535353535353535353535353535353500000000000000000000000000000000000000000000000000000000002625a07080d8c1a28c3490018087a70e124134f89c2837b2fae4c33963b93a79f5e08a2a26e78026a6f9cb5854c9845a545f3d3143ca43ed33e8ad24c863f1bc36d884792389def5568bb45aa55a7853bf0f1b',
  },
];

/**
 * A real mainnet TRX transfer whose client-set `timestamp` is .NET ticks, above 2^53 − 1
 * (java-tron does not bound `timestamp`): block 86,615,431, txid `a362c1f34d02…7502`,
 * captured once from TronGrid's `POST /wallet/getblockbynum {"num":86615431}` on
 * 2026-09-27. `txId` = SHA-256 of `rawHex`.
 */
export const MAINNET_TICKS: {
  readonly block: number;
  readonly txId: string;
  readonly rawHex: string;
  /** The exact field value; a JS number can hold it only rounded. */
  readonly timestamp: bigint;
  readonly raw: TronRawData;
} = {
  block: 86_615_431,
  txId: 'a362c1f34d02111f60d9d7816d2114a5c6d0f0c0dd774533409a3ff5f7387502',
  rawHex:
    '0a02a5862208cb0cb318c446eb0140988683ab8e345a67080112630a2d747970652e676f6f676c65617069732e636f6d2f70726f746f636f6c2e5472616e73666572436f6e747261637412320a1541ebb6d7a38d61b656ab0a445a8ca83281cf887e66121541853b2ffcc680170993e5b9dd2af3c0dea1c7f11818e0a00c70d8c888c8d49cc7ef08',
  timestamp: 639_261_443_207_865_432n,
  raw: {
    refBlockBytes: 'a586',
    refBlockHash: 'cb0cb318c446eb01',
    expiration: 1_790_554_719_000,
    timestamp: Number(639_261_443_207_865_432n),
    contract: {
      type: 'TransferContract',
      owner: '41ebb6d7a38d61b656ab0a445a8ca83281cf887e66',
      to: '41853b2ffcc680170993e5b9dd2af3c0dea1c7f118',
      amount: 200_800n,
    },
  },
};
