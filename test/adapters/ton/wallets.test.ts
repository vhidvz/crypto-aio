import { ed25519 } from '@noble/curves/ed25519';
import {
  Address,
  Cell,
  Slice,
  beginCell,
  external,
  internal,
  loadMessage,
  loadMessageRelaxed,
  storeMessage,
  storeMessageRelaxed,
} from '@ton/core';
import {
  addressArgument,
  addressFromBoc,
  cellFromBoc,
  commentCell,
  decodeComment,
  decodeJettonInternalTransfer,
  decodeJettonNotification,
  decodeJettonTransfer,
  decodeWalletRequest,
  jettonMessage,
  messageBody,
  messageFacts,
  MAX_ADDRESS_BOC_LENGTH,
  MAX_BODY_BOC_LENGTH,
  MAX_BODY_CELLS,
  MAX_COMMENT_CELLS,
  MAX_MEMO_BYTES,
  nativeMessage,
  OP,
} from '../../../src/adapters/ton/messages';
import {
  MAX_MESSAGES,
  normalizedHash,
  requestIsOwn,
  resolveIdentity,
  sdkAddress,
  signedRequest,
  unsignedRequest,
  walletAddress,
  walletIdOf,
  externalHashOf,
  walletStateInit,
  type TonIdentity,
} from '../../../src/adapters/ton/wallets';
import {
  CHAIN_WALLETS,
  KEY,
  PUBLIC_KEY,
  REAL_REQUESTS,
  TEST_WALLETS,
  USDT_MASTER,
  WALLET_IDS,
} from './support/vectors';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const PK = Buffer.from(PUBLIC_KEY, 'hex');
const RECIPIENT = `0:${'11'.repeat(32)}`;
const MAINNET = -239;
const TESTNET = -3;

describe('TON wallet identity (spec §9)', () => {
  it('fills the defaults of each version', () => {
    expect(resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET)).toEqual({
      version: 'v4r2',
      workchain: 0,
      subwalletId: 698983191,
    });
    expect(resolveIdentity({ ton: { version: 'v4r2', workchain: -1 } }, MAINNET)).toEqual(
      {
        version: 'v4r2',
        workchain: -1,
        subwalletId: 698983190,
      },
    );
    expect(resolveIdentity({ ton: { version: 'v5r1' } }, TESTNET)).toEqual({
      version: 'v5r1',
      workchain: 0,
      subwalletNumber: 0,
      networkGlobalId: TESTNET,
    });
  });

  it('refuses incomplete, unknown or out-of-range settings with CONFIG_INVALID', () => {
    const bad: readonly unknown[] = [
      undefined,
      {},
      { version: 'v3r2' },
      { version: 'v4r2', workchain: 1 },
      { version: 'v4r2', subwalletId: -1 },
      { version: 'v4r2', subwalletId: 2 ** 32 },
      { version: 'v4r2', subwalletId: 1.5 },
      { version: 'v4r2', subwalletNumber: 1 },
      { version: 'v5r1', subwalletNumber: 32768 },
      { version: 'v5r1', subwalletNumber: -1 },
      { version: 'v5r1', subwalletNumber: 1.5 },
      { version: 'v5r1', workchain: '0' },
      { version: 'v5r1', subwalletId: 7 },
    ];
    for (const ton of bad) {
      expect(() => resolveIdentity({ ton }, MAINNET)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    // Lesson 19: the ends of each range are accepted; the texts never carry the value.
    const at = (ton: object) => resolveIdentity({ ton }, MAINNET);
    expect(at({ version: 'v4r2', subwalletId: 0 })).toMatchObject({ subwalletId: 0 });
    expect(at({ version: 'v4r2', subwalletId: 2 ** 32 - 1 })).toMatchObject({
      subwalletId: 2 ** 32 - 1,
    });
    expect(at({ version: 'v5r1', subwalletNumber: 32767 })).toMatchObject({
      subwalletNumber: 32767,
    });
    expect(() => at({ version: 'v4r2', subwalletId: 2 ** 32 })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(String(2 ** 32)) }),
    );
    expect(() => at({ version: 'v5r1', subwalletNumber: 32768 })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('32768') }),
    );
    // M3: an unknown key is named, but never more than 64 characters of it.
    const key = 'k'.repeat(100_000);
    let error: unknown;
    try {
      at({ version: 'v4r2', [key]: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining(`'${'k'.repeat(64)}' is not a v4r2 setting`),
    });
    expect((error as Error).message.length).toBeLessThan(120);
  });

  it('refuses a v5r1 wallet id of another network before any key is used (lesson 5)', () => {
    expect(() =>
      resolveIdentity({ ton: { version: 'v5r1', networkGlobalId: TESTNET } }, MAINNET),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining("is not this network's (-239)"),
      }),
    );
    expect(() =>
      resolveIdentity({ ton: { version: 'v5r1', networkGlobalId: 12345 } }, MAINNET),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('12345') }));
  });
});

describe('TON wallet addresses', () => {
  it('derives the test key wallets; v5r1 differs per network, v4r2 does not', () => {
    const at = (ton: object, globalId: number) =>
      walletAddress(resolveIdentity({ ton }, globalId), PK);
    expect(at({ version: 'v4r2' }, MAINNET)).toBe(TEST_WALLETS.v4r2.basechain);
    expect(at({ version: 'v4r2' }, TESTNET)).toBe(TEST_WALLETS.v4r2.basechain);
    expect(at({ version: 'v4r2', workchain: -1 }, MAINNET)).toBe(
      TEST_WALLETS.v4r2.masterchain,
    );
    expect(at({ version: 'v5r1' }, MAINNET)).toBe(TEST_WALLETS.v5r1.mainnet);
    expect(at({ version: 'v5r1' }, TESTNET)).toBe(TEST_WALLETS.v5r1.testnet);
    expect(at({ version: 'v5r1', workchain: -1 }, MAINNET)).toBe(
      TEST_WALLETS.v5r1.mainnetMasterchain,
    );
  });

  it('reproduces the addresses of live mainnet wallets from their public keys', () => {
    for (const [address, publicKey, version] of CHAIN_WALLETS) {
      expect(
        walletAddress(
          resolveIdentity({ ton: { version } }, MAINNET),
          Buffer.from(publicKey, 'hex'),
        ),
      ).toBe(address);
    }
  });

  it('uses the wallet ids seen on each live network', () => {
    const id = (ton: object, globalId: number) =>
      walletIdOf(resolveIdentity({ ton }, globalId), PK);
    expect(id({ version: 'v4r2' }, MAINNET)).toBe(WALLET_IDS.v4r2.basechain);
    expect(id({ version: 'v4r2', workchain: -1 }, MAINNET)).toBe(
      WALLET_IDS.v4r2.masterchain,
    );
    expect(id({ version: 'v5r1' }, MAINNET)).toBe(WALLET_IDS.v5r1.mainnet);
    expect(id({ version: 'v5r1' }, TESTNET)).toBe(WALLET_IDS.v5r1.testnet);
    expect(id({ version: 'v5r1', workchain: -1 }, MAINNET)).toBe(
      WALLET_IDS.v5r1.mainnetMasterchain,
    );
  });

  it('refuses a key that is not a canonical ed25519 point (lesson 4)', () => {
    const identity = resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET);
    const smallOrder = new Uint8Array(32);
    smallOrder[0] = 1; // the identity point
    for (const key of [smallOrder, new Uint8Array(32).fill(0xff)]) {
      expect(() => walletAddress(identity, key)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    expect(() =>
      walletAddress(
        resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET),
        new Uint8Array(33),
      ),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('refuses an identity outside its fields, never wrapping it (lesson 19)', () => {
    const outOfRange = [
      { version: 'v4r2', workchain: 0, subwalletId: 2 ** 32 },
      { version: 'v4r2', workchain: 0, subwalletId: -1 },
      { version: 'v4r2', workchain: 1, subwalletId: 0 },
      { version: 'v5r1', workchain: 0, subwalletNumber: 32768, networkGlobalId: MAINNET },
      { version: 'v5r1', workchain: 0, subwalletNumber: 0, networkGlobalId: 2 ** 31 },
      {
        version: 'v5r1',
        workchain: 0,
        subwalletNumber: 0,
        networkGlobalId: -(2 ** 31) - 1,
      },
    ] as unknown as readonly TonIdentity[];
    for (const identity of outOfRange) {
      expect(() => walletAddress(identity, PK)).toThrow(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
    // M2: the ends of each field are wallets.
    const ends: readonly TonIdentity[] = [
      { version: 'v4r2', workchain: 0, subwalletId: 2 ** 32 - 1 },
      { version: 'v4r2', workchain: -1, subwalletId: 0 },
      {
        version: 'v5r1',
        workchain: 0,
        subwalletNumber: 0x7fff,
        networkGlobalId: -(2 ** 31),
      },
      {
        version: 'v5r1',
        workchain: -1,
        subwalletNumber: 0,
        networkGlobalId: 2 ** 31 - 1,
      },
    ];
    for (const identity of ends) {
      expect(walletAddress(identity, PK)).toMatch(/^(0|-1):[0-9a-f]{64}$/);
    }
  });
});

describe('TON signing requests', () => {
  const request = (version: 'v4r2' | 'v5r1', deploy: boolean) =>
    unsignedRequest(resolveIdentity({ ton: { version } }, MAINNET), PK, {
      seqno: 7,
      validUntil: 1_790_000_000,
      deploy,
      messages: [
        nativeMessage({
          to: RECIPIENT,
          value: 1_500_000_000n,
          bounce: false,
          memo: 'invoice 42',
        }),
      ],
    });
  const sign = (digest: Uint8Array) => ed25519.sign(digest, Buffer.from(KEY, 'hex'));

  it('signs one digest and places the signature where each wallet reads it', async () => {
    const expected = {
      v4r2: {
        digest: 'bd81599f3aacb69ebb481811e47236f40c62773da7dab4bb1f081d43c7e54c4a',
        norm: '57ab035ae71e067aff35d1d57d5beaaa7c484d0bdbfff191206d3f70607e2a7d',
      },
      v5r1: {
        digest: 'dcad1d95c9011e5eba6b04c0b1bb3691037047758b282808d58ace8ecc2db76f',
        norm: 'a70c3369b4d3f174f3b0a02af9728036b5216ce1827a344b689863926e382c4b',
      },
    } as const;
    for (const version of ['v4r2', 'v5r1'] as const) {
      const unsigned = await request(version, version === 'v5r1');
      expect(hex(unsigned.digest)).toBe(expected[version].digest);
      const signature = sign(unsigned.digest);
      const signed = signedRequest(unsigned.message, unsigned.digest, signature);
      expect(hex(normalizedHash(signed))).toBe(expected[version].norm);
      const message = loadMessage(signed.beginParse());
      expect(message.info.type).toBe('external-in');
      expect(message.init !== undefined && message.init !== null).toBe(
        version === 'v5r1',
      );
      const bits = message.body.bits;
      const placed =
        version === 'v4r2'
          ? bits.substring(0, 512)
          : bits.substring(bits.length - 512, 512);
      expect(
        placed.equals(beginCell().storeBuffer(Buffer.from(signature)).endCell().bits),
      ).toBe(true);
      expect(ed25519.verify(signature, unsigned.digest, PK)).toBe(true);
      expect(decodeWalletRequest(message.body)).toMatchObject({
        seqno: 7,
        validUntil: 1_790_000_000,
        messages: [expect.anything()],
      });
    }
  });

  it('refuses a digest the payload does not carry, and a payload that is not external', async () => {
    const unsigned = await request('v4r2', false);
    const other = new Uint8Array(32).fill(9);
    expect(() => signedRequest(unsigned.message, other, sign(other))).toThrow(
      expect.objectContaining({ code: 'SIGNING_FAILED' }),
    );
    const internalCell = beginCell()
      .store(
        storeMessage({
          ...nativeMessage({ to: RECIPIENT, value: 1n, bounce: true }),
          info: {
            type: 'external-out',
            src: sdkAddress(RECIPIENT),
            dest: null,
            createdAt: 0,
            createdLt: 0n,
          },
        }),
      )
      .endCell();
    expect(() =>
      signedRequest(internalCell, unsigned.digest, sign(unsigned.digest)),
    ).toThrow(expect.objectContaining({ code: 'SIGNING_FAILED' }));
    // M12: a cell that holds no message, or a signature of another size, is refused too.
    const signature = sign(unsigned.digest);
    for (const [payload, bytes] of [
      [commentCell('x'), signature],
      [unsigned.message, signature.subarray(0, 63)],
      [unsigned.message, new Uint8Array([...signature, 0])],
    ] as const) {
      expect(() => signedRequest(payload, unsigned.digest, bytes)).toThrow(
        expect.objectContaining({ code: 'SIGNING_FAILED' }),
      );
    }
    expect(() => normalizedHash(commentCell('x'))).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });

  it('keeps the normalized hash independent of the StateInit (TEP-467)', async () => {
    const plain = await request('v5r1', false);
    const deploy = await request('v5r1', true);
    expect(hex(plain.digest)).toBe(hex(deploy.digest));
    const signature = sign(plain.digest);
    expect(
      hex(normalizedHash(signedRequest(plain.message, plain.digest, signature))),
    ).toBe(hex(normalizedHash(signedRequest(deploy.message, deploy.digest, signature))));
  });

  it('never lets the SDK choose a lifetime or exceed the wallet limit', async () => {
    const identity = resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET);
    const one = nativeMessage({ to: RECIPIENT, value: 1n, bounce: true });
    await expect(
      unsignedRequest(identity, PK, {
        seqno: 0,
        validUntil: 0,
        deploy: false,
        messages: [one],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: expect.stringContaining('validUntil'),
    });
    await expect(
      unsignedRequest(identity, PK, {
        seqno: 0,
        validUntil: 10,
        deploy: false,
        messages: Array(MAX_MESSAGES.v4r2 + 1).fill(one),
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: expect.stringContaining('carries 1 to 4'),
    });
    expect(MAX_MESSAGES).toEqual({ v4r2: 4, v5r1: 255 });
  });

  it('refuses a seqno or lifetime outside uint32 with a fixed text, and takes the ends (lesson 19)', async () => {
    const identity = resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET);
    const make = (seqno: number, validUntil: number) =>
      unsignedRequest(identity, PK, {
        seqno,
        validUntil,
        deploy: false,
        messages: [nativeMessage({ to: RECIPIENT, value: 1n, bounce: true })],
      });
    const refused = [
      { seqno: -1, validUntil: 10, bad: -1 },
      { seqno: 2 ** 32, validUntil: 10, bad: 2 ** 32 },
      { seqno: 1.5, validUntil: 10, bad: 1.5 },
      { seqno: 0, validUntil: 2 ** 32, bad: 2 ** 32 },
      { seqno: 0, validUntil: -1, bad: -1 },
      { seqno: 0, validUntil: 10.5, bad: 10.5 },
    ];
    for (const { seqno, validUntil, bad } of refused) {
      const error: unknown = await make(seqno, validUntil).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INVALID_INTENT' });
      expect((error as Error).message).not.toContain(String(bad));
    }
    for (const [seqno, validUntil] of [
      [0, 1],
      [2 ** 32 - 1, 2 ** 32 - 1],
    ] as const) {
      const unsigned = await make(seqno, validUntil);
      const body = loadMessage(unsigned.message.beginParse()).body;
      expect(decodeWalletRequest(body)).toMatchObject({ seqno, validUntil });
    }
    // A hand-built message the SDK cannot encode: a fixed text, not the SDK's bare error.
    for (const version of ['v4r2', 'v5r1'] as const) {
      const error: unknown = await unsignedRequest(
        resolveIdentity({ ton: { version } }, MAINNET),
        PK,
        {
          seqno: 0,
          validUntil: 10,
          deploy: false,
          messages: [internal({ to: sdkAddress(RECIPIENT), value: -7n })],
        },
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INVALID_INTENT' });
      expect((error as Error).message).not.toContain('7');
    }
  });

  it('matches live mainnet requests: signature layout, digest and both hashes', () => {
    for (const real of REAL_REQUESTS) {
      const body = Cell.fromBoc(Buffer.from(real.body, 'base64'))[0] as Cell;
      const n = body.bits.length;
      const front = real.version === 'v4r2';
      const remainder = beginCell().storeBits(
        front ? body.bits.substring(512, n - 512) : body.bits.substring(0, n - 512),
      );
      for (const ref of body.refs) remainder.storeRef(ref);
      const signature = beginCell()
        .storeBits(
          front ? body.bits.substring(0, 512) : body.bits.substring(n - 512, 512),
        )
        .endCell()
        .beginParse()
        .loadBuffer(64);
      expect(
        ed25519.verify(
          signature,
          remainder.endCell().hash(),
          Buffer.from(real.publicKey, 'hex'),
        ),
      ).toBe(true);
      expect(decodeWalletRequest(body)?.seqno).toBe(real.seqno);
      const message = beginCell()
        .store(storeMessage(external({ to: sdkAddress(real.address), body })))
        .endCell();
      expect(hex(message.hash())).toBe(real.hash);
      expect(hex(normalizedHash(message))).toBe(real.hashNorm);
      expect(externalHashOf(real.address, body)).toBe(real.hashNorm);
    }
  });

  it('deploys the wallet it derives', () => {
    const identity = resolveIdentity({ ton: { version: 'v4r2' } }, MAINNET);
    const init = walletStateInit(identity, PK);
    const stateInit = beginCell()
      .storeBit(false)
      .storeBit(false)
      .storeMaybeRef(init.code)
      .storeMaybeRef(init.data)
      .storeBit(false)
      .endCell();
    expect(`0:${stateInit.hash().toString('hex')}`).toBe(TEST_WALLETS.v4r2.basechain);
  });
});

describe('TON message bodies', () => {
  it('encodes a memo as a text comment and reads it back, across cells', () => {
    const long = 'пример '.repeat(40);
    for (const memo of ['invoice 42', '', long]) {
      expect(decodeComment(commentCell(memo))).toBe(memo);
    }
    expect(
      decodeComment(beginCell().storeUint(OP.jettonTransfer, 32).endCell()),
    ).toBeUndefined();
    expect(decodeComment(Cell.EMPTY)).toBeUndefined();
  });

  it('reads a comment chain in one bounded pass (lesson 20)', () => {
    const chain = (cells: number): Cell => {
      let tail: Cell | undefined;
      for (let i = cells - 1; i >= 0; i -= 1) {
        const cell = beginCell();
        if (i === 0) cell.storeUint(OP.comment, 32);
        cell.storeBuffer(Buffer.alloc(8, 0x61));
        if (tail) cell.storeRef(tail);
        tail = cell.endCell();
      }
      return tail as Cell;
    };
    const longest = chain(MAX_COMMENT_CELLS);
    const tooLong = [chain(MAX_COMMENT_CELLS + 1), chain(6_000)];
    const concat = jest.spyOn(Buffer, 'concat');
    const loadRef = jest.spyOn(Slice.prototype, 'loadRef');
    try {
      expect(decodeComment(longest)).toBe('a'.repeat(8 * MAX_COMMENT_CELLS));
      // One step per cell and one concatenation for the whole chain: linear work.
      expect(loadRef).toHaveBeenCalledTimes(MAX_COMMENT_CELLS - 1);
      expect(concat).toHaveBeenCalledTimes(1);
      for (const body of tooLong) {
        concat.mockClear();
        loadRef.mockClear();
        expect(decodeComment(body)).toBeUndefined();
        // It stops at the bound, before concatenating anything.
        expect(loadRef.mock.calls.length).toBeLessThanOrEqual(MAX_COMMENT_CELLS);
        expect(concat).not.toHaveBeenCalled();
      }
    } finally {
      concat.mockRestore();
      loadRef.mockRestore();
    }
    // The bound is well above the library's own memo limit, in a jetton payload too.
    expect(MAX_COMMENT_CELLS * 127).toBeGreaterThanOrEqual(16 * MAX_MEMO_BYTES);
    const memo = 'é'.repeat(MAX_MEMO_BYTES / 2);
    expect(decodeComment(commentCell(memo))).toBe(memo);
    const transfer = jettonMessage({
      jettonWallet: RECIPIENT,
      attached: 1n,
      queryId: 0n,
      amount: 1n,
      destination: RECIPIENT,
      responseDestination: RECIPIENT,
      forwardAmount: 1n,
      memo,
    });
    expect(decodeJettonTransfer(transfer.body)?.comment).toBe(memo);
    // Not a snake string: two refs, or a partial byte.
    const tail = beginCell().storeBuffer(Buffer.from('x')).endCell();
    const twoRefs = beginCell().storeUint(0, 32).storeRef(tail).storeRef(tail).endCell();
    expect(decodeComment(twoRefs)).toBeUndefined();
    expect(
      decodeComment(beginCell().storeUint(0, 32).storeUint(1, 7).endCell()),
    ).toBeUndefined();
  });

  it('builds a TEP-74 transfer to the sender jetton wallet, memo in the forward payload', () => {
    const jettonWallet = `0:${'22'.repeat(32)}`;
    const wallet = TEST_WALLETS.v4r2.basechain;
    for (const memo of ['deposit 7', undefined]) {
      const message = jettonMessage({
        jettonWallet,
        attached: 50_000_000n,
        queryId: 7n,
        amount: 1_000_000n,
        destination: USDT_MASTER.raw,
        responseDestination: wallet,
        forwardAmount: 1n,
        ...(memo !== undefined ? { memo } : {}),
      });
      expect(messageFacts(message)).toMatchObject({
        to: jettonWallet,
        value: 50_000_000n,
      });
      expect(message.info.type === 'internal' && message.info.bounce).toBe(true);
      expect(decodeJettonTransfer(message.body)).toEqual({
        queryId: 7n,
        amount: 1_000_000n,
        destination: USDT_MASTER.raw,
        forwardAmount: 1n,
        ...(memo !== undefined ? { comment: memo } : {}),
      });
    }
  });

  it('reads an internal_transfer and refuses other bodies', () => {
    const body = beginCell()
      .storeUint(OP.jettonInternalTransfer, 32)
      .storeUint(7, 64)
      .storeCoins(5n)
      .storeAddress(sdkAddress(TEST_WALLETS.v4r2.basechain))
      .storeAddress(sdkAddress(TEST_WALLETS.v4r2.basechain))
      .storeCoins(1n)
      .storeBit(true)
      .storeRef(commentCell('hi'))
      .endCell();
    expect(decodeJettonInternalTransfer(body)).toEqual({
      queryId: 7n,
      amount: 5n,
      from: TEST_WALLETS.v4r2.basechain,
      comment: 'hi',
    });
    expect(decodeJettonInternalTransfer(commentCell('x'))).toBeNull();
    expect(decodeJettonTransfer(commentCell('x'))).toBeNull();
    expect(decodeWalletRequest(commentCell('x'))).toBeNull();
  });

  it('refuses amounts and query ids outside their TL-B fields, never wrapping (lesson 19)', () => {
    const MAX_COINS = 2n ** 120n - 1n;
    const MAX_QUERY_ID = 2n ** 64n - 1n;
    const jetton = (patch: Partial<Parameters<typeof jettonMessage>[0]>) =>
      jettonMessage({
        jettonWallet: RECIPIENT,
        attached: 1n,
        queryId: 0n,
        amount: 1n,
        destination: RECIPIENT,
        responseDestination: RECIPIENT,
        forwardAmount: 0n,
        ...patch,
      });
    // The ends encode exactly.
    const native = nativeMessage({ to: RECIPIENT, value: MAX_COINS, bounce: false });
    const wire = beginCell().store(storeMessageRelaxed(native)).endCell();
    expect(messageFacts(loadMessageRelaxed(wire.beginParse()))?.value).toBe(MAX_COINS);
    const top = jetton({
      attached: MAX_COINS,
      queryId: MAX_QUERY_ID,
      amount: MAX_COINS,
      forwardAmount: MAX_COINS,
    });
    expect(decodeJettonTransfer(top.body)).toMatchObject({
      queryId: MAX_QUERY_ID,
      amount: MAX_COINS,
      forwardAmount: MAX_COINS,
    });
    expect(
      messageFacts(nativeMessage({ to: RECIPIENT, value: 0n, bounce: false }))?.value,
    ).toBe(0n);
    const refused = (build: () => unknown, code: string, value: bigint): void => {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code });
      expect((error as Error).message).not.toContain(value.toString());
    };
    for (const value of [-1n, MAX_COINS + 1n, 2n ** 128n + 5n]) {
      refused(
        () => nativeMessage({ to: RECIPIENT, value, bounce: false }),
        'INVALID_AMOUNT',
        value,
      );
      refused(() => jetton({ amount: value }), 'INVALID_AMOUNT', value);
      refused(() => jetton({ forwardAmount: value }), 'INVALID_AMOUNT', value);
      refused(() => jetton({ attached: value }), 'INVALID_AMOUNT', value);
    }
    for (const queryId of [-1n, MAX_QUERY_ID + 1n, 2n ** 64n + 5n]) {
      refused(() => jetton({ queryId }), 'INVALID_INTENT', queryId);
    }
  });

  it('decodes at most one message worth of body: 2^13 cells, read from the header (lesson 20)', () => {
    expect(MAX_BODY_CELLS).toBe(2 ** 13);
    // The longest legal body BOC: 2^21 bits of data in 2^13 cells, each with its
    // descriptors, 4 two-byte refs, a rounding byte and a 3-byte index entry, plus header
    // and checksum.
    const longest = 17 + 2 ** 13 * (2 + 8 + 1 + 3) + 2 ** 21 / 8 + 4;
    expect(Math.ceil(longest / 3) * 4).toBeLessThanOrEqual(MAX_BODY_BOC_LENGTH);
    expect(MAX_BODY_BOC_LENGTH).toBe(2 ** 19);
    const header = (magic: number, sizeByte: number, cells: number): string => {
      const bytes = Buffer.alloc(64);
      bytes.writeUInt32BE(magic, 0);
      bytes[4] = sizeByte;
      bytes[5] = 1;
      bytes.writeUInt16BE(cells, 6);
      return bytes.toString('base64');
    };
    const fromBoc = jest.spyOn(Cell, 'fromBoc');
    try {
      for (const [magic, sizeByte] of [
        [0xb5ee9c72, 0x02],
        [0x68ff65f3, 2],
        [0xacc3a728, 2],
      ] as const) {
        fromBoc.mockClear();
        expect(cellFromBoc(header(magic, sizeByte, MAX_BODY_CELLS + 1))).toBeNull();
        expect(fromBoc).not.toHaveBeenCalled();
        // A legal count reaches the SDK (this header is otherwise broken, so still null).
        expect(cellFromBoc(header(magic, sizeByte, MAX_BODY_CELLS))).toBeNull();
        expect(fromBoc).toHaveBeenCalledTimes(1);
      }
      fromBoc.mockClear();
      expect(cellFromBoc(header(0x12345678, 2, 1))).toBeNull();
      expect(fromBoc).not.toHaveBeenCalled();
    } finally {
      fromBoc.mockRestore();
    }
  });

  it('reads only workchains 0 and -1 from untrusted bodies (M1)', () => {
    const foreign = new Address(5, Buffer.alloc(32, 0x33));
    const owner = sdkAddress(TEST_WALLETS.v4r2.basechain);
    const bocOf = (address: Address) =>
      beginCell().storeAddress(address).endCell().toBoc().toString('base64');
    expect(addressFromBoc(bocOf(foreign))).toBeNull();
    expect(addressFromBoc(bocOf(sdkAddress(TEST_WALLETS.v4r2.masterchain)))).toBe(
      TEST_WALLETS.v4r2.masterchain,
    );
    const transfer = (destination: Address) =>
      beginCell()
        .storeUint(OP.jettonTransfer, 32)
        .storeUint(7, 64)
        .storeCoins(5n)
        .storeAddress(destination)
        .storeAddress(owner)
        .storeMaybeRef(null)
        .storeCoins(1n)
        .storeBit(false)
        .endCell();
    expect(decodeJettonTransfer(transfer(owner))).toMatchObject({
      destination: TEST_WALLETS.v4r2.basechain,
    });
    expect(decodeJettonTransfer(transfer(foreign))).toBeNull();
    // An optional sender that is no TON account is not named; the amount still counts.
    const arrival = beginCell()
      .storeUint(OP.jettonInternalTransfer, 32)
      .storeUint(7, 64)
      .storeCoins(5n)
      .storeAddress(foreign)
      .storeAddress(owner)
      .storeCoins(1n)
      .storeBit(false)
      .endCell();
    expect(decodeJettonInternalTransfer(arrival)).toEqual({
      queryId: 7n,
      amount: 5n,
      from: null,
    });
    const note = beginCell()
      .storeUint(OP.jettonNotification, 32)
      .storeUint(7, 64)
      .storeCoins(5n)
      .storeAddress(foreign)
      .storeBit(false)
      .endCell();
    expect(decodeJettonNotification(note)).toEqual({
      queryId: 7n,
      amount: 5n,
      sender: null,
    });
    expect(messageFacts(internal({ to: foreign, value: 1n }))).toBeNull();
  });

  it('hands the SDK only strict raw addresses (lesson 4)', () => {
    const hexPart = RECIPIENT.slice(2);
    for (const lenient of [`1:${hexPart}`, `00:${hexPart}`, USDT_MASTER.bounceable, '']) {
      for (const use of [
        () => sdkAddress(lenient),
        () => nativeMessage({ to: lenient, value: 1n, bounce: false }),
        () => addressArgument(lenient),
        () => externalHashOf(lenient, Cell.EMPTY),
      ]) {
        expect(use).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
      }
    }
    expect(sdkAddress(RECIPIENT).toRawString()).toBe(RECIPIENT);
  });

  it('passes addresses to and from get-methods as one-cell slices', () => {
    expect(addressFromBoc(addressArgument(USDT_MASTER.raw))).toBe(USDT_MASTER.raw);
    expect(addressFromBoc('not a boc')).toBeNull();
    // Lesson 20: a provider's text longer than the format allows is refused before decoding
    // (the SDK ignores bytes after a BOC without a checksum, so padding decodes below it).
    const boc = beginCell()
      .storeAddress(sdkAddress(USDT_MASTER.raw))
      .endCell()
      .toBoc({ idx: false, crc32: false })
      .toString('base64');
    expect(addressFromBoc(boc.padEnd(MAX_ADDRESS_BOC_LENGTH, 'A'))).toBe(USDT_MASTER.raw);
    expect(addressFromBoc(boc.padEnd(MAX_ADDRESS_BOC_LENGTH + 4, 'A'))).toBeNull();
    expect(addressFromBoc(boc.padEnd(100_000, 'A'))).toBeNull();
    expect(nativeMessage({ to: RECIPIENT, value: 3n, bounce: false }).info).toMatchObject(
      {
        type: 'internal',
        bounce: false,
      },
    );
  });

  it('binds an indexed body to its keyed hash (C1), and decodes relayed W5 requests (M17)', () => {
    const body = commentCell('hi');
    const boc = body.toBoc().toString('base64');
    const bodyHash = body.hash().toString('hex');
    expect(messageBody({})).toBeNull();
    expect(messageBody({ body: boc, bodyHash })?.hash().toString('hex')).toBe(bodyHash);
    // Lesson 20: at most the longest message BOC TON's limits allow, checked before decoding.
    const longest = boc.padEnd(MAX_BODY_BOC_LENGTH, 'A');
    expect(cellFromBoc(longest)?.hash().toString('hex')).toBe(bodyHash);
    expect(cellFromBoc(boc.padEnd(MAX_BODY_BOC_LENGTH + 4, 'A'))).toBeNull();
    expect(() =>
      messageBody({ body: boc.padEnd(MAX_BODY_BOC_LENGTH + 4, 'A'), bodyHash }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }));
    for (const bad of [
      { body: boc },
      { body: boc, bodyHash: '00'.repeat(32) },
      { body: 'not a boc', bodyHash },
    ]) {
      expect(() => messageBody(bad)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
    const relayed = Cell.fromBoc(
      Buffer.from(REAL_REQUESTS[1]!.body, 'base64'),
    )[0] as Cell;
    const bits = relayed.bits;
    const internal = beginCell()
      .storeUint(OP.w5SignedInternal, 32)
      .storeBits(bits.substring(32, bits.length - 32));
    for (const ref of relayed.refs) internal.storeRef(ref);
    expect(decodeWalletRequest(internal.endCell())).toMatchObject({
      auth: 'internal',
      seqno: REAL_REQUESTS[1]!.seqno,
    });
    expect(decodeWalletRequest(relayed)).toMatchObject({ auth: 'external' });
  });

  it('authenticates a wallet request: the wallet key signed it, for this very wallet (A23)', async () => {
    const identity = resolveIdentity({ ton: { version: 'v5r1' } }, -3);
    const from = walletAddress(identity, PK);
    const relayed = (walletId: number, seed: string): Cell => {
      const signing = beginCell()
        .storeUint(OP.w5SignedInternal, 32)
        .storeInt(walletId, 32)
        .storeUint(1_790_000_060, 32)
        .storeUint(1, 32)
        .storeMaybeRef(null)
        .storeBit(false)
        .endCell();
      const signature = ed25519.sign(signing.hash(), Buffer.from(seed, 'hex'));
      return beginCell()
        .storeSlice(signing.beginParse())
        .storeBuffer(Buffer.from(signature))
        .endCell();
    };
    const own = relayed(walletIdOf(identity, PK), KEY);
    expect(decodeWalletRequest(own)).toMatchObject({ auth: 'internal', seqno: 1 });
    expect(requestIsOwn(from, own, PK, -3)).toBe(true);
    // Forged: anyone can post the body, but only the wallet's key can sign it.
    const forged = relayed(walletIdOf(identity, PK), 'ab'.repeat(32));
    expect(requestIsOwn(from, forged, PK, -3)).toBe(false);
    // Replayed into the v4r2 twin of the same key (it accepts any internal body), or into
    // another subwallet: never that wallet's request.
    const v4 = walletAddress(resolveIdentity({ ton: { version: 'v4r2' } }, -3), PK);
    const sibling = walletAddress(
      resolveIdentity({ ton: { version: 'v5r1', subwalletNumber: 1 } }, -3),
      PK,
    );
    expect(requestIsOwn(v4, own, PK, -3)).toBe(false);
    expect(requestIsOwn(sibling, own, PK, -3)).toBe(false);
    const unsigned = beginCell().storeUint(OP.w5SignedInternal, 32).endCell();
    expect(requestIsOwn(from, unsigned, PK, -3)).toBe(false);
    // External requests too (the final review): a made-up one fails the signature check.
    for (const version of ['v4r2', 'v5r1'] as const) {
      const id = resolveIdentity({ ton: { version } }, -3);
      const request = await unsignedRequest(id, PK, {
        seqno: 3,
        validUntil: 1_790_000_060,
        deploy: false,
        messages: [nativeMessage({ to: v4, value: 1n, bounce: false })],
      });
      const bodyOf = (seed: string) =>
        loadMessage(
          signedRequest(
            request.message,
            request.digest,
            ed25519.sign(request.digest, Buffer.from(seed, 'hex')),
          ).beginParse(),
        ).body;
      expect(requestIsOwn(walletAddress(id, PK), bodyOf(KEY), PK, -3)).toBe(true);
      expect(requestIsOwn(walletAddress(id, PK), bodyOf('ab'.repeat(32)), PK, -3)).toBe(
        false,
      );
    }
  });
});
