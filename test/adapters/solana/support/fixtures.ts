/**
 * A real devnet transaction (getTransaction, jsonParsed, 2026-09-25; log messages dropped):
 * two ComputeBudget instructions, an SPL transferChecked of 0.001 USDC (devnet) and a
 * memo, signed by a fee payer and a separate token owner. Public chain data.
 */
export const DEVNET_TRANSFER_CHECKED = {
  blockTime: 1790356677,
  meta: {
    computeUnitsConsumed: 13180,
    costUnits: 15582,
    err: null,
    fee: 10001,
    innerInstructions: [],
    logMessages: [],
    postBalances: [
      132692960, 13750000, 2039280, 2039280, 421923285289, 1, 20369267856, 41509609334,
    ],
    postTokenBalances: [
      {
        accountIndex: 2,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '405000',
          decimals: 6,
          uiAmount: 0.405,
          uiAmountString: '0.405',
        },
      },
      {
        accountIndex: 3,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '372686000',
          decimals: 6,
          uiAmount: 372.686,
          uiAmountString: '372.686',
        },
      },
    ],
    preBalances: [
      132702961, 13750000, 2039280, 2039280, 421923285289, 1, 20369267856, 41509609334,
    ],
    preTokenBalances: [
      {
        accountIndex: 2,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '406000',
          decimals: 6,
          uiAmount: 0.406,
          uiAmountString: '0.406',
        },
      },
      {
        accountIndex: 3,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '372685000',
          decimals: 6,
          uiAmount: 372.685,
          uiAmountString: '372.685',
        },
      },
    ],
    rewards: [],
    status: {
      Ok: null,
    },
  },
  slot: 504092431,
  transaction: {
    message: {
      accountKeys: [
        {
          pubkey: 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb',
          signer: true,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
          signer: true,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
          signer: false,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
          signer: false,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'ComputeBudget111111111111111111111111111111',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
          signer: false,
          source: 'transaction',
          writable: false,
        },
      ],
      addressTableLookups: [],
      instructions: [
        {
          accounts: [],
          data: 'EuxTsD',
          programId: 'ComputeBudget111111111111111111111111111111',
          stackHeight: 1,
        },
        {
          accounts: [],
          data: '3DdGGhkhJbjm',
          programId: 'ComputeBudget111111111111111111111111111111',
          stackHeight: 1,
        },
        {
          parsed: {
            info: {
              authority: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
              destination: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
              mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
              source: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
              tokenAmount: {
                amount: '1000',
                decimals: 6,
                uiAmount: 0.001,
                uiAmountString: '0.001',
              },
            },
            type: 'transferChecked',
          },
          program: 'spl-token',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          stackHeight: 1,
        },
        {
          parsed: '83c873a1f7d4c4bcfd6c095906248332',
          program: 'spl-memo',
          programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
          stackHeight: 1,
        },
      ],
      recentBlockhash: 'HqSZf935XJS4ZWxHWGf9V55kWj4wuRC7UJGbuL8faYxy',
    },
    signatures: [
      '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
      '2dZqU9pyrx1t3eo22cL7KsqMCDk8YdL4pwerkEX8bAsoVCv5DwuM9y4GonWduuCwmyV58TCo3gwTdH8a7ZuuoQgA',
    ],
  },
  transactionIndex: 2,
  version: 0,
};
