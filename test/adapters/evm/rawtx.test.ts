import { Transaction, Wallet } from 'ethers';
import { classifyOwnBroadcast } from '../../../src/adapters/evm/errors';
import {
  MAX_SENT_BYTES,
  readSentTx,
  signatureValuesValid,
} from '../../../src/adapters/evm/rawtx';
import { KEY, RECIPIENT, VECTORS } from './support/vectors';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SEPOLIA = 11_155_111n;
const eip1559 = VECTORS[0]?.raw as string;
const legacy = VECTORS[1]?.raw as string;

/** A signed EIP-2930 transaction, made with ethers as an independent encoder. */
function accessListTx(): string {
  const tx = Transaction.from({
    type: 1,
    chainId: SEPOLIA,
    nonce: 3,
    gasPrice: 2_000_000_000n,
    gasLimit: 21_000n,
    to: RECIPIENT,
    value: 1n,
    accessList: [],
  });
  tx.signature = new Wallet(`0x${KEY}`).signingKey.sign(tx.unsignedHash);
  return tx.serialized;
}

describe('the SDK-free reader of sent EVM bytes (lesson 21)', () => {
  it('reads the checked fields of EIP-1559, EIP-2930 and legacy transactions', () => {
    expect(readSentTx(eip1559)).toMatchObject({
      type: 2,
      chainId: SEPOLIA,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      recovery: 0,
    });
    expect(readSentTx(accessListTx())).toMatchObject({ type: 1, chainId: SEPOLIA });
    expect(readSentTx(legacy)).toMatchObject({ type: 0, chainId: 97n });
    for (const raw of [eip1559, legacy, accessListTx()]) {
      expect(signatureValuesValid(readSentTx(raw) as never)).toBe(true);
    }
  });

  it('calls malformed only what geth cannot decode either', () => {
    for (const hex of [
      '0x', // empty
      '0xzz', // not hex
      '0x80', // a string, not a list
      `${eip1559}00`, // trailing bytes
      eip1559.slice(0, -2), // truncated
      '0x02c0', // too few fields
      '0x02f801c0', // a long-form length under 56
      `0x02f900${eip1559.slice(6)}`, // a length with a leading zero byte
      '0xc9008080808080808080', // an integer with a leading zero byte
    ]) {
      expect(readSentTx(hex)).toBe('malformed');
    }
  });

  it('reads nothing it cannot decode but that may be valid: blob, set-code, oversized', () => {
    expect(readSentTx('0x03f8')).toBeUndefined();
    expect(readSentTx('0x04c0')).toBeUndefined();
    expect(readSentTx(`0x${'00'.repeat(MAX_SENT_BYTES + 1)}`)).toBeUndefined();
    expect(readSentTx(42 as unknown as string)).toBeUndefined();
  });

  it("checks geth's signature values: r and s in range, low s, a recovery id of 0 or 1", () => {
    const tx = readSentTx(eip1559) as Exclude<
      ReturnType<typeof readSentTx>,
      'malformed' | undefined
    >;
    expect(signatureValuesValid({ ...tx, s: N / 2n })).toBe(true);
    expect(signatureValuesValid({ ...tx, s: N / 2n + 1n })).toBe(false);
    expect(signatureValuesValid({ ...tx, r: 0n })).toBe(false);
    expect(signatureValuesValid({ ...tx, r: N })).toBe(false);
    expect(signatureValuesValid({ ...tx, recovery: -1 })).toBe(false);
  });
});

describe('a node rejection of the bytes we sent is a claim (lesson 21, F3-R11)', () => {
  const claims = [
    'invalid chain id for signer',
    'invalid sender',
    'invalid transaction v, r, s values',
    'rlp: expected input list for types.LegacyTx',
    'typed transaction too short',
    'max priority fee per gas higher than max fee per gas',
  ];

  it.each(claims)(
    'refuses, never rejects, valid bytes a node calls invalid: %s',
    (text) => {
      expect(classifyOwnBroadcast(text, eip1559, SEPOLIA)).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'the node claimed the transaction is invalid',
      });
    },
  );

  it('rejects when the claim holds for the bytes', () => {
    expect(classifyOwnBroadcast('invalid chain id for signer', eip1559, 97n)).toEqual({
      kind: 'rejected',
      reason: 'wrong chain id',
    });
    expect(classifyOwnBroadcast('rlp: expected input list', '0x80', SEPOLIA)).toEqual({
      kind: 'rejected',
      reason: 'malformed transaction',
    });
    const highS = Transaction.from(eip1559);
    const signature = highS.signature;
    if (!signature) throw new Error('unsigned vector');
    const flipped = `0x${(N - BigInt(signature.s)).toString(16).padStart(64, '0')}`;
    const raw = eip1559.replace(signature.s.slice(2), flipped.slice(2));
    expect(classifyOwnBroadcast('invalid sender', raw, SEPOLIA)).toEqual({
      kind: 'rejected',
      reason: 'invalid signature',
    });
  });

  it('keeps every other answer as the node gave it', () => {
    expect(classifyOwnBroadcast('nonce too low', eip1559, SEPOLIA)).toMatchObject({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
    });
    expect(classifyOwnBroadcast('already known', eip1559, SEPOLIA)).toEqual({
      kind: 'already-known',
    });
  });
});
