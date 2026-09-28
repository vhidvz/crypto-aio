/**
 * Solana transfers (spec §15): SystemProgram and SPL `transferChecked`, with
 * `createAssociatedTokenAccountIdempotent` when the recipient's token account is missing,
 * an optional Memo, and compute-budget instructions. Expiry ordering: the recent blockhash's
 * `lastValidBlockHeight` is the Attempt's ordering, recorded with the blockhash and the slot
 * of its block (`SolanaExpiryOrdering`, F5-R9) so proofs can attest the height before a
 * verdict rests on it. One `ed25519` signing request per required signer, over the
 * message; the Attempt ref is the first signature (canonical).
 *
 * Nothing is signed before the compiled bytes are read back, SDK-free (`wire.ts`): one legacy
 * message whose only signer is the sender, on our blockhash, with exactly our instructions,
 * whose transfer pays the intent's recipient (the landing guard in `decode.ts` trusts it).
 * No transaction over the 1,232-byte packet limit is simulated, quoted, signed or sent.
 */
import type {
  BroadcastResult,
  Broadcaster,
  TxBuilder,
  WalletKey,
} from '../../core/driver/types';
import {
  SigningError,
  ValidationError,
  type CryptoAioError,
} from '../../core/errors/error';
import { assetId } from '../../core/model/asset';
import { isFeeSpeed, type FeeSpeed } from '../../core/model/fee';
import type { DriverIntent, DriverOutput } from '../../core/model/intent';
import type { RawTx, SignedTx, UnsignedTx } from '../../core/model/transaction';
import { equalBytes } from '../../core/util/bytes';
import { classifyBroadcastError } from './errors';
import {
  computeUnitLimitFor,
  detailsOf,
  fallbackComputeUnitLimit,
  feeDraft,
  lamportsCharged,
  parseOverride,
  priceForSpeed,
  priorityFee,
  variantOffsets,
} from './fees';
import { addressFromPublicKey, decodeBase58, encodeBase58 } from './keys';
import {
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_MEMO_BYTES,
  MAX_TRANSACTION_SIZE,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM,
  createAssociatedTokenAccountIdempotent,
  decodeTokenAccount,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from './programs';
import { accountInfo, mintDecimals, mintOf, type SolanaContext } from './reader';
import {
  BROADCAST,
  READ,
  call,
  contextValue,
  malformed,
  notYet,
  record,
  rpcCode,
  rpcMessage,
  u64,
  withSignal,
} from './rpc';
import type {
  SolanaCallTags,
  SolanaExpiryOrdering,
  SolanaFeeDetails,
  SolanaInstruction,
} from './types';
import { parseMessage, signedTransaction, type MessageParts } from './wire';

const invalid = (reason: string) => new ValidationError('INVALID_INTENT', reason);
/** A UTF-16 surrogate without its pair: text that has no UTF-8 encoding. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const U64_MAX = 2n ** 64n - 1n;
const SIGNATURE_BYTES = 64;
/** The longest text of a packet-sized transaction: 1,644 base64 characters, 2,464 hex. */
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_TRANSACTION_SIZE / 3);
const MAX_HEX_CHARS = 2 * MAX_TRANSACTION_SIZE;
const TOO_LARGE = `the transaction exceeds ${MAX_TRANSACTION_SIZE} bytes`;
/** Every node refuses a transaction over the packet limit; it is refused here, unsent. */
const REFUSED_TOO_LARGE: BroadcastResult = Object.freeze({
  kind: 'refused',
  code: 'TX_REFUSED',
  reason: 'transaction too large',
});

/** What a transfer needs on chain, resolved once per estimate. */
interface TransferPlan {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly memo?: string;
  readonly token?: {
    readonly mint: string;
    readonly decimals: number;
    readonly source: string;
    readonly destination: string;
  };
  readonly createsRecipientAccount: boolean;
}

function onlyOutput(intent: DriverIntent): DriverOutput {
  const output = intent.outputs[0];
  if (!output || intent.outputs.length !== 1) {
    throw invalid('Solana transfers have exactly one output');
  }
  return output;
}

const addressOf = (publicKey: Uint8Array): string | null => {
  try {
    return addressFromPublicKey(publicKey);
  } catch {
    return null;
  }
};

/** The wallet's ed25519 key whose address is the sending address. */
function keyOf(from: string, keys: readonly WalletKey[]): WalletKey {
  const key = keys.find((k) => k.scheme === 'ed25519' && addressOf(k.publicKey) === from);
  if (!key) {
    throw new SigningError(
      'SIGNER_UNAVAILABLE',
      'no ed25519 key for the sending address',
    );
  }
  return key;
}

/** D16: at most 256 UTF-8 bytes of well-formed text (the intent's policy, not `memo()`'s). */
function memoOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (LONE_SURROGATE.test(text))
    throw invalid('the memo is not well-formed Unicode text');
  if (new TextEncoder().encode(text).length > MAX_MEMO_BYTES) {
    throw invalid(`the memo exceeds ${MAX_MEMO_BYTES} UTF-8 bytes`);
  }
  return text;
}

async function rentExemptMinimum(
  ctx: SolanaContext,
  bytes: number,
  tags: SolanaCallTags,
): Promise<bigint> {
  return u64(
    await call(
      ctx.transport,
      'getMinimumBalanceForRentExemption',
      [bytes, { commitment: 'confirmed' }],
      tags,
    ),
    'getMinimumBalanceForRentExemption',
  );
}

/**
 * The classic token account of `owner` for `mint` at its associated address, or `null`
 * while that account is not created. An address that only holds lamports is not created
 * yet: the ATA program keeps those lamports when it creates the account, so nobody can
 * block a transfer by funding the address first. Anything else there is not the owner's
 * account for the mint (a reassigned owner included), and is refused.
 */
async function associatedAccount(
  ctx: SolanaContext,
  address: string,
  owner: string,
  mint: string,
  whose: 'source' | 'recipient',
  tags: SolanaCallTags,
): Promise<{ readonly amount: bigint; readonly frozen: boolean } | null> {
  const info = await accountInfo(ctx, address, tags);
  if (
    !info ||
    (info.owner === SYSTEM_PROGRAM && !info.executable && info.data.length === 0)
  ) {
    return null;
  }
  const account = info.owner === TOKEN_PROGRAM ? decodeTokenAccount(info.data) : null;
  if (
    !account ||
    encodeBase58(account.owner) !== owner ||
    encodeBase58(account.mint) !== mint
  ) {
    throw invalid(`the ${whose} token account does not match`);
  }
  return { amount: account.amount, frozen: account.frozen };
}

/**
 * Where a transfer pays the recipient `to` (the binding the landing guard trusts): SOL to
 * `to` itself; SPL into `to`'s associated token account for the mint, derived with the
 * mint's own program, classic Token (`mintDecimals` refuses every other owner).
 */
const destinationOf = (ctx: SolanaContext, to: string, mint: string | undefined) =>
  mint === undefined ? to : ctx.codec.associatedTokenAddress(to, mint);

function tokenPlan(
  ctx: SolanaContext,
  from: string,
  to: string,
  mint: string,
  decimals: number,
): NonNullable<TransferPlan['token']> {
  return {
    mint,
    decimals,
    source: ctx.codec.associatedTokenAddress(from, mint),
    destination: destinationOf(ctx, to, mint),
  };
}

/** The one output and the recipient's on-chain checks (no key: a fee needs none). */
async function planTransfer(
  ctx: SolanaContext,
  intent: DriverIntent,
  tags: SolanaCallTags,
): Promise<TransferPlan> {
  const output = onlyOutput(intent);
  const { from } = intent;
  const text = memoOf(intent.memo);
  const base = {
    from,
    to: output.to,
    amount: output.amount,
    ...(text !== undefined ? { memo: text } : {}),
  };
  const recipient = output.to === from ? null : await accountInfo(ctx, output.to, tags);
  if (intent.asset === 'native') {
    if (recipient && (recipient.executable || recipient.owner !== SYSTEM_PROGRAM)) {
      throw invalid('the recipient is a program-owned account');
    }
    if (
      !recipient &&
      output.to !== from &&
      output.amount < (await rentExemptMinimum(ctx, 0, tags))
    ) {
      throw new ValidationError(
        'INVALID_AMOUNT',
        'a new account needs at least the rent-exempt minimum',
      );
    }
    return { ...base, createsRecipientAccount: false };
  }
  const mint = mintOf(intent.asset);
  const decimals = await mintDecimals(ctx, mint, tags);
  // M4: nobody can sign for a program's associated token account.
  if (recipient?.executable) {
    throw invalid('the recipient is a program; send to a wallet or a PDA owner');
  }
  if (
    recipient &&
    (recipient.owner === TOKEN_PROGRAM || recipient.owner === TOKEN_2022_PROGRAM)
  ) {
    throw invalid('the recipient is a token account; send to its owner');
  }
  const token = tokenPlan(ctx, from, output.to, mint, decimals);
  const existing = await associatedAccount(
    ctx,
    token.destination,
    output.to,
    mint,
    'recipient',
    tags,
  );
  if (existing?.frozen) throw invalid('the recipient token account is frozen');
  return { ...base, token, createsRecipientAccount: existing === null };
}

/** The transfer's own instructions (no compute budget). */
function transferInstructions(plan: TransferPlan): SolanaInstruction[] {
  const list: SolanaInstruction[] = [];
  const { token } = plan;
  if (token) {
    if (plan.createsRecipientAccount) {
      list.push(
        createAssociatedTokenAccountIdempotent(
          plan.from,
          token.destination,
          plan.to,
          token.mint,
        ),
      );
    }
    list.push(
      transferChecked(
        token.source,
        token.mint,
        token.destination,
        plan.from,
        plan.amount,
        token.decimals,
      ),
    );
  } else {
    list.push(systemTransfer(plan.from, plan.to, plan.amount));
  }
  if (plan.memo !== undefined) list.push(memo(plan.memo));
  return list;
}

const withBudget = (limit: bigint, price: bigint, list: readonly SolanaInstruction[]) => [
  setComputeUnitLimit(limit),
  setComputeUnitPrice(price),
  ...list,
];

/**
 * The newest blockhash at `confirmed`, its last valid height, and the slot of its block:
 * agave answers from one bank (`rpc.rs` `get_latest_blockhash`: the bank's last blockhash,
 * that blockhash's last valid height, and `new_response`'s context slot, the bank's own).
 * One endpoint's word: proofs attest the three together before using the height (F5-R9).
 */
async function latestBlockhash(
  ctx: SolanaContext,
  tags: SolanaCallTags,
): Promise<{
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly slot: bigint;
}> {
  const result = await call(
    ctx.transport,
    'getLatestBlockhash',
    [{ commitment: 'confirmed' }],
    tags,
  );
  const value = contextValue(result, 'getLatestBlockhash') as {
    blockhash?: unknown;
    lastValidBlockHeight?: unknown;
  } | null;
  if (!value || decodeBase58(value.blockhash, 32) === null) {
    throw malformed('getLatestBlockhash');
  }
  return {
    blockhash: value.blockhash as string,
    lastValidBlockHeight: u64(value.lastValidBlockHeight, 'lastValidBlockHeight'),
    slot: u64(record(record(result)?.context)?.slot, 'getLatestBlockhash context slot'),
  };
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Whether `bytes` (a key read from a message) is the key `address`. */
function isKey(bytes: Uint8Array | undefined, address: string): boolean {
  const expected = decodeBase58(address, 32);
  return bytes !== undefined && expected !== null && equalBytes(bytes, expected);
}

/** The transaction with a zero signature for each required signer. */
const withPlaceholders = (parts: MessageParts, message: Uint8Array): Uint8Array =>
  signedTransaction(
    Array.from({ length: parts.required }, () => new Uint8Array(SIGNATURE_BYTES)),
    message,
  );

/**
 * A compiled message read back from its bytes before it is simulated, quoted or signed: one
 * legacy message (a `null` from the reader is a refusal, never "no signers needed") whose
 * only signer is `from`, the fee payer, and whose transaction fits the packet limit.
 */
function readBack(message: Uint8Array, from: string): MessageParts {
  const parts = parseMessage(message);
  if (!parts) throw invalid('the compiled message is not one legacy message');
  if (parts.required !== 1 || !isKey(parts.keys[0], from)) {
    throw invalid('the compiled message has unexpected signers');
  }
  if (withPlaceholders(parts, message).length > MAX_TRANSACTION_SIZE) {
    throw invalid(TOO_LARGE);
  }
  return parts;
}

const isWritable = (parts: MessageParts, index: number): boolean =>
  index < parts.required
    ? index < parts.required - parts.readonlySigned
    : index < parts.keys.length - parts.readonlyUnsigned;

/** A little-endian u64 of `data` at `at`, or `null` when the data is too short. */
const u64At = (data: Uint8Array, at: number): bigint | null =>
  data.length < at + 8
    ? null
    : new DataView(data.buffer, data.byteOffset + at, 8).getBigUint64(0, true);

/**
 * The recipient binding the landing guard trusts, read from the bytes and re-derived from
 * the intent alone: exactly one transfer (System `Transfer`, or Token `TransferChecked`)
 * moves the intent's amount into `destinationOf` the intent's recipient. The sender is
 * bound by `readBack`: it is the message's only signer.
 */
function checkRecipient(
  ctx: SolanaContext,
  parts: MessageParts,
  output: DriverOutput,
  mint: string | undefined,
): void {
  const program = mint === undefined ? SYSTEM_PROGRAM : TOKEN_PROGRAM;
  // The destination's position and the amount's offset: System [from, to], data
  // [u32 2, u64 lamports]; Token [source, mint, destination, authority], data
  // [12, u64 amount, u8 decimals].
  const [destination, amountAt] = mint === undefined ? [1, 4] : [2, 1];
  const transfers = parts.instructions.filter((ix) =>
    isKey(parts.keys[ix.program], program),
  );
  const transfer = transfers[0];
  if (
    transfers.length !== 1 ||
    !transfer ||
    !isKey(
      parts.keys[transfer.accounts[destination] as number],
      destinationOf(ctx, output.to, mint),
    ) ||
    u64At(transfer.data, amountAt) !== output.amount
  ) {
    throw invalid('the transfer does not pay the recipient');
  }
}

/**
 * The bytes carry exactly `list` on `blockhash`: each instruction's program, accounts and
 * data, and no other instruction. An account the list writes must be writable (the message
 * merges flags per key); its signers are `readBack`'s.
 */
function checkInstructions(
  parts: MessageParts,
  blockhash: string,
  list: readonly SolanaInstruction[],
): void {
  const mismatch = () => invalid('the compiled message does not match the transfer');
  if (!isKey(parts.blockhash, blockhash) || parts.instructions.length !== list.length) {
    throw mismatch();
  }
  list.forEach((expected, i) => {
    const found = parts.instructions[i];
    if (
      !found ||
      !isKey(parts.keys[found.program], expected.programId) ||
      found.accounts.length !== expected.accounts.length ||
      !equalBytes(found.data, expected.data)
    ) {
      throw mismatch();
    }
    expected.accounts.forEach((account, j) => {
      const index = found.accounts[j] as number;
      if (
        !isKey(parts.keys[index], account.address) ||
        (account.writable && !isWritable(parts, index))
      ) {
        throw mismatch();
      }
    });
  });
}

/** The simulated compute units of the transfer, or `null` when it cannot be measured. */
async function simulatedUnits(
  ctx: SolanaContext,
  from: string,
  price: bigint,
  list: readonly SolanaInstruction[],
  blockhash: string,
  tags: SolanaCallTags,
): Promise<bigint | null> {
  const message = ctx.codec.compileMessage(
    from,
    blockhash,
    withBudget(MAX_COMPUTE_UNIT_LIMIT, price, list),
  );
  const unsignedTx = withPlaceholders(readBack(message, from), message);
  const value = contextValue(
    await call(
      ctx.transport,
      'simulateTransaction',
      [
        base64(unsignedTx),
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        },
      ],
      tags,
    ),
    'simulateTransaction',
  ) as { err?: unknown; unitsConsumed?: unknown } | null;
  if (!value) throw malformed('simulateTransaction');
  // A failing simulation (e.g. insufficient funds) still lets `checkFunds` explain itself.
  if (value.err !== null || value.unitsConsumed === undefined) return null;
  return u64(value.unitsConsumed, 'unitsConsumed');
}

/**
 * The base64 wire bytes of a signed transaction, or `null` when they exceed the packet
 * limit. The text is capped before it is decoded (lesson 20), and only a canonical text is
 * read: `Buffer` skips what it cannot decode, and a truncated transaction is never sent.
 */
function wirePayload(raw: RawTx): string | null {
  const { encoding, data } = raw;
  if (encoding === 'json') throw invalid('a Solana transaction is bytes (base64 or hex)');
  if (typeof data !== 'string') throw invalid('a Solana transaction is a text of bytes');
  if (data.length > (encoding === 'hex' ? MAX_HEX_CHARS : MAX_BASE64_CHARS)) return null;
  const bytes = Buffer.from(data, encoding);
  const canonical =
    encoding === 'hex'
      ? bytes.toString('hex') === data.toLowerCase()
      : bytes.toString('base64') === data;
  if (!canonical) throw invalid(`the transaction is not canonical ${encoding}`);
  return bytes.length > MAX_TRANSACTION_SIZE ? null : bytes.toString('base64');
}

export function createSolanaBuilder(ctx: SolanaContext): TxBuilder {
  return {
    async estimateFee(intent, build) {
      const tags = withSignal(READ, build.signal);
      const plan = await planTransfer(ctx, intent, tags);
      const list = transferInstructions(plan);
      const override = isFeeSpeed(intent.fee) ? undefined : parseOverride(intent.fee);
      const variant = variantOffsets(ctx.nextVariant());
      let price: bigint;
      if (override) {
        price = override.computeUnitPrice;
      } else {
        const writable = plan.token
          ? [plan.from, plan.token.source, plan.token.destination]
          : [plan.from, plan.to];
        const recent = await call(
          ctx.transport,
          'getRecentPrioritizationFees',
          [writable],
          tags,
        );
        price = priceForSpeed(recent, intent.fee as FeeSpeed) + variant.price;
      }
      const { blockhash } = await latestBlockhash(ctx, tags);
      let base = override?.computeUnitLimit;
      if (base === undefined) {
        const units = await simulatedUnits(ctx, plan.from, price, list, blockhash, tags);
        base =
          units === null
            ? fallbackComputeUnitLimit(list.length)
            : computeUnitLimitFor(units);
      }
      // D10, M3: every build varies the limit, an explicit one included (the price of an
      // explicit fee is kept exactly); at the protocol maximum no variant fits.
      const limit =
        base + variant.limit > MAX_COMPUTE_UNIT_LIMIT
          ? MAX_COMPUTE_UNIT_LIMIT
          : base + variant.limit;
      // Lesson 19: a fee is a u64 of lamports. An explicit price without one is the
      // caller's; a node's recent prices or quote without one decide nothing (retryable).
      const unpriced = (what: string) =>
        override
          ? invalid('Solana fee override: the fee does not fit in u64')
          : malformed(what);
      const priority = priorityFee(price, limit);
      if (priority > U64_MAX) throw unpriced('getRecentPrioritizationFees');
      const message = ctx.codec.compileMessage(
        plan.from,
        blockhash,
        withBudget(limit, price, list),
      );
      readBack(message, plan.from);
      const quoted = contextValue(
        await call(
          ctx.transport,
          'getFeeForMessage',
          [base64(message), { commitment: 'confirmed' }],
          tags,
        ),
        'getFeeForMessage',
      );
      // `null`: the endpoint does not know the blockhash yet.
      if (quoted === null) throw notYet('the fee of the message');
      const total = u64(quoted, 'getFeeForMessage');
      // agave's fee arithmetic saturates: a quote of u64::MAX is no fee.
      if (total === U64_MAX) throw unpriced('getFeeForMessage');
      if (total < priority) throw malformed('getFeeForMessage');
      const details: SolanaFeeDetails = {
        signatures: 1,
        baseFee: total - priority,
        computeUnitLimit: limit,
        computeUnitPrice: price,
        priorityFee: priority,
        rent: plan.createsRecipientAccount
          ? await rentExemptMinimum(ctx, TOKEN_ACCOUNT_SIZE, tags)
          : 0n,
        createsRecipientAccount: plan.createsRecipientAccount,
      };
      return feeDraft(override ? 'custom' : (intent.fee as FeeSpeed), details);
    },

    async checkFunds(intent, fee, build) {
      const output = onlyOutput(intent);
      const tags = withSignal(READ, build.signal);
      const balance = u64(
        contextValue(
          await call(
            ctx.transport,
            'getBalance',
            [intent.from, { commitment: 'confirmed' }],
            tags,
          ),
          'getBalance',
        ),
        'balance',
      );
      if (intent.asset !== 'native') {
        const mint = mintOf(intent.asset);
        const source = await associatedAccount(
          ctx,
          ctx.codec.associatedTokenAddress(intent.from, mint),
          intent.from,
          mint,
          'source',
          tags,
        );
        if (source?.frozen) throw invalid('the source token account is frozen');
        const available = source?.amount ?? 0n;
        if (available < output.amount) {
          return { ok: false, asset: intent.asset, required: output.amount, available };
        }
      }
      // A system account may end at 0 or at the rent-exempt minimum, nothing in between.
      const spent =
        lamportsCharged(fee) + (intent.asset === 'native' ? output.amount : 0n);
      const minimum = await rentExemptMinimum(ctx, 0, tags);
      if (balance < spent) {
        return { ok: false, asset: 'native', required: spent, available: balance };
      }
      const left = balance - spent;
      if (left !== 0n && left < minimum) {
        return {
          ok: false,
          asset: 'native',
          required: spent + minimum,
          available: balance,
        };
      }
      return { ok: true };
    },

    async build(intent, fee, build) {
      const output = onlyOutput(intent);
      const details = detailsOf(fee);
      const key = keyOf(intent.from, build.keys);
      const text = memoOf(intent.memo);
      const tags = withSignal(READ, build.signal);
      const mint = intent.asset === 'native' ? undefined : mintOf(intent.asset);
      const plan: TransferPlan = {
        from: intent.from,
        to: output.to,
        amount: output.amount,
        ...(text !== undefined ? { memo: text } : {}),
        createsRecipientAccount: details.createsRecipientAccount,
        ...(mint === undefined
          ? {}
          : {
              token: tokenPlan(
                ctx,
                intent.from,
                output.to,
                mint,
                await mintDecimals(ctx, mint, tags),
              ),
            }),
      };
      const list = withBudget(
        details.computeUnitLimit,
        details.computeUnitPrice,
        transferInstructions(plan),
      );
      const { blockhash, lastValidBlockHeight, slot } = await latestBlockhash(ctx, tags);
      // The payload, the signing request and the ordering all come from this one message,
      // read back before it is offered for signing.
      const message = ctx.codec.compileMessage(plan.from, blockhash, list);
      const parts = readBack(message, plan.from);
      checkRecipient(ctx, parts, output, mint);
      checkInstructions(parts, blockhash, list);
      // F5-R9: the height, with the blockhash and slot that let a proof attest it.
      const ordering: SolanaExpiryOrdering = {
        kind: 'expiry',
        lastValidHeight: lastValidBlockHeight,
        blockhash,
        blockhashSlot: slot,
      };
      const unsigned: UnsignedTx = {
        payload: { encoding: 'base64', data: base64(message) },
        signingRequests: [
          {
            id: 's0',
            scheme: 'ed25519',
            payload: message,
            payloadKind: 'message',
            publicKey: key.publicKey,
            ...(key.keyRef ? { keyRef: key.keyRef } : {}),
          },
        ],
        ordering,
        fee,
        summary: {
          asset: assetId(ctx.chain.id, ctx.network.id, intent.asset),
          outputs: [{ to: output.to, amount: output.amount.toString() }],
          ...(text !== undefined ? { memo: text } : {}),
        },
      };
      return unsigned;
    },

    async assemble(unsigned, signatures): Promise<SignedTx> {
      const failed = (reason: string) => new SigningError('SIGNING_FAILED', reason);
      const mismatch = () => failed('the message and its signing requests do not match');
      const { encoding, data } = unsigned.payload;
      if (encoding !== 'base64') throw failed('not a Solana message');
      const message = new Uint8Array(Buffer.from(data, 'base64'));
      if (base64(message) !== data) throw failed('not a Solana message');
      // A `null` is a refusal, never "no signers needed": one request per required signer.
      const parts = parseMessage(message);
      if (!parts || parts.required !== unsigned.signingRequests.length) throw mismatch();
      const bytes = unsigned.signingRequests.map((request, i) => {
        if (
          request.scheme !== 'ed25519' ||
          request.payloadKind !== 'message' ||
          !equalBytes(request.publicKey, parts.keys[i] as Uint8Array) ||
          !equalBytes(request.payload, message)
        ) {
          throw mismatch();
        }
        const signature = signatures.find((s) => s.requestId === request.id);
        if (!signature || signature.bytes.length !== SIGNATURE_BYTES) {
          throw failed(`missing signature for request ${request.id}`);
        }
        return signature.bytes;
      });
      const raw = signedTransaction(bytes, message);
      if (raw.length > MAX_TRANSACTION_SIZE) throw failed(TOO_LARGE);
      return {
        raw: { encoding: 'base64', data: base64(raw) },
        ref: {
          id: encodeBase58(bytes[0] as Uint8Array),
          idKind: 'signature',
          canonical: true,
        },
      };
    },
  };
}

export function createSolanaBroadcaster(ctx: SolanaContext): Broadcaster {
  return {
    async broadcast(signed, options = {}) {
      const payload = wirePayload(signed.raw);
      if (payload === null) return REFUSED_TOO_LARGE;
      try {
        await call(
          ctx.transport,
          'sendTransaction',
          [payload, { encoding: 'base64', preflightCommitment: 'confirmed' }],
          {
            ...withSignal(BROADCAST, options.signal),
            ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          },
        );
        return { kind: 'accepted' };
      } catch (error) {
        // Handoff §3, R16/R17: only a definitive, non-ambiguous node answer is classified:
        // by its code, then its structured data (a preflight failure's simulation result),
        // then its anchored text. Anything else may have been sent: rethrown unchanged.
        const code = rpcCode(error);
        if (code === undefined) throw error;
        const failure = error as CryptoAioError;
        return classifyBroadcastError(
          code,
          rpcMessage(failure),
          failure.details?.rpcData,
        );
      }
    },
  };
}
