/**
 * A scripted Esplora node for the UTXO family (test-only, ruling A7): an in-memory Bitcoin
 * chain behind Esplora's REST API. It exists to test safety invariants, so it is never more
 * lenient than a real node: it applies bitcoind's rules in bitcoind's order and answers with
 * bitcoind's texts and codes (Bitcoin Core 30 by default; Plan 3 appendix):
 * - `sendrawtransaction`: strict hex decoding (-22), `maxburnamount` (-25), outputs already
 *   in the UTXO set (-27), already in the mempool (re-announced), then AcceptToMemoryPool;
 * - AcceptToMemoryPool (`PreChecks`): `CheckTransaction`, coinbase, `IsStandardTx`, finality,
 *   conflicts (BIP125 signalling without full RBF), missing or spent inputs (-25), BIP68,
 *   `CheckTxInputs` (coinbase maturity, values), standard inputs and witnesses, ephemeral
 *   dust, the relay and mempool minimum fees, the ancestor and descendant limits (with the
 *   CPFP carve-out) and spends of a conflict; then the replacement rules of Bitcoin Core
 *   28-30 in their order (6, 5, 2, 3 and 4); then every input's script, policy flags first
 *   and consensus flags to tell `mempool-` from `block-script-verify-flag-failed`; then
 *   `maxfeerate` (-25). Every other refusal is -26.
 * - Scripts are interpreted for the standard templates (p2pkh, p2sh-p2wpkh, p2wpkh, p2wsh,
 *   p2tr key path, bare `OP_TRUE`), with bitcoinjs' signature hashes and `@noble/curves`.
 *   An opcode or spend path outside them throws: this node never guesses.
 * - Blocks: a test mines them (`mine`, whose `extra` transactions are held to consensus
 *   rules only, as a miner's block is), disconnects them (`reorg`, which re-adds their
 *   transactions with the fee limits bypassed, as bitcoind does) and evicts from the mempool.
 * - Esplora: the routes and answer shapes of electrs, per endpoint. An endpoint may lag
 *   (I1: it hides blocks above its view but still holds in its mempool what it saw relayed)
 *   and its index may trail its node's mempool (`mempoolDelayMs`). electrs keeps the
 *   transactions and txids of a disconnected block (its txstore is append-only).
 *
 * Every change is applied to a copy of the state and committed only when it succeeds, so a
 * refused transaction or an invalid block leaves no trace. Blocks and transactions are
 * immutable once recorded; `transaction()` hands out a decoded copy. Deterministic: block
 * times come from the `FakeClock`; no real timer, `Math.random` or `Date.now`.
 *
 * It decodes and verifies with bitcoinjs-lib and `@noble/curves`, independently of the
 * driver's address and fee code, so it is not shipped in `crypto-aio/testing`.
 */
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  bitcoin,
  useNobleEcc,
  type Network,
  type Transaction,
} from '../../../../src/adapters/utxo/sdk';
import { concatBytes, equalBytes, fromHex, toHex } from '../../../../src/core/util/bytes';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../../src/testing/fake-fetch';

const COIN = 100_000_000n;
const MAX_MONEY = 21_000_000n * COIN;
const ZERO_TXID = '0'.repeat(64);
/** electrs' page size for block transactions and address history. */
const PAGE = 25;
const MAX_BLOCK_WEIGHT = 4_000_000;
const MAX_STANDARD_TX_WEIGHT = 400_000;
const MIN_STANDARD_TX_NONWITNESS_SIZE = 65;
const MAX_STANDARD_SCRIPTSIG_SIZE = 1_650;
const MAX_SCRIPT_SIZE = 10_000;
const MAX_SCRIPT_ELEMENT_SIZE = 520;
const MAX_STANDARD_P2WSH_SCRIPT_SIZE = 3_600;
const MAX_STANDARD_P2WSH_STACK_ITEMS = 100;
const MAX_STANDARD_P2WSH_STACK_ITEM_SIZE = 80;
const COINBASE_MATURITY = 100;
const MAX_REPLACEMENT_CANDIDATES = 100;
/** Bitcoin Core 29+ (ephemeral dust): one dust output is standard, in a 0-fee transaction. */
const MAX_DUST_OUTPUTS_PER_TX = 1;
const LIMITS = {
  ancestorCount: 25,
  ancestorSize: 101_000,
  descendantCount: 25,
  descendantSize: 101_000,
};
const EXTRA_DESCENDANT_TX_SIZE_LIMIT = 10_000;
/** `sendrawtransaction`'s default `maxfeerate`: 0.10 BTC/kvB. */
const MAX_RAW_TX_FEE_RATE = 10_000_000n;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 0x80000000;
const SEQUENCE_LOCKTIME_TYPE_FLAG = 0x00400000;
const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;
const LOCKTIME_THRESHOLD = 500_000_000;
const OP_TRUE = Uint8Array.of(0x51);
/** Block rewards pay an anyone-can-spend p2wsh (witness script `OP_TRUE`). */
const MINER_SCRIPT = Uint8Array.of(0x00, 0x20, ...sha256(OP_TRUE));
const TRUE = Uint8Array.of(1);
const FALSE = new Uint8Array(0);

/** bitcoind's `ScriptErrorString` texts. */
const ERR = {
  EVAL_FALSE:
    'Script evaluated without error but finished with a false/empty top stack element',
  OP_RETURN: 'OP_RETURN was encountered',
  SCRIPT_SIZE: 'Script is too large',
  PUSH_SIZE: 'Push value size limit exceeded',
  BAD_OPCODE: 'Opcode missing or not understood',
  INVALID_STACK_OPERATION: 'Operation not valid with the current stack size',
  EQUALVERIFY: 'Script failed an OP_EQUALVERIFY operation',
  SIG_HASHTYPE: 'Signature hash type missing or not understood',
  SIG_DER: 'Non-canonical DER signature',
  MINIMALDATA: 'Data push larger than necessary',
  SIG_PUSHONLY: 'Only push operators allowed in signatures',
  SIG_HIGH_S: 'Non-canonical signature: S value is unnecessarily high',
  PUBKEYTYPE: 'Public key is neither compressed or uncompressed',
  CLEANSTACK: 'Stack size must be exactly one after execution',
  SIG_NULLFAIL: 'Signature must be zero for failed CHECK(MULTI)SIG operation',
  DISCOURAGE_UPGRADABLE_NOPS: 'NOPx reserved for soft-fork upgrades',
  DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM:
    'Witness version reserved for soft-fork upgrades',
  WITNESS_PROGRAM_WRONG_LENGTH: 'Witness program has incorrect length',
  WITNESS_PROGRAM_WITNESS_EMPTY: 'Witness program was passed an empty witness',
  WITNESS_PROGRAM_MISMATCH: 'Witness program hash mismatch',
  WITNESS_MALLEATED: 'Witness requires empty scriptSig',
  WITNESS_MALLEATED_P2SH: 'Witness requires only-redeemscript scriptSig',
  WITNESS_UNEXPECTED: 'Witness provided for non-witness script',
  WITNESS_PUBKEYTYPE: 'Using non-compressed keys in segwit',
  SCHNORR_SIG_SIZE: 'Invalid Schnorr signature size',
  SCHNORR_SIG_HASHTYPE: 'Invalid Schnorr signature hash type',
  SCHNORR_SIG: 'Invalid Schnorr signature',
} as const;

export type ErrorFormat = 'blockstream' | 'mempool';

export interface ScriptedEsploraNodeOptions {
  readonly clock: FakeClock;
  readonly network?: Network;
  readonly genesisHash?: string;
  /** sat/kvB; Bitcoin Core v30 defaults. */
  readonly minRelayFee?: bigint;
  readonly incrementalRelayFee?: bigint;
  readonly dustRelayFee?: bigint;
  /** `false`: pre-v28 opt-in RBF (a conflict must signal BIP125). */
  readonly fullRbf?: boolean;
  /** Reject-reason texts of Bitcoin Core before v30 (`mandatory-script-verify-flag-failed`). */
  readonly legacyScriptErrors?: boolean;
  readonly errorFormat?: ErrorFormat;
}

export interface EndpointOptions {
  /** Blocks this endpoint has not indexed yet (I1). */
  readonly lag?: number;
  /** How long a new mempool transaction takes to reach this endpoint's index. */
  readonly mempoolDelayMs?: number;
  /**
   * electrs' `--lightmode`: transactions are read from bitcoind by their confirming block,
   * so one of a disconnected block that is not in the mempool is a 404. Off by default: the
   * public Esplora hosts run full mode, whose append-only txstore still serves it (unconfirmed).
   */
  readonly lightMode?: boolean;
}

/**
 * Answers an endpoint's request instead of the node while it returns a reply (a 429, a 5xx,
 * a lie, or `hang(signal)` for a timeout). `honest()` is what the node itself answers; for a
 * `POST /tx` it submits the transaction, so a proxy error after acceptance is scriptable.
 */
export type EsploraIntercept = (
  request: FakeRequest,
  signal: AbortSignal | undefined,
  honest: () => FakeReply,
) => FakeReply | undefined | Promise<FakeReply | undefined>;

/** A refusal of `sendrawtransaction`: bitcoind's RPC code and reject text. */
export class NodeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'NodeError';
  }
}

interface Output {
  readonly script: Uint8Array;
  readonly value: bigint;
}

interface Input {
  readonly txid: string;
  readonly vout: number;
  readonly sequence: number;
  readonly script: Uint8Array;
  readonly witness: readonly Uint8Array[];
}

/** A decoded transaction. Never handed out: `transaction()` decodes a copy. */
interface Parsed {
  readonly txid: string;
  readonly hex: string;
  readonly version: number;
  readonly locktime: number;
  readonly ins: readonly Input[];
  readonly outs: readonly Output[];
  readonly weight: number;
  /** Weight / 4, rounded up (sigops are not counted: never binding for these scripts). */
  readonly vsize: number;
  readonly size: number;
  readonly baseSize: number;
}

/**
 * `coinbase`: a block reward. `funding`: a test's payment from outside (`fund`), shaped like
 * a coinbase (a null prevout, so Esplora shows it as one) but spendable at once.
 */
type Kind = 'coinbase' | 'funding' | 'tx';

interface Entry extends Parsed {
  readonly kind: Kind;
  /** The outputs a `tx` spends, in input order (none for the other kinds). */
  readonly prevouts: readonly Output[];
  readonly fee: bigint;
}

interface Block {
  readonly hash: string;
  readonly height: number;
  readonly parentHash: string;
  readonly timestamp: number;
  readonly mediantime: number;
  /** The coinbase first. */
  readonly entries: readonly Entry[];
  /** Transactions that were in the mempool before this block (a lagging index holds them). */
  readonly relayed: ReadonlySet<string>;
  /** Mempool transactions this block's own transactions conflicted out. */
  readonly evicted: readonly Entry[];
}

interface Pooled {
  readonly entry: Entry;
  /** Clock time of acceptance. */
  readonly time: number;
}

interface State {
  readonly chain: Block[];
  /** Transactions of the active chain: txid → height. */
  readonly confirmed: Map<string, number>;
  readonly mempool: Map<string, Pooled>;
  /** outpoint → spending txid (the active chain and the mempool). */
  readonly spentBy: Map<string, string>;
  /** Every transaction that was ever in a block (electrs' txstore), by txid. */
  readonly archive: Map<string, Entry>;
  /** Disconnected blocks, by hash. */
  readonly stale: Map<string, Block>;
}

interface Coin {
  readonly output: Output;
  /** Its block height, or the next block's for a mempool output (BIP68, maturity). */
  readonly height: number;
  readonly kind: Kind;
  readonly mempool: boolean;
}

/** What one endpoint shows: blocks up to `height` and the mempool it holds. */
interface View {
  readonly height: number;
  readonly lightMode: boolean;
  readonly pooled: ReadonlyMap<string, Entry>;
  readonly spentBy: ReadonlyMap<string, string>;
}

interface Checker {
  readonly tx: Transaction;
  readonly index: number;
  readonly prevScripts: Uint8Array[];
  readonly prevValues: bigint[];
  /** Bitcoin Core's standard flags; `false`: the consensus (mandatory) flags only. */
  readonly policy: boolean;
}

type SigVersion = 'base' | 'v0';

class ScriptFailure extends Error {}
const fail = (reason: string): never => {
  throw new ScriptFailure(reason);
};
const rejected = (reason: string) => new NodeError(-26, reason);
const invalidBlock = (reason: string) => new Error(`invalid block: ${reason}`);

const cloneState = (state: State): State => ({
  chain: [...state.chain],
  confirmed: new Map(state.confirmed),
  mempool: new Map(state.mempool),
  spentBy: new Map(state.spentBy),
  archive: new Map(state.archive),
  stale: new Map(state.stale),
});

const outpointOf = (txid: string, vout: number): string => `${txid}:${vout}`;
const reversedHex = (hash: Uint8Array): string => toHex(Uint8Array.from(hash).reverse());
const isNull = (input: Input): boolean =>
  input.txid === ZERO_TXID && input.vout === 0xffffffff;
const isCoinbaseTx = (tx: Parsed): boolean => tx.ins.length === 1 && isNull(tx.ins[0]!);
const moneyRange = (value: bigint): boolean => value >= 0n && value <= MAX_MONEY;
const sum = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);
const compactSizeLength = (n: number): number =>
  n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9;
const bigOf = (bytes: Uint8Array): bigint =>
  bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`);
const bytes32 = (n: bigint): Uint8Array => fromHex(n.toString(16).padStart(64, '0'));

/** `CFeeRate::GetFee`: a sat/kvB rate over `vsize`, rounded up. */
const feeAt = (rate: bigint, vsize: number): bigint =>
  rate <= 0n ? 0n : (rate * BigInt(vsize) + 999n) / 1000n;

/** bitcoind's `FormatMoney`: BTC, trailing zeros trimmed to two decimals. */
function formatMoney(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  let text = `${abs / COIN}.${(abs % COIN).toString().padStart(8, '0')}`;
  while (text.endsWith('0') && /\d/.test(text[text.length - 3] ?? '')) {
    text = text.slice(0, -1);
  }
  return negative ? `-${text}` : text;
}

/** `CFeeRate(fee, vsize).ToString()`: sat/kvB truncated, printed as BTC/kvB. */
function formatRate(perK: bigint): string {
  return `${perK / COIN}.${(perK % COIN).toString().padStart(8, '0')} BTC/kvB`;
}

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
/** `GetMedianTimePast` of the block at `height`: the median of it and its 10 ancestors. */
const mtpAt = (chain: readonly Block[], height: number): number =>
  median(chain.slice(Math.max(0, height - 10), height + 1).map((b) => b.timestamp));

// ---- scripts -------------------------------------------------------------------------------

interface Op {
  readonly code: number;
  readonly data?: Uint8Array;
}

/** `GetOp` over a whole script; `undefined` when a push runs past its end. */
function parseScript(script: Uint8Array): Op[] | undefined {
  const ops: Op[] = [];
  let i = 0;
  while (i < script.length) {
    const code = script[i++]!;
    let size = -1;
    if (code <= 0x4b) size = code;
    else if (code === 0x4c || code === 0x4d || code === 0x4e) {
      const width = code === 0x4c ? 1 : code === 0x4d ? 2 : 4;
      if (i + width > script.length) return undefined;
      size = 0;
      for (let k = width - 1; k >= 0; k--) size = size * 256 + script[i + k]!;
      i += width;
    }
    if (size < 0) {
      ops.push({ code });
      continue;
    }
    if (i + size > script.length) return undefined;
    ops.push({ code, data: script.subarray(i, i + size) });
    i += size;
  }
  return ops;
}

/** `IsPushOnly`: every opcode is a push or `OP_1NEGATE`..`OP_16`. */
function isPushOnly(script: Uint8Array): boolean {
  const ops = parseScript(script);
  return ops !== undefined && ops.every((op) => op.code <= 0x60);
}

/** `HasValidOps`. */
function hasValidOps(script: Uint8Array): boolean {
  const ops = parseScript(script);
  return (
    ops !== undefined &&
    ops.every(
      (op) => op.code <= 0xb9 && (op.data?.length ?? 0) <= MAX_SCRIPT_ELEMENT_SIZE,
    )
  );
}

/** `CheckMinimalPush`. */
function minimalPush(op: Op): boolean {
  const data = op.data as Uint8Array;
  if (data.length === 0) return op.code === 0x00;
  if (data.length === 1 && data[0]! >= 1 && data[0]! <= 16) return false;
  if (data.length === 1 && data[0] === 0x81) return false;
  if (data.length <= 75) return op.code === data.length;
  if (data.length <= 255) return op.code === 0x4c;
  if (data.length <= 65_535) return op.code === 0x4d;
  return true;
}

/** `CScript() << data`. */
function pushData(data: Uint8Array): Uint8Array {
  if (data.length < 0x4c) return concatBytes(Uint8Array.of(data.length), data);
  if (data.length <= 0xff) return concatBytes(Uint8Array.of(0x4c, data.length), data);
  return concatBytes(Uint8Array.of(0x4d, data.length & 0xff, data.length >> 8), data);
}

/** `CScript() << n` (BIP34 heights). */
function pushNumber(n: number): Uint8Array {
  if (n === 0) return Uint8Array.of(0x00);
  if (n >= 1 && n <= 16) return Uint8Array.of(0x50 + n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.push(v % 256);
  if (bytes[bytes.length - 1]! & 0x80) bytes.push(0);
  return pushData(Uint8Array.from(bytes));
}

/** A push-only script's stack (`EvalScript` with no flags), or `undefined` on failure. */
function pushStack(script: Uint8Array): Uint8Array[] | undefined {
  const ops = parseScript(script);
  if (!ops) return undefined;
  const stack: Uint8Array[] = [];
  for (const op of ops) {
    if (op.data !== undefined) {
      if (op.data.length > MAX_SCRIPT_ELEMENT_SIZE) return undefined;
      stack.push(op.data);
    } else if (op.code === 0x4f) stack.push(Uint8Array.of(0x81));
    else if (op.code >= 0x51 && op.code <= 0x60)
      stack.push(Uint8Array.of(op.code - 0x50));
    else return undefined;
  }
  return stack;
}

function witnessProgram(
  script: Uint8Array,
): { readonly version: number; readonly program: Uint8Array } | undefined {
  if (script.length < 4 || script.length > 42) return undefined;
  const op = script[0]!;
  if (op !== 0x00 && (op < 0x51 || op > 0x60)) return undefined;
  if (script[1]! + 2 !== script.length) return undefined;
  return { version: op === 0 ? 0 : op - 0x50, program: script.subarray(2) };
}

const isP2sh = (s: Uint8Array): boolean =>
  s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87;
const isP2pkh = (s: Uint8Array): boolean =>
  s.length === 25 &&
  s[0] === 0x76 &&
  s[1] === 0xa9 &&
  s[2] === 0x14 &&
  s[23] === 0x88 &&
  s[24] === 0xac;
const isPayToAnchor = (s: Uint8Array): boolean =>
  s.length === 4 && s[0] === 0x51 && s[1] === 0x02 && s[2] === 0x4e && s[3] === 0x73;
/** `CScript::IsUnspendable`: never enters the UTXO set. */
const isUnspendable = (s: Uint8Array): boolean =>
  (s.length > 0 && s[0] === 0x6a) || s.length > MAX_SCRIPT_SIZE;

type ScriptType =
  | 'p2pkh'
  | 'p2sh'
  | 'p2wpkh'
  | 'p2wsh'
  | 'p2tr'
  | 'anchor'
  | 'witness_unknown'
  | 'nulldata'
  | 'pubkey'
  | 'nonstandard';

/** bitcoind's `Solver`, without bare multisig (treated as non-standard: stricter). */
function solve(s: Uint8Array): ScriptType {
  if (isP2sh(s)) return 'p2sh';
  const wp = witnessProgram(s);
  if (wp) {
    if (wp.version === 0 && wp.program.length === 20) return 'p2wpkh';
    if (wp.version === 0 && wp.program.length === 32) return 'p2wsh';
    if (wp.version === 1 && wp.program.length === 32) return 'p2tr';
    if (isPayToAnchor(s)) return 'anchor';
    return wp.version === 0 ? 'nonstandard' : 'witness_unknown';
  }
  if (s.length >= 1 && s[0] === 0x6a && isPushOnly(s.subarray(1))) return 'nulldata';
  if (
    s[s.length - 1] === 0xac &&
    ((s.length === 35 && s[0] === 33 && (s[1] === 2 || s[1] === 3)) ||
      (s.length === 67 && s[0] === 65 && s[1] === 4))
  )
    return 'pubkey';
  if (isP2pkh(s)) return 'p2pkh';
  return 'nonstandard';
}

function castToBool(value: Uint8Array): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== 0) return !(i === value.length - 1 && value[i] === 0x80);
  }
  return false;
}

/** BIP66 `IsValidSignatureEncoding` (DER plus the sighash byte). */
function isValidSignatureEncoding(sig: Uint8Array): boolean {
  if (sig.length < 9 || sig.length > 73) return false;
  if (sig[0] !== 0x30 || sig[1] !== sig.length - 3) return false;
  const lenR = sig[3]!;
  if (5 + lenR >= sig.length) return false;
  const lenS = sig[5 + lenR]!;
  if (lenR + lenS + 7 !== sig.length) return false;
  if (sig[2] !== 0x02 || lenR === 0 || sig[4]! & 0x80) return false;
  if (lenR > 1 && sig[4] === 0x00 && !(sig[5]! & 0x80)) return false;
  if (sig[lenR + 4] !== 0x02 || lenS === 0 || sig[lenR + 6]! & 0x80) return false;
  if (lenS > 1 && sig[lenR + 6] === 0x00 && !(sig[lenR + 7]! & 0x80)) return false;
  return true;
}

/** `r` and `s` of a signature that passed `isValidSignatureEncoding`. */
function derValues(sig: Uint8Array): { r: bigint; s: bigint } {
  const lenR = sig[3]!;
  const lenS = sig[5 + lenR]!;
  return {
    r: bigOf(sig.subarray(4, 4 + lenR)),
    s: bigOf(sig.subarray(6 + lenR, 6 + lenR + lenS)),
  };
}

/** A public key as libsecp256k1 parses it (hybrid keys included), or `undefined`. */
function parsePubkey(key: Uint8Array): Uint8Array | undefined {
  const header = key[0];
  if ((header === 2 || header === 3) && key.length === 33) return key;
  if (header === 4 && key.length === 65) return key;
  if ((header === 6 || header === 7) && key.length === 65) {
    if ((key[64]! & 1) !== (header & 1)) return undefined;
    return concatBytes(Uint8Array.of(4), key.subarray(1));
  }
  return undefined;
}

/** `EvalChecksigPreTapscript` and `CheckECDSASignature`. */
function checksig(
  sig: Uint8Array,
  pubkey: Uint8Array,
  scriptCode: Uint8Array,
  sigversion: SigVersion,
  checker: Checker,
): boolean {
  const n = secp256k1.CURVE.n;
  if (sig.length > 0) {
    // DERSIG is a consensus rule (BIP66); LOW_S and STRICTENC are policy.
    if (!isValidSignatureEncoding(sig)) fail(ERR.SIG_DER);
    if (checker.policy) {
      const { r, s } = derValues(sig);
      if (r < n && s < n && s > n >> 1n) fail(ERR.SIG_HIGH_S);
      const type = sig[sig.length - 1]! & ~0x80;
      if (type < 1 || type > 3) fail(ERR.SIG_HASHTYPE);
    }
  }
  if (checker.policy) {
    const header = pubkey[0];
    const known =
      (pubkey.length === 33 && (header === 2 || header === 3)) ||
      (pubkey.length === 65 && header === 4);
    if (!known) fail(ERR.PUBKEYTYPE);
    if (sigversion === 'v0' && pubkey.length !== 33) fail(ERR.WITNESS_PUBKEYTYPE);
  }
  let ok = false;
  const key = parsePubkey(pubkey);
  if (key && sig.length > 0) {
    const hashType = sig[sig.length - 1]!;
    const { r, s } = derValues(sig);
    if (r > 0n && s > 0n && r < n && s < n) {
      const digest =
        sigversion === 'base'
          ? checker.tx.hashForSignature(checker.index, scriptCode, hashType)
          : checker.tx.hashForWitnessV0(
              checker.index,
              scriptCode,
              checker.prevValues[checker.index]!,
              hashType,
            );
      const low = s > n >> 1n ? n - s : s;
      ok = secp256k1.verify(concatBytes(bytes32(r), bytes32(low)), digest, key, {
        prehash: false,
        lowS: true,
        format: 'compact',
      });
    }
  }
  if (!ok && checker.policy && sig.length > 0) fail(ERR.SIG_NULLFAIL);
  return ok;
}

/** `EvalScript` for the opcodes of the standard templates; anything else throws. */
function evalScript(
  stack: Uint8Array[],
  script: Uint8Array,
  sigversion: SigVersion,
  checker: Checker,
): void {
  if (script.length > MAX_SCRIPT_SIZE) fail(ERR.SCRIPT_SIZE);
  const ops = parseScript(script) ?? fail(ERR.BAD_OPCODE);
  const need = (count: number) => {
    if (stack.length < count) fail(ERR.INVALID_STACK_OPERATION);
  };
  for (const op of ops) {
    if (op.data !== undefined) {
      if (op.data.length > MAX_SCRIPT_ELEMENT_SIZE) fail(ERR.PUSH_SIZE);
      if (checker.policy && !minimalPush(op)) fail(ERR.MINIMALDATA);
      stack.push(op.data);
      continue;
    }
    const code = op.code;
    if (code === 0x4f) stack.push(Uint8Array.of(0x81));
    else if (code >= 0x51 && code <= 0x60) stack.push(Uint8Array.of(code - 0x50));
    else if (code === 0x61)
      continue; // OP_NOP
    else if (code === 0xb0 || (code >= 0xb3 && code <= 0xb9)) {
      if (checker.policy) fail(ERR.DISCOURAGE_UPGRADABLE_NOPS);
    } else if (code === 0x50) fail(ERR.BAD_OPCODE);
    else if (code === 0x6a) fail(ERR.OP_RETURN);
    else if (code === 0x76) {
      need(1);
      stack.push(stack[stack.length - 1]!);
    } else if (code === 0xa9) {
      need(1);
      stack.push(bitcoin.crypto.hash160(stack.pop()!));
    } else if (code === 0x87 || code === 0x88) {
      need(2);
      const equal = equalBytes(stack.pop()!, stack.pop()!);
      if (code === 0x88) {
        if (!equal) fail(ERR.EQUALVERIFY);
      } else stack.push(equal ? TRUE : FALSE);
    } else if (code === 0xac) {
      need(2);
      const pubkey = stack.pop()!;
      const sig = stack.pop()!;
      stack.push(checksig(sig, pubkey, script, sigversion, checker) ? TRUE : FALSE);
    } else {
      throw new Error(
        `the scripted node does not model opcode 0x${code.toString(16)}: extend it or use a standard script`,
      );
    }
  }
}

/** `ExecuteWitnessScript`: a witness script leaves exactly one true element. */
function executeWitnessScript(
  stack: Uint8Array[],
  script: Uint8Array,
  checker: Checker,
): void {
  if (stack.some((item) => item.length > MAX_SCRIPT_ELEMENT_SIZE)) fail(ERR.PUSH_SIZE);
  evalScript(stack, script, 'v0', checker);
  if (stack.length !== 1) fail(ERR.CLEANSTACK);
  if (!castToBool(stack[0]!)) fail(ERR.EVAL_FALSE);
}

/** BIP341 key-path spending: `CheckSchnorrSignature`. */
function checkTaprootKey(
  sig: Uint8Array,
  program: Uint8Array,
  checker: Checker,
  annex: Uint8Array | undefined,
): void {
  if (sig.length !== 64 && sig.length !== 65) fail(ERR.SCHNORR_SIG_SIZE);
  const hashType = sig.length === 65 ? sig[64]! : 0x00;
  if (sig.length === 65 && hashType === 0x00) fail(ERR.SCHNORR_SIG_HASHTYPE);
  const defined = hashType <= 0x03 || (hashType >= 0x81 && hashType <= 0x83);
  const single = (hashType & 0x03) === 0x03;
  if (!defined || (single && checker.index >= checker.tx.outs.length)) {
    fail(ERR.SCHNORR_SIG_HASHTYPE);
  }
  const digest = checker.tx.hashForWitnessV1(
    checker.index,
    checker.prevScripts,
    checker.prevValues,
    hashType,
    undefined,
    annex,
  );
  if (!schnorr.verify(sig.subarray(0, 64), digest, program)) fail(ERR.SCHNORR_SIG);
}

/** `VerifyWitnessProgram`. */
function verifyWitnessProgram(
  witness: readonly Uint8Array[],
  version: number,
  program: Uint8Array,
  checker: Checker,
  p2sh: boolean,
): void {
  if (version === 0) {
    if (program.length === 32) {
      if (witness.length === 0) fail(ERR.WITNESS_PROGRAM_WITNESS_EMPTY);
      const script = witness[witness.length - 1]!;
      if (!equalBytes(sha256(script), program)) fail(ERR.WITNESS_PROGRAM_MISMATCH);
      return executeWitnessScript(witness.slice(0, -1), script, checker);
    }
    if (program.length === 20) {
      if (witness.length !== 2) fail(ERR.WITNESS_PROGRAM_MISMATCH);
      const script = concatBytes(
        Uint8Array.of(0x76, 0xa9, 0x14),
        program,
        Uint8Array.of(0x88, 0xac),
      );
      return executeWitnessScript([...witness], script, checker);
    }
    return fail(ERR.WITNESS_PROGRAM_WRONG_LENGTH);
  }
  if (version === 1 && program.length === 32 && !p2sh) {
    if (witness.length === 0) fail(ERR.WITNESS_PROGRAM_WITNESS_EMPTY);
    const stack = [...witness];
    const last = stack[stack.length - 1]!;
    const annex = stack.length >= 2 && last[0] === 0x50 ? stack.pop() : undefined;
    if (stack.length === 1) return checkTaprootKey(stack[0]!, program, checker, annex);
    throw new Error('the scripted node does not model taproot script-path spending');
  }
  const anchor = version === 1 && program.length === 2 && program[0] === 0x4e;
  if (!p2sh && anchor && program[1] === 0x73) return; // pay-to-anchor
  if (checker.policy) fail(ERR.DISCOURAGE_UPGRADABLE_WITNESS_PROGRAM);
}

/** `VerifyScript` (P2SH, WITNESS and TAPROOT always on; CLEANSTACK with the policy flags). */
function verifyScript(
  scriptSig: Uint8Array,
  scriptPubKey: Uint8Array,
  witness: readonly Uint8Array[],
  checker: Checker,
): void {
  let stack: Uint8Array[] = [];
  evalScript(stack, scriptSig, 'base', checker);
  const copy = [...stack];
  evalScript(stack, scriptPubKey, 'base', checker);
  if (stack.length === 0 || !castToBool(stack[stack.length - 1]!)) fail(ERR.EVAL_FALSE);
  let hadWitness = false;
  const wp = witnessProgram(scriptPubKey);
  if (wp) {
    hadWitness = true;
    if (scriptSig.length !== 0) fail(ERR.WITNESS_MALLEATED);
    verifyWitnessProgram(witness, wp.version, wp.program, checker, false);
    stack = stack.slice(0, 1);
  }
  if (isP2sh(scriptPubKey)) {
    if (!isPushOnly(scriptSig)) fail(ERR.SIG_PUSHONLY);
    stack = copy;
    const redeem = stack.pop()!;
    evalScript(stack, redeem, 'base', checker);
    if (stack.length === 0 || !castToBool(stack[stack.length - 1]!)) fail(ERR.EVAL_FALSE);
    const inner = witnessProgram(redeem);
    if (inner) {
      hadWitness = true;
      if (!equalBytes(scriptSig, pushData(redeem))) fail(ERR.WITNESS_MALLEATED_P2SH);
      verifyWitnessProgram(witness, inner.version, inner.program, checker, true);
      stack = stack.slice(0, 1);
    }
  }
  if (checker.policy && stack.length !== 1) fail(ERR.CLEANSTACK);
  if (!hadWitness && witness.length > 0) fail(ERR.WITNESS_UNEXPECTED);
}

// ---- transactions --------------------------------------------------------------------------

function parsedOf(tx: Transaction): Parsed {
  const weight = tx.weight();
  return Object.freeze({
    txid: tx.getId(),
    hex: tx.toHex(),
    version: tx.version >>> 0,
    locktime: tx.locktime >>> 0,
    ins: Object.freeze(
      tx.ins.map((input) =>
        Object.freeze({
          txid: reversedHex(input.hash),
          vout: input.index,
          sequence: input.sequence >>> 0,
          script: Uint8Array.from(input.script),
          witness: Object.freeze(input.witness.map((item) => Uint8Array.from(item))),
        }),
      ),
    ),
    outs: Object.freeze(
      tx.outs.map((output) =>
        Object.freeze({ script: Uint8Array.from(output.script), value: output.value }),
      ),
    ),
    weight,
    vsize: Math.ceil(weight / 4),
    size: tx.byteLength(),
    baseSize: tx.byteLength(false),
  });
}

/** bitcoind's `DecodeHexTx`: plain hex of either case, every byte consumed, an input. */
function decode(hex: string): Parsed | undefined {
  if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return undefined;
  let tx: Transaction;
  try {
    tx = bitcoin.Transaction.fromBuffer(fromHex(hex));
  } catch {
    return undefined;
  }
  return tx.ins.length === 0 ? undefined : parsedOf(tx);
}

const entryOf = (
  parsed: Parsed,
  kind: Kind,
  prevouts: readonly Output[],
  fee: bigint,
): Entry =>
  Object.freeze({ ...parsed, kind, prevouts: Object.freeze([...prevouts]), fee });

/** `CheckTransaction`. */
function checkTransaction(tx: Parsed): void {
  if (tx.ins.length === 0) throw rejected('bad-txns-vin-empty');
  if (tx.outs.length === 0) throw rejected('bad-txns-vout-empty');
  if (tx.baseSize * 4 > MAX_BLOCK_WEIGHT) throw rejected('bad-txns-oversize');
  let total = 0n;
  for (const output of tx.outs) {
    if (output.value < 0n) throw rejected('bad-txns-vout-negative');
    if (output.value > MAX_MONEY) throw rejected('bad-txns-vout-toolarge');
    total += output.value;
    if (total > MAX_MONEY) throw rejected('bad-txns-txouttotal-toolarge');
  }
  const seen = new Set<string>();
  for (const input of tx.ins) {
    const key = outpointOf(input.txid, input.vout);
    if (seen.has(key)) throw rejected('bad-txns-inputs-duplicate');
    seen.add(key);
  }
  if (isCoinbaseTx(tx)) {
    const length = tx.ins[0]!.script.length;
    if (length < 2 || length > 100) throw rejected('bad-cb-length');
  } else if (tx.ins.some(isNull)) throw rejected('bad-txns-prevout-null');
}

/** `IsFinalTx` at a block height and median time past. */
function isFinal(tx: Parsed, height: number, time: number): boolean {
  if (tx.locktime === 0) return true;
  if (tx.locktime < (tx.locktime < LOCKTIME_THRESHOLD ? height : time)) return true;
  return tx.ins.every((input) => input.sequence === SEQUENCE_FINAL);
}

/** BIP68 `CalculateSequenceLocks` + `EvaluateSequenceLocks` for a block at `height`. */
function sequenceLocksPass(
  chain: readonly Block[],
  tx: Parsed,
  coinHeights: readonly number[],
  height: number,
): boolean {
  if (tx.version < 2) return true;
  let minHeight = -1;
  let minTime = -1;
  tx.ins.forEach((input, index) => {
    if (input.sequence & SEQUENCE_LOCKTIME_DISABLE_FLAG) return;
    const coinHeight = coinHeights[index]!;
    const value = input.sequence & SEQUENCE_LOCKTIME_MASK;
    if (input.sequence & SEQUENCE_LOCKTIME_TYPE_FLAG) {
      const coinTime = mtpAt(chain, Math.max(coinHeight - 1, 0));
      minTime = Math.max(minTime, coinTime + value * 512 - 1);
    } else minHeight = Math.max(minHeight, coinHeight + value - 1);
  });
  return minHeight < height && minTime < mtpAt(chain, height - 1);
}

const signalsRbf = (tx: Parsed): boolean =>
  tx.ins.some((input) => input.sequence <= 0xfffffffd);

// ---- the node ------------------------------------------------------------------------------

export class ScriptedEsploraNode {
  readonly fetch = new FakeFetch();
  readonly network: Network;
  readonly options: Required<Omit<ScriptedEsploraNodeOptions, 'clock' | 'network'>>;
  /** Raw bodies POSTed to `/tx` that reached the node, in order (accepted or not). */
  readonly broadcasts: string[] = [];
  readonly #clock: FakeClock;
  readonly #endpoints = new Map<string, Required<EndpointOptions>>();
  readonly #intercepts = new Map<string, EsploraIntercept>();
  /** Views are derived from an immutable state: cached per state object. */
  readonly #views = new WeakMap<State, Map<string, View>>();
  #estimates: Readonly<Record<string, number>> = { '2': 20, '6': 10, '144': 2 };
  /** The dynamic mempool minimum (sat/kvB) a full mempool raises; 0 when not full. */
  #mempoolMinFee = 0n;
  #salt = 0;
  #state: State;

  constructor(options: ScriptedEsploraNodeOptions) {
    // bitcoinjs needs an ECC backend for taproot addresses.
    useNobleEcc();
    this.#clock = options.clock;
    this.network = options.network ?? bitcoin.networks.regtest;
    this.options = Object.freeze({
      genesisHash:
        options.genesisHash ??
        '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
      minRelayFee: options.minRelayFee ?? 100n,
      incrementalRelayFee: options.incrementalRelayFee ?? 100n,
      dustRelayFee: options.dustRelayFee ?? 3_000n,
      fullRbf: options.fullRbf ?? true,
      legacyScriptErrors: options.legacyScriptErrors ?? false,
      errorFormat: options.errorFormat ?? 'blockstream',
    });
    const coinbase = this.#coinbase(0, 0n);
    const time = Math.floor(this.#clock.now() / 1000);
    const genesis: Block = Object.freeze({
      hash: this.options.genesisHash,
      height: 0,
      parentHash: ZERO_TXID,
      timestamp: time,
      mediantime: time,
      entries: Object.freeze([coinbase]),
      relayed: new Set<string>(),
      evicted: Object.freeze([]),
    });
    this.#state = {
      chain: [genesis],
      confirmed: new Map([[coinbase.txid, 0]]),
      mempool: new Map(),
      spentBy: new Map(),
      archive: new Map([[coinbase.txid, coinbase]]),
      stale: new Map(),
    };
  }

  // ---- scripting ------------------------------------------------------------------------

  /** A base URL for an endpoint of this node. Registering a name again updates its options. */
  endpoint(name: string, options: EndpointOptions = {}): string {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid endpoint name ${name}`);
    const base = `https://esplora-${name}.test/api`;
    const known = this.#endpoints.has(name);
    this.#endpoints.set(name, {
      lag: this.#count(options.lag ?? 0, 'lag'),
      mempoolDelayMs: this.#count(options.mempoolDelayMs ?? 0, 'mempoolDelayMs'),
      lightMode: options.lightMode ?? false,
    });
    if (!known) {
      this.fetch.route(base, (request, signal) => this.#handle(name, request, signal));
    }
    return base;
  }

  /** The endpoint hides its top `lag` blocks (I1). */
  setLag(name: string, lag: number): void {
    this.#endpointOf(name).lag = this.#count(lag, 'lag');
  }

  /** New mempool transactions reach the endpoint's index `ms` after their acceptance. */
  setMempoolDelay(name: string, ms: number): void {
    this.#endpointOf(name).mempoolDelayMs = this.#count(ms, 'mempoolDelayMs');
  }

  intercept(name: string, handler: EsploraIntercept): void {
    this.#endpointOf(name);
    this.#intercepts.set(name, handler);
  }

  clearIntercept(name: string): void {
    this.#intercepts.delete(name);
  }

  setFeeEstimates(estimates: Readonly<Record<string, number>>): void {
    this.#estimates = Object.freeze({ ...estimates });
  }

  /**
   * A full mempool's minimum fee rate (sat/kvB): lower transactions are refused. Like
   * bitcoind's `GetMinFee`, a raised minimum is never below the incremental relay fee.
   */
  setMempoolMinFee(rate: bigint): void {
    this.#mempoolMinFee = rate;
  }

  /** How many times these exact transaction bytes (by txid) were POSTed. */
  sendCount(txid: string): number {
    return this.broadcasts.filter((hex) => decode(hex)?.txid === txid).length;
  }

  get height(): number {
    return this.#state.chain.length - 1;
  }

  /**
   * Pays `value` to `address` from outside (a funding transaction, shown as a coinbase and
   * spendable at once), confirmed in a new block (which also mines the mempool, as `mine`
   * does) unless `mempool`. Returns its outpoint.
   */
  fund(
    address: string,
    value: bigint,
    options: { readonly mempool?: boolean } = {},
  ): string {
    if (typeof value !== 'bigint' || !moneyRange(value)) {
      throw new Error('fund: the value must be 0 to 21 million bitcoin, in satoshis');
    }
    const script = bitcoin.address.toOutputScript(address, this.network);
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(
      new Uint8Array(32),
      0xffffffff,
      SEQUENCE_FINAL,
      pushData(utf8ToBytes(`fund:${this.#salt++}`)),
    );
    tx.addOutput(script, value);
    const entry = entryOf(parsedOf(tx), 'funding', [], 0n);
    this.#commit((draft) => {
      if (options.mempool) this.#addToMempool(draft, entry);
      else this.#mineBlock(draft, [entry], [], []);
    });
    return outpointOf(entry.txid, 0);
  }

  /**
   * Mines `count` blocks. The first includes `extra` transactions that never went through
   * the mempool (a miner's own: held to consensus rules only; a conflicting mempool
   * transaction and its descendants are evicted), then every mempool transaction (parents
   * first) except `skip` and their descendants. An invalid block throws and changes nothing.
   */
  mine(
    count = 1,
    options: {
      readonly skip?: readonly string[];
      readonly extra?: readonly string[];
    } = {},
  ): string[] {
    if (!Number.isInteger(count) || count < 1)
      throw new Error(`cannot mine ${count} blocks`);
    return this.#commit((draft) => {
      const hashes = [
        this.#mineBlock(draft, [], options.extra ?? [], options.skip ?? []),
      ];
      for (let n = 1; n < count; n++)
        hashes.push(this.#mineBlock(draft, [], [], [], false));
      return hashes;
    });
  }

  /**
   * Disconnects the top `depth` blocks, as bitcoind does in a reorg: their transactions go
   * back to the mempool through AcceptToMemoryPool with the fee limits bypassed (those that
   * are no longer valid are dropped, as are the listed `drop`), and mempool transactions
   * whose inputs went away are removed. Call `mine` for the new branch. The genesis block
   * cannot be disconnected.
   */
  reorg(depth: number, options: { readonly drop?: readonly string[] } = {}): void {
    if (!Number.isInteger(depth) || depth < 1 || depth > this.height) {
      throw new Error(`cannot reorg ${depth} blocks at height ${this.height}`);
    }
    const drop = new Set(options.drop ?? []);
    this.#commit((draft) => {
      const disconnected = draft.chain.splice(draft.chain.length - depth, depth);
      const found = new Set<string>();
      for (const block of [...disconnected].reverse()) {
        draft.stale.set(block.hash, block);
        for (const entry of [...block.entries].reverse()) {
          draft.confirmed.delete(entry.txid);
          this.#unspend(draft, entry);
          if (drop.has(entry.txid)) found.add(entry.txid);
        }
      }
      for (const txid of drop) {
        if (!found.has(txid))
          throw new Error(`reorg: ${txid} is not in a disconnected block`);
      }
      for (const block of disconnected) {
        for (const entry of block.entries) {
          if (entry.kind === 'coinbase' || drop.has(entry.txid)) continue;
          if (entry.kind === 'funding') {
            this.#addToMempool(draft, entry);
            continue;
          }
          try {
            this.#accept(draft, entry, true);
          } catch (error) {
            // bitcoind drops a disconnected transaction that is no longer valid.
            if (!(error instanceof NodeError)) throw error;
          }
        }
      }
      this.#pruneMempool(draft);
    });
  }

  /** Mempool eviction or expiry (`-mempoolexpiry`, a full mempool): the tx and its descendants. */
  evict(txid: string): void {
    if (!this.#state.mempool.has(txid))
      throw new Error(`evict: ${txid} is not in the mempool`);
    this.#commit((draft) => this.#removeWithDescendants(draft, txid));
  }

  inMempool(txid: string): boolean {
    return this.#state.mempool.has(txid);
  }

  confirmations(txid: string): number {
    const height = this.#state.confirmed.get(txid);
    return height === undefined ? 0 : this.height - height + 1;
  }

  /** The txids of the active chain's block at `height` (its coinbase first). */
  blockTxids(height: number): readonly string[] {
    return this.#state.chain[height]?.entries.map((entry) => entry.txid) ?? [];
  }

  /** A decoded copy of the transaction (mempool, chain, or a disconnected block). */
  transaction(txid: string): Transaction | undefined {
    const entry =
      this.#state.mempool.get(txid)?.entry ?? this.#state.archive.get(txid) ?? undefined;
    return entry ? bitcoin.Transaction.fromHex(entry.hex) : undefined;
  }

  /** Accepts raw bytes from outside the library, as `POST /tx` does; throws a `NodeError`. */
  submit(hex: string): string {
    return this.#submit(hex);
  }

  // ---- state ----------------------------------------------------------------------------

  /** Applies `work` to a copy of the state and commits it only when `work` succeeds. */
  #commit<T>(work: (draft: State) => T): T {
    const draft = cloneState(this.#state);
    const result = work(draft);
    this.#state = draft;
    return result;
  }

  #count(value: number, what: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${what} must be a non-negative integer`);
    }
    return value;
  }

  #endpointOf(name: string): { lag: number; mempoolDelayMs: number; lightMode: boolean } {
    const endpoint = this.#endpoints.get(name);
    if (!endpoint) throw new Error(`no endpoint ${name}: call endpoint('${name}') first`);
    return endpoint;
  }

  #subsidy(height: number): bigint {
    const halvings = Math.floor(
      height / (this.network.bech32 === 'bcrt' ? 150 : 210_000),
    );
    return halvings >= 64 ? 0n : (50n * COIN) >> BigInt(halvings);
  }

  #coinbase(height: number, fees: bigint): Entry {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(
      new Uint8Array(32),
      0xffffffff,
      SEQUENCE_FINAL,
      concatBytes(pushNumber(height), pushNumber(this.#salt++)),
    );
    tx.addOutput(MINER_SCRIPT, this.#subsidy(height) + fees);
    return entryOf(parsedOf(tx), 'coinbase', [], 0n);
  }

  #addToMempool(draft: State, entry: Entry): void {
    draft.mempool.set(entry.txid, { entry, time: this.#clock.now() });
    if (entry.kind === 'tx') {
      for (const input of entry.ins) {
        draft.spentBy.set(outpointOf(input.txid, input.vout), entry.txid);
      }
    }
  }

  #unspend(draft: State, entry: Entry): void {
    if (entry.kind !== 'tx') return;
    for (const input of entry.ins) {
      const key = outpointOf(input.txid, input.vout);
      if (draft.spentBy.get(key) === entry.txid) draft.spentBy.delete(key);
    }
  }

  #removeWithDescendants(draft: State, txid: string): void {
    for (const id of [txid, ...this.#descendants(draft, txid)]) {
      const pooled = draft.mempool.get(id);
      if (!pooled) continue;
      draft.mempool.delete(id);
      this.#unspend(draft, pooled.entry);
    }
  }

  /** In-mempool descendants of `txid`, nearest first. */
  #descendants(state: State, txid: string): string[] {
    const out: string[] = [];
    const seen = new Set([txid]);
    const queue = [txid];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const entry = state.mempool.get(current)?.entry ?? state.archive.get(current);
      for (let vout = 0; vout < (entry?.outs.length ?? 0); vout++) {
        const spender = state.spentBy.get(outpointOf(current, vout));
        if (spender === undefined || seen.has(spender) || !state.mempool.has(spender)) {
          continue;
        }
        seen.add(spender);
        out.push(spender);
        queue.push(spender);
      }
    }
    return out;
  }

  #mempoolParents(state: State, tx: Parsed): string[] {
    return [
      ...new Set(
        tx.ins.map((input) => input.txid).filter((txid) => state.mempool.has(txid)),
      ),
    ];
  }

  /**
   * The coin an input spends (`CCoinsViewMemPool`): any output of a mempool transaction, or
   * an output of the active chain not spent by it. Unspendable outputs and the genesis
   * block's reward never enter the UTXO set.
   */
  #coin(state: State, txid: string, vout: number): Coin | undefined {
    const next = state.chain.length;
    const pooled = state.mempool.get(txid);
    if (pooled) {
      const output = pooled.entry.outs[vout];
      return output && { output, height: next, kind: pooled.entry.kind, mempool: true };
    }
    const height = state.confirmed.get(txid);
    if (height === undefined || height === 0) return undefined;
    const entry = state.archive.get(txid) as Entry;
    const output = entry.outs[vout];
    if (!output || isUnspendable(output.script)) return undefined;
    const spender = state.spentBy.get(outpointOf(txid, vout));
    if (spender !== undefined && state.confirmed.has(spender)) return undefined;
    return { output, height, kind: entry.kind, mempool: false };
  }

  #dust(script: Uint8Array): bigint {
    if (isUnspendable(script)) return 0n;
    const size =
      8 +
      compactSizeLength(script.length) +
      script.length +
      (witnessProgram(script) ? 32 + 4 + 1 + 26 + 4 : 32 + 4 + 1 + 107 + 4);
    return feeAt(this.options.dustRelayFee, size);
  }

  // ---- sendrawtransaction and AcceptToMemoryPool ----------------------------------------

  /** `sendrawtransaction` (rpc/mempool.cpp, node/transaction.cpp `BroadcastTransaction`). */
  #submit(hex: string): string {
    const parsed = decode(hex);
    if (!parsed) {
      throw new NodeError(
        -22,
        'TX decode failed. Make sure the tx has at least one input.',
      );
    }
    for (const output of parsed.outs) {
      if (
        (isUnspendable(output.script) || !hasValidOps(output.script)) &&
        output.value > 0n
      ) {
        throw new NodeError(
          -25,
          'Unspendable output exceeds maximum configured by user (maxburnamount)',
        );
      }
    }
    const state = this.#state;
    if (
      state.confirmed.has(parsed.txid) &&
      parsed.outs.some((_, vout) => this.#coin(state, parsed.txid, vout) !== undefined)
    ) {
      throw new NodeError(-27, 'Transaction outputs already in utxo set');
    }
    // Already in the mempool (any witness): bitcoind re-announces it and returns the txid.
    if (state.mempool.has(parsed.txid)) return parsed.txid;
    return this.#commit((draft) => {
      const entry = this.#accept(draft, parsed, false);
      if (entry.fee > feeAt(MAX_RAW_TX_FEE_RATE, entry.vsize)) {
        throw new NodeError(
          -25,
          'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)',
        );
      }
      return entry.txid;
    });
  }

  /** `IsStandardTx`. */
  #checkStandard(tx: Parsed): void {
    if (tx.version === 3) {
      throw new Error('the scripted node does not model TRUC (version 3) transactions');
    }
    if (tx.version < 1 || tx.version > 3) throw rejected('version');
    if (tx.weight > MAX_STANDARD_TX_WEIGHT) throw rejected('tx-size');
    for (const input of tx.ins) {
      if (input.script.length > MAX_STANDARD_SCRIPTSIG_SIZE)
        throw rejected('scriptsig-size');
      if (!isPushOnly(input.script)) throw rejected('scriptsig-not-pushonly');
    }
    for (const output of tx.outs) {
      if (solve(output.script) === 'nonstandard') throw rejected('scriptpubkey');
    }
    const dust = tx.outs.filter((output) => output.value < this.#dust(output.script));
    if (dust.length > MAX_DUST_OUTPUTS_PER_TX) throw rejected('dust');
  }

  /** `Consensus::CheckTxInputs`: maturity and values; the fee. */
  #checkTxInputs(tx: Parsed, coins: readonly Coin[], spendHeight: number): bigint {
    let valueIn = 0n;
    for (const coin of coins) {
      const depth = spendHeight - coin.height;
      if (coin.kind === 'coinbase' && depth < COINBASE_MATURITY) {
        throw rejected(
          `bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth ${depth}`,
        );
      }
      valueIn += coin.output.value;
      if (!moneyRange(coin.output.value) || !moneyRange(valueIn)) {
        throw rejected('bad-txns-inputvalues-outofrange');
      }
    }
    const valueOut = sum(tx.outs.map((output) => output.value));
    if (valueIn < valueOut) {
      throw rejected(
        `bad-txns-in-belowout, value in (${formatMoney(valueIn)}) < value out (${formatMoney(valueOut)})`,
      );
    }
    const fee = valueIn - valueOut;
    if (!moneyRange(fee)) throw rejected('bad-txns-fee-outofrange');
    return fee;
  }

  /** `AreInputsStandard` and `IsWitnessStandard`. */
  #checkInputsStandard(tx: Parsed, coins: readonly Coin[]): void {
    tx.ins.forEach((input, index) => {
      const type = solve(coins[index]!.output.script);
      if (type === 'nonstandard' || type === 'witness_unknown') {
        throw rejected('bad-txns-nonstandard-inputs');
      }
      if (type === 'p2sh' && !pushStack(input.script)?.length) {
        throw rejected('bad-txns-nonstandard-inputs');
      }
    });
    const witnessNonstandard = rejected('bad-witness-nonstandard');
    tx.ins.forEach((input, index) => {
      if (input.witness.length === 0) return;
      let prev = coins[index]!.output.script;
      if (isPayToAnchor(prev)) throw witnessNonstandard;
      let p2sh = false;
      if (isP2sh(prev)) {
        const stack = pushStack(input.script);
        if (!stack?.length) throw witnessNonstandard;
        prev = stack[stack.length - 1]!;
        p2sh = true;
      }
      const wp = witnessProgram(prev);
      if (!wp) throw witnessNonstandard;
      const { witness } = input;
      if (wp.version === 0 && wp.program.length === 32) {
        const items = witness.slice(0, -1);
        if (
          witness[witness.length - 1]!.length > MAX_STANDARD_P2WSH_SCRIPT_SIZE ||
          items.length > MAX_STANDARD_P2WSH_STACK_ITEMS ||
          items.some((item) => item.length > MAX_STANDARD_P2WSH_STACK_ITEM_SIZE)
        ) {
          throw witnessNonstandard;
        }
      }
      if (wp.version === 1 && wp.program.length === 32 && !p2sh) {
        const last = witness[witness.length - 1]!;
        if (witness.length >= 2 && last[0] === 0x50) throw witnessNonstandard; // an annex
      }
    });
  }

  /** `CalculateMemPoolAncestors`: the ancestors, or the reason a limit is exceeded. */
  #ancestors(
    state: State,
    tx: Parsed,
    vsize: number,
    limits: typeof LIMITS,
  ): Set<string> | string {
    const parents = this.#mempoolParents(state, tx);
    if (parents.length + 1 > limits.ancestorCount) {
      return `too many unconfirmed parents [limit: ${limits.ancestorCount}]`;
    }
    const staged = new Set(parents);
    const ancestors = new Set<string>();
    let total = vsize;
    while (staged.size > 0) {
      const [next] = staged as Set<string> & [string];
      staged.delete(next);
      ancestors.add(next);
      const entry = (state.mempool.get(next) as Pooled).entry;
      total += entry.vsize;
      const descendants = this.#descendants(state, next);
      const descendantSize =
        entry.vsize +
        descendants.reduce(
          (a, id) => a + (state.mempool.get(id) as Pooled).entry.vsize,
          0,
        );
      if (descendantSize + vsize > limits.descendantSize) {
        return `exceeds descendant size limit for tx ${next} [limit: ${limits.descendantSize}]`;
      }
      if (descendants.length + 2 > limits.descendantCount) {
        return `too many descendants for tx ${next} [limit: ${limits.descendantCount}]`;
      }
      if (total > limits.ancestorSize) {
        return `exceeds ancestor size limit [limit: ${limits.ancestorSize}]`;
      }
      for (const parent of this.#mempoolParents(state, entry)) {
        if (!ancestors.has(parent)) staged.add(parent);
        if (staged.size + ancestors.size + 1 > limits.ancestorCount) {
          return `too many unconfirmed ancestors [limit: ${limits.ancestorCount}]`;
        }
      }
    }
    return ancestors;
  }

  /**
   * AcceptToMemoryPool on `draft` (validation.cpp: `PreChecks`, `ReplacementChecks`, then
   * the script checks). Every check runs before the first change, so a refusal changes
   * nothing. `bypassLimits`: a transaction of a disconnected block (the fee minimums are
   * skipped, as bitcoind's `bypass_limits` does).
   */
  #accept(draft: State, tx: Parsed, bypassLimits: boolean): Entry {
    checkTransaction(tx);
    if (isCoinbaseTx(tx)) throw rejected('coinbase');
    this.#checkStandard(tx);
    if (tx.baseSize < MIN_STANDARD_TX_NONWITNESS_SIZE) throw rejected('tx-size-small');
    const tip = draft.chain.length - 1;
    if (!isFinal(tx, tip + 1, mtpAt(draft.chain, tip))) throw rejected('non-final');

    const conflicts = new Set<string>();
    for (const input of tx.ins) {
      const spender = draft.spentBy.get(outpointOf(input.txid, input.vout));
      if (spender === undefined || conflicts.has(spender)) continue;
      const pooled = draft.mempool.get(spender);
      if (!pooled) continue;
      if (!this.options.fullRbf && !signalsRbf(pooled.entry)) {
        throw rejected('txn-mempool-conflict');
      }
      conflicts.add(spender);
    }
    const found = tx.ins.map((input) => this.#coin(draft, input.txid, input.vout));
    if (found.some((coin) => coin === undefined)) {
      throw new NodeError(-25, 'bad-txns-inputs-missingorspent');
    }
    const coins = found as Coin[];
    if (
      !sequenceLocksPass(
        draft.chain,
        tx,
        coins.map((coin) => coin.height),
        tip + 1,
      )
    ) {
      throw rejected('non-BIP68-final');
    }
    const fee = this.#checkTxInputs(tx, coins, tip + 1);
    this.#checkInputsStandard(tx, coins);
    const dust = tx.outs.some((output) => output.value < this.#dust(output.script));
    if (dust && fee !== 0n) throw rejected('dust, tx with dust output must be 0-fee');
    if (!bypassLimits) {
      const relay = feeAt(this.options.minRelayFee, tx.vsize);
      if (fee < relay) throw rejected(`min relay fee not met, ${fee} < ${relay}`);
      const rate =
        this.#mempoolMinFee > 0n && this.#mempoolMinFee < this.options.incrementalRelayFee
          ? this.options.incrementalRelayFee
          : this.#mempoolMinFee;
      const floor = feeAt(rate, tx.vsize);
      if (floor > 0n && fee < floor) {
        throw rejected(`mempool min fee not met, ${fee} < ${floor}`);
      }
    }

    const limits = { ...LIMITS };
    if (conflicts.size === 1) {
      const [conflict] = conflicts as Set<string> & [string];
      limits.descendantCount += 1;
      limits.descendantSize += [conflict, ...this.#descendants(draft, conflict)].reduce(
        (a, id) => a + (draft.mempool.get(id) as Pooled).entry.vsize,
        0,
      );
    }
    let ancestors = this.#ancestors(draft, tx, tx.vsize, limits);
    if (typeof ancestors === 'string') {
      // The CPFP carve-out: one more small child of a transaction with no other ancestor.
      const retry =
        tx.vsize > EXTRA_DESCENDANT_TX_SIZE_LIMIT
          ? ancestors
          : this.#ancestors(draft, tx, tx.vsize, {
              ancestorCount: 2,
              ancestorSize: limits.ancestorSize,
              descendantCount: limits.descendantCount + 1,
              descendantSize: limits.descendantSize + EXTRA_DESCENDANT_TX_SIZE_LIMIT,
            });
      if (typeof retry === 'string')
        throw rejected(`too-long-mempool-chain, ${ancestors}`);
      ancestors = retry;
    }
    for (const ancestor of ancestors) {
      if (conflicts.has(ancestor)) {
        throw rejected(
          `bad-txns-spends-conflicting-tx, ${tx.txid} spends conflicting transaction ${ancestor}`,
        );
      }
    }
    if (conflicts.size > 0) this.#checkReplacement(draft, tx, fee, conflicts);
    const prevouts = coins.map((coin) => coin.output);
    this.#checkScripts(tx, prevouts);

    for (const conflict of conflicts) this.#removeWithDescendants(draft, conflict);
    const entry = entryOf(tx, 'tx', prevouts, fee);
    this.#addToMempool(draft, entry);
    return entry;
  }

  /** `ReplacementChecks` of Bitcoin Core 28-30: rules 6, 5, 2, then 3 and 4. */
  #checkReplacement(
    draft: State,
    tx: Parsed,
    fee: bigint,
    conflicts: ReadonlySet<string>,
  ): void {
    const entryOfPool = (txid: string) => (draft.mempool.get(txid) as Pooled).entry;
    const rate = (fee * 1000n) / BigInt(tx.vsize);
    for (const txid of conflicts) {
      const original = entryOfPool(txid);
      const old = (original.fee * 1000n) / BigInt(original.vsize);
      if (rate <= old) {
        throw rejected(
          `insufficient fee, rejecting replacement ${tx.txid}; new feerate ${formatRate(rate)} <= old feerate ${formatRate(old)}`,
        );
      }
    }
    let count = 0;
    const all = new Set<string>();
    for (const txid of conflicts) {
      const descendants = this.#descendants(draft, txid);
      count += 1 + descendants.length;
      if (count > MAX_REPLACEMENT_CANDIDATES) {
        throw rejected(
          `too many potential replacements, rejecting replacement ${tx.txid}; too many potential replacements (${count} > ${MAX_REPLACEMENT_CANDIDATES})`,
        );
      }
      for (const id of [txid, ...descendants]) all.add(id);
    }
    const parents = new Set(
      [...all].flatMap((txid) => entryOfPool(txid).ins.map((input) => input.txid)),
    );
    tx.ins.forEach((input, index) => {
      if (!parents.has(input.txid) && draft.mempool.has(input.txid)) {
        throw rejected(
          `replacement-adds-unconfirmed, replacement ${tx.txid} adds unconfirmed input, idx ${index}`,
        );
      }
    });
    const paid = sum([...all].map((txid) => entryOfPool(txid).fee));
    if (fee < paid) {
      throw rejected(
        `insufficient fee, rejecting replacement ${tx.txid}, less fees than conflicting txs; ${formatMoney(fee)} < ${formatMoney(paid)}`,
      );
    }
    const relay = feeAt(this.options.incrementalRelayFee, tx.vsize);
    if (fee - paid < relay) {
      throw rejected(
        `insufficient fee, rejecting replacement ${tx.txid}, not enough additional fees to relay; ${formatMoney(fee - paid)} < ${formatMoney(relay)}`,
      );
    }
  }

  #checker(
    tx: Parsed,
    prevouts: readonly Output[],
    index: number,
    policy: boolean,
  ): Checker {
    return {
      tx: bitcoin.Transaction.fromHex(tx.hex),
      index,
      prevScripts: prevouts.map((p) => p.script),
      prevValues: prevouts.map((p) => p.value),
      policy,
    };
  }

  /** The script error of one input under the policy or consensus flags, if any. */
  #scriptError(
    tx: Parsed,
    prevouts: readonly Output[],
    index: number,
    policy: boolean,
  ): string | undefined {
    const input = tx.ins[index]!;
    try {
      verifyScript(
        input.script,
        prevouts[index]!.script,
        input.witness,
        this.#checker(tx, prevouts, index, policy),
      );
      return undefined;
    } catch (error) {
      if (error instanceof ScriptFailure) return error.message;
      throw error;
    }
  }

  #scriptText(reason: string, consensus: boolean): string {
    const legacy = this.options.legacyScriptErrors;
    if (consensus) {
      return legacy
        ? `mandatory-script-verify-flag-failed (${reason})`
        : `block-script-verify-flag-failed (${reason})`;
    }
    return legacy
      ? `non-mandatory-script-verify-flag (${reason})`
      : `mempool-script-verify-flag-failed (${reason})`;
  }

  /**
   * `CheckInputScripts` with the standard flags; a failure is checked again with the
   * consensus flags alone, which tells a policy refusal from a consensus one (the text of
   * the first failure either way).
   */
  #checkScripts(tx: Parsed, prevouts: readonly Output[]): void {
    for (let index = 0; index < tx.ins.length; index++) {
      const first = this.#scriptError(tx, prevouts, index, true);
      if (first === undefined) continue;
      const consensus = this.#scriptError(tx, prevouts, index, false) !== undefined;
      throw rejected(this.#scriptText(first, consensus));
    }
  }

  // ---- blocks ---------------------------------------------------------------------------

  /** A miner's transaction checked against consensus rules only (`ConnectBlock`). */
  #blockTx(
    draft: State,
    hex: string,
    height: number,
    inBlock: ReadonlyMap<string, Entry>,
    spentInBlock: ReadonlySet<string>,
  ): Entry {
    const tx = decode(hex);
    if (!tx) throw invalidBlock('a transaction does not decode');
    try {
      checkTransaction(tx);
    } catch (error) {
      throw invalidBlock((error as Error).message);
    }
    if (isCoinbaseTx(tx)) throw invalidBlock('bad-cb-multiple');
    const coins = tx.ins.map((input): Coin | undefined => {
      if (spentInBlock.has(outpointOf(input.txid, input.vout))) return undefined;
      const parent = inBlock.get(input.txid);
      if (parent) {
        const output = parent.outs[input.vout];
        return output && !isUnspendable(output.script)
          ? { output, height, kind: parent.kind, mempool: false }
          : undefined;
      }
      if (draft.mempool.has(input.txid)) {
        throw new Error(
          'an extra transaction may spend only confirmed outputs or earlier extras: mine its parent first',
        );
      }
      return this.#coin(draft, input.txid, input.vout);
    });
    if (coins.some((coin) => coin === undefined)) {
      throw invalidBlock('bad-txns-inputs-missingorspent');
    }
    const spendable = coins as Coin[];
    const heights = spendable.map((coin) => coin.height);
    if (
      !isFinal(tx, height, mtpAt(draft.chain, height - 1)) ||
      !sequenceLocksPass(draft.chain, tx, heights, height)
    ) {
      throw invalidBlock('bad-txns-nonfinal');
    }
    let fee: bigint;
    try {
      fee = this.#checkTxInputs(tx, spendable, height);
    } catch (error) {
      throw invalidBlock((error as Error).message);
    }
    const prevouts = spendable.map((coin) => coin.output);
    for (let index = 0; index < tx.ins.length; index++) {
      const error = this.#scriptError(tx, prevouts, index, false);
      if (error !== undefined) throw invalidBlock(this.#scriptText(error, true));
    }
    return entryOf(tx, 'tx', prevouts, fee);
  }

  /**
   * Connects a block on `draft`: `funding` (a test's payments), then `extra` (a miner's
   * own transactions), then the mempool (parents first) unless `includeMempool` is false.
   */
  #mineBlock(
    draft: State,
    funding: readonly Entry[],
    extra: readonly string[],
    skip: readonly string[],
    includeMempool = true,
  ): string {
    const parent = draft.chain[draft.chain.length - 1] as Block;
    const height = parent.height + 1;
    const timestamp = Math.max(
      Math.floor(this.#clock.now() / 1000),
      mtpAt(draft.chain, parent.height) + 1,
    );
    const included: Entry[] = [...funding];
    const relayed = new Set<string>();
    const evicted: Entry[] = [];
    const inBlock = new Map(funding.map((entry) => [entry.txid, entry]));
    const spentInBlock = new Set<string>();
    for (const hex of extra) {
      const entry = this.#blockTx(draft, hex, height, inBlock, spentInBlock);
      if (draft.mempool.has(entry.txid)) {
        // The same transaction (any witness): mined from the mempool, children kept.
        this.#unspend(draft, (draft.mempool.get(entry.txid) as Pooled).entry);
        draft.mempool.delete(entry.txid);
        relayed.add(entry.txid);
      }
      for (const input of entry.ins) {
        const spender = draft.spentBy.get(outpointOf(input.txid, input.vout));
        if (spender === undefined || !draft.mempool.has(spender)) continue;
        for (const id of [spender, ...this.#descendants(draft, spender)]) {
          evicted.push((draft.mempool.get(id) as Pooled).entry);
        }
        this.#removeWithDescendants(draft, spender);
      }
      included.push(entry);
      inBlock.set(entry.txid, entry);
      for (const input of entry.ins) spentInBlock.add(outpointOf(input.txid, input.vout));
    }
    if (includeMempool) {
      const skipped = new Set<string>();
      for (const txid of skip) {
        if (!draft.mempool.has(txid))
          throw new Error(`mine: ${txid} is not in the mempool`);
        for (const id of [txid, ...this.#descendants(draft, txid)]) skipped.add(id);
      }
      const pending = [...draft.mempool.values()]
        .map((pooled) => pooled.entry)
        .filter((entry) => !skipped.has(entry.txid));
      const done = new Set(inBlock.keys());
      for (;;) {
        const index = pending.findIndex((entry) =>
          entry.ins.every(
            (input) => !draft.mempool.has(input.txid) || done.has(input.txid),
          ),
        );
        if (index < 0) break;
        const [entry] = pending.splice(index, 1) as [Entry];
        done.add(entry.txid);
        relayed.add(entry.txid);
        included.push(entry);
      }
    }
    const coinbase = this.#coinbase(height, sum(included.map((entry) => entry.fee)));
    const entries = Object.freeze([coinbase, ...included]);
    const block: Block = Object.freeze({
      hash: toHex(sha256(utf8ToBytes(`${parent.hash}:${height}:${this.#salt++}`))),
      height,
      parentHash: parent.hash,
      timestamp,
      mediantime: median([
        ...draft.chain.slice(Math.max(0, height - 10)).map((b) => b.timestamp),
        timestamp,
      ]),
      entries,
      relayed,
      evicted: Object.freeze(evicted),
    });
    draft.chain.push(block);
    for (const entry of entries) {
      draft.mempool.delete(entry.txid);
      draft.confirmed.set(entry.txid, height);
      draft.archive.set(entry.txid, entry);
      if (entry.kind === 'tx') {
        for (const input of entry.ins) {
          draft.spentBy.set(outpointOf(input.txid, input.vout), entry.txid);
        }
      }
    }
    return block.hash;
  }

  /** `removeForReorg`: mempool transactions whose inputs went away, or no longer final. */
  #pruneMempool(draft: State): void {
    const tip = draft.chain.length - 1;
    for (;;) {
      const invalid = [...draft.mempool.values()].find(({ entry }) => {
        if (entry.kind !== 'tx') return false;
        const coins = entry.ins.map((input) => this.#coin(draft, input.txid, input.vout));
        if (coins.some((coin) => coin === undefined)) return true;
        const spendable = coins as Coin[];
        return (
          spendable.some(
            (coin) =>
              coin.kind === 'coinbase' && tip + 1 - coin.height < COINBASE_MATURITY,
          ) ||
          !isFinal(entry, tip + 1, mtpAt(draft.chain, tip)) ||
          !sequenceLocksPass(
            draft.chain,
            entry,
            spendable.map((coin) => coin.height),
            tip + 1,
          )
        );
      });
      if (!invalid) return;
      this.#removeWithDescendants(draft, invalid.entry.txid);
    }
  }

  // ---- the Esplora REST API ---------------------------------------------------------------

  async #handle(
    name: string,
    request: FakeRequest,
    signal: AbortSignal | undefined,
  ): Promise<FakeReply> {
    let answer: FakeReply | undefined;
    const honest = () => (answer ??= this.#answer(name, request));
    const intercept = this.#intercepts.get(name);
    if (intercept) {
      const reply = await intercept(request, signal, honest);
      if (reply !== undefined) return reply;
    }
    return honest();
  }

  /**
   * What endpoint `name` shows: blocks up to its view, and a mempool of the transactions it
   * saw relayed (the node's, after `mempoolDelayMs`, plus those of blocks above its view
   * that were in a mempool first, or that such a block conflicted out), minus any whose
   * parents it does not know.
   */
  #view(name: string): View {
    const state = this.#state;
    const { lag, mempoolDelayMs, lightMode } = this.#endpointOf(name);
    const tip = state.chain.length - 1;
    const height = Math.max(0, tip - lag);
    const now = this.#clock.now();
    const key = `${height}:${mempoolDelayMs > 0 ? now - mempoolDelayMs : '-'}:${lightMode}`;
    const cache = this.#views.get(state) ?? new Map<string, View>();
    this.#views.set(state, cache);
    const cached = cache.get(key);
    if (cached) return cached;
    const candidates: Entry[] = [];
    for (let h = height + 1; h <= tip; h++) {
      const block = state.chain[h] as Block;
      candidates.push(...block.evicted);
      candidates.push(...block.entries.filter((entry) => block.relayed.has(entry.txid)));
    }
    for (const { entry, time } of state.mempool.values()) {
      if (time + mempoolDelayMs <= now) candidates.push(entry);
    }
    const known = new Set<string>();
    const inView = (txid: string) => {
      const confirmed = state.confirmed.get(txid);
      return (confirmed !== undefined && confirmed <= height) || known.has(txid);
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const entry of candidates) {
        if (known.has(entry.txid)) continue;
        if (entry.kind !== 'tx' || entry.ins.every((input) => inView(input.txid))) {
          known.add(entry.txid);
          changed = true;
        }
      }
    }
    const pooled = new Map<string, Entry>();
    for (const entry of candidates)
      if (known.has(entry.txid)) pooled.set(entry.txid, entry);
    const spentBy = new Map<string, string>();
    const spend = (entry: Entry) => {
      if (entry.kind !== 'tx') return;
      for (const input of entry.ins) {
        const key = outpointOf(input.txid, input.vout);
        if (!spentBy.has(key)) spentBy.set(key, entry.txid);
      }
    };
    for (let h = 0; h <= height; h++) (state.chain[h] as Block).entries.forEach(spend);
    pooled.forEach(spend);
    const view: View = { height, lightMode, pooled, spentBy };
    cache.set(key, view);
    return view;
  }

  #confirmedIn(state: State, view: View, txid: string): number | undefined {
    const height = state.confirmed.get(txid);
    return height !== undefined && height <= view.height ? height : undefined;
  }

  /** A transaction as the endpoint serves it: confirmed, in its mempool, or in its txstore. */
  #lookup(state: State, view: View, txid: string): Entry | undefined {
    if (this.#confirmedIn(state, view, txid) !== undefined)
      return state.archive.get(txid);
    const pooled = view.pooled.get(txid);
    if (pooled) return pooled;
    if (view.lightMode) return undefined;
    for (const block of state.stale.values()) {
      if (block.height > view.height) continue;
      const entry = block.entries.find((e) => e.txid === txid);
      if (entry) return state.archive.get(txid) ?? entry;
    }
    return undefined;
  }

  #status(state: State, view: View, txid: string): Record<string, unknown> {
    const height = this.#confirmedIn(state, view, txid);
    if (height === undefined) return { confirmed: false };
    const block = state.chain[height] as Block;
    return {
      confirmed: true,
      block_height: height,
      block_hash: block.hash,
      block_time: block.timestamp,
    };
  }

  #outputJson(output: Output): Record<string, unknown> {
    let address: string | undefined;
    try {
      address = bitcoin.address.fromOutputScript(output.script, this.network);
    } catch {
      address = undefined;
    }
    const s = output.script;
    const types: Partial<Record<ScriptType, string>> = {
      pubkey: 'p2pk',
      p2pkh: 'p2pkh',
      p2sh: 'p2sh',
      p2wpkh: 'v0_p2wpkh',
      p2wsh: 'v0_p2wsh',
      p2tr: 'v1_p2tr',
    };
    const type =
      s.length === 0
        ? 'empty'
        : s[0] === 0x6a
          ? 'op_return'
          : (types[solve(s)] ?? 'unknown');
    return {
      scriptpubkey: toHex(s),
      scriptpubkey_asm: '',
      scriptpubkey_type: type,
      ...(address !== undefined ? { scriptpubkey_address: address } : {}),
      value: Number(output.value),
    };
  }

  #txJson(state: State, view: View, entry: Entry): Record<string, unknown> {
    return {
      txid: entry.txid,
      version: entry.version,
      locktime: entry.locktime,
      vin: entry.ins.map((input, index) => ({
        txid: input.txid,
        vout: input.vout,
        prevout: entry.kind === 'tx' ? this.#outputJson(entry.prevouts[index]!) : null,
        scriptsig: toHex(input.script),
        scriptsig_asm: '',
        ...(input.witness.length > 0
          ? { witness: input.witness.map((w) => toHex(w)) }
          : {}),
        is_coinbase: entry.kind !== 'tx',
        sequence: input.sequence,
      })),
      vout: entry.outs.map((output) => this.#outputJson(output)),
      size: entry.size,
      weight: entry.weight,
      fee: Number(entry.fee),
      status: this.#status(state, view, entry.txid),
    };
  }

  #blockJson(block: Block): Record<string, unknown> {
    const txids = block.entries.map((entry) => entry.txid);
    let level = txids.map((txid) => fromHex(txid).reverse());
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]!;
        next.push(sha256(sha256(concatBytes(left, level[i + 1] ?? left))));
      }
      level = next;
    }
    const header = 80 + compactSizeLength(block.entries.length);
    return {
      id: block.hash,
      height: block.height,
      version: 0x20000000,
      timestamp: block.timestamp,
      tx_count: block.entries.length,
      size: header + block.entries.reduce((a, e) => a + e.size, 0),
      weight: header * 4 + block.entries.reduce((a, e) => a + e.weight, 0),
      merkle_root: reversedHex(level[0]!),
      previousblockhash: block.height === 0 ? null : block.parentHash,
      mediantime: block.mediantime,
      nonce: 0,
      bits: 0x207fffff,
      difficulty: 1,
    };
  }

  /** An address's output script, or electrs' refusal text. */
  #addressScript(address: string): Uint8Array | string {
    if (address.length <= 100) {
      try {
        return bitcoin.address.toOutputScript(address, this.network);
      } catch {
        const { bitcoin: main, testnet, regtest } = bitcoin.networks;
        for (const network of [main, testnet, regtest]) {
          try {
            bitcoin.address.toOutputScript(address, network);
            return 'Address on invalid network';
          } catch {
            // Not this network either.
          }
        }
      }
    }
    return 'Invalid Bitcoin address';
  }

  #addressStats(entries: Iterable<Entry>, script: Uint8Array): Record<string, number> {
    let fundedCount = 0;
    let funded = 0n;
    let spentCount = 0;
    let spent = 0n;
    let txCount = 0;
    for (const entry of entries) {
      let touched = false;
      for (const output of entry.outs) {
        if (!equalBytes(output.script, script)) continue;
        fundedCount++;
        funded += output.value;
        touched = true;
      }
      for (const prevout of entry.prevouts) {
        if (!equalBytes(prevout.script, script)) continue;
        spentCount++;
        spent += prevout.value;
        touched = true;
      }
      if (touched) txCount++;
    }
    return {
      funded_txo_count: fundedCount,
      funded_txo_sum: Number(funded),
      spent_txo_count: spentCount,
      spent_txo_sum: Number(spent),
      tx_count: txCount,
    };
  }

  #addressRoute(
    state: State,
    view: View,
    parts: readonly string[],
  ): FakeReply | undefined {
    const [, address, sub, chain, lastSeen] = parts;
    const n = parts.length;
    const shape =
      n === 2 ||
      (n === 3 && sub === 'utxo') ||
      ((n === 4 || n === 5) && sub === 'txs' && chain === 'chain');
    if (!shape) return undefined;
    const script = this.#addressScript(address as string);
    if (typeof script === 'string') return { status: 400, text: script };
    const confirmed = state.chain.slice(0, view.height + 1).flatMap((b) => b.entries);
    if (n === 2) {
      return {
        json: {
          address,
          chain_stats: this.#addressStats(confirmed, script),
          mempool_stats: this.#addressStats(view.pooled.values(), script),
        },
      };
    }
    if (sub === 'utxo') {
      const utxos: Record<string, unknown>[] = [];
      for (const entry of [...confirmed, ...view.pooled.values()]) {
        entry.outs.forEach((output, vout) => {
          if (!equalBytes(output.script, script)) return;
          if (view.spentBy.has(outpointOf(entry.txid, vout))) return;
          utxos.push({
            txid: entry.txid,
            vout,
            status: this.#status(state, view, entry.txid),
            value: Number(output.value),
          });
        });
      }
      return { json: utxos };
    }
    const touches = (entry: Entry) =>
      entry.outs.some((o) => equalBytes(o.script, script)) ||
      entry.prevouts.some((p) => equalBytes(p.script, script));
    const history = [...confirmed].reverse().filter(touches);
    // electrs ignores a cursor that is not a txid, and answers nothing after an unknown one.
    const cursor = lastSeen !== undefined ? parseHash(lastSeen) : undefined;
    let from = 0;
    if (cursor !== undefined) {
      from = history.findIndex((entry) => entry.txid === cursor) + 1;
      if (from === 0) return { json: [] };
    }
    return {
      json: history
        .slice(from, from + PAGE)
        .map((entry) => this.#txJson(state, view, entry)),
    };
  }

  #blockRoute(state: State, view: View, parts: readonly string[]): FakeReply | undefined {
    const [, id, sub, start] = parts;
    const n = parts.length;
    const shape =
      n === 2 || (n === 3 && sub === 'txids') || ((n === 3 || n === 4) && sub === 'txs');
    if (!shape) return undefined;
    const hash = parseHash(id as string);
    if (hash === undefined) return { status: 400, text: 'Invalid hex string' };
    const active = state.chain.find((b) => b.hash === hash && b.height <= view.height);
    if (n === 2) {
      return active
        ? { json: this.#blockJson(active) }
        : { status: 404, text: 'Block not found' };
    }
    // electrs keeps a disconnected block's txids and transactions.
    const stale = state.stale.get(hash);
    const block = active ?? (stale && stale.height <= view.height ? stale : undefined);
    if (!block) return { status: 404, text: 'Block not found' };
    if (sub === 'txids') return { json: block.entries.map((entry) => entry.txid) };
    const first = start === undefined ? 0 : (parseNumber(start, 0xffffffff) ?? 0);
    if (first >= block.entries.length) {
      return { status: 404, text: 'start index out of range' };
    }
    if (first % PAGE !== 0) {
      return { status: 400, text: `start index must be a multipication of ${PAGE}` };
    }
    return {
      json: block.entries
        .slice(first, first + PAGE)
        .map((entry) => this.#txJson(state, view, entry)),
    };
  }

  #txRoute(state: State, view: View, parts: readonly string[]): FakeReply | undefined {
    const [, id, sub, index] = parts;
    const n = parts.length;
    const shape =
      n === 2 ||
      (n === 3 && (sub === 'hex' || sub === 'status')) ||
      (n === 4 && sub === 'outspend');
    if (!shape) return undefined;
    const txid = parseHash(id as string);
    if (txid === undefined) return { status: 400, text: 'Invalid hex string' };
    if (sub === 'status') return { json: this.#status(state, view, txid) };
    if (sub === 'outspend') {
      const vout = parseNumber(index as string, 0xffffffff);
      if (vout === undefined) return { status: 400, text: 'Invalid number' };
      const spender = view.spentBy.get(outpointOf(txid, vout));
      if (spender === undefined) return { json: { spent: false } };
      const entry = this.#lookup(state, view, spender) as Entry;
      return {
        json: {
          spent: true,
          txid: spender,
          vin: entry.ins.findIndex((i) => i.txid === txid && i.vout === vout),
          status: this.#status(state, view, spender),
        },
      };
    }
    const entry = this.#lookup(state, view, txid);
    if (!entry) return { status: 404, text: 'Transaction not found' };
    return sub === 'hex'
      ? { text: entry.hex }
      : { json: this.#txJson(state, view, entry) };
  }

  #broadcast(body: string): FakeReply {
    this.broadcasts.push(body);
    try {
      return { text: this.#submit(body) };
    } catch (error) {
      if (!(error instanceof NodeError)) throw error;
      const text =
        this.options.errorFormat === 'mempool'
          ? `sendrawtransaction RPC error: ${JSON.stringify({ code: error.code, message: error.message })}`
          : `sendrawtransaction RPC error ${error.code}: ${error.message}`;
      return { status: 400, text };
    }
  }

  /** electrs' `handle_request` for one endpoint. */
  #answer(name: string, request: FakeRequest): FakeReply {
    const pathname = request.url.pathname;
    const path = pathname.slice('/api'.length);
    const unknown = {
      status: 404,
      text: `endpoint does not exist ${JSON.stringify(path)}`,
    };
    if (!pathname.startsWith('/api') || (path !== '' && !path.startsWith('/')))
      return unknown;
    const parts = path.split('/').slice(1);
    if (request.method === 'POST') {
      return parts.length === 1 && parts[0] === 'tx'
        ? this.#broadcast(request.body ?? '')
        : unknown;
    }
    if (request.method !== 'GET') return unknown;
    const state = this.#state;
    const view = this.#view(name);
    const [head, a, b] = parts;
    const n = parts.length;
    switch (head) {
      case 'blocks':
        if (n === 3 && a === 'tip' && b === 'height')
          return { text: String(view.height) };
        if (n === 3 && a === 'tip' && b === 'hash') {
          return { text: (state.chain[view.height] as Block).hash };
        }
        return unknown;
      case 'block-height': {
        if (n !== 2) return unknown;
        const height = parseNumber(a as string, Number.MAX_SAFE_INTEGER);
        if (height === undefined) return { status: 400, text: 'Invalid number' };
        const block = height <= view.height ? state.chain[height] : undefined;
        return block ? { text: block.hash } : { status: 404, text: 'Block not found' };
      }
      case 'block':
        return this.#blockRoute(state, view, parts) ?? unknown;
      case 'tx':
        return this.#txRoute(state, view, parts) ?? unknown;
      case 'address':
        return this.#addressRoute(state, view, parts) ?? unknown;
      case 'fee-estimates':
        return n === 1 ? { json: this.#estimates } : unknown;
      default:
        return unknown;
    }
  }
}

/** A txid or block hash as electrs parses one (either case), lowercased. */
function parseHash(value: string): string | undefined {
  return /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : undefined;
}

/** An unsigned integer up to `max`, as Rust's `parse` reads one. */
function parseNumber(value: string, max: number): number | undefined {
  if (!/^\+?\d{1,20}$/.test(value)) return undefined;
  const number = Number(value.replace('+', ''));
  return number <= max ? number : undefined;
}
