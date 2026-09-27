import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { BROADCAST, READ } from '../../../src/adapters/solana/rpc';
import {
  createAssociatedTokenAccountIdempotent,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { createWeb3Codec } from '../../../src/adapters/solana/web3';
import {
  decodeLength,
  encodeLength,
  messageSigners,
  signedTransaction,
} from '../../../src/adapters/solana/wire';
import { PLACEHOLDER_ORIGIN, type Transport } from '../../../src/core/transport/types';
import {
  KEY_ADDRESS,
  KEY_PUBLIC,
  MINT,
  RECIPIENT,
  compileLegacy,
  sign,
} from './support/vectors';

const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SOURCE_ATA = 'CCYv891E1JjJ834xKsRFvmdu1Q6W5TQy6UzGg6mCBLcA';
const RECIPIENT_ATA = 'H3yGizipXnUp5JJxpFDikUCHFevydZH6ajimjQQzayUU';

/** Frozen vectors: generated once with @solana/web3.js 1.99.0, cross-checked below. */
const VECTORS = [
  {
    name: 'native transfer with memo',
    instructions: [
      setComputeUnitLimit(16_000n),
      setComputeUnitPrice(1_000n),
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_500_000_000n),
      memo('order-7'),
    ],
    message:
      'AQADBVrI3WBGoGnLbCiVIYOFWFd514dJhL1jlWvYiBgVkg2PWQhNw70tZsh/gPw8EyCOwEcJz96KrMegP3Hw7r6XzpwDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI3OWdtQgPwsbTvPfKkHEtPC5ebCjyfw37uZU72wiUwDqwQCAAUCgD4AAAIACQPoAwAAAAAAAAMCAAEMAgAAAAAvaFkAAAAABAAHb3JkZXItNw==',
    signature:
      '3gLw2weFTqCxcyAK3Vq3DbtjUJC8dyTo2ikvYBdBexoprNf2Mtmy8ByumTFpfs31LH4szn4pDJ3XgYd5n8fAomEZ',
  },
  {
    name: 'SPL transferChecked creating the recipient account',
    instructions: [
      setComputeUnitLimit(26_000n),
      setComputeUnitPrice(0n),
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, RECIPIENT_ATA, RECIPIENT, MINT),
      transferChecked(SOURCE_ATA, MINT, RECIPIENT_ATA, KEY_ADDRESS, 2_000_000n, 6),
    ],
    message:
      'AQAGCVrI3WBGoGnLbCiVIYOFWFd514dJhL1jlWvYiBgVkg2P7n3HQ++iJT4YiDF8r3is4hXVdfBf5H2bgF0X6xYgffGmZghT39AeTr57eL9MxCsAJpBCpkUYSd8pTAWoX8E0IwMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FlZCE3DvS1myH+A/DwTII7ARwnP3oqsx6A/cfDuvpfOnCEBsld1ikGCfxegz/jNUMAhHo+nLb+ldQOVRPnq+b2pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8Aqc5Z21CA/CxtO898qQcS08Ll5sKPJ/Dfu5lTvbCJTAOrBAMABQKQZQAAAwAJAwAAAAAAAAAABAYAAQUGBwgBAQgEAgYBAAoMgIQeAAAAAAAG',
    signature:
      '2m3dQsMFMSp4xP9KHq2hzE4Xb3hF7Zi26wVrk9wKSTC3Uih2SVNMDrtxnC28o3Eb193PjVyJNkhZMwwVN1At6ZLf',
  },
];

describe('the @solana/web3.js codec (lesson 11)', () => {
  // Codec work needs no transport; only `createNative` uses one.
  const codec = createWeb3Codec(undefined as never);

  it.each(VECTORS)('compiles $name to the frozen, independently derived bytes', (v) => {
    const message = codec.compileMessage(KEY_ADDRESS, BLOCKHASH, v.instructions);
    expect(Buffer.from(message).toString('base64')).toBe(v.message);
    expect(compileLegacy(KEY_ADDRESS, BLOCKHASH, v.instructions)).toEqual(message);
    const signature = sign(message);
    expect(base58.encode(signature)).toBe(v.signature);
    expect(ed25519.verify(signature, message, KEY_PUBLIC, { zip215: false })).toBe(true);
    // Our signed layout is exactly what the SDK parses and writes back.
    const raw = signedTransaction([signature], message);
    const parsed = VersionedTransaction.deserialize(raw);
    expect(base58.encode(parsed.signatures[0] as Uint8Array)).toBe(v.signature);
    expect(Buffer.from(parsed.serialize())).toEqual(Buffer.from(raw));
    expect(messageSigners(message)).toEqual([KEY_ADDRESS]);
  });

  it('builds System and ComputeBudget data exactly as the SDK does', () => {
    const sdk = SystemProgram.transfer({
      fromPubkey: new PublicKey(KEY_ADDRESS),
      toPubkey: new PublicKey(RECIPIENT),
      lamports: 1_500_000_000n,
    });
    const ours = systemTransfer(KEY_ADDRESS, RECIPIENT, 1_500_000_000n);
    expect(Buffer.from(ours.data)).toEqual(Buffer.from(sdk.data));
    expect(ours.accounts.map((a) => [a.address, a.signer, a.writable])).toEqual(
      sdk.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    );
    expect(Buffer.from(setComputeUnitLimit(123_456n).data)).toEqual(
      Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 123_456 }).data),
    );
    expect(Buffer.from(setComputeUnitPrice(2n ** 63n).data)).toEqual(
      Buffer.from(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2n ** 63n }).data,
      ),
    );
  });

  it('derives associated token addresses as the chain does', () => {
    // Devnet 3CaZnr7H…3QDY created H5ri5h… for AieRQ9…'s CSqx1A… tokens.
    expect(
      codec.associatedTokenAddress(
        'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
        'CSqx1AjNB5q71a1Z2uT32LCNVbtcGCQamkgdQQUKk7CA',
      ),
    ).toBe('H5ri5hFMzV2WUoaR4WBPELgf9ZxRvHCAnxUro4TGn6C4');
    expect(codec.associatedTokenAddress(KEY_ADDRESS, MINT)).toBe(SOURCE_ATA);
  });

  it('reads and writes compact-u16 lengths and refuses versioned or empty messages', () => {
    for (const value of [0, 1, 127, 128, 255, 16_383, 16_384, 65_535]) {
      const bytes = encodeLength(value);
      expect(decodeLength(Uint8Array.from([9, ...bytes]), 1)).toEqual({
        value,
        next: 1 + bytes.length,
      });
    }
    expect(Array.from(encodeLength(128))).toEqual([0x80, 0x01]);
    expect(decodeLength(Uint8Array.of(0x80), 0)).toBeNull();
    const message = Buffer.from(VECTORS[0]!.message, 'base64');
    expect(messageSigners(Uint8Array.from([0x80, ...message]))).toBeNull();
    expect(messageSigners(Uint8Array.from([0, ...message.subarray(1)]))).toBeNull();
    expect(messageSigners(message.subarray(0, 20))).toBeNull();
  });
});

describe('the wire format on out-of-range values and untrusted bytes (lessons 19, 20)', () => {
  const refused = (code: string, message: string, run: () => unknown) =>
    expect(run).toThrow(expect.objectContaining({ code, message }));

  it('refuses a length that does not fit compact-u16 instead of wrapping it', () => {
    // Fixed text that never contains the value; unchecked, 2^32 encodes as 0 and -1 never ends.
    for (const value of [65_536, 2 ** 32, 1.5, Number.NaN, -1]) {
      refused('INVALID_INTENT', 'a length does not fit in its compact-u16 field', () =>
        encodeLength(value),
      );
    }
    expect(Array.from(encodeLength(65_535))).toEqual([0xff, 0xff, 0x03]);
  });

  it('reads only canonical compact-u16: no alias, no overflow, at most three bytes', () => {
    expect(decodeLength(Uint8Array.of(0xff, 0xff, 0x03), 0)).toEqual({
      value: 65_535,
      next: 3,
    });
    expect(decodeLength(Uint8Array.of(0x80, 0x80, 0x01), 0)).toEqual({
      value: 16_384,
      next: 3,
    });
    for (const bytes of [
      [0x80, 0x00], // 0 written in two bytes
      [0xff, 0x80, 0x00], // 127 written in three bytes
      [0xff, 0xff, 0x04], // 65,536
      [0x80, 0x80, 0x80, 0x01], // a fourth byte
      [0xff, 0xff], // cut short
    ]) {
      expect(decodeLength(Uint8Array.from(bytes), 0)).toBeNull();
    }
    expect(decodeLength(Uint8Array.of(1), 1)).toBeNull();
    expect(decodeLength(Uint8Array.of(1), -1)).toBeNull();
  });

  it('reads signers only from a whole, well-formed legacy message', () => {
    // Header [1, 0, 1]; keys payer, recipient, System; blockhash; one transfer
    // instruction: program 2 at 133, 2 accounts [0, 1] at 134..136, 12 data bytes at 137.
    const base = () =>
      compileLegacy(KEY_ADDRESS, BLOCKHASH, [systemTransfer(KEY_ADDRESS, RECIPIENT, 1n)]);
    const edit = (changes: Record<number, number>) => {
      const bytes = base();
      for (const [at, value] of Object.entries(changes)) bytes[Number(at)] = value;
      return bytes;
    };
    const splice = (at: number, bytes: number[]) => {
      const m = base();
      return Uint8Array.from([...m.subarray(0, at), ...bytes, ...m.subarray(at + 1)]);
    };
    expect(base()).toHaveLength(150);
    expect(messageSigners(base())).toEqual([KEY_ADDRESS]);
    expect(messageSigners(edit({ 2: 0 }))).toEqual([KEY_ADDRESS]);
    expect(messageSigners(edit({ 0: 2 }))).toEqual([KEY_ADDRESS, RECIPIENT]);
    for (const bad of [
      new Uint8Array(0),
      Uint8Array.of(1, 0),
      edit({ 1: 1 }), // a read-only fee payer
      edit({ 2: 3 }), // signers and read-only non-signers overlap
      edit({ 3: 4 }), // more keys than bytes
      splice(3, [0xff, 0xff, 0x03]), // 65,535 keys
      splice(3, [0x83, 0x00]), // a non-canonical key count
      edit({ 132: 2 }), // a missing instruction
      splice(132, [0xff, 0xff, 0x03]), // 65,535 instructions
      edit({ 133: 0 }), // the fee payer as a program
      edit({ 133: 3 }), // a program index out of range
      edit({ 134: 0x7f }), // more account indexes than bytes
      edit({ 136: 3 }), // an account index out of range
      edit({ 137: 13 }), // more data than bytes
      Uint8Array.from([...base(), 0]), // a trailing byte
    ]) {
      expect(messageSigners(bad)).toBeNull();
    }
  });

  it('refuses a signature that is not exactly 64 bytes', () => {
    const message = compileLegacy(KEY_ADDRESS, BLOCKHASH, []);
    for (const length of [0, 63, 65]) {
      refused('INVALID_INTENT', 'a Solana signature is exactly 64 bytes', () =>
        signedTransaction([new Uint8Array(length)], message),
      );
    }
    expect(signedTransaction([new Uint8Array(64)], message)).toHaveLength(
      1 + 64 + message.length,
    );
  });
});

describe('the native Connection (R34, spec §11)', () => {
  it('bridges a fresh Connection per call to the transport, sends tagged as broadcasts', async () => {
    const tags: unknown[] = [];
    const transport = {
      createFetch: (classify: (url: URL, init: RequestInit | undefined) => unknown) =>
        (async (input: string, init?: RequestInit) => {
          tags.push(classify(new URL(input), init));
          const { id, method } = JSON.parse(String(init?.body)) as {
            id: string;
            method: string;
          };
          const result = method === 'sendTransaction' ? VECTORS[0]!.signature : 42;
          return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
    } as unknown as Transport;
    const codec = createWeb3Codec(transport);
    const first = codec.createNative();
    const second = codec.createNative();
    expect(first.client).toBeInstanceOf(Connection);
    expect(first.client).not.toBe(second.client);
    const connection = first.client as Connection;
    // The SDK only ever sees the placeholder origin; the transport holds the real URLs.
    expect(connection.rpcEndpoint).toBe(`${PLACEHOLDER_ORIGIN}/`);
    expect(connection.commitment).toBe('confirmed');
    await expect(connection.getSlot()).resolves.toBe(42);
    const message = Buffer.from(VECTORS[0]!.message, 'base64');
    const raw = signedTransaction([sign(message)], message);
    await expect(
      connection.sendRawTransaction(raw, { skipPreflight: true }),
    ).resolves.toBe(VECTORS[0]!.signature);
    expect(tags).toEqual([READ, BROADCAST]);
    // Closing stops the (never bridged) websocket client from reconnecting, then closes it.
    const socket = (
      connection as unknown as {
        _rpcWebSocket: { close(): void; setAutoReconnect(on: boolean): void };
      }
    )._rpcWebSocket;
    const reconnect = jest.spyOn(socket, 'setAutoReconnect');
    const close = jest.spyOn(socket, 'close');
    await first.close?.();
    expect(reconnect).toHaveBeenCalledWith(false);
    expect(close).toHaveBeenCalledTimes(1);
    await second.close?.();
  });
});
