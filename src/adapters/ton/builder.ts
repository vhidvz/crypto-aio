/**
 * TON transfers (spec §7, §15): fees, funds, the unsigned external request, its assembly,
 * and the broadcaster. Builds use `read` tags, except the sender's jetton wallet, which the
 * proof quorum attests (I5); sending uses `broadcast` / `ambiguous-on-failure` with the
 * caller's fanout and signal (R41).
 *
 * The fund-safety rules this module keeps:
 * - One output per transfer. The verdict answers `failed` for a partly delivered batch, and
 *   a failed Operation may be sent again whole, paying twice the outputs that moved; so a
 *   TON transfer carries exactly one message, and TON offers no `batch-transfer`.
 * - The built request is decoded again before it is handed out for signing, and must say
 *   exactly what the intent says: the one message's destination, value and bounce flag, or
 *   the jetton transfer's jetton wallet, recipient, amount and forward amount; the memo; the
 *   seqno and lifetime; the wallet (`assertBuilt`).
 * - An emulation that ran nothing is no estimate: every request this builder makes runs the
 *   wallet code (deployed, or deployed by its `StateInit`) and sends one message, so a gas
 *   fee or a forward fee of 0 is never an `expected` draft that `checkFunds` would trust.
 *   tonlib buys the emulated gas with the balance, so a sender whose balance is below what
 *   the transfer must at least send is answered `INSUFFICIENT_FUNDS`; any other such
 *   emulation is a retryable `PROVIDER_INCONSISTENT` (F6-R17).
 * - A node-suggested fee is bounded by the network's `maxNetworkFee` (the economic ceiling).
 * - A frozen wallet, or an undeployed one at an allocated seqno past 0, is refused from its
 *   state before anything is built.
 */
import {
  Cell,
  beginCell,
  loadMessage,
  storeMessageRelaxed,
  type MessageRelaxed,
} from '@ton/core';
import { computeMessageForwardFees, configParseMsgPrices } from '@ton/ton';
import type {
  BroadcastResult,
  BuildContext,
  Broadcaster,
  FundsCheck,
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
  isCryptoAioError,
} from '../../core/errors/error';
import { assetId, type AssetRef } from '../../core/model/asset';
import type { FeeEstimateDraft } from '../../core/model/fee';
import type { DriverIntent, DriverOutput } from '../../core/model/intent';
import type { UnsignedTx } from '../../core/model/transaction';
import type { SigningRequest } from '../../core/signing/types';
import { BROADCAST, PROOF, READ, type AccountState } from './api';
import { classifyBroadcastError } from './errors';
import {
  feeRequest,
  networkFee,
  tonFeeDetails,
  tonFeeDraft,
  type FeeRequest,
} from './fees';
import {
  MAX_MEMO_BYTES,
  cellFromBoc,
  decodeComment,
  decodeJettonTransfer,
  decodeWalletRequest,
  jettonMessage,
  memoBytes,
  messageFacts,
  nativeMessage,
  sdkAddress,
} from './messages';
import {
  normalizedHash,
  resolveIdentity,
  SEND_MODE,
  signedRequest,
  unsignedRequest,
  walletAddress,
  walletIdOf,
  walletStateInit,
  type TonIdentity,
} from './wallets';
import {
  jettonBalance,
  jettonMaster,
  jettonWalletAddress,
  walletSeqno,
  type TonContext,
} from './reader';
import type { TonFeeDetails } from './types';

/** The id of the one signing request (spec §15: 1 × ed25519 over the signing cell hash). */
export const REQUEST_ID = 'wallet';

/** How far an endpoint's `sync_utime` may be from the local clock (M3), in seconds. */
export const CHAIN_TIME_TOLERANCE = 300;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const inconsistent = (reason: string) =>
  new ProviderError('PROVIDER_INCONSISTENT', reason, { retryable: true });

/**
 * The funds path's answer when the balance is below what the transfer must at least send
 * (`required`: a lower bound, before gas), as the engine reports a failed funds check.
 */
const insufficient = (required: bigint, available: bigint) =>
  new ChainError('INSUFFICIENT_FUNDS', 'insufficient funds for this transfer', {
    details: { required: required.toString(), available: available.toString() },
  });

/** The one output, with the bounce flag its address variant gives it. */
interface Output {
  readonly to: string;
  readonly amount: bigint;
  readonly bounce: boolean;
}

interface Plan {
  readonly identity: TonIdentity;
  readonly key: WalletKey;
  readonly output: Output;
  readonly jetton?: { readonly master: string; readonly asset: AssetRef };
  readonly request: FeeRequest;
  /** Jettons: the value attached to the jetton wallet message (override or network default). */
  readonly attached?: bigint;
}

/**
 * The recipient's bounce flag (spec §6.4, D7): the variant is `{ bounceable }` only
 * (P25-R13), and a raw address without one is bounceable. Any other variant did not come
 * from the TON codec, and the driver never guesses what it meant.
 */
function bounceOf(output: DriverOutput): boolean {
  const variant = output.variant;
  if (variant === undefined) return true;
  const keys = Object.keys(variant);
  const flag = Object.hasOwn(variant, 'bounceable') ? variant.bounceable : undefined;
  if (keys.length !== 1 || typeof flag !== 'boolean') {
    throw new ValidationError(
      'INVALID_INTENT',
      `a TON recipient's variant holds only its bounce flag`,
    );
  }
  return flag;
}

/**
 * The checks every builder method runs before any codec, signing or I/O work (lesson 5):
 * the wallet identity derives exactly `from`, the intent is one output with a memo that
 * fits, and the fee is TON's.
 */
function planOf(ctx: TonContext, intent: DriverIntent, build: BuildContext): Plan {
  const identity = resolveIdentity(build.wallet, ctx.config.globalId);
  const key = build.keys.find((k) => k.scheme === 'ed25519');
  if (!key) throw new ConfigError('CONFIG_INVALID', 'the TON wallet has no ed25519 key');
  if (
    walletAddress(identity, key.publicKey) !== build.from ||
    intent.from !== build.from
  ) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'the TON wallet identity does not derive the sending address',
    );
  }
  if (intent.outputs.length > 1) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'a TON transfer carries exactly one output (no batch transfers)',
    );
  }
  const [first] = intent.outputs;
  if (!first)
    throw new ValidationError('INVALID_INTENT', 'a TON transfer needs an output');
  if (intent.memo !== undefined && memoBytes(intent.memo) > MAX_MEMO_BYTES) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a TON memo is at most ${MAX_MEMO_BYTES} bytes`,
    );
  }
  sdkAddress(first.to); // INVALID_ADDRESS unless raw (lesson 4)
  const output = { to: first.to, amount: first.amount, bounce: bounceOf(first) };
  const asset = intent.asset;
  let jetton: Plan['jetton'];
  if (asset !== 'native') {
    const master = jettonMaster(ctx, asset);
    jetton = { master, asset: { standard: 'jetton', contract: master } };
  }
  const request = feeRequest(intent.fee, jetton !== undefined);
  const attached = jetton ? (request.attached ?? ctx.config.jettonAttached) : undefined;
  // The attached value pays the recipient's notification and more: at or below the forward
  // amount the jetton wallet cannot run the transfer.
  if (attached !== undefined && attached <= ctx.config.jettonForwardAmount) {
    throw new ValidationError(
      'INVALID_INTENT',
      `'attached' must exceed the network's jetton forward amount`,
    );
  }
  return {
    identity,
    key,
    output,
    ...(jetton ? { jetton } : {}),
    request,
    ...(attached !== undefined ? { attached } : {}),
  };
}

/** The allocated seqno (lesson 19: a uint32); a build never runs without one. */
function seqnoOf(build: BuildContext): number {
  const ordering = build.ordering;
  if (ordering?.kind !== 'seqno' || ordering.seqno > 0xffffffffn || ordering.seqno < 0n) {
    throw new ValidationError(
      'INVALID_INTENT',
      'a TON transfer needs its allocated seqno',
    );
  }
  return Number(ordering.seqno);
}

/**
 * The fee draft `build` and `checkFunds` are given, read strictly (R11): TON's, and made for
 * this transfer's attached value (none for native coin).
 */
function feeOf(fee: FeeEstimateDraft, plan: Plan): TonFeeDetails {
  const details = tonFeeDetails(fee.details);
  if (fee.kind !== 'ton' || details.attached !== plan.attached) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the fee estimate was not made for this TON transfer',
    );
  }
  return details;
}

/** The wallet's state; a frozen wallet runs no message, its deploy `StateInit` included. */
async function walletState(ctx: TonContext, from: string): Promise<AccountState> {
  const state = await ctx.api.account(from, READ);
  if (state.status === 'frozen') {
    throw new ChainError('TX_REFUSED', 'the wallet account is frozen');
  }
  return state;
}

/**
 * I6: an undeployed wallet only runs a request at seqno 0 (its `StateInit`'s). At a later
 * allocated seqno the state lags, or the wallet was deleted, and its `StateInit` would
 * restart it at 0: either way nothing is built, and a later read decides.
 */
function assertDeployable(state: AccountState, seqno: number): void {
  if (state.status === 'uninitialized' && seqno !== 0) {
    throw inconsistent('the wallet is not deployed at the allocated seqno');
  }
}

/** M3: the endpoint's chain time, when it is within the tolerance of the local clock. */
function chainTime(ctx: TonContext, state: AccountState): number {
  if (Math.abs(state.syncUtime - ctx.clock.now() / 1000) > CHAIN_TIME_TOLERANCE) {
    throw inconsistent('the endpoint reports a chain time far from the local clock');
  }
  return state.syncUtime;
}

/** The one message, and for jettons the sender's jetton wallet it goes to. */
async function messageOf(
  ctx: TonContext,
  intent: DriverIntent,
  plan: Plan,
  from: string,
  queryId: bigint,
): Promise<{ readonly message: MessageRelaxed; readonly jettonWallet?: string }> {
  const { output } = plan;
  const memo = intent.memo !== undefined ? { memo: intent.memo } : {};
  if (!plan.jetton || plan.attached === undefined) {
    return {
      message: nativeMessage({
        to: output.to,
        value: output.amount,
        bounce: output.bounce,
        ...memo,
      }),
    };
  }
  // I5 and C8-4: the jetton wallet is the one the intent's master names for our wallet, as
  // the proof quorum attests it (cached only so). The verdict's legs carry no master, so
  // this is what binds a transfer to the intended jetton.
  const jettonWallet = await jettonWalletAddress(ctx, plan.jetton.master, from, PROOF);
  return {
    jettonWallet,
    message: jettonMessage({
      jettonWallet,
      attached: plan.attached,
      queryId,
      amount: output.amount,
      destination: output.to,
      responseDestination: from,
      forwardAmount: ctx.config.jettonForwardAmount,
      ...memo,
    }),
  };
}

const malformedConfig = () =>
  new ProviderError('PROVIDER_UNAVAILABLE', 'malformed message prices in the config', {
    retryable: true,
  });

/**
 * The config's forward fee of `message` (D13): param 25, or 24 when the masterchain is
 * involved (transaction.cpp prices a message by the source's or the destination's chain).
 * The cell goes through the capped `cellFromBoc` (lesson 20); an answer that does not parse
 * is the endpoint's fault, retryable, never a bare SDK error (M12).
 */
async function configForwardFee(
  ctx: TonContext,
  from: string,
  message: MessageRelaxed,
): Promise<bigint> {
  const masterchain =
    from.startsWith('-1:') ||
    (message.info.type === 'internal' && message.info.dest.workChain === -1);
  const cell = cellFromBoc(await ctx.api.configParam(masterchain ? 24 : 25, READ));
  if (!cell) throw malformedConfig();
  try {
    const prices = configParseMsgPrices(cell.beginParse());
    const stored = beginCell().store(storeMessageRelaxed(message)).endCell();
    const { fees, remaining } = computeMessageForwardFees(prices, stored);
    return fees + remaining;
  } catch {
    throw malformedConfig();
  }
}

/** The external message's body (the wallet request) as a base64 BOC. */
const bodyOf = (external: Cell): string =>
  loadMessage(external.beginParse()).body.toBoc().toString('base64');

/**
 * The recipient binding: the unsigned external message, decoded again, says exactly what
 * the intent says. It goes to `from`, deploys exactly when asked, carries our wallet's
 * request at `seqno` until `validUntil`, and sends one message with `SEND_MODE` exactly
 * (never +128, which sends the whole balance, nor +32), no extra currencies and no
 * `StateInit`: native coin to the recipient with its value, bounce flag and memo; or a
 * jetton `transfer` to the attested jetton wallet with the attached value, bounceable, naming
 * the recipient, the amount, `from` for the excess, no custom payload, the network's forward
 * amount, the memo and the seqno as query id. Anything else is never handed out for signing
 * (`INVALID_INTENT`, fixed text).
 */
function assertBuilt(
  ctx: TonContext,
  intent: DriverIntent,
  plan: Plan,
  unsigned: Cell,
  expected: {
    readonly from: string;
    readonly deploy: boolean;
    readonly seqno: number;
    readonly validUntil: number;
    readonly jettonWallet?: string;
  },
): void {
  const refuse = (): never => {
    throw new ValidationError(
      'INVALID_INTENT',
      'the built TON message does not match the intent',
    );
  };
  let external: ReturnType<typeof loadMessage>;
  try {
    external = loadMessage(unsigned.beginParse());
  } catch {
    return refuse();
  }
  if (
    external.info.type !== 'external-in' ||
    external.info.dest.toRawString() !== expected.from ||
    Boolean(external.init) !== expected.deploy
  ) {
    refuse();
  }
  const request = decodeWalletRequest(external.body);
  if (
    request?.auth !== 'external' ||
    request.seqno !== expected.seqno ||
    request.validUntil !== expected.validUntil ||
    request.walletId !== walletIdOf(plan.identity, plan.key.publicKey) ||
    request.messages.length !== 1 ||
    request.modes.length !== 1 ||
    request.modes[0] !== SEND_MODE
  ) {
    return refuse();
  }
  const message = request.messages[0] as MessageRelaxed;
  const facts = messageFacts(message);
  if (
    !facts ||
    message.info.type !== 'internal' ||
    (message.info.value.other?.size ?? 0) > 0 ||
    message.init
  ) {
    return refuse();
  }
  const { output } = plan;
  if (!plan.jetton) {
    const memo =
      intent.memo !== undefined
        ? decodeComment(facts.body) === intent.memo
        : facts.body.bits.length === 0 && facts.body.refs.length === 0;
    if (
      facts.to !== output.to ||
      facts.value !== output.amount ||
      message.info.bounce !== output.bounce ||
      !memo
    ) {
      refuse();
    }
    return;
  }
  const transfer = decodeJettonTransfer(facts.body);
  if (
    facts.to !== expected.jettonWallet ||
    facts.value !== plan.attached ||
    !message.info.bounce ||
    transfer?.destination !== output.to ||
    transfer.amount !== output.amount ||
    transfer.queryId !== BigInt(expected.seqno) ||
    transfer.responseDestination !== expected.from ||
    transfer.customPayload ||
    transfer.forwardAmount !== ctx.config.jettonForwardAmount ||
    transfer.comment !== intent.memo
  ) {
    refuse();
  }
}

export function createTonBuilder(ctx: TonContext): TxBuilder {
  const { api, config } = ctx;
  return {
    async estimateFee(intent, build): Promise<FeeEstimateDraft> {
      const plan = planOf(ctx, intent, build);
      const state = await walletState(ctx, build.from);
      const now = chainTime(ctx, state);
      const deploy = state.status === 'uninitialized';
      // The engine allocates the seqno; an estimate outside it (`Blockchain.estimateFee`)
      // runs at the wallet's live one, read at the state's own block (Task 8), since the
      // wallet code refuses any other and the emulation would then run nothing.
      const seqno =
        build.ordering !== undefined
          ? seqnoOf(build)
          : deploy
            ? 0
            : Number(await walletSeqno(ctx, build.from, READ));
      assertDeployable(state, seqno);
      const { message } = await messageOf(ctx, intent, plan, build.from, BigInt(seqno));
      const unsigned = await unsignedRequest(plan.identity, plan.key.publicKey, {
        seqno,
        validUntil: now + config.validForSeconds,
        messages: [message],
        deploy: false,
      });
      const init = deploy
        ? walletStateInit(plan.identity, plan.key.publicKey)
        : undefined;
      const emulated = await api.estimateFee(
        {
          address: build.from,
          body: bodyOf(unsigned.message),
          ...(init?.code && init.data
            ? {
                initCode: init.code.toBoc().toString('base64'),
                initData: init.data.toBoc().toString('base64'),
              }
            : {}),
        },
        READ,
      );
      // I3: the forward fee counts once. The emulation's follows the real action list; the
      // config's formula is its floor, so an endpoint that reports less cannot shrink it.
      const computed = await configForwardFee(ctx, build.from, message);
      // The economic ceiling by the sender's workchain. F6-R20: the config's forward fee
      // comes from one endpoint too, so it is held to the ceiling before anything trusts it:
      // an inflated param 25 must never turn an empty emulation into a definitive shortfall.
      const ceiling = build.from.startsWith('-1:')
        ? config.maxNetworkFee.masterchain
        : config.maxNetworkFee.basechain;
      if (computed > ceiling) {
        throw inconsistent(
          "the endpoint's config prices a forward fee above the policy maximum",
        );
      }
      // Task 6 review: the wallet runs (deployed, or by its `StateInit`) and sends one
      // message, so an emulation without gas or without a forward fee ran nothing.
      if (emulated.gasFee === 0n || emulated.forwardFee === 0n) {
        // F6-R17: tonlib buys the emulated gas with the balance (`compute_gas_limits`), so
        // a sender that cannot pay emulates to nothing too. Below what the transfer must at
        // least send (the amount, or the jetton attached value, plus the config's forward
        // fee) that is the answer; otherwise the endpoint's view lags, or it refused the
        // request (another seqno), and a later read decides.
        const minimum = (plan.attached ?? plan.output.amount) + computed;
        if (state.balance < minimum) throw insufficient(minimum, state.balance);
        throw inconsistent("the endpoint's emulation did not run the transfer");
      }
      const details: TonFeeDetails = {
        importFee: emulated.importFee,
        gasFee: emulated.gasFee,
        storageFee: emulated.storageFee,
        ...(emulated.forwardFee >= computed
          ? { forwardFee: emulated.forwardFee, forwardFeeSource: 'emulated' as const }
          : { forwardFee: computed, forwardFeeSource: 'computed' as const }),
        deploy,
        ...(plan.attached !== undefined
          ? { attached: plan.attached, forwardAmount: config.jettonForwardAmount }
          : {}),
      };
      if (networkFee(details) > ceiling) {
        throw inconsistent('the endpoint suggests a fee above the policy maximum');
      }
      return tonFeeDraft({
        speed: plan.request.speed,
        details,
        ...(plan.jetton ? { jettonOutputs: 1 } : {}),
        payer: build.from,
      });
    },

    async checkFunds(intent, fee, build): Promise<FundsCheck> {
      const plan = planOf(ctx, intent, build);
      const details = feeOf(fee, plan);
      const charges = networkFee(details) + (details.attached ?? 0n);
      const available = (await walletState(ctx, build.from)).balance;
      const required = charges + (plan.jetton ? 0n : plan.output.amount);
      if (available < required) {
        return { ok: false, asset: 'native', required, available };
      }
      if (plan.jetton) {
        const wanted = plan.output.amount;
        const held = await jettonBalance(ctx, plan.jetton.master, build.from, READ);
        if (held < wanted) {
          return {
            ok: false,
            asset: plan.jetton.asset,
            required: wanted,
            available: held,
          };
        }
      }
      return { ok: true };
    },

    async build(intent, fee, build): Promise<UnsignedTx> {
      const plan = planOf(ctx, intent, build);
      const seqno = seqnoOf(build);
      feeOf(fee, plan);
      const state = await walletState(ctx, build.from);
      // M3 and D8: the lifetime runs from the endpoint's chain time, bounded by the local
      // clock; Task 10 proves expiry against attested chain time, never a node's clock.
      const validUntil = chainTime(ctx, state) + config.validForSeconds;
      assertDeployable(state, seqno);
      const deploy = state.status === 'uninitialized';
      const { message, jettonWallet } = await messageOf(
        ctx,
        intent,
        plan,
        build.from,
        BigInt(seqno),
      );
      const unsigned = await unsignedRequest(plan.identity, plan.key.publicKey, {
        seqno,
        validUntil,
        messages: [message],
        deploy,
      });
      assertBuilt(ctx, intent, plan, unsigned.message, {
        from: build.from,
        deploy,
        seqno,
        validUntil,
        ...(jettonWallet !== undefined ? { jettonWallet } : {}),
      });
      const request: SigningRequest = {
        id: REQUEST_ID,
        scheme: 'ed25519',
        payload: unsigned.digest,
        payloadKind: 'message',
        publicKey: plan.key.publicKey,
        ...(plan.key.keyRef ? { keyRef: plan.key.keyRef } : {}),
      };
      return {
        payload: {
          encoding: 'base64',
          data: unsigned.message.toBoc().toString('base64'),
        },
        signingRequests: [request],
        ordering: { kind: 'seqno', seqno: BigInt(seqno), validUntil },
        fee,
        summary: {
          asset: assetId(ctx.chain.id, ctx.network.id, plan.jetton?.asset ?? 'native'),
          outputs: [{ to: plan.output.to, amount: plan.output.amount.toString() }],
          ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
        },
      };
    },

    async assemble(unsigned, signatures) {
      const request = unsigned.signingRequests[0];
      const signature = signatures.find((s) => s.requestId === request?.id);
      if (!request || !signature || signature.bytes.length !== 64) {
        throw new SigningError('SIGNING_FAILED', 'the wallet signature is missing');
      }
      const payload =
        unsigned.payload.encoding === 'base64'
          ? cellFromBoc(unsigned.payload.data)
          : null;
      if (!payload) {
        throw new SigningError(
          'SIGNING_FAILED',
          'the unsigned TON payload does not parse',
        );
      }
      // D5: the signature goes only where the rest of the request hashes to its digest.
      const signed = signedRequest(payload, request.payload, signature.bytes);
      return {
        raw: { encoding: 'base64', data: signed.toBoc().toString('base64') },
        ref: {
          id: hex(normalizedHash(signed)),
          idKind: 'message-hash',
          canonical: false,
        },
      };
    },
  };
}

const MALFORMED: BroadcastResult = Object.freeze({
  kind: 'rejected',
  reason: 'malformed message',
});

/**
 * The normalized hash of raw bytes, or null when they are no external message. The bytes
 * go through the capped `cellFromBoc` (lesson 20): a bare broadcast's bytes are anyone's.
 */
function hashOfRaw(data: string): string | null {
  const cell = cellFromBoc(data);
  if (!cell) return null;
  try {
    return hex(normalizedHash(cell));
  } catch {
    return null;
  }
}

/** The node's own error text inside a v2 error body (`{ ok: false, error }`), if any. */
function nodeText(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const text = (parsed as Record<string, unknown>).error;
      if (typeof text === 'string') return text;
    }
  } catch {
    // Not JSON, or cut by the transport: the body itself is the text.
  }
  return body;
}

export function createTonBroadcaster(ctx: TonContext): Broadcaster {
  return {
    async broadcast(signed, options = {}) {
      // Bytes that are no external message can never be valid anywhere: `rejected`, from
      // our own parse, is the only rejection (lesson 21, F6-R9: never from a node's text).
      if (signed.raw.encoding !== 'base64') return MALFORMED;
      const expected = hashOfRaw(signed.raw.data);
      if (expected === null) return MALFORMED;
      try {
        const sent = await ctx.api.send(signed.raw.data, {
          ...BROADCAST,
          ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (sent.hashNorm !== expected) {
          ctx.log.warn('the node reports another normalized message hash', {
            code: 'MESSAGE_HASH_MISMATCH',
          });
        }
        return { kind: 'accepted' };
      } catch (error) {
        // D16, lesson 3: only a definitive 4xx answer is classified, and the classifier
        // itself throws a retryable, ambiguous error for a "not now" answer (F6-R10). A
        // 429, 408, 5xx (toncenter's refusals), a timeout or any answer after an attempt
        // that may have been delivered goes back unchanged: the ambiguous path.
        if (isCryptoAioError(error, 'RPC_ERROR') && !error.ambiguous) {
          return classifyBroadcastError(nodeText(error.details?.body) ?? error.message);
        }
        throw error;
      }
    },
  };
}
