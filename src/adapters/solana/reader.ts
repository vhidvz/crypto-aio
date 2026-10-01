/**
 * Solana addresses, reads and the `ext.solana` API. Every call carries the tags of the
 * `ChainDriver` contract table: `read` for point queries, `monitor` for heights and
 * observations. Heads are read at `confirmed`, finality at `finalized`.
 */
import type {
  AddressCodec,
  ChainReader,
  DriverBlock,
  DriverTxObservation,
} from '../../core/driver/types';
import {
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
  withContext,
} from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { AssetMetadata, AssetRef, TokenRef } from '../../core/model/asset';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { Transport } from '../../core/transport/types';
import {
  decodeTransaction,
  parseTransaction,
  tokenTransfersLanded,
  type ParsedTransaction,
} from './decode';
import type { HeightIndex } from './heights';
import {
  addressFromPublicKey,
  decodeBase58,
  encodeBase58,
  isAddress,
  isSignature,
} from './keys';
import type { SolanaNetworkConfig } from './network';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  decodeMint,
  decodeTokenAccount,
} from './programs';
import {
  MONITOR,
  READ,
  call,
  contextValue,
  inconsistent,
  malformed,
  notYet,
  parsedOptions,
  record,
  u64,
  type BlockHeader,
} from './rpc';
import type { SolanaCallTags, SolanaCodec, SolanaExt, SolanaTokenAccount } from './types';

/** What every Solana port is built from. */
export interface SolanaContext {
  readonly transport: Transport;
  readonly codec: SolanaCodec;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: SolanaNetworkConfig;
  readonly heights: HeightIndex;
  readonly log: Logger;
  /** The next build variant (`fees.ts`, `variantCounter`). */
  readonly nextVariant: () => number;
}

export interface AccountInfo {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

/**
 * Account data in agave's `base64` encoding, refused unless it is canonical: Node decodes
 * leniently (a stray character is skipped, `AB==` reads as `AA==`), so the bytes must
 * encode back to the same text. The check is linear, which matters: accounts hold up to
 * 10 MiB, and a repeated-group regex overflows the stack on a few MiB.
 */
function base64Data(value: unknown, what: string): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[1] !== 'base64' ||
    typeof value[0] !== 'string' ||
    value[0].length % 4 !== 0
  ) {
    throw malformed(what);
  }
  const bytes = Buffer.from(value[0], 'base64');
  if (bytes.toString('base64') !== value[0]) throw malformed(what);
  return new Uint8Array(bytes);
}

/** A `getAccountInfo` answer (base64): the account, or `null` when it does not exist. */
function parseAccount(result: unknown): AccountInfo | null {
  const value = contextValue(result, 'getAccountInfo');
  if (value === null) return null;
  const account = record(value);
  if (!account || !isAddress(account.owner) || typeof account.executable !== 'boolean') {
    throw malformed('getAccountInfo');
  }
  return {
    owner: account.owner,
    executable: account.executable,
    data: base64Data(account.data, 'getAccountInfo'),
  };
}

/** `getAccountInfo` (base64) at `confirmed`; `null` when the account does not exist. */
export async function accountInfo(
  ctx: SolanaContext,
  address: string,
  tags: SolanaCallTags,
): Promise<AccountInfo | null> {
  return parseAccount(
    await call(
      ctx.transport,
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: 'confirmed' }],
      tags,
    ),
  );
}

const assetError = (reason: string) => new ValidationError('ASSET_RESOLUTION', reason);

/** The mint of an `spl` asset ref; any other standard is not a Solana token. */
export function mintOf(asset: AssetRef): string {
  if (asset === 'native' || asset.standard !== 'spl') {
    throw assetError(`Solana tokens use the 'spl' standard`);
  }
  if (!isAddress(asset.contract)) throw assetError('not a Solana mint address');
  return asset.contract;
}

/** What a mint account says about its token: the only fields a mint read decides on. */
type MintVerdict =
  | { readonly decimals: number }
  | { readonly refused: 'missing' | 'token-2022' | 'other-program' | 'unparsable' };

/**
 * The verdict of a mint account, by its owning program first: a classic mint and a
 * Token-2022 one cannot be told apart by their size.
 */
function mintVerdict(info: AccountInfo | null): MintVerdict {
  if (!info) return { refused: 'missing' };
  if (info.owner === TOKEN_2022_PROGRAM) return { refused: 'token-2022' };
  if (info.owner !== TOKEN_PROGRAM) return { refused: 'other-program' };
  const decoded = decodeMint(info.data);
  return decoded ? { decimals: decoded.decimals } : { refused: 'unparsable' };
}

/**
 * A mint read's quorum key, verdict fields only: the verdict itself, never the
 * context slot, the lamports or the supply, on which honest endpoints differ. A malformed
 * answer keys as such, so it never agrees with a verdict.
 */
function mintKey(result: unknown): unknown {
  try {
    return mintVerdict(parseAccount(result));
  } catch {
    return 'malformed';
  }
}

/**
 * A classic Token mint's decimals: a missing mint, an account of another
 * program or data that does not parse is the token's own `ASSET_RESOLUTION`; a Token-2022
 * mint is `UNSUPPORTED_CAPABILITY`. A definitive node error is made retryable;
 * `PROVIDER_MISCONFIGURED` and retryable errors propagate unchanged. Under a quorum (the
 * token metadata the core caches), endpoints must agree on the verdict: a lagging one that
 * has no mint yet, or one with other decimals, decides nothing (`PROVIDER_INCONSISTENT`).
 */
export async function mintDecimals(
  ctx: SolanaContext,
  mint: string,
  tags: SolanaCallTags,
): Promise<number> {
  let info: AccountInfo | null;
  try {
    info = await accountInfo(ctx, mint, { ...tags, quorumKey: mintKey });
  } catch (error) {
    if (isCryptoAioError(error, 'RPC_ERROR') && !error.retryable) {
      throw withContext(error, {}, { retryable: true });
    }
    throw error;
  }
  const verdict = mintVerdict(info);
  if ('decimals' in verdict) return verdict.decimals;
  switch (verdict.refused) {
    case 'missing':
      throw assetError('no mint at this address');
    case 'token-2022':
      throw new UnsupportedCapabilityError(
        'UNSUPPORTED_CAPABILITY',
        'Token-2022 mints are not supported',
      );
    case 'other-program':
      throw assetError('not an SPL token mint');
    case 'unparsable':
      throw assetError('the mint does not parse');
  }
}

export function createSolanaAddressCodec(): AddressCodec {
  return {
    validate: (value) => isAddress(value),
    normalize: (value) => {
      if (!isAddress(value)) {
        throw new ValidationError('INVALID_ADDRESS', 'not a Solana address');
      }
      return { canonical: value, display: value };
    },
    fromPublicKey: (publicKey) => {
      const canonical = addressFromPublicKey(publicKey);
      return { canonical, display: canonical };
    },
  };
}

function driverBlock(height: bigint, header: BlockHeader): DriverBlock {
  return {
    height,
    hash: header.blockhash,
    parentHash: header.previousBlockhash,
    ...(header.blockTime !== undefined ? { timestamp: header.blockTime } : {}),
  };
}

/**
 * The block at dense `height` (`confirmed`), checked against the height it claims; `null`
 * while the endpoint has no block there. A contradicting answer is a retryable
 * `PROVIDER_INCONSISTENT`, and the cached slot it came from is dropped.
 */
export async function blockAtHeight(
  ctx: SolanaContext,
  height: bigint,
  tags: SolanaCallTags,
): Promise<{ readonly slot: bigint; readonly block: DriverBlock } | null> {
  const slot = await ctx.heights.slotAt(height, 'confirmed', tags);
  if (slot === null) return null;
  const header = await ctx.heights.header(slot, 'confirmed', tags);
  if (!header) return null;
  if (header.blockHeight !== height) {
    ctx.heights.forget();
    throw inconsistent(`the block at slot ${slot} is not at height ${height}`);
  }
  return { slot, block: driverBlock(height, header) };
}

/**
 * Reads a transaction at `confirmed`, with its block's height and hash. The answer must be
 * the transaction asked for: another one decides nothing (a retryable "not yet"), never
 * reads as ours.
 */
export async function readTransaction(
  ctx: SolanaContext,
  signature: string,
  tags: SolanaCallTags,
): Promise<{ readonly parsed: ParsedTransaction; readonly header: BlockHeader } | null> {
  const result = await call(
    ctx.transport,
    'getTransaction',
    [signature, parsedOptions('confirmed')],
    tags,
  );
  if (result === null) return null;
  const parsed = parseTransaction(result, signature);
  if (parsed.slot === undefined) throw malformed('getTransaction');
  const header = await ctx.heights.header(parsed.slot, 'confirmed', tags);
  if (!header) throw notYet('the block of the transaction');
  return { parsed, header };
}

/**
 * Token metadata is read under the proof quorum, stricter than
 * the contract table's minimum: the core caches a token's decimals and "no such token" for
 * the container's life, so one lagging or wrong endpoint must not mis-scale every amount
 * until a restart. `mintDecimals` compares the mint's verdict only. The builder reads the
 * decimals it signs into `transferChecked` the same way, so a lagging
 * endpoint without the mint decides nothing instead of refusing the transfer.
 */
export const METADATA: SolanaCallTags = Object.freeze({ ...READ, quorum: 'proof' });

export function createSolanaReader(ctx: SolanaContext): ChainReader {
  const height = async (commitment: 'confirmed' | 'finalized') =>
    u64(
      await call(ctx.transport, 'getBlockHeight', [{ commitment }], MONITOR),
      'getBlockHeight',
    );
  return {
    getBalance: async (address, asset) => {
      if (asset === 'native') {
        return u64(
          contextValue(
            await call(
              ctx.transport,
              'getBalance',
              [address, { commitment: 'confirmed' }],
              READ,
            ),
            'getBalance',
          ),
          'balance',
        );
      }
      const mint = mintOf(asset);
      const accounts = await tokenAccountsOf(ctx, address, mint, READ);
      return accounts.reduce((sum, account) => sum + account.amount, 0n);
    },
    getBlockHeight: () => height('confirmed'),
    getFinalizedHeight: () => height('finalized'),
    getBlock: async (ref) => {
      if (typeof ref !== 'bigint') {
        throw new UnsupportedCapabilityError(
          'UNSUPPORTED_CAPABILITY',
          'Solana has no block lookup by hash; pass a block height',
        );
      }
      return (await blockAtHeight(ctx, ref, READ))?.block ?? null;
    },
    getTransaction: async (id) => {
      if (!isSignature(id)) return null;
      const found = await readTransaction(ctx, id, READ);
      if (!found) return null;
      return decodeTransaction(found.parsed, {
        height: found.header.blockHeight,
        hash: found.header.blockhash,
        ...(found.parsed.blockTime !== undefined
          ? { blockTime: found.parsed.blockTime }
          : {}),
      });
    },
    observe: async (ref, ordering, from): Promise<DriverTxObservation> => {
      if (!isSignature(ref.id)) return { seen: 'none' };
      const found = await readTransaction(ctx, ref.id, MONITOR);
      if (!found) return { seen: 'none' };
      const { parsed, header } = found;
      let success = parsed.err === null;
      let reason = success ? undefined : 'transaction failed';
      // The phantom-success guard applies to our own Attempts only. This is
      // one endpoint's `confirmed` view, so the core records it as observed evidence,
      // never terminal: a verdict reads the finalized transaction under the proof quorum's
      // key (`proofs.ts`). A node that drops the token instruction makes the transfer look
      // native here, which that verdict catches.
      if (success && ordering !== undefined && from !== undefined) {
        if (!tokenTransfersLanded(parsed, from)) {
          success = false;
          reason = 'token transfer failed';
        }
      }
      return {
        seen: 'block',
        txHash: parsed.signature,
        blockHeight: header.blockHeight,
        blockHash: header.blockhash,
        success,
        ...(reason !== undefined ? { reason } : {}),
      };
    },
    getTokenMetadata: async (ref: TokenRef): Promise<AssetMetadata> => {
      const mint = mintOf(ref);
      const decimals = await mintDecimals(ctx, mint, METADATA);
      // SPL mints carry no symbol on chain: a registered token has its own; any other
      // shows the first characters of its mint (display only).
      return { symbol: mint.slice(0, 8), decimals };
    },
    normalizeTokenRef: (ref) => ({ standard: 'spl', contract: mintOf(ref) }),
  };
}

/**
 * The classic token accounts of `owner`, optionally for one mint. The answer is filtered to
 * what was asked (lookups by id): an account of another owner or mint, as a node that
 * drops a filter would list it, is none of the owner's. Token-2022 accounts are skipped
 * (unsupported). An account listed twice is malformed, never a doubled balance.
 */
export async function tokenAccountsOf(
  ctx: SolanaContext,
  owner: string,
  mint: string | undefined,
  tags: SolanaCallTags,
): Promise<SolanaTokenAccount[]> {
  const value = contextValue(
    await call(
      ctx.transport,
      'getTokenAccountsByOwner',
      [
        owner,
        mint !== undefined ? { mint } : { programId: TOKEN_PROGRAM },
        { encoding: 'base64', commitment: 'confirmed' },
      ],
      tags,
    ),
    'getTokenAccountsByOwner',
  );
  if (!Array.isArray(value)) throw malformed('getTokenAccountsByOwner');
  const accounts: SolanaTokenAccount[] = [];
  const listed = new Set<string>();
  for (const entry of value) {
    const item = record(entry);
    const account = record(item?.account);
    if (
      !item ||
      !account ||
      !isAddress(item.pubkey) ||
      listed.has(item.pubkey) ||
      !isAddress(account.owner)
    ) {
      throw malformed('getTokenAccountsByOwner');
    }
    listed.add(item.pubkey);
    if (account.owner !== TOKEN_PROGRAM) continue; // Token-2022 is unsupported.
    const decoded = decodeTokenAccount(
      base64Data(account.data, 'getTokenAccountsByOwner'),
    );
    if (!decoded) throw malformed('getTokenAccountsByOwner');
    const accountMint = encodeBase58(decoded.mint);
    if (encodeBase58(decoded.owner) !== owner) continue;
    if (mint !== undefined && accountMint !== mint) continue;
    accounts.push({
      address: item.pubkey,
      mint: accountMint,
      amount: decoded.amount,
      frozen: decoded.frozen,
    });
  }
  return accounts;
}

export function createSolanaExt(ctx: SolanaContext): SolanaExt {
  return {
    solana: {
      getTokenAccounts: async (owner, mint) => {
        if (!isAddress(owner)) {
          throw new ValidationError('INVALID_ADDRESS', 'not a Solana address');
        }
        if (mint !== undefined && decodeBase58(mint, 32) === null) {
          throw new ValidationError('INVALID_ADDRESS', 'not a Solana mint address');
        }
        return tokenAccountsOf(ctx, owner, mint, READ);
      },
    },
  };
}
