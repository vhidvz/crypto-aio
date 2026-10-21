/**
 * A real block (signet 70000, fetched once from mempool.space's Esplora and pinned): its
 * bytes, its `/block/:hash` header, its `/block/:hash/txs/0` page (fields the driver reads)
 * and the bytes of the transactions its inputs spend. Six segwit transactions and a
 * coinbase witness commitment, so the raw reader's hash, merkle root and BIP141 checks,
 * and the decoding of a block's own bytes, are held to what a real chain and server say.
 */
export const SIGNET_70000 = {
  hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
  height: 70000,
  /** `/block/:hash`. */
  header: {
    id: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
    height: 70000,
    version: 536870912,
    timestamp: 1640395170,
    tx_count: 6,
    size: 826,
    weight: 3121,
    merkle_root: '6dacf8516dbfad8d2dfea43831eb8f82c691051a3e885df237b642fbdf56f6aa',
    previousblockhash: '00000087f59400f633c77701dcf36171c167b11678a185ed552781757cc108af',
    mediantime: 1640392945,
    nonce: 17604401,
    bits: 503404228,
    difficulty: 0.002917400895177098,
  },
  /** `/block/:hash/raw`, as hex. */
  raw: [
    '00000020af08c17c75812755ed85a17816b167c17161f3dc0177c733f60094f587000000aaf656dffb42b637',
    'f25d883e1a0591c6828feb3138a4fe2d8dadbf6d51f8ac6da271c661c456011e319f0c010601000000000101',
    '0000000000000000000000000000000000000000000000000000000000000000ffffffff0403701101feffff',
    'ff0271f4052a0100000016001481113cad52683679a83e76f76f84a4cfe36f75010000000000000000776a24',
    'aa21a9ed6a637237ce867cbe9a1aef5aacb4c0404b7754269face164b7e4139fc346ee404c4fecc7daa24900',
    '47304402200fd47ab934469d371fa873e474b60d79e1a938d9d89bc4882da340a88cdd07ce0220225e32d82c',
    '98e258f1536d90834b5b00d7845b58998a9c7ff16d3266499457af0100012000000000000000000000000000',
    '00000000000000000000000000000000000000000000000200000000010130c40d3f0bb26de5ceb921642b89',
    'dc17cb61cc590c98167968a26bbf09abd4c80000000000ffffffff01a88a0e00000000002200204ae81572f0',
    '6e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc332600101510000000002000000000101700e8c',
    'e7c70f0b7eb215d7abeddbb1fa59ee38b4056885ddfddae2be871ec15e0000000000ffffffff01a88a0e0000',
    '0000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260010151000000',
    '00020000000001013cd1fd35ebc22f952e1f9b381825572a3afaad09020f2e29b1010d245534c4d300000000',
    '00ffffffff0118258b00000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c0',
    '0b8cc3326001015100000000020000000001010c6d4e33300beda7cfee39a58bb579df239875b24a690ef3d8',
    '1df5180359a4ea0000000000ffffffff01aa4bb605000000002200204ae81572f06e1b88fd5ced7a1a000945',
    '432e83e1551e6f721ee9c00b8cc332600101510000000002000000000101e06a0a6a2f66dfeb60bb261027ca',
    '01a4012e1dda60dd1ddf0256006b833062710000000000ffffffff01222b8c1d000000002200204ae81572f0',
    '6e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
  ].join(''),
  /** `/block/:hash/txs/0`. */
  page: [
    {
      txid: '42b97442aec345ab3828ce51906aa8739d5b8a8dd7ef00b3bdd1dc1a91e26b45',
      version: 1,
      locktime: 0,
      vin: [
        {
          txid: '0000000000000000000000000000000000000000000000000000000000000000',
          vout: 4294967295,
          prevout: null,
          is_coinbase: true,
          sequence: 4294967294,
        },
      ],
      vout: [
        {
          scriptpubkey: '001481113cad52683679a83e76f76f84a4cfe36f7501',
          scriptpubkey_type: 'v0_p2wpkh',
          value: 5000000625,
          scriptpubkey_address: 'tb1qsygnet2jdqm8n2p7wmmklp9yel3k7agpnycv4f',
        },
        {
          scriptpubkey:
            '6a24aa21a9ed6a637237ce867cbe9a1aef5aacb4c0404b7754269face164b7e4139fc346ee404c4fecc7daa2490047304402200fd47ab934469d371fa873e474b60d79e1a938d9d89bc4882da340a88cdd07ce0220225e32d82c98e258f1536d90834b5b00d7845b58998a9c7ff16d3266499457af0100',
          scriptpubkey_type: 'op_return',
          value: 0,
        },
      ],
      size: 250,
      weight: 892,
      fee: 0,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
    {
      txid: 'a7926f22242d07d2ed2b95c018d77a88728d47f9c7fa8fbb96b7396f2e7f6f4b',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: 'c8d4ab09bf6ba2687916980c59cc61cb17dc892b6421b9cee56db20b3f0dc430',
          vout: 0,
          prevout: {
            scriptpubkey:
              '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
            scriptpubkey_type: 'v0_p2wsh',
            value: 953125,
            scriptpubkey_address:
              'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
          },
          is_coinbase: false,
          sequence: 4294967295,
        },
      ],
      vout: [
        {
          scriptpubkey:
            '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
          scriptpubkey_type: 'v0_p2wsh',
          value: 953000,
          scriptpubkey_address:
            'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
        },
      ],
      size: 99,
      weight: 381,
      fee: 125,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
    {
      txid: '39d29dc2903c6e9a16dd96accedb6e971707fcc6837ab2ae3dfb2fdb7554aa55',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: '5ec11e87bee2dafddd856805b438ee59fab1dbedabd715b27e0b0fc7e78c0e70',
          vout: 0,
          prevout: {
            scriptpubkey:
              '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
            scriptpubkey_type: 'v0_p2wsh',
            value: 953125,
            scriptpubkey_address:
              'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
          },
          is_coinbase: false,
          sequence: 4294967295,
        },
      ],
      vout: [
        {
          scriptpubkey:
            '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
          scriptpubkey_type: 'v0_p2wsh',
          value: 953000,
          scriptpubkey_address:
            'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
        },
      ],
      size: 99,
      weight: 381,
      fee: 125,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
    {
      txid: '50d4c00e34d168c8196df51c9bd133c5b3b6636c4376612aa16570a3d075886e',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: 'd3c43455240d01b1292e0f0209adfa3a2a572518389b1f2e952fc2eb35fdd13c',
          vout: 0,
          prevout: {
            scriptpubkey:
              '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
            scriptpubkey_type: 'v0_p2wsh',
            value: 9119125,
            scriptpubkey_address:
              'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
          },
          is_coinbase: false,
          sequence: 4294967295,
        },
      ],
      vout: [
        {
          scriptpubkey:
            '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
          scriptpubkey_type: 'v0_p2wsh',
          value: 9119000,
          scriptpubkey_address:
            'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
        },
      ],
      size: 99,
      weight: 381,
      fee: 125,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
    {
      txid: '5a12ec2974d7c1f93e456f7f9310c6d8cb3ffafca2a926aa47c4850d9ee199cf',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: 'eaa4590318f51dd8f30e694ab2759823df79b58ba539eecfa7ed0b30334e6d0c',
          vout: 0,
          prevout: {
            scriptpubkey:
              '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
            scriptpubkey_type: 'v0_p2wsh',
            value: 95833127,
            scriptpubkey_address:
              'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
          },
          is_coinbase: false,
          sequence: 4294967295,
        },
      ],
      vout: [
        {
          scriptpubkey:
            '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
          scriptpubkey_type: 'v0_p2wsh',
          value: 95833002,
          scriptpubkey_address:
            'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
        },
      ],
      size: 99,
      weight: 381,
      fee: 125,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
    {
      txid: '37187ba09afaf3bea15fb3615f5954a243b21b7a53b097deb87dcdfc25ea4cfd',
      version: 2,
      locktime: 0,
      vin: [
        {
          txid: '716230836b005602df1ddd60da1d2e01a401ca271026bb60ebdf662f6a0a6ae0',
          vout: 0,
          prevout: {
            scriptpubkey:
              '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
            scriptpubkey_type: 'v0_p2wsh',
            value: 495725471,
            scriptpubkey_address:
              'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
          },
          is_coinbase: false,
          sequence: 4294967295,
        },
      ],
      vout: [
        {
          scriptpubkey:
            '00204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc33260',
          scriptpubkey_type: 'v0_p2wsh',
          value: 495725346,
          scriptpubkey_address:
            'tb1qft5p2uhsdcdc3l2ua4ap5qqfg4pjaqlp250x7us7a8qqhrxrxfsqaqh7jw',
        },
      ],
      size: 99,
      weight: 381,
      fee: 125,
      status: {
        confirmed: true,
        block_height: 70000,
        block_hash: '0000009266d061c81d88492a405e2e84f55d9a953b8f10cbbb9ea77cfd52a3b1',
        block_time: 1640395170,
      },
    },
  ],
  /** `/tx/:txid/hex` of each previous transaction. */
  parents: {
    c8d4ab09bf6ba2687916980c59cc61cb17dc892b6421b9cee56db20b3f0dc430:
      '02000000000101d687913def4f1c5c006fd63ce70a464d6334742c43beca53515afba409fdfa120000000000ffffffff01258b0e00000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
    '5ec11e87bee2dafddd856805b438ee59fab1dbedabd715b27e0b0fc7e78c0e70':
      '02000000000101c72a7e1eb663edc37aad4e5a038c113ae64f4924400675f9803c77950002dd0d0000000000ffffffff01258b0e00000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
    d3c43455240d01b1292e0f0209adfa3a2a572518389b1f2e952fc2eb35fdd13c:
      '020000000001019520b53920feced21d2ba00a91a54bd3fd3cd06cacab75fd00b653d46c5f747b0000000000ffffffff0195258b00000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
    eaa4590318f51dd8f30e694ab2759823df79b58ba539eecfa7ed0b30334e6d0c:
      '02000000000101ba4ad73df02c52006970003cb634d2caee250b65fee5e92a878923a2170df9f40000000000ffffffff01274cb605000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
    '716230836b005602df1ddd60da1d2e01a401ca271026bb60ebdf662f6a0a6ae0':
      '02000000000101dc9ec3ad9a72993c125993dc59da5f25b040863474318ce13ff2573e69c1d5cf0000000000ffffffff019f2b8c1d000000002200204ae81572f06e1b88fd5ced7a1a000945432e83e1551e6f721ee9c00b8cc3326001015100000000',
  } as Record<string, string>,
};
