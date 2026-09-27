import { base58 } from '@scure/base';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  createAssociatedTokenAccountIdempotent,
  decodeMint,
  decodeTokenAccount,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Account data read from devnet (Plan 5 appendix): the devnet USDC mint and a holder. */
const USDC_MINT_DATA =
  'AQAAAOuFRM+RGCd6ljLpmVBmZRu/sUCLhXPrwC5T76tavw4Lh9zMk85BBuIGAQEAAACoBjP/Bn2I36XUNXv0TibOzM8IZmiBA8a6YJ+kTBjSCA==';
const TOKEN_ACCOUNT_DATA =
  'O0Qss5EhV/E6kz0BNCgtAytf/s0Botvxt3kGCN8ALqdaN3JklJOAkxqwIMNQ2zW6E99wSN2reC/e0jJPIzobcxh2OBYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('Solana instructions, as devnet encodes them', () => {
  it('matches the instruction data of a real transferChecked transaction', () => {
    // Devnet 4DETGWWs…sixv: limit 20000, price 1, transferChecked 1000 (6 decimals), memo.
    expect(hex(setComputeUnitLimit(20_000n).data)).toBe('02204e0000');
    expect(hex(setComputeUnitPrice(1n).data)).toBe('030100000000000000');
    const ix = transferChecked(
      '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
      '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
      1_000n,
      6,
    );
    expect(hex(ix.data)).toBe('0ce80300000000000006');
    expect(ix.programId).toBe(TOKEN_PROGRAM);
    expect(ix.accounts).toEqual([
      {
        address: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
        signer: false,
        writable: true,
      },
      {
        address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        signer: false,
        writable: false,
      },
      {
        address: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
        signer: false,
        writable: true,
      },
      {
        address: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        signer: true,
        writable: false,
      },
    ]);
    expect(
      Buffer.from(memo('83c873a1f7d4c4bcfd6c095906248332').data).toString('utf8'),
    ).toBe('83c873a1f7d4c4bcfd6c095906248332');
  });

  it('matches a real CreateIdempotent and encodes a System transfer', () => {
    // Devnet 3CaZnr7H…3QDY: [payer, ata, wallet, mint, system, token], data 01.
    const ix = createAssociatedTokenAccountIdempotent(
      'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
      'H5ri5hFMzV2WUoaR4WBPELgf9ZxRvHCAnxUro4TGn6C4',
      'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
      'CSqx1AjNB5q71a1Z2uT32LCNVbtcGCQamkgdQQUKk7CA',
    );
    expect(ix.programId).toBe(ASSOCIATED_TOKEN_PROGRAM);
    expect(hex(ix.data)).toBe('01');
    expect(ix.accounts.map((a) => [a.address.slice(0, 6), a.signer, a.writable])).toEqual(
      [
        ['AieRQ9', true, true],
        ['H5ri5h', false, true],
        ['AieRQ9', false, false],
        ['CSqx1A', false, false],
        ['111111', false, false],
        ['Tokenk', false, false],
      ],
    );
    const transfer = systemTransfer(SYSTEM_PROGRAM, TOKEN_PROGRAM, 1_000_000_000n);
    expect(hex(transfer.data)).toBe('0200000000ca9a3b00000000');
  });

  it('refuses a value that does not fit its field instead of wrapping it (lesson 19)', () => {
    const [a, b] = [SYSTEM_PROGRAM, TOKEN_PROGRAM];
    // Fixed text that never contains the value: INVALID_AMOUNT for a u64, else INVALID_INTENT.
    const refused = (bits: 8 | 32 | 64, build: () => unknown) =>
      expect(build).toThrow(
        expect.objectContaining({
          code: bits === 64 ? 'INVALID_AMOUNT' : 'INVALID_INTENT',
          message: `a value does not fit in its u${bits} field`,
        }),
      );
    // u64 (lamports, token amounts, micro-lamports): DataView would encode 2^64 + 5 as 5
    // and -1 as 2^64 - 1.
    refused(64, () => systemTransfer(a, b, 2n ** 64n + 5n));
    refused(64, () => systemTransfer(a, b, -1n));
    refused(64, () => transferChecked(a, b, a, b, 2n ** 64n, 6));
    refused(64, () => setComputeUnitPrice(2n ** 64n));
    refused(64, () => setComputeUnitPrice(-1n));
    expect(hex(systemTransfer(a, b, 2n ** 64n - 1n).data)).toBe(
      '02000000ffffffffffffffff',
    );
    // u32 (compute units).
    refused(32, () => setComputeUnitLimit(2n ** 32n));
    refused(32, () => setComputeUnitLimit(-1n));
    expect(hex(setComputeUnitLimit(2n ** 32n - 1n).data)).toBe('02ffffffff');
    // u8 (decimals).
    refused(8, () => transferChecked(a, b, a, b, 1n, 256));
    refused(8, () => transferChecked(a, b, a, b, 1n, -1));
    refused(8, () => transferChecked(a, b, a, b, 1n, 1.5));
    expect(hex(transferChecked(a, b, a, b, 1n, 255).data).slice(-2)).toBe('ff');
  });

  it('decodes classic mints and token accounts strictly', () => {
    const mint = new Uint8Array(Buffer.from(USDC_MINT_DATA, 'base64'));
    expect(decodeMint(mint)).toEqual({ decimals: 6 });
    expect(decodeMint(mint.slice(0, 81))).toBeNull();
    const uninitialized = mint.slice();
    uninitialized[45] = 0;
    expect(decodeMint(uninitialized)).toBeNull();
    const account = new Uint8Array(Buffer.from(TOKEN_ACCOUNT_DATA, 'base64'));
    const decoded = decodeTokenAccount(account);
    expect(decoded && base58.encode(decoded.mint)).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    expect(decoded && base58.encode(decoded.owner)).toBe(
      '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
    );
    expect(decoded).toMatchObject({ amount: 372_799_000n, frozen: false });
    const frozen = account.slice();
    frozen[108] = 2;
    expect(decodeTokenAccount(frozen)).toMatchObject({ frozen: true });
    const closed = account.slice();
    closed[108] = 0;
    expect(decodeTokenAccount(closed)).toBeNull();
    expect(decodeTokenAccount(mint)).toBeNull();
  });
});
