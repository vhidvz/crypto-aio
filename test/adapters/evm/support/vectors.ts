import { secp256k1 } from '@noble/curves/secp256k1';
import type { EvmSignature, EvmTxFields } from '../../../../src/adapters/evm/types';

/** A well-known test key (never funded anywhere real) and its account. */
export const KEY = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
export const KEY_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
export const KEY_PUBLIC = secp256k1.getPublicKey(KEY, true);
export const RECIPIENT = '0x3535353535353535353535353535353535353535';

/** Deterministic vectors, generated once with ethers 6.17.0 and frozen here. */
export const VECTORS: readonly {
  readonly name: string;
  readonly fields: EvmTxFields;
  readonly unsigned: string;
  readonly digest: string;
  readonly raw: string;
  readonly hash: string;
}[] = [
  {
    name: 'eip1559 on sepolia',
    fields: {
      type: 'eip1559',
      chainId: 11155111n,
      nonce: 7n,
      to: RECIPIENT,
      value: 10n ** 15n,
      data: '0x',
      gasLimit: 21_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    },
    unsigned:
      '0x02f183aa36a707843b9aca0084b2d05e0082520894353535353535353535353535353535353535353587038d7ea4c6800080c0',
    digest: '0xd9edcc0e5b21780a63750a057ab9d084f1dd3b721d91964b523185c5fe6607b9',
    raw: '0x02f87483aa36a707843b9aca0084b2d05e0082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0b43c0c11cff5af3f8be4a7dc699d092bc97e4fc1a45d40e5f30964b4f9cdb9f5a0453c932246e4f1be56153a5eb04d02f84541aa7772b7a2fc03715f5f8ccbd9ea',
    hash: '0xb9b71db7c52e37cb71074ddd52c0359d70943a36f1301f354d9bd12463937c72',
  },
  {
    name: 'legacy (EIP-155) on bsc testnet',
    fields: {
      type: 'legacy',
      chainId: 97n,
      nonce: 7n,
      to: RECIPIENT,
      value: 10n ** 15n,
      data: '0x',
      gasLimit: 21_000n,
      gasPrice: 5_000_000_000n,
    },
    unsigned:
      '0xeb0785012a05f20082520894353535353535353535353535353535353535353587038d7ea4c6800080618080',
    digest: '0x88bb1c4acd44eb0172c33b2a7d67ea51199859920c04af33a7a99fc824aa4856',
    raw: '0xf86c0785012a05f20082520894353535353535353535353535353535353535353587038d7ea4c680008081e6a0e5ec62418de30fccafffeb126eb5b755b25b251e0a739664f09ff3661fdbd65ea02bf9a66da8ac10ca950f2f925fa7f848c5ba13e79ba0118c274c3dd8b0d347fc',
    hash: '0x4680b7d289be1be2ba0068913260b6d20e40a3418db24f60aca621dba7fca4cd',
  },
];

/** Signs a digest the way `localSigner` does: RFC 6979, low-s, with the recovery bit. */
export function signDigest(digest: string): EvmSignature {
  const signature = secp256k1.sign(digest.slice(2), KEY, { lowS: true });
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
  return {
    r: word(signature.r),
    s: word(signature.s),
    yParity: signature.recovery as 0 | 1,
  };
}
