/**
 * Frozen TON vectors. Cross-checks (Plan 6 appendix):
 * - `KEY`/`PUBLIC_KEY`: RFC 8032 §7.1 test 1, so the ed25519 key pair is independent.
 * - `CHAIN_WALLETS`: live mainnet wallets (toncenter `walletInformation` type and
 *   `get_public_key`); our derivation must reproduce the address the chain holds.
 * - `REAL_REQUESTS`: live mainnet external messages whose signatures verify under
 *   `@noble/curves` over our digest layout, with the node's raw and TEP-467 hashes.
 * - `WALLET_IDS`: the v5r1 wallet ids seen on each live network.
 */
export const KEY = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const PUBLIC_KEY =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

/** The test key's wallets (raw form). v4r2 addresses do not depend on the network. */
export const TEST_WALLETS = {
  v4r2: {
    basechain: '0:cdac97c9162b2e141ad4463828b2a70efdf8762b97e83563f352becf902e88a6',
    masterchain: '-1:de069b75fcdaeaf0e88aa6182cf41efd6cabcb9e3203fa039b602a2000e918e2',
  },
  v5r1: {
    mainnet: '0:94a7ae12249e74e5d21d7201c31b5a03f0928c2d7a50ceee56ea52c57501ad03',
    testnet: '0:65cd37326614221028346d4db16723a8acce6a014e8ac31bbd5fbe91d97b0e9d',
    mainnetMasterchain:
      '-1:6e91b0e162c9ad1ad29886f2090c1766dd7114eaa78b61824b9a08e07628da4b',
  },
} as const;

export const WALLET_IDS = {
  v4r2: { basechain: 698983191, masterchain: 698983190 },
  v5r1: { mainnet: 2147483409, testnet: 2147483645, mainnetMasterchain: 8388369 },
} as const;

/** Live mainnet wallets: address, public key, version. */
export const CHAIN_WALLETS: readonly (readonly [string, string, 'v4r2' | 'v5r1'])[] = [
  [
    '0:0517a4dffe30004d36a3fa1b358ab7993af7dd3fb6cbf31e1f1d698cdf6c2f3f',
    'f2ee4e794a24c723bb443ef0bcd1d5e29d88228e3d352a5eade97932a02cfdd9',
    'v4r2',
  ],
  [
    '0:0fdb5c07b253b361dd261546df0da800ca76f620622493987b6eb73d875ca846',
    '807a12af2bb0eb0174112bfc3a5941834148d64aecb107b5457760b2d6d75b3d',
    'v4r2',
  ],
  [
    '0:104c8e35b1a9ac57cb1401103b66ad2f4e2174a1dfe1c4344d4e3d9cd487497d',
    '5eb77a92383d0fddaa5c593e7b7253b348403b8a68b2aa79e45357f838217d62',
    'v5r1',
  ],
  [
    '0:7dadb32dadc47eeb136d2c10c2a2b2b91302a8079caac544d17de37f266f3df1',
    'b8f871fa2163d1e820e909430cf63dea4de37860e93e5e329f07883619a752f3',
    'v5r1',
  ],
];

export interface RealRequest {
  readonly version: 'v4r2' | 'v5r1';
  readonly address: string;
  readonly publicKey: string;
  /** The external message body (base64 BOC). */
  readonly body: string;
  readonly seqno: number;
  /** The message hash and the TEP-467 normalized hash the indexer reports. */
  readonly hash: string;
  readonly hashNorm: string;
}

export const REAL_REQUESTS: readonly RealRequest[] = [
  {
    version: 'v4r2',
    address: '0:0517a4dffe30004d36a3fa1b358ab7993af7dd3fb6cbf31e1f1d698cdf6c2f3f',
    publicKey: 'f2ee4e794a24c723bb443ef0bcd1d5e29d88228e3d352a5eade97932a02cfdd9',
    body: 'te6cckEBAgEAiAABnLIvLC2PV5HvXbNXNxd04ioPSNvYnovqfqVClfJNBNShKewwRaVbVoFqhywTdGVWg7OfDSsa9tN1RSS9B9AWGwkpqaMXara2twASFBwAAwEAakIADSCK9A1Xpb34JlHCTGp3AcAAlB21jWr1sDxISOwRaW8oCyJCKdAAAAAAAAAAAAAAAAAAYcnpng==',
    seqno: 1184796,
    hash: 'a0286f7804381bafade6c1a8f2b09faa8e648ca478d8e59eadb5822dcc62c532',
    hashNorm: '9807df6f1cd68e1c238496c2dd3e59c4df15ebd75a6a3328cbf7e2b1a11f83bd',
  },
  {
    version: 'v5r1',
    address: '0:104c8e35b1a9ac57cb1401103b66ad2f4e2174a1dfe1c4344d4e3d9cd487497d',
    publicKey: '5eb77a92383d0fddaa5c593e7b7253b348403b8a68b2aa79e45357f838217d62',
    body: 'te6cckEBBQEAxwABoXNpZ25///8Rara1wQAABCqgOoVTxGVBYJd7OLnn3GCU+esjC9oZuwnw5+GNifFoq9Pi/YvlEiHuQ5E1ZyOmInAz+KbCnR6ICzQK92DL69ICoAECCg7DyG0DAgMAAAG4QgAvNN9h7+IkYZUvQNm9sMwIZ4Btt+IPmGYMeUXEub1Hy6hdIdugAAAAAAAAAAAAAAAAAAAAAAAAVGVsZWdyYW0gQWQgYWNjb3VudCB0b3AgdXAgCgpSZWYjUHUEAA5UTExyWURyjDXtNg==',
    seqno: 1066,
    hash: 'b152ea28c693b5c09d4afebdb3c809c981faebb8fc9cbbde303fb90b65fea17a',
    hashNorm: '71bcd556170330ec2f1198fb2cfb413de0dcdafca061b0c9af7e464b4285fbe4',
  },
];

/** The USDT master in every user-friendly form (TEP-2 flags, CRC16). */
export const USDT_MASTER = {
  raw: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe',
  bounceable: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  nonBounceable: 'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p',
  testBounceable: 'kQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_ntm',
  testNonBounceable: '0QCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_iaj',
  standardAlphabet: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id/sDs',
} as const;

/** A masterchain address, bounceable. */
export const MASTERCHAIN_FRIENDLY = 'Ef_eBpt1_Nrq8OiKphgs9B79bKvLnjID-gObYCogAOkY4l9O';
