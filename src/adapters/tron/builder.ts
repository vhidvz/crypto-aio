/**
 * The Tron `TxBuilder` and `Broadcaster`. One output (TRX or TRC-20), an optional memo in
 * `raw_data.data`, `expiry` ordering (`expiresAtMs`), one `secp256k1-ecdsa` digest request
 * over the txID, and the txID as the Attempt ref, known before signing (spec §15).
 *
 * Reference block and expiration (D3, D4): the reference is the head block (TaPoS), and the
 * transaction expires `expirationMs` after the earlier of the head's time and the local
 * clock, as tronweb does from the head. A head older than half the window is refused
 * (retryable) instead of producing a transaction that is born nearly expired; a head dated
 * in the future cannot push the expiration beyond the window from now. The ordering records
 * the signed expiration and the reference block's TaPoS bound (`lastValidHeight`: its height,
 * read from its id, plus `TAPOS_WINDOW`), so the negative inclusion proof scans from the
 * attested reference block up to the expiration, whatever the head or the clock claimed
 * (F4-R12). The expiration stays inside java-tron's own window (at least the next slot, at
 * most 24 h past its head).
 *
 * Uniqueness (D5): Tron has no nonce, so two identical transfers built on the same head in
 * the same millisecond would share one txID and one on-chain effect. The core refuses an
 * Attempt whose ref another Operation holds (A15); as defense in depth, each build takes a
 * `timestamp` strictly above the previous one from this driver, plus crypto-random offsets
 * on `timestamp` (up to +999 ms) and `expiration` (up to −999 ms); java-tron never
 * validates `raw_data.timestamp`.
 *
 * Nothing is signed before the built bytes are decoded back and shown to carry exactly the
 * intent: owner, recipient, amount, token contract, canonical `transfer(to, amount)` call
 * data with no value, memo, expiration and fee limit. `assemble` checks the same against the
 * stored summary, ordering and fee limit, so the signature goes out only with the transfer
 * that was authorized.
 *
 * Broadcasts are classified here (`classifyOwnBroadcast`), never under a quorum: a transport
 * failure, an unreadable reply or a node answer that may follow pooling is thrown ambiguous
 * (possibly sent). A node's rejection is a claim (lesson 21): it stands only when its reason
 * holds for the bytes that were sent, read back from them; otherwise it is a refusal. A
 * `TX_EXPIRED` refusal is the node's view at its own head, a hint and not proof: Tron has no
 * nonce, so a second Attempt could land beside the first. The broadcaster never re-sends or
 * rebuilds on it; only an attested expiry (the proofs) lets the core build again.
 */
import { sha256 } from '@noble/hashes/sha256';
import type {
  Broadcaster,
  BuildContext,
  TxBuilder,
  WalletKey,
} from '../../core/driver/types';
import {
  ChainError,
  ConfigError,
  ProviderError,
  SigningError,
  UnsupportedCapabilityError,
  ValidationError,
} from '../../core/errors/error';
import { assetId, parseAssetId } from '../../core/model/asset';
import type { FeeEstimateDraft } from '../../core/model/fee';
import type { DriverIntent, IntentSummary } from '../../core/model/intent';
import type { OrderingData } from '../../core/model/ordering';
import type { UnsignedTx } from '../../core/model/transaction';
import {
  bytesToUtf8,
  concatBytes,
  fromHex,
  randomBytes,
  toHex,
  utf8ToBytes,
} from '../../core/util/bytes';
import { decodeTransferCall, encodeTransfer } from './abi';
import { addressFromPublicKey, toHexAddress } from './address';
import { classifyOwnBroadcast, txBytesOf } from './errors';
import { feeLimitCeiling, feeSun, tronFee } from './fees';
import { BROADCAST, READ, malformed, withSignal, type TronBlockHeader } from './http';
import {
  MAX_EXPIRATION_MS,
  MAX_MEMO_BYTES,
  MIN_EXPIRATION_MS,
  TAPOS_WINDOW,
} from './network';
import { trc20Balance, trc20Contract, type TronContext } from './reader';
import type {
  TronContract,
  TronExpiryOrdering,
  TronFeeDetails,
  TronRawData,
} from './types';

/** The largest `int64` the codec writes from a JS number (lesson 19). */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** A positive base-unit amount in a stored summary: at most a `uint256` (78 digits). */
const SUMMARY_AMOUNT = /^[1-9][0-9]{0,77}$/;
/** Linear on any input (lesson 20): one character class, no repeated group. */
const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/** What the signed bytes must carry; addresses are lower-case `41…` hex. */
interface Transfer {
  readonly owner: string;
  readonly recipient: string;
  readonly amount: bigint;
  /** The TRC-20 contract, absent for TRX. */
  readonly token?: string;
  /** The memo bytes, lower-case hex; absent without a memo. */
  readonly memo?: string;
}

interface Prepared extends Transfer {
  /** The recipient as the intent gives it (the summary's form). */
  readonly to: string;
  readonly contract: TronContract;
}

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_INTENT', message);
}

/** The memo's UTF-8 bytes as hex, or undefined; refused when over `MAX_MEMO_BYTES`. */
function memoHex(memo: string | undefined): string | undefined {
  if (memo === undefined || memo.length === 0) return undefined;
  const tooLong = () => invalid(`a Tron memo is at most ${MAX_MEMO_BYTES} UTF-8 bytes`);
  // Each UTF-16 unit is at least one UTF-8 byte, so a longer string is refused unencoded.
  if (memo.length > MAX_MEMO_BYTES) throw tooLong();
  const bytes = utf8ToBytes(memo);
  if (bytes.length > MAX_MEMO_BYTES) throw tooLong();
  // A lone surrogate would be written as U+FFFD: the chain would carry another memo.
  if (bytesToUtf8(bytes) !== memo) throw invalid('a Tron memo must be well-formed text');
  return toHex(bytes);
}

/**
 * The validated transfer, before any I/O: one output, a positive amount, TRX or TRC-20,
 * valid addresses, a memo within bounds, amounts the encoders can write exactly (lesson 19,
 * D20), and TRX never to the sender (java-tron: "Cannot transfer TRX to yourself.", for the
 * bytes alone). A TRC-20 transfer to the sender is valid on chain and is allowed.
 */
function prepare(intent: DriverIntent): Prepared {
  const output = intent.outputs[0];
  if (!output || intent.outputs.length !== 1) {
    throw invalid('a Tron transfer has exactly one output');
  }
  if (output.amount <= 0n) {
    throw new ValidationError('INVALID_AMOUNT', 'the amount must be positive');
  }
  const token = intent.asset === 'native' ? undefined : trc20Contract(intent.asset);
  const owner = toHexAddress(intent.from);
  const recipient = toHexAddress(output.to);
  const memo = memoHex(intent.memo);
  let contract: TronContract;
  if (token === undefined) {
    if (output.amount > MAX_SAFE) {
      throw new ValidationError(
        'INVALID_AMOUNT',
        'a TRX amount must be at most the largest safe integer of sun',
      );
    }
    if (recipient === owner) throw invalid('a TRX transfer cannot go to its sender');
    contract = { type: 'TransferContract', owner, to: recipient, amount: output.amount };
  } else {
    // encodeTransfer refuses an amount outside uint256 (INVALID_AMOUNT).
    const data = encodeTransfer(recipient, output.amount);
    contract = { type: 'TriggerSmartContract', owner, contract: token, data };
  }
  return {
    to: output.to,
    amount: output.amount,
    owner,
    recipient,
    contract,
    ...(token !== undefined ? { token } : {}),
    ...(memo !== undefined ? { memo } : {}),
  };
}

/**
 * Whether decoded raw data carries exactly `t`. A TRC-20 call must be the canonical
 * `transfer(to, amount)` (selector, zero-padded recipient, one amount word, nothing more)
 * with no TRX or TRC-10 value: the verdict (Task 6) reads only that shape.
 */
function carries(raw: TronRawData, t: Transfer): boolean {
  const c = raw.contract;
  if (c.owner !== t.owner || raw.data !== t.memo) return false;
  if (t.token === undefined) {
    return c.type === 'TransferContract' && c.to === t.recipient && c.amount === t.amount;
  }
  if (c.type !== 'TriggerSmartContract' || c.contract !== t.token) return false;
  if (
    c.callValue !== undefined ||
    c.callTokenValue !== undefined ||
    c.tokenId !== undefined
  ) {
    return false;
  }
  const call = decodeTransferCall(c.data);
  return call !== null && call.to === t.recipient && call.amount === t.amount;
}

/** The transfer a stored summary describes, signed by `owner`; null when it describes none. */
function summaryTransfer(
  ctx: TronContext,
  summary: IntentSummary,
  owner: string,
): Transfer | null {
  try {
    const { chain, network, ref } = parseAssetId(summary.asset);
    const output = summary.outputs[0];
    if (
      chain !== ctx.chain.id ||
      network !== ctx.network.id ||
      !output ||
      summary.outputs.length !== 1 ||
      !SUMMARY_AMOUNT.test(output.amount)
    ) {
      return null;
    }
    const token = ref === 'native' ? undefined : trc20Contract(ref);
    const memo = memoHex(summary.memo);
    return {
      owner,
      recipient: toHexAddress(output.to),
      amount: BigInt(output.amount),
      ...(token !== undefined ? { token } : {}),
      ...(memo !== undefined ? { memo } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The fee fields a build writes, from this transfer's own `tron` estimate: the bandwidth
 * the estimate covers and, for TRC-20 only, a positive fee limit within the handle's
 * `maxFeeLimit` (F4-R28), wherever the estimate came from. The limit is handed to the codec
 * as a number and its `safe()` refuses one it cannot hold exactly (lesson 19): it is never
 * rounded into the bytes.
 */
function feeFields(
  fee: FeeEstimateDraft,
  p: Prepared,
  maxFeeLimit: bigint,
): { readonly bandwidth: bigint; readonly feeLimit?: number } {
  const details = fee.details as Partial<TronFeeDetails>;
  const mismatch = () =>
    invalid('the fee estimate is not a Tron estimate for this transfer');
  if (
    fee.kind !== 'tron' ||
    typeof details.bandwidth !== 'bigint' ||
    details.bandwidth <= 0n
  ) {
    throw mismatch();
  }
  if (p.token === undefined) {
    if (details.feeLimit !== undefined) throw mismatch();
    return { bandwidth: details.bandwidth };
  }
  if (typeof details.feeLimit !== 'bigint' || details.feeLimit <= 0n) throw mismatch();
  if (details.feeLimit > maxFeeLimit) {
    throw invalid(
      'the fee limit is above maxFeeLimit, the Tron handle option that bounds it (in sun)',
    );
  }
  return { bandwidth: details.bandwidth, feeLimit: Number(details.feeLimit) };
}

/** The sender's own key: a signature from any other key would not authorize the owner. */
function signingKey(keys: readonly WalletKey[], owner: string): WalletKey {
  for (const key of keys) {
    if (key.scheme !== 'secp256k1-ecdsa') continue;
    try {
      if (toHexAddress(addressFromPublicKey(key.publicKey)) === owner) return key;
    } catch {
      // Not a secp256k1 point: not this sender's key.
    }
  }
  throw new SigningError(
    'SIGNER_UNAVAILABLE',
    'no secp256k1 key for the sending address',
  );
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Uint8Array.from(out);
}

/** `Transaction { raw raw_data = 1; repeated bytes signature = 2; }` with one signature. */
function signedTransaction(raw: Uint8Array, signature: Uint8Array): Uint8Array {
  return concatBytes(
    Uint8Array.of(0x0a),
    varint(raw.length),
    raw,
    Uint8Array.of(0x12),
    varint(signature.length),
    signature,
  );
}

/**
 * java-tron's bandwidth for a transaction whose `raw_data` is `rawBytes` long
 * (`BandwidthProcessor.consume`): the signed size without `ret` (field 1 with its length and
 * the raw bytes, field 2 with its length and one 65-byte signature) plus 64 result bytes.
 */
export function bandwidthOf(rawBytes: number): bigint {
  return BigInt(1 + varint(rawBytes).length + rawBytes + 2 + 65 + 64);
}

/** A crypto-random integer in [0, 1000). */
function jitter(): number {
  const bytes = randomBytes(2);
  return (((bytes[0] as number) << 8) | (bytes[1] as number)) % 1000;
}

const expiresAt = (ordering: OrderingData): number | undefined =>
  ordering.kind === 'expiry' ? ordering.expiresAtMs : undefined;

/**
 * Whether an ordering names the signed reference block (F4-R12, F4-R14): a reference height
 * (`lastValidHeight − TAPOS_WINDOW`) whose bytes 6..8 are the signed `ref_block_bytes`, and
 * the signed `ref_block_hash` itself. The proofs trust the height only with the hash.
 */
function boundToReference(ordering: OrderingData, raw: TronRawData): boolean {
  if (ordering.kind !== 'expiry') return false;
  const { lastValidHeight: last, refBlockHash } = ordering as Partial<TronExpiryOrdering>;
  if (typeof last !== 'bigint' || last < TAPOS_WINDOW) return false;
  return (
    ((last - TAPOS_WINDOW) & 0xffffn) === BigInt(`0x${raw.refBlockBytes}`) &&
    refBlockHash === raw.refBlockHash
  );
}

export function createTronBuilder(ctx: TronContext): {
  readonly builder: TxBuilder;
  readonly broadcaster: Broadcaster;
} {
  const { api, codec, config } = ctx;
  let lastTimestamp = 0;

  const refFields = (head: TronBlockHeader) => ({
    refBlockBytes: head.id.slice(12, 16),
    refBlockHash: head.id.slice(16, 32),
  });

  async function head(signal?: AbortSignal): Promise<TronBlockHeader> {
    // `block` throws a malformed answer rather than return no head.
    return (await api.block(
      'full',
      undefined,
      withSignal(READ, signal),
    )) as TronBlockHeader;
  }

  /**
   * The simulated energy of a TRC-20 transfer, after the balance check: a shortfall is
   * `INSUFFICIENT_FUNDS`, never a revert; a token that refuses a transfer its balance
   * allows (a blacklist, say) is `INVALID_INTENT`.
   */
  async function tokenEnergy(p: Prepared, signal?: AbortSignal): Promise<bigint> {
    const tags = withSignal(READ, signal);
    const token = p.token as string;
    const available = await trc20Balance(ctx, token, p.owner, tags);
    if (available < p.amount) {
      throw new ChainError(
        'INSUFFICIENT_FUNDS',
        'insufficient token balance for this transfer',
        { details: { required: p.amount.toString(), available: available.toString() } },
      );
    }
    const data = (p.contract as Extract<TronContract, { type: 'TriggerSmartContract' }>)
      .data;
    const call = await api.constantCall(p.owner, token, data, tags);
    if (call.kind === 'no-contract') {
      // Its balanceOf just answered: two reads disagree, which decides nothing.
      throw new ProviderError(
        'PROVIDER_INCONSISTENT',
        'the node both holds and lacks this token contract',
        { retryable: true },
      );
    }
    if (call.kind === 'failed') throw invalid('the token contract refuses this transfer');
    return call.energy;
  }

  const builder: TxBuilder = {
    async estimateFee(intent, build: BuildContext) {
      const p = prepare(intent);
      const tags = withSignal(READ, build.signal);
      const [params, resources, block, recipient, energy] = await Promise.all([
        api.chainParameters(tags),
        api.resources(p.owner, tags),
        head(build.signal),
        p.token === undefined ? api.account(p.recipient, tags) : undefined,
        p.token === undefined ? undefined : tokenEnergy(p, build.signal),
      ]);
      // An upper bound of the built size: no expiration jitter, a later timestamp, and the
      // largest fee limit a build can carry (the ceiling `tronFee` applies, F4-R12 M4).
      const now = ctx.clock.now();
      const ceiling = feeLimitCeiling(params, config.maxFeeLimit).value;
      const provisional = codec.encodeRaw({
        ...refFields(block),
        expiration: Math.min(block.timestamp, now) + config.expirationMs,
        timestamp: Math.max(now + 1_000, lastTimestamp + 1),
        ...(p.token !== undefined ? { feeLimit: Number(ceiling) } : {}),
        ...(p.memo !== undefined ? { data: p.memo } : {}),
        contract: p.contract,
      });
      return tronFee({
        fee: intent.fee,
        params,
        resources,
        bandwidth: bandwidthOf(provisional.length / 2),
        activation: recipient !== undefined && !recipient.exists,
        memo: p.memo !== undefined,
        ...(energy !== undefined ? { energy } : {}),
        marginPercent: config.energyMarginPercent,
        maxFeeLimit: config.maxFeeLimit,
      });
    },

    async checkFunds(intent, fee, build) {
      const p = prepare(intent);
      const tags = withSignal(READ, build.signal);
      const [account, tokens] = await Promise.all([
        api.account(p.owner, tags),
        p.token === undefined ? undefined : trc20Balance(ctx, p.token, p.owner, tags),
      ]);
      if (tokens !== undefined && tokens < p.amount) {
        return { ok: false, asset: intent.asset, required: p.amount, available: tokens };
      }
      const required = feeSun(fee) + (p.token === undefined ? p.amount : 0n);
      // An account that was never activated has no free bandwidth and cannot send.
      return account.exists && account.balance >= required
        ? { ok: true }
        : { ok: false, asset: 'native', required, available: account.balance };
    },

    async build(intent, fee, build): Promise<UnsignedTx> {
      const p = prepare(intent);
      const key = signingKey(build.keys, p.owner);
      const fees = feeFields(fee, p, config.maxFeeLimit);
      const block = await head(build.signal);
      const now = ctx.clock.now();
      if (now - block.timestamp > config.expirationMs / 2) {
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          'the head block is too old to reference; try again',
        );
      }
      // F4-R12: the reference block's height, from its id (java-tron's block id is the
      // height's 8 bytes followed by 24 bytes of the header hash, `generateBlockId`): the
      // same bytes TaPoS reads. A head whose id and number disagree is not a block.
      const reference = BigInt(`0x${block.id.slice(0, 16)}`);
      if (reference !== block.number) throw malformed('head block id');
      const anchor = Math.min(block.timestamp, now);
      const expiration = anchor + config.expirationMs - jitter();
      // D3: the window stays within MAX_EXPIRATION_MS, and java-tron wants at least the next
      // slot. The network config bounds the window; this holds it.
      if (expiration - anchor > MAX_EXPIRATION_MS) {
        throw new ConfigError(
          'CONFIG_INVALID',
          'the expiration window exceeds the maximum',
        );
      }
      if (expiration - anchor < MIN_EXPIRATION_MS - 1_000) {
        throw new ConfigError(
          'CONFIG_INVALID',
          'the expiration window is below the minimum',
        );
      }
      const timestamp = Math.max(now + jitter(), lastTimestamp + 1);
      lastTimestamp = timestamp;
      const raw: TronRawData = {
        ...refFields(block),
        expiration,
        timestamp,
        ...(fees.feeLimit !== undefined ? { feeLimit: fees.feeLimit } : {}),
        ...(p.memo !== undefined ? { data: p.memo } : {}),
        contract: p.contract,
      };
      const payload = codec.encodeRaw(raw);
      // Before anything is signed: the bytes decode strictly to exactly this transfer.
      let built: TronRawData | undefined;
      try {
        built = codec.decodeRaw(payload);
      } catch {
        built = undefined;
      }
      if (
        !built ||
        !carries(built, p) ||
        built.expiration !== expiration ||
        built.feeLimit !== raw.feeLimit
      ) {
        throw invalid('the built transaction does not carry this transfer');
      }
      if (bandwidthOf(payload.length / 2) > fees.bandwidth) {
        throw invalid("the fee estimate does not cover this transaction's bandwidth");
      }
      const txId = toHex(sha256(fromHex(payload)));
      // The negative proof scans from the reference block to the signed expiration; the
      // height is the head's claim, so the signed hash bytes go with it (F4-R14).
      const ordering: TronExpiryOrdering = {
        kind: 'expiry',
        expiresAtMs: expiration,
        lastValidHeight: reference + TAPOS_WINDOW,
        refBlockHash: raw.refBlockHash,
      };
      return {
        payload: { encoding: 'hex', data: payload },
        expectedRef: { id: txId, idKind: 'tx-hash', canonical: true },
        signingRequests: [
          {
            id: 'r0',
            scheme: 'secp256k1-ecdsa',
            payload: fromHex(txId),
            payloadKind: 'digest',
            publicKey: key.publicKey,
            ...(key.keyRef ? { keyRef: key.keyRef } : {}),
          },
        ],
        ordering,
        fee,
        summary: {
          asset: assetId(ctx.chain.id, ctx.network.id, intent.asset),
          outputs: [{ to: p.to, amount: p.amount.toString() }],
          ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
        },
      };
    },

    async assemble(unsigned, signatures) {
      const fail = (message: string) => new SigningError('SIGNING_FAILED', message);
      const request = unsigned.signingRequests[0];
      const signature = signatures.find((s) => s.requestId === 'r0');
      if (
        !request ||
        request.id !== 'r0' ||
        unsigned.signingRequests.length !== 1 ||
        !signature ||
        signature.bytes.length !== 64 ||
        (signature.recovery !== 0 && signature.recovery !== 1)
      ) {
        throw fail('missing or malformed signature for request r0');
      }
      const mismatch = () => fail('the unsigned payload does not match its txID');
      if (unsigned.payload.encoding !== 'hex') throw mismatch();
      let raw: Uint8Array;
      try {
        raw = fromHex(unsigned.payload.data);
      } catch {
        throw mismatch();
      }
      const txId = toHex(sha256(raw));
      if (txId !== toHex(request.payload) || txId !== unsigned.expectedRef?.id) {
        throw mismatch();
      }
      // Lesson 4: the stored bytes decode strictly, and their owner is the signing key's
      // account, so a signature never authorizes another account's transaction.
      let decoded: TronRawData;
      try {
        decoded = codec.decodeRaw(unsigned.payload.data);
      } catch {
        throw fail('the unsigned payload is not a Tron transfer');
      }
      let signer: string;
      try {
        signer = toHexAddress(addressFromPublicKey(request.publicKey));
      } catch {
        throw fail('the signing request has no valid public key');
      }
      if (decoded.contract.owner !== signer) {
        throw fail("the payload's owner is not the signing key's account");
      }
      // The bytes carry the authorized summary; the proofs read the expiration and the
      // reference height from the ordering; only the named fee field is read (the core may
      // add others).
      const expected = summaryTransfer(ctx, unsigned.summary, signer);
      const feeLimit = (unsigned.fee.details as Partial<TronFeeDetails>).feeLimit;
      if (
        !expected ||
        !carries(decoded, expected) ||
        expiresAt(unsigned.ordering) !== decoded.expiration ||
        !boundToReference(unsigned.ordering, decoded) ||
        unsigned.fee.kind !== 'tron' ||
        (expected.token === undefined
          ? decoded.feeLimit !== undefined
          : typeof feeLimit !== 'bigint' ||
            decoded.feeLimit === undefined ||
            BigInt(decoded.feeLimit) !== feeLimit)
      ) {
        throw fail(
          'the unsigned payload does not match its summary, expiry or fee limit',
        );
      }
      const sig = concatBytes(signature.bytes, Uint8Array.of(27 + signature.recovery));
      return {
        raw: { encoding: 'hex', data: toHex(signedTransaction(raw, sig)) },
        ref: { id: txId, idKind: 'tx-hash', canonical: true },
      };
    },
  };

  const broadcaster: Broadcaster = {
    async broadcast(signed, options = {}) {
      const { raw } = signed;
      if (
        raw.encoding !== 'hex' ||
        typeof raw.data !== 'string' ||
        raw.data.length % 2 !== 0 ||
        !HEX_DIGITS.test(raw.data)
      ) {
        throw new UnsupportedCapabilityError(
          'UNSUPPORTED_CAPABILITY',
          'Tron broadcasts take the signed transaction as hex',
        );
      }
      // The broadcast tags carry no quorum: one node's answer is classified, never compared.
      const hex = raw.data.toLowerCase();
      const answer = await api.broadcastHex(hex, {
        ...BROADCAST,
        ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // Inside the broadcaster, so a possibly-sent throw reaches the engine's recordAmbiguous.
      // Lesson 21: a rejection stands only when its reason holds for these bytes.
      return classifyOwnBroadcast(answer, txBytesOf(hex));
    },
  };

  return { builder, broadcaster };
}
