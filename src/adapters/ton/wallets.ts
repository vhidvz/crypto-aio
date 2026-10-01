/**
 * TON wallet contracts, over `@ton/core` and `@ton/ton`: the wallet identity,
 * its address and `StateInit`, the signing message, and the external message around it.
 * Loaded only through the adapter manifest's `load()`.
 *
 * Signing flow: `build` asks the SDK for the transfer body with a zero signature and keeps
 * the whole unsigned external message (a BOC) as the payload; the one ed25519 request signs
 * the signing message's cell hash. `assemble` finds the 512 zero bits the signature
 * replaces (front for v4r2, tail for v5r1) by the one position whose remainder hashes to
 * the signed digest, so it needs no wallet version and cannot write a signature anywhere
 * else.
 */
import {
  Cell,
  SendMode,
  beginCell,
  external,
  loadMessage,
  storeMessage,
  type Message,
  type MessageRelaxed,
  type StateInit,
} from '@ton/core';
import { ed25519 } from '@noble/curves/ed25519';
import { WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import type { WalletOptions } from '../../core/driver/types';
import { ConfigError, SigningError, ValidationError } from '../../core/errors/error';
import { rawAddress, type TonWorkchain } from './address';
import { OP, sdkAddress } from './messages';
import type { TonWalletVersion } from './types';

/** Messages one external request may carry: 4 refs per cell (v4r2), 255 (v5r1). */
export const MAX_MESSAGES: Readonly<Record<TonWalletVersion, number>> = Object.freeze({
  v4r2: 4,
  v5r1: 255,
});

/** Pay forward fees separately and never fail the action phase (W5 requires +2). */
export const SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;

/** The resolved wallet identity: every field that determines the address. */
export type TonIdentity =
  | {
      readonly version: 'v4r2';
      readonly workchain: TonWorkchain;
      readonly subwalletId: number;
    }
  | {
      readonly version: 'v5r1';
      readonly workchain: TonWorkchain;
      readonly subwalletNumber: number;
      readonly networkGlobalId: number;
    };

const V4_KEYS = new Set(['version', 'workchain', 'subwalletId']);
const V5_KEYS = new Set(['version', 'workchain', 'subwalletNumber', 'networkGlobalId']);

/**
 * `wallets.<name>.ton` validated against the network: a v5r1 wallet id made for
 * another network is refused before any key is used. Every problem is `CONFIG_INVALID`.
 */
export function resolveIdentity(
  wallet: WalletOptions | undefined,
  globalId: number,
): TonIdentity {
  const fail = (reason: string): never => {
    throw new ConfigError('CONFIG_INVALID', `TON wallet: ${reason}`);
  };
  const ton = wallet?.ton;
  if (ton === undefined || ton === null || typeof ton !== 'object') {
    return fail(`set wallets.<name>.ton = { version: 'v4r2' | 'v5r1' }`);
  }
  const config = ton as Record<string, unknown>;
  const version = config.version;
  if (version !== 'v4r2' && version !== 'v5r1') {
    return fail(`version must be 'v4r2' or 'v5r1'`);
  }
  const allowed = version === 'v4r2' ? V4_KEYS : V5_KEYS;
  for (const key of Object.keys(config)) {
    if (config[key] !== undefined && !allowed.has(key)) {
      // The caller's key is never echoed (it could be a pasted secret).
      fail(`a ${version} wallet takes only ${[...allowed].join(', ')}`);
    }
  }
  const workchain = config.workchain ?? 0;
  if (workchain !== 0 && workchain !== -1) fail('workchain must be 0 or -1');
  const wc = workchain as TonWorkchain;
  if (version === 'v4r2') {
    const subwalletId = config.subwalletId ?? 698983191 + wc;
    if (
      !Number.isInteger(subwalletId) ||
      (subwalletId as number) < 0 ||
      (subwalletId as number) > 0xffffffff
    ) {
      fail('subwalletId must be an integer in [0, 2^32 - 1]');
    }
    return { version, workchain: wc, subwalletId: subwalletId as number };
  }
  const subwalletNumber = config.subwalletNumber ?? 0;
  if (
    !Number.isInteger(subwalletNumber) ||
    (subwalletNumber as number) < 0 ||
    (subwalletNumber as number) > 0x7fff
  ) {
    fail('subwalletNumber must be an integer in [0, 32767]');
  }
  const networkGlobalId = config.networkGlobalId ?? globalId;
  if (networkGlobalId !== globalId) {
    fail(`networkGlobalId is not this network's (${globalId})`);
  }
  return {
    version,
    workchain: wc,
    subwalletNumber: subwalletNumber as number,
    networkGlobalId: globalId,
  };
}

type WalletContract = WalletContractV4 | WalletContractV5R1;

/** A strict (RFC 8032) encoding of a point that is not of small order. */
function canonicalKey(publicKey: Uint8Array): boolean {
  try {
    return !ed25519.Point.fromHex(publicKey, false).isSmallOrder();
  } catch {
    return false;
  }
}

const isInt = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

/**
 * Every identity field fits the wire field the SDK writes it into (workchain
 * int8, subwallet id uint32, subwallet number uint15, network id int32), so an identity
 * not made by `resolveIdentity` is refused rather than wrapped or thrown as a bare `Error`.
 */
function identityFits(identity: TonIdentity): boolean {
  if (identity.workchain !== 0 && identity.workchain !== -1) return false;
  if (identity.version === 'v4r2') return isInt(identity.subwalletId, 0, 0xffffffff);
  return (
    identity.version === 'v5r1' &&
    isInt(identity.subwalletNumber, 0, 0x7fff) &&
    isInt(identity.networkGlobalId, -0x80000000, 0x7fffffff)
  );
}

function contractOf(identity: TonIdentity, publicKey: Uint8Array): WalletContract {
  if (!identityFits(identity)) {
    throw new ConfigError('CONFIG_INVALID', 'the TON wallet identity is out of range');
  }
  if (publicKey.length !== 32 || !canonicalKey(publicKey)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'a TON wallet key must be a canonical 32-byte ed25519 public key',
    );
  }
  const key = Buffer.from(publicKey);
  if (identity.version === 'v4r2') {
    return WalletContractV4.create({
      workchain: identity.workchain,
      publicKey: key,
      walletId: identity.subwalletId,
    });
  }
  // Every field explicit: the SDK's defaults are mainnet's id and workchain 0.
  return WalletContractV5R1.create({
    publicKey: key,
    walletId: {
      networkGlobalId: identity.networkGlobalId,
      context: {
        workchain: identity.workchain,
        walletVersion: 'v5r1',
        subwalletNumber: identity.subwalletNumber,
      },
    },
  });
}

/** The wallet's raw address: the hash of its `StateInit` in its workchain. */
export function walletAddress(identity: TonIdentity, publicKey: Uint8Array): string {
  const contract = contractOf(identity, publicKey);
  return rawAddress(identity.workchain, contract.address.hash);
}

/** The code and data a first message carries to deploy the wallet. */
export function walletStateInit(identity: TonIdentity, publicKey: Uint8Array): StateInit {
  const { init } = contractOf(identity, publicKey);
  return { code: init.code, data: init.data };
}

/** The wallet's wire wallet id (v4r2: the subwallet id; v5r1: the signed 32-bit id). */
export function walletIdOf(identity: TonIdentity, publicKey: Uint8Array): number {
  const contract = contractOf(identity, publicKey);
  if (contract instanceof WalletContractV4) return contract.walletId;
  // v5r1 data: is_signature_allowed:1 seqno:32 wallet_id:int32 public_key:256 extensions.
  const data = contract.init.data.beginParse();
  data.skip(1 + 32);
  return data.loadInt(32);
}

export interface UnsignedRequest {
  /** The unsigned external message: the wallet body with 512 zero bits for the signature. */
  readonly message: Cell;
  /** The signing message's cell hash: what the ed25519 key signs. */
  readonly digest: Uint8Array;
}

/**
 * The external request for `messages` at `seqno`, valid while chain time is before
 * `validUntil` (seconds). `init` deploys the wallet with its first message.
 */
export async function unsignedRequest(
  identity: TonIdentity,
  publicKey: Uint8Array,
  args: {
    readonly seqno: number;
    readonly validUntil: number;
    readonly messages: readonly MessageRelaxed[];
    readonly deploy: boolean;
  },
): Promise<UnsignedRequest> {
  // The seqno is a uint32 on the wire, never wrapped.
  if (!Number.isSafeInteger(args.seqno) || args.seqno < 0 || args.seqno > 0xffffffff) {
    throw new ValidationError('INVALID_INTENT', 'seqno must be a uint32');
  }
  // The SDK falls back to the wall clock for a falsy timeout; never let it.
  if (
    !Number.isSafeInteger(args.validUntil) ||
    args.validUntil <= 0 ||
    args.validUntil > 0xffffffff
  ) {
    throw new ValidationError('INVALID_INTENT', 'validUntil must be a uint32 above 0');
  }
  if (
    args.messages.length === 0 ||
    args.messages.length > MAX_MESSAGES[identity.version]
  ) {
    throw new ValidationError(
      'INVALID_INTENT',
      `a ${identity.version} request carries 1 to ${MAX_MESSAGES[identity.version]} messages`,
    );
  }
  const contract = contractOf(identity, publicKey);
  let signing: Cell | undefined;
  const transfer = {
    seqno: args.seqno,
    timeout: args.validUntil,
    sendMode: SEND_MODE,
    messages: [...args.messages],
    signer: async (cell: Cell): Promise<Buffer> => {
      signing = cell;
      return Buffer.alloc(64);
    },
  };
  let message: Cell;
  try {
    const body = await (contract instanceof WalletContractV4
      ? contract.createTransfer(transfer)
      : contract.createTransfer(transfer));
    message = beginCell()
      .store(
        storeMessage(
          external({
            to: contract.address,
            body,
            ...(args.deploy
              ? { init: { code: contract.init.code, data: contract.init.data } }
              : {}),
          }),
        ),
      )
      .endCell();
  } catch {
    // The SDK throws bare errors that may name a value; `nativeMessage` and
    // `jettonMessage` range-check theirs, so only a hand-built message ends here.
    throw new ValidationError('INVALID_INTENT', 'the TON request cannot be encoded');
  }
  if (!signing) {
    throw new SigningError('SIGNING_FAILED', 'the SDK did not produce a signing message');
  }
  return { message, digest: new Uint8Array(signing.hash()) };
}

/** The message in `cell`, or undefined when it holds none (the SDK throws a bare `Error`). */
function messageOf(cell: Cell): Message | undefined {
  try {
    return loadMessage(cell.beginParse());
  } catch {
    return undefined;
  }
}

/** A cell of `bits` then `refs`. */
function cellOf(parts: readonly (Buffer | Cell['bits'])[], refs: readonly Cell[]): Cell {
  const builder = beginCell();
  for (const part of parts) {
    if (Buffer.isBuffer(part)) builder.storeBuffer(part);
    else builder.storeBits(part);
  }
  for (const ref of refs) builder.storeRef(ref);
  return builder.endCell();
}

const ZERO_SIGNATURE = Buffer.alloc(64);

/**
 * The signed external message: `signature` in place of the 512 zero bits whose remainder
 * hashes to `digest` (the front for v4r2, the tail for v5r1). Refuses (`SIGNING_FAILED`) a
 * payload with no such position, so a signature can never land anywhere else.
 */
export function signedRequest(
  unsigned: Cell,
  digest: Uint8Array,
  signature: Uint8Array,
): Cell {
  if (signature.length !== 64) {
    throw new SigningError('SIGNING_FAILED', 'a TON signature is 64 bytes');
  }
  const message = messageOf(unsigned);
  if (message?.info.type !== 'external-in') {
    throw new SigningError(
      'SIGNING_FAILED',
      'the unsigned TON payload is not an external message',
    );
  }
  const { body } = message;
  const length = body.bits.length;
  const expected = Buffer.from(digest);
  const zero = cellOf([ZERO_SIGNATURE], []).bits;
  const sig = Buffer.from(signature);
  let signedBody: Cell | undefined;
  if (length >= 512) {
    const front = body.bits.substring(0, 512);
    const afterFront = body.bits.substring(512, length - 512);
    const tail = body.bits.substring(length - 512, 512);
    const beforeTail = body.bits.substring(0, length - 512);
    if (front.equals(zero) && cellOf([afterFront], body.refs).hash().equals(expected)) {
      signedBody = cellOf([sig, afterFront], body.refs);
    } else if (
      tail.equals(zero) &&
      cellOf([beforeTail], body.refs).hash().equals(expected)
    ) {
      signedBody = cellOf([beforeTail, sig], body.refs);
    }
  }
  if (!signedBody) {
    throw new SigningError(
      'SIGNING_FAILED',
      'the unsigned TON payload does not match its signing request',
    );
  }
  return beginCell()
    .store(
      storeMessage({
        info: message.info,
        ...(message.init ? { init: message.init } : {}),
        body: signedBody,
      }),
    )
    .endCell();
}

/**
 * TEP-467: the hash of the external-in message with `src` = addr_none, `import_fee` = 0,
 * no `init`, and the body always as a reference. Stable across relays; the Attempt id.
 */
export function normalizedHash(externalMessage: Cell): Uint8Array {
  const message = messageOf(externalMessage);
  if (message?.info.type !== 'external-in') {
    throw new ValidationError('INVALID_INTENT', 'not an external-in message');
  }
  const normalized = beginCell()
    .storeUint(2, 2)
    .storeUint(0, 2)
    .storeAddress(message.info.dest)
    .storeCoins(0)
    .storeBit(false)
    .storeBit(true)
    .storeRef(message.body)
    .endCell();
  return new Uint8Array(normalized.hash());
}

/**
 * Whether the wallet request `body` (external, or a W5
 * `internal_signed` request relayed in an internal message) is `from`'s own. Anyone can post
 * a relayed body, and a lone lying indexer can make up an external one, so a request
 * proves nothing unless its ed25519 signature verifies over the rest of the request under
 * `publicKey`, the wallet's key (v4r2: the first 512 bits; v5r1: the last 512), and its
 * wallet id derives `from` with that key (v4r2: the subwallet id in `from`'s workchain;
 * v5r1: the signed wallet id). A request of another wallet sharing the key, replayed
 * here, never counts. For a relayed request the caller also requires the transaction's
 * compute phase to have succeeded, i.e. the wallet ran it.
 */
export function requestIsOwn(
  from: string,
  body: Cell,
  publicKey: Uint8Array,
  globalId: number,
): boolean {
  try {
    const length = body.bits.length;
    if (length < 512 + 32 || publicKey.length !== 32) return false;
    const op = body.beginParse().preloadUint(32);
    const v5 = op === OP.w5SignedExternal || op === OP.w5SignedInternal;
    const [signed, rest] = v5
      ? [body.bits.substring(length - 512, 512), body.bits.substring(0, length - 512)]
      : [body.bits.substring(0, 512), body.bits.substring(512, length - 512)];
    const signing = cellOf([rest], body.refs);
    const signature = cellOf([signed], []).beginParse().loadBuffer(64);
    if (!ed25519.verify(signature, signing.hash(), publicKey)) return false;
    const identity = v5
      ? v5IdentityOf(signing.beginParse().skip(32).loadInt(32), globalId)
      : v4IdentityOf(from, signing.beginParse().loadUint(32));
    return identity !== undefined && walletAddress(identity, publicKey) === from;
  } catch {
    return false;
  }
}

/** The v4r2 identity a request's subwallet id names in `from`'s workchain. */
function v4IdentityOf(from: string, subwalletId: number): TonIdentity | undefined {
  const workchain = Number(from.split(':')[0]);
  if (workchain !== 0 && workchain !== -1) return undefined;
  return { version: 'v4r2', workchain, subwalletId };
}

/** The v5r1 identity a signed wallet id names: 1 bit set, workchain int8, version 0, uint15. */
function v5IdentityOf(walletId: number, globalId: number): TonIdentity | undefined {
  const context = (walletId ^ globalId) | 0;
  if (context >>> 31 !== 1 || ((context >> 15) & 0xff) !== 0) return undefined;
  const byte = (context >> 23) & 0xff;
  const workchain = byte >= 128 ? byte - 256 : byte;
  if (workchain !== 0 && workchain !== -1) return undefined;
  return {
    version: 'v5r1',
    workchain,
    subwalletNumber: context & 0x7fff,
    networkGlobalId: globalId,
  };
}

/** The SDK's `Address` for a raw address, parsed strictly. */
export { sdkAddress };

/** The TEP-467 hash (hex) of the external message `body` to `account` would travel in. */
export function externalHashOf(account: string, body: Cell): string {
  const message = beginCell()
    .store(storeMessage(external({ to: sdkAddress(account), body })))
    .endCell();
  return Buffer.from(normalizedHash(message)).toString('hex');
}
