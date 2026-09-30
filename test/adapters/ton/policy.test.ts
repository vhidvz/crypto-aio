import { TON_CHAINS } from '../../../src/adapters/ton/chains';
import { classifyBroadcastError } from '../../../src/adapters/ton/errors';
import {
  feeRequest,
  MAX_COINS,
  networkFee,
  tonFeeDetails,
  tonFeeDraft,
} from '../../../src/adapters/ton/fees';
import {
  DEFAULT_MAX_NETWORK_FEE,
  TON_CAPABILITIES,
  TON_INDEXER_CAPABILITIES,
  tonNetworkConfig,
} from '../../../src/adapters/ton/network';
import type { BroadcastResult } from '../../../src/core/driver/types';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import type { FeeOverride } from '../../../src/core/model/fee';

const chain = TON_CHAINS[0] as ChainInfo;
const mainnet = chain.networks.mainnet as NetworkInfo;

/** A config name that could be a pasted secret: a toncenter key, an xprv, a token, a blob. */
const SECRET_SHAPED = [
  'a1b2'.repeat(16),
  `xprv${'K'.repeat(107)}`,
  'apiKey=hunter2',
  'bearer:0123456789abcdef',
  'x'.repeat(100_000),
];

describe('TON network config', () => {
  it("never echoes a caller's key or capability name into an error (F3-R16)", () => {
    for (const name of SECRET_SHAPED) {
      const patches: readonly Partial<NetworkInfo>[] = [
        { params: { [name]: 1 } },
        { params: { maxNetworkFee: { [name]: 1n } } },
        { capabilities: { add: [name] } },
        { capabilities: { remove: [name] } },
        { feeModel: name as 'ton' },
        { finality: { kind: name } as unknown as NetworkInfo['finality'] },
      ];
      for (const patch of patches) {
        let thrown: unknown;
        try {
          tonNetworkConfig(chain, { ...mainnet, ...patch });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
        const message = (thrown as Error).message;
        expect([name.slice(0, 12), message.includes(name.slice(0, 8))]).toEqual([
          name.slice(0, 12),
          false,
        ]);
        expect(message.length).toBeLessThan(200);
      }
    }
  });

  it('reads the global id, lifetime and jetton values of the built-in networks', () => {
    expect(tonNetworkConfig(chain, mainnet)).toEqual({
      globalId: -239,
      testnet: false,
      validForSeconds: 60,
      jettonAttached: 50_000_000n,
      jettonForwardAmount: 1n,
      finalitySkewBlocks: 10,
      maxNetworkFee: { basechain: 1_000_000_000n, masterchain: 100_000_000_000n },
      capabilities: new Set([...TON_CAPABILITIES, 'address-history']),
    });
    expect(tonNetworkConfig(chain, chain.networks.testnet as NetworkInfo).globalId).toBe(
      -3,
    );
    expect(TON_INDEXER_CAPABILITIES).toEqual(['address-history']);
    expect(Object.isFrozen(TON_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(TON_INDEXER_CAPABILITIES)).toBe(true);
  });

  it('refuses inconsistent network data with CONFIG_INVALID (M3)', () => {
    const bad: readonly Partial<NetworkInfo>[] = [
      { identity: 'ton' },
      { identity: '0' },
      { identity: String(2 ** 31) },
      { identity: String(-(2 ** 31) - 1) },
      { identity: '0x10' },
      { identity: '1'.repeat(100_000) },
      { feeModel: 'evm-1559' },
      { finality: { kind: 'confirmations', confirmations: 1 } },
      { params: { validForSeconds: 1.5 } },
      { params: { validForSeconds: 5 } },
      { params: { validForSeconds: 9 } },
      { params: { validForSeconds: 86_401 } },
      { params: { validForSeconds: '60' } },
      { params: { jettonAttached: 0n } },
      { params: { jettonAttached: -1n } },
      { params: { jettonAttached: 5 } },
      // Lesson 19: the value is encoded as Coins (VarUInteger 16).
      { params: { jettonAttached: MAX_COINS + 1n } },
      { params: { jettonForwardAmount: 50_000_000n } },
      { params: { jettonForwardAmount: -1n } },
      { params: { jettonForwardAmount: 1 } },
      { params: { finalitySkewBlocks: 0 } },
      { params: { finalitySkewBlocks: 2.5 } },
      { params: { finalitySkewBlocks: 1_001 } },
      { capabilities: { add: ['block-scan'] } },
      { capabilities: { add: ['replace-fee'] } },
      { capabilities: { add: ['cancel'] } },
      // M2: only its own options and capabilities.
      { params: { jettonAttachd: 1n } },
      { params: { ...mainnet.params, validForSecond: 60 } },
      { capabilities: { add: ['fee-market-1559'] } },
      { capabilities: { remove: ['contract-read'] } },
      { capabilities: { add: ['toString'] } },
    ];
    for (const patch of bad) {
      expect(() => tonNetworkConfig(chain, { ...mainnet, ...patch })).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it('accepts the ends of every range, and a network that removes a capability', () => {
    const config = tonNetworkConfig(chain, {
      ...mainnet,
      identity: String(-(2 ** 31)),
      params: {
        validForSeconds: 10,
        jettonAttached: MAX_COINS,
        jettonForwardAmount: 0n,
        finalitySkewBlocks: 1,
      },
      capabilities: { remove: ['memo'] },
    });
    expect(config).toMatchObject({
      globalId: -(2 ** 31),
      validForSeconds: 10,
      jettonAttached: MAX_COINS,
      jettonForwardAmount: 0n,
      finalitySkewBlocks: 1,
    });
    expect(config.capabilities.has('memo')).toBe(false);
    expect(
      tonNetworkConfig(chain, {
        ...mainnet,
        identity: String(2 ** 31 - 1),
        params: {
          validForSeconds: 86_400,
          jettonAttached: 2n,
          jettonForwardAmount: 1n,
          finalitySkewBlocks: 1_000,
        },
      }),
    ).toMatchObject({
      globalId: 2 ** 31 - 1,
      validForSeconds: 86_400,
      finalitySkewBlocks: 1_000,
    });
    // An explicit `undefined` param is absent: the network default applies.
    expect(
      tonNetworkConfig(chain, { ...mainnet, params: { validForSeconds: undefined } })
        .validForSeconds,
    ).toBe(60);
  });

  it("takes maxNetworkFee as a handle option too: the option, then the network's, then the default (F6-R24, F6-R25)", () => {
    const config = (
      options: Readonly<Record<string, unknown>>,
      params: Readonly<Record<string, unknown>> = {},
    ) => tonNetworkConfig(chain, { ...mainnet, params }, options).maxNetworkFee;
    expect(config({})).toEqual(DEFAULT_MAX_NETWORK_FEE);
    expect(config({ maxNetworkFee: undefined })).toEqual(DEFAULT_MAX_NETWORK_FEE);
    // Per workchain: the option's, else the network's, else the default.
    expect(
      config(
        { maxNetworkFee: { basechain: 7n } },
        { maxNetworkFee: { basechain: 5n, masterchain: 9n } },
      ),
    ).toEqual({ basechain: 7n, masterchain: 9n });
    expect(config({ maxNetworkFee: { masterchain: 3n } })).toEqual({
      basechain: 1_000_000_000n,
      masterchain: 3n,
    });
    expect(Object.isFrozen(config({ maxNetworkFee: { basechain: 7n } }))).toBe(true);
    // Validated like the network's value; the network's is checked even when overridden.
    const refused = (
      options: Readonly<Record<string, unknown>>,
      params: Readonly<Record<string, unknown>>,
      message: string,
    ) => {
      let thrown: unknown;
      try {
        config(options, params);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining(message),
      });
      return (thrown as Error).message;
    };
    refused({ maxNetworkFee: { basechain: 0n } }, {}, 'maxNetworkFee.basechain must be');
    refused(
      { maxNetworkFee: 5n },
      {},
      'maxNetworkFee must be { basechain?, masterchain? }',
    );
    refused({ maxNetworkFee: { basechain: 5 } }, {}, 'maxNetworkFee.basechain must be');
    refused(
      { maxNetworkFee: { basechain: 5n } },
      { maxNetworkFee: { basechain: -1n } },
      'params.maxNetworkFee.basechain must be',
    );
    // F3-R16: an unknown option is refused, naming the accepted one, never echoing its key.
    const secret = 'EQ' + 'k'.repeat(46);
    for (const key of ['maxNetworkFees', 'validForSeconds', secret]) {
      const message = refused(
        { [key]: 1n },
        {},
        "unknown option; the TON driver's only option is 'maxNetworkFee'",
      );
      expect(message).not.toContain(key === secret ? secret : `'${key}'`);
    }
  });

  it('takes a per-workchain fee ceiling, validated as Coins (F6-R17)', () => {
    const ceiling = (maxNetworkFee: unknown) =>
      tonNetworkConfig(chain, { ...mainnet, params: { maxNetworkFee } }).maxNetworkFee;
    expect(DEFAULT_MAX_NETWORK_FEE).toEqual({
      basechain: 1_000_000_000n,
      masterchain: 100_000_000_000n,
    });
    expect(Object.isFrozen(DEFAULT_MAX_NETWORK_FEE)).toBe(true);
    expect(ceiling(undefined)).toEqual(DEFAULT_MAX_NETWORK_FEE);
    expect(ceiling({ basechain: 5n, masterchain: MAX_COINS })).toEqual({
      basechain: 5n,
      masterchain: MAX_COINS,
    });
    // Each workchain's own default where the override leaves it out.
    expect(ceiling({ basechain: 2n * 10n ** 9n })).toEqual({
      basechain: 2n * 10n ** 9n,
      masterchain: 100_000_000_000n,
    });
    expect(ceiling({ masterchain: 1n, basechain: undefined })).toEqual({
      basechain: 1_000_000_000n,
      masterchain: 1n,
    });
    expect(Object.isFrozen(ceiling({ basechain: 5n }))).toBe(true);
    const long = 'w'.repeat(100_000);
    const bad: readonly (readonly [unknown, string])[] = [
      [0n, 'maxNetworkFee'],
      [null, 'maxNetworkFee'],
      [[1n, 1n], 'maxNetworkFee'],
      ['1000', 'maxNetworkFee'],
      [{ basechain: 0n }, 'maxNetworkFee.basechain'],
      [{ basechain: -1n }, 'maxNetworkFee.basechain'],
      [{ basechain: 1_000 }, 'maxNetworkFee.basechain'],
      [{ basechain: '1000' }, 'maxNetworkFee.basechain'],
      [{ masterchain: MAX_COINS + 1n }, 'maxNetworkFee.masterchain'],
      [{ masterchain: null }, 'maxNetworkFee.masterchain'],
      // F3-R16: the caller's key is never echoed; the accepted names are.
      [
        { shardchain: 1n },
        "params.maxNetworkFee takes only 'basechain' and 'masterchain'",
      ],
      [{ [long]: 1n }, "params.maxNetworkFee takes only 'basechain' and 'masterchain'"],
    ];
    for (const [value, name] of bad) {
      let thrown: unknown;
      try {
        ceiling(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'CONFIG_INVALID' });
      const message = (thrown as Error).message;
      expect(message).toContain(name);
      expect(message).not.toMatch(/shardchain|ww/);
      expect(message.length).toBeLessThan(200);
    }
  });

  it('allows only its own options and capabilities, listing what it accepts (M2, F3-R16)', () => {
    const long = 'k'.repeat(100_000);
    const options =
      'TON network ton:mainnet: params has a key that is not a TON network option ' +
      '(validForSeconds, jettonAttached, jettonForwardAmount, finalitySkewBlocks, maxNetworkFee)';
    const cases: readonly (readonly [Partial<NetworkInfo>, string])[] = [
      [{ params: { jettonAttachd: 1n } }, options],
      [{ params: { [long]: 1 } }, options],
      // A core capability's name is a fixed word, never the caller's text: it is shown.
      [
        { capabilities: { add: ['fee-market-1559'] } },
        "TON network ton:mainnet: 'fee-market-1559' is not available on TON",
      ],
      // One output per transfer (Task 9): no network can offer TON batches.
      [
        { capabilities: { add: ['batch-transfer'] } },
        "TON network ton:mainnet: 'batch-transfer' is not available on TON",
      ],
      [
        { capabilities: { remove: [long] } },
        'TON network ton:mainnet: an unknown capability is not available on TON',
      ],
      [
        { feeModel: long as 'ton' },
        "TON network ton:mainnet: its fee model must be 'ton'",
      ],
      [
        { finality: { kind: long } as unknown as NetworkInfo['finality'] },
        "TON network ton:mainnet: its finality must be 'masterchain'",
      ],
    ];
    for (const [patch, expected] of cases) {
      let thrown: unknown;
      try {
        tonNetworkConfig(chain, { ...mainnet, ...patch });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'CONFIG_INVALID', message: expected });
    }
    // Its own capabilities may each be added back or removed.
    expect(
      tonNetworkConfig(chain, {
        ...mainnet,
        capabilities: {
          add: [...TON_CAPABILITIES, ...TON_INDEXER_CAPABILITIES],
          remove: ['address-history'],
        },
      }).capabilities,
    ).toEqual(new Set(['tokens', 'memo', 'expiry']));
  });
});

describe('TON fees', () => {
  const details = {
    importFee: 1n,
    gasFee: 20n,
    storageFee: 300n,
    forwardFee: 4_000n,
    forwardFeeSource: 'emulated' as const,
    deploy: false,
  };

  it('accepts a speed (which changes nothing) and only a jetton attached override', () => {
    expect(feeRequest('fast', false)).toEqual({ speed: 'fast' });
    expect(feeRequest({ attached: 70n }, true)).toEqual({
      speed: 'custom',
      attached: 70n,
    });
    expect(feeRequest({}, false)).toEqual({ speed: 'custom' });
    expect(feeRequest({ attached: undefined }, false)).toEqual({ speed: 'custom' });
    expect(feeRequest({ attached: MAX_COINS }, true)).toEqual({
      speed: 'custom',
      attached: MAX_COINS,
    });
    for (const [fee, jetton] of [
      [{ attached: 70n }, false],
      [{ attached: 0n }, true],
      [{ attached: -1n }, true],
      [{ attached: '7' }, true],
      [{ attached: MAX_COINS + 1n }, true],
      [{ gasPrice: 1n }, true],
      [null, true],
      ['fastest', false],
    ] as const) {
      expect(() => feeRequest(fee as unknown as FeeOverride, jetton)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
    // Own keys only: an inherited `attached` is not an override.
    const inherited = Object.create({ attached: 70n }) as FeeOverride;
    expect(feeRequest(inherited, true)).toEqual({ speed: 'custom' });
  });

  it('charges the network fee, plus the attached value per jetton output as an upper bound', () => {
    expect(networkFee(details)).toBe(4_321n);
    expect(tonFeeDraft({ speed: 'normal', details, payer: 'w' })).toEqual({
      kind: 'ton',
      speed: 'normal',
      bound: 'expected',
      payer: 'w',
      charges: [{ asset: 'native', amount: 4_321n, label: 'network' }],
      details,
    });
    const jetton = { ...details, attached: 50n, forwardAmount: 1n };
    expect(
      tonFeeDraft({ speed: 'custom', details: jetton, jettonOutputs: 3, payer: 'w' }),
    ).toMatchObject({
      bound: 'upper',
      charges: [
        { label: 'network', amount: 4_321n },
        { label: 'attached', amount: 150n },
      ],
      details: jetton,
    });
    // bigint all the way: no rounding at any size.
    const huge = { ...jetton, attached: MAX_COINS, gasFee: MAX_COINS };
    expect(
      tonFeeDraft({ speed: 'custom', details: huge, jettonOutputs: 255, payer: 'w' })
        .charges,
    ).toEqual([
      { asset: 'native', amount: MAX_COINS + 4_301n, label: 'network' },
      { asset: 'native', amount: MAX_COINS * 255n, label: 'attached' },
    ]);
  });

  it('refuses a draft whose jetton outputs and attached value disagree', () => {
    const jetton = { ...details, attached: 50n };
    for (const args of [
      { details, jettonOutputs: 1 },
      { details: jetton },
      { details: jetton, jettonOutputs: 0 },
      { details: jetton, jettonOutputs: 1.5 },
      { details: jetton, jettonOutputs: -1 },
    ]) {
      expect(() => tonFeeDraft({ speed: 'normal', payer: 'w', ...args })).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('reads stored fee details back, and refuses incomplete ones', () => {
    expect(tonFeeDetails({ ...details, attached: 5n })).toEqual({
      ...details,
      attached: 5n,
    });
    expect(
      tonFeeDetails({ ...details, forwardFeeSource: 'computed', deploy: true }),
    ).toEqual({ ...details, forwardFeeSource: 'computed', deploy: true });
    // Keys the core adds later (`requestedFee`) are not ours to read; `undefined` is absent.
    expect(
      tonFeeDetails({ ...details, requestedFee: 'normal', attached: undefined }),
    ).toEqual(details);
    expect(() => tonFeeDetails({ ...details, gasFee: 20 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it('never fills a missing or ill-typed stored field with a default (strict fields)', () => {
    const { forwardFeeSource: _source, ...noSource } = details;
    const { deploy: _deploy, ...noDeploy } = details;
    const { importFee: _import, ...noImport } = details;
    for (const stored of [
      noSource,
      noDeploy,
      noImport,
      { ...details, forwardFeeSource: 'guessed' },
      { ...details, deploy: 'false' },
      { ...details, storageFee: -1n },
      { ...details, forwardFee: MAX_COINS + 1n },
      { ...details, attached: 0n },
      { ...details, attached: '5' },
      { ...details, attached: null },
      { ...details, attached: MAX_COINS + 1n },
      { ...details, forwardAmount: 1 },
      { ...details, forwardAmount: -1n },
    ] as Readonly<Record<string, unknown>>[]) {
      expect(() => tonFeeDetails(stored)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
    expect(tonFeeDetails({ ...details, gasFee: MAX_COINS, forwardAmount: 0n })).toEqual({
      ...details,
      gasFee: MAX_COINS,
      forwardAmount: 0n,
    });
  });
});

describe('TON broadcast classification (D16)', () => {
  // The chain's own texts. The wallet refusal and the skipped compute phase were captured
  // from testnet toncenter (2026-09-28); the rest are cited in src/adapters/ton/errors.ts.
  const HEX = 'CCA3DC4922DEAA32160983996E8482B5F179112552943DE3A0AC0D0E449A1381';
  const LITE = 'LITE_SERVER_UNKNOWN: cannot apply external message to current state : ';
  const RUN = 'External message was not accepted: cannot run message on account: ';
  const byTransaction = (exitCode: number, steps = 13, gasUsed = 0): string =>
    `${LITE}${RUN}inbound external message rejected by transaction ${HEX}:\n` +
    `exitcode=${exitCode}, steps=${steps}, gas_used=${gasUsed}` +
    (steps === 0
      ? ''
      : `\nVM Log (truncated):\n...execute THROWIF ${exitCode}\n` +
        `default exception handler, terminating vm with exit code ${exitCode}\n`);
  const LIVE_EXIT_9 =
    `${LITE}${RUN}inbound external message rejected by transaction ${HEX}:\n` +
    'exitcode=9, steps=13, gas_used=0\nVM Log (truncated):\n...e DUP\nexecute PUSHINT ' +
    '85143\nexecute EQUAL\nexecute PUSHCONT x308208070F04\nexecute IFJMP\nexecute INC\n' +
    'execute THROWIF 32\nexecute PUSHINT 512\nexecute LDSLICEX\nhandling exception code 9: ' +
    'cell underflow\ndefault exception handler, terminating vm with exit code 9\n';
  const BY_ACCOUNT = `${LITE}${RUN}inbound external message rejected by account ${HEX} before smart-contract execution`;
  const DUPLICATE = 'cannot send external message : duplicate message';

  const seqno = { kind: 'refused', code: 'NONCE_CONFLICT', reason: 'seqno mismatch' };
  const expired = { kind: 'refused', code: 'TX_EXPIRED', reason: 'message expired' };
  const inactive = {
    kind: 'refused',
    code: 'TX_REFUSED',
    reason: 'wallet not active or not funded',
  };
  const malformed = { kind: 'refused', code: 'TX_REFUSED', reason: 'malformed message' };
  const byNode = { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' };

  it.each([
    // The wallet code's refusals: v4r2 (wallet-v4-code.fc) and v5r1 (wallet_v5.fc).
    [byTransaction(33), seqno],
    [byTransaction(133), seqno],
    [byTransaction(36), expired],
    [byTransaction(136), expired],
    [
      byTransaction(34),
      { kind: 'refused', code: 'TX_REFUSED', reason: 'wallet id mismatch' },
    ],
    [
      byTransaction(134),
      { kind: 'refused', code: 'TX_REFUSED', reason: 'wallet id mismatch' },
    ],
    [
      byTransaction(35),
      { kind: 'refused', code: 'TX_REFUSED', reason: 'signature not accepted' },
    ],
    [
      byTransaction(135),
      { kind: 'refused', code: 'TX_REFUSED', reason: 'signature not accepted' },
    ],
    [
      byTransaction(132),
      { kind: 'refused', code: 'TX_REFUSED', reason: 'signature disabled' },
    ],
    [LIVE_EXIT_9, byNode],
    [byTransaction(-14, 60, 10_000), byNode],
    // The compute phase never ran: no code, no gas or frozen (a skipped phase is all zeros).
    [byTransaction(0, 0), inactive],
    [byTransaction(0, 5, 300), byNode],
    [`${LITE}Failed to unpack account state`, inactive],
    ['Failed to unpack account state', inactive],
    [
      BY_ACCOUNT,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    // Success (spec §8.4): the liteserver already took these exact bytes.
    [DUPLICATE, { kind: 'already-known' }],
    [`LITE_SERVER_UNKNOWN: ${DUPLICATE}`, { kind: 'already-known' }],
    // M4: success is matched as strictly as a refusal, and only after every refusal.
    [`${DUPLICATE}\n${byTransaction(33)}`, seqno],
    [`${DUPLICATE} and more`, byNode],
    [`not ${DUPLICATE}`, byNode],
    // Malformed bytes are a refusal, never `rejected`: one endpoint's text decides no verdict.
    ['Failed to unpack Message', malformed],
    [
      'INVALID_BAG_OF_CELLS: bodycannot deserialize bag-of-cells: not enough bytes (3 present, 10 required)',
      malformed,
    ],
    ['error while parsing: failed to unpack message', byNode],
    // toncenter's definitive 4xx answers: the request did not parse.
    [
      "failed to parse post request: Error at path 'boc': invalid base64 encoded bytes: Wrong padding length",
      byNode,
    ],
    ['failed to validate request: empty boc', byNode],
    // Texts no TON node writes (the plan's first guesses) are plain refusals, never success.
    ['duplicate external message', byNode],
    ['External message already known', byNode],
    ['External message was not accepted: exitcode=33, steps=5', byNode],
    ['exitcode=133', byNode],
    ['Cannot run message on account 0:abc: not enough balance to pay 12345', byNode],
    ['Cannot run message on account: no state', byNode],
    ['something new', byNode],
    ['', byNode],
  ])('classifies %j', (message, expected) => {
    const result = classifyBroadcastError(message);
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    if ('reason' in result) expect(result.reason).not.toMatch(/0:|12345|[0-9A-F]{64}/i);
  });

  it('never answers `rejected` from a node text', () => {
    const texts = [
      'Failed to unpack Message',
      'INVALID_BAG_OF_CELLS: body',
      `${LITE}external message is not a valid bag of cells`,
      'cannot deserialize bag of cells',
      'failed to deserialize boc',
      byTransaction(9),
    ];
    for (const text of texts) {
      expect(classifyBroadcastError(text).kind).not.toBe(
        'rejected' as BroadcastResult['kind'],
      );
    }
  });

  it('reads a v2 error body the transport cut at 300 characters, never flipping a verdict', () => {
    const envelope = (text: string): string =>
      JSON.stringify({ ok: false, error: text, code: 400 }).slice(0, 300);
    // The exit code survives the cut, behind an escaped newline.
    const cut = envelope(byTransaction(33));
    expect(cut.length).toBe(300);
    expect(cut).toContain('\\nexitcode=33, steps=13');
    expect(classifyBroadcastError(cut)).toEqual(seqno);
    // A code or step count the cut may have shortened is never read (`exitcode=33` may be
    // the start of `exitcode=333`): each must end at its comma.
    const line = `${LITE}${RUN}inbound external message rejected by transaction ${HEX}:\n`;
    expect(classifyBroadcastError(`${line}exitcode=33`)).toEqual(byNode);
    expect(classifyBroadcastError(`${line}exitcode=36, steps=1`)).toEqual(byNode);
    expect(classifyBroadcastError(`${line}exitcode=0, steps=0`)).toEqual(byNode);
    expect(classifyBroadcastError(`${line}exitcode=333, steps=1, gas_used=0`)).toEqual(
      byNode,
    );
    // A cut success is a refusal, never the other way round.
    expect(classifyBroadcastError(envelope(DUPLICATE))).toEqual(byNode);
  });

  it('rethrows a transient node answer as retryable and ambiguous, never a stalling refusal (M4)', () => {
    // ext-message-pool.cpp: "not ready" and "too many pending external message checks"
    // (ErrorCode::notready, so tonlib names them LITE_SERVER_NOTREADY), and "too many
    // external messages to address <wc>:<HEX>" (the per-address limit).
    const PENDING = 'cannot apply external message to current state : ';
    const transient = [
      `LITE_SERVER_NOTREADY: ${PENDING}not ready`,
      `LITE_SERVER_NOTREADY: ${PENDING}too many pending external message checks`,
      `${LITE}too many external messages to address 0:${HEX}`,
      `${LITE}too many external messages to address -1:${HEX}`,
      'not ready',
      'too many pending external message checks',
      `too many external messages to address 0:${HEX}\n`,
      `LITE_SERVER_NOTREADY: ${DUPLICATE}`,
      `LITE_SERVER_NOTREADY: ${PENDING}no shard in masterchain state for account 0:8000000000000000`,
      `LITE_SERVER_NOTREADY: ${'x'.repeat(100_000)}`,
    ];
    for (const text of transient) {
      let thrown: unknown;
      try {
        classifyBroadcastError(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
        ambiguous: true,
      });
      // R24: the node's text (an address) never reaches the error.
      expect((thrown as Error).message).not.toMatch(/0:|[0-9A-F]{64}/i);
      expect((thrown as Error).cause).toBeUndefined();
    }
    // Anchored whole texts: anything else is the node's plain refusal.
    for (const text of [
      'not ready yet',
      `${LITE}not ready, try later`,
      'LITE_SERVER_UNKNOWN: too many pending external message checks and more',
      `too many external messages to address 0:${HEX.slice(1)}`,
      ' LITE_SERVER_NOTREADY: not ready',
      'LITE_SERVER_NOTREADY not ready',
      `not ready${' '.repeat(1_100)}`,
    ]) {
      expect(classifyBroadcastError(text)).toEqual(byNode);
    }
  });

  it('reads only a bounded prefix of a long text (lesson 20)', () => {
    expect(classifyBroadcastError('x'.repeat(100_000))).toEqual(byNode);
    expect(classifyBroadcastError('x'.repeat(100_000) + byTransaction(33))).toEqual(
      byNode,
    );
    expect(
      classifyBroadcastError(
        'inbound external message rejected by transaction '.repeat(2_000) +
          byTransaction(33),
      ),
    ).toEqual(byNode);
    expect(classifyBroadcastError(`${'\\n'.repeat(50_000)}${DUPLICATE}`)).toEqual(byNode);
    // M1: the classifier's own cut never completes a whole-text answer, success above all.
    const padded = (text: string, length: number): string =>
      text + ' '.repeat(length - text.length);
    expect(classifyBroadcastError(`${DUPLICATE}${' '.repeat(1_000)}x`)).toEqual(byNode);
    expect(classifyBroadcastError(padded(DUPLICATE, 1_024))).toEqual({
      kind: 'already-known',
    });
    expect(classifyBroadcastError(`${padded(DUPLICATE, 1_024)}x`)).toEqual(byNode);
    expect(
      classifyBroadcastError(`Failed to unpack account state${' '.repeat(1_000)}x`),
    ).toEqual(byNode);
    expect(
      classifyBroadcastError(`Failed to unpack Message${' '.repeat(1_000)}x`),
    ).toEqual(byNode);
  });
});
