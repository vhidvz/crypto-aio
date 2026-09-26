/**
 * EVM addresses, reads, nonces, finality and the `ext.evm` API. Every call carries the tags
 * of the `ChainDriver` contract table (`src/core/driver/types.ts`): `read` for point
 * queries, `monitor` for heights, observations and nonces, and `proof` for the finality
 * that proofs attest (R74).
 */
import type {
  AddressCodec,
  ChainReader,
  DriverBlock,
  SequenceSource,
} from '../../core/driver/types';
import {
  ProviderError,
  ValidationError,
  isCryptoAioError,
  withContext,
} from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { AssetMetadata, AssetRef, TokenRef } from '../../core/model/asset';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { quantity } from './client';
import { chainObservation, decodeTransaction, evmObservation } from './decode';
import type { EvmNetworkConfig } from './network';
import type { EvmBlock, EvmCallTags, EvmClient, EvmExt } from './types';

/** What every EVM port is built from. */
export interface EvmContext {
  readonly client: EvmClient;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: EvmNetworkConfig;
  readonly log: Logger;
}

export const READ: EvmCallTags = { purpose: 'read', retry: 'safe' };
export const MONITOR: EvmCallTags = { purpose: 'monitor', retry: 'safe' };
export const PROOF: EvmCallTags = { purpose: 'proof', retry: 'safe', quorum: 'proof' };

export const withSignal = (tags: EvmCallTags, signal?: AbortSignal): EvmCallTags =>
  signal ? { ...tags, signal } : tags;

export function toDriverBlock(block: EvmBlock): DriverBlock {
  return {
    height: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    transactionIds: block.transactions,
  };
}

/** Whether a definitive (non-ambiguous) JSON-RPC error says the call reverted. */
export function isRevert(error: unknown): boolean {
  if (!isCryptoAioError(error, 'RPC_ERROR') || error.ambiguous) return false;
  const { rpcCode, rpcMessage } = error.details ?? {};
  return rpcCode === 3 || /revert/i.test(String(rpcMessage ?? error.message));
}

/**
 * R74: how many blocks a proof's final height trails the one endpoint that proposed it, so
 * a quorum peer up to this far behind that endpoint still attests it.
 */
export const PEER_SKEW = 2n;

/** `height - depth`, or genesis. */
const below = (height: bigint, depth: bigint): bigint =>
  height > depth ? height - depth : 0n;

/**
 * R74: a quorum key under which every endpoint whose block is at or past `height` agrees,
 * so honest endpoints at different heights agree, and one that is not there disagrees.
 * A malformed answer throws, which the transport counts as a disagreement.
 */
const atOrPast =
  (height: bigint) =>
  (result: unknown): boolean =>
    result !== null &&
    quantity((result as { readonly number?: unknown }).number, 'block number') >= height;

/** Whether every quorum endpoint's `finalized` block is at or past `height` (R74). */
async function finalizedAtOrPast(
  ctx: EvmContext,
  height: bigint,
  tags: EvmCallTags,
): Promise<boolean> {
  const block = await ctx.client.getBlock('finalized', {
    ...tags,
    quorumKey: atOrPast(height),
  });
  // The endpoints agreed on the predicate, so the first one's block states it for all.
  return block !== null && block.number >= height;
}

/**
 * The highest final block as one endpoint sees it (a `monitor` view): the `finalized` tag,
 * or the head minus the confirmations; the head read carries the signal of `tags`. Proofs
 * never use it as a final height: `provenFinal` attests one.
 */
export async function finalizedHeight(
  ctx: EvmContext,
  tags: EvmCallTags,
): Promise<bigint> {
  const { finality } = ctx.config;
  if (finality.kind === 'confirmations') {
    const head = await ctx.client.blockNumber(withSignal(MONITOR, tags.signal));
    return below(head, BigInt(finality.confirmations - 1));
  }
  const block = await ctx.client.getBlock('finalized', tags);
  if (!block) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'the endpoint reports no finalized block',
    );
  }
  return block.number;
}

/**
 * A height that is final on every endpoint of the proof quorum (`tags`), and the quorum's
 * block at it when the proof read that block anyway. One endpoint's view (a `monitor` read)
 * only proposes: the height trails it by `PEER_SKEW` blocks, and the quorum attests it. On
 * tag networks every quorum endpoint's `finalized` block must be at or past it; on
 * confirmation networks every one must hold the block that confirms it (R67). So an
 * endpoint that over-reports cannot advance finality, and a peer that trails the proposer
 * by up to `PEER_SKEW` blocks still agrees (R74).
 */
export async function provenFinal(
  ctx: EvmContext,
  tags: EvmCallTags,
): Promise<{ readonly height: bigint; readonly block?: EvmBlock }> {
  const { finality } = ctx.config;
  const view = withSignal(MONITOR, tags.signal);
  if (finality.kind === 'confirmations') {
    const confirming = below(await ctx.client.blockNumber(view), PEER_SKEW);
    const block = await ctx.client.getBlock(confirming, tags);
    if (block?.number !== confirming) {
      throw new ProviderError(
        'PROVIDER_INCONSISTENT',
        'the endpoints do not hold the confirming block',
      );
    }
    const height = below(confirming, BigInt(finality.confirmations - 1));
    return height === confirming ? { height, block } : { height };
  }
  const height = below(await finalizedHeight(ctx, view), PEER_SKEW);
  if (!(await finalizedAtOrPast(ctx, height, tags))) {
    throw new ProviderError(
      'PROVIDER_INCONSISTENT',
      'the endpoints do not attest the proposed finalized block',
    );
  }
  return { height };
}

/**
 * The quorum's block at `height` when `height` is final on every endpoint of the proof
 * quorum (`tags`), else `null`. Anchored at `height` itself, not at any endpoint's view:
 * honest endpoints disagree only while `height` is final on one and not yet on another, and
 * that decides nothing (a retryable `PROVIDER_INCONSISTENT`) (R74).
 */
export async function finalBlockAt(
  ctx: EvmContext,
  height: bigint,
  tags: EvmCallTags,
): Promise<EvmBlock | null> {
  const { client } = ctx;
  const { finality } = ctx.config;
  if (finality.kind === 'tag') {
    if (!(await finalizedAtOrPast(ctx, height, tags))) return null;
    return client.getBlock(height, tags);
  }
  // The block that gives `height` its confirmations; with one, it is `height`'s own.
  const depth = BigInt(finality.confirmations - 1);
  const confirming = await client.getBlock(height + depth, tags);
  if (confirming === null) return null;
  return depth === 0n ? confirming : client.getBlock(height, tags);
}

export function createEvmAddressCodec(client: EvmClient): AddressCodec {
  return {
    validate: (value) => client.isAddress(value),
    normalize: (value) => {
      if (!client.isAddress(value)) {
        throw new ValidationError('INVALID_ADDRESS', 'not an EVM address');
      }
      const canonical = client.checksum(value);
      return { canonical, display: canonical };
    },
    fromPublicKey: (publicKey) => {
      // R58: the client's strict decode already throws a specific `INVALID_ADDRESS`.
      const canonical = client.addressFromPublicKey(publicKey);
      return { canonical, display: canonical };
    },
  };
}

const assetError = (reason: string) => new ValidationError('ASSET_RESOLUTION', reason);

/** geth's texts for an EVM that stopped the called code itself (`core/vm/errors.go`). */
const VM_FAILURE =
  /^(out of gas|invalid opcode|invalid jump destination|stack (underflow|limit reached)|write protection|return data out of bounds)/i;

/** Whether a definitive (non-ambiguous) JSON-RPC error says the EVM stopped the code. */
export function isExecutionFailure(error: unknown): boolean {
  if (!isCryptoAioError(error, 'RPC_ERROR') || error.ambiguous) return false;
  const { rpcMessage } = error.details ?? {};
  return typeof rpcMessage === 'string' && VM_FAILURE.test(rpcMessage);
}

/** An ERC-20 `balanceOf` at `latest`; `ASSET_RESOLUTION` when the contract gives none. */
export async function erc20Balance(
  client: EvmClient,
  token: string,
  owner: string,
  tags: EvmCallTags,
): Promise<bigint> {
  const data = await client.call(
    { to: token, data: client.abi.encodeBalanceOf(owner) },
    'latest',
    tags,
  );
  try {
    return client.abi.decodeUint256(data);
  } catch {
    throw assetError('the token contract returned no balance');
  }
}

function tokenOf(asset: AssetRef): string {
  if (asset === 'native' || asset.standard !== 'erc20') {
    throw assetError(`EVM tokens use the 'erc20' standard`);
  }
  return asset.contract;
}

/** The text of an ABI `string`, or of a `bytes32` (older tokens such as MKR return one). */
function symbolText(client: EvmClient, data: string): string {
  try {
    return client.abi.decodeString(data);
  } catch {
    if (!/^0x[0-9a-fA-F]{64}$/.test(data))
      throw assetError('the token symbol is unreadable');
    return Buffer.from(data.slice(2), 'hex').toString('utf8').replace(/\0+$/, '');
  }
}

/**
 * M4: token metadata is read under the proof quorum, stricter than the contract table's
 * minimum. The core caches it for the container's life, and one endpoint's wrong `decimals`
 * (a lagging, misrouted or buggy backend) would mis-scale every amount by orders of
 * magnitude until restart. `decimals` never changes, so honest endpoints always agree.
 */
const METADATA: EvmCallTags = { ...READ, quorum: 'proof' };

export function createEvmReader(ctx: EvmContext): ChainReader {
  const { client } = ctx;
  /**
   * N6, R53, R66: a revert or a VM execution failure is the token's own permanent problem
   * (`ASSET_RESOLUTION`, which the core caches). Any other JSON-RPC error is the node's, so
   * it is rethrown retryable. Everything else propagates unchanged: a misconfigured
   * endpoint stays final (transport I10), and a retryable failure is already retryable.
   */
  const tokenCall = async (contract: string, data: string): Promise<string> => {
    try {
      return await client.call({ to: contract, data }, 'latest', METADATA);
    } catch (error) {
      if (isRevert(error)) throw assetError('the token contract reverted');
      if (isExecutionFailure(error)) throw assetError('the token contract failed to run');
      if (isCryptoAioError(error, 'RPC_ERROR')) {
        throw withContext(error, {}, { retryable: true });
      }
      throw error;
    }
  };

  return {
    getBalance: async (address, asset) => {
      if (asset === 'native') return client.getBalance(address, 'latest', READ);
      return erc20Balance(client, tokenOf(asset), address, READ);
    },
    getBlockHeight: () => client.blockNumber(MONITOR),
    getFinalizedHeight: () => finalizedHeight(ctx, MONITOR),
    getBlock: async (ref) => {
      const block = await client.getBlock(ref, READ);
      return block ? toDriverBlock(block) : null;
    },
    getTransaction: async (id) => {
      const tx = await client.getTransaction(id, READ);
      if (!tx) return null;
      const receipt = tx.blockHash !== null ? await client.getReceipt(id, READ) : null;
      return decodeTransaction(client.abi, tx, receipt, undefined, ctx.config);
    },
    /**
     * With an ordering, the R50 verdict on one of our own Attempts. Without one (a status
     * lookup by id, for a transaction the library does not manage) the chain's view, so a
     * third party's call that shares the `transfer` selector is not reported failed (R68).
     */
    observe: async (ref, ordering) => {
      const tx = await client.getTransaction(ref.id, MONITOR);
      if (!tx) return { seen: 'none' };
      const receipt =
        tx.blockHash === null ? null : await client.getReceipt(ref.id, MONITOR);
      return ordering === undefined
        ? chainObservation(tx, receipt)
        : evmObservation(client.abi, tx, receipt);
    },
    getTokenMetadata: async (ref: TokenRef): Promise<AssetMetadata> => {
      const contract = tokenOf(ref);
      const decimalsData = await tokenCall(contract, client.abi.encodeDecimals());
      if (decimalsData === '0x') throw assetError('no token contract at this address');
      let decimals: bigint;
      try {
        decimals = client.abi.decodeUint256(decimalsData);
      } catch {
        throw assetError('the token decimals are unreadable');
      }
      if (decimals > 255n) throw assetError('the token decimals are out of range');
      const symbol = symbolText(
        client,
        await tokenCall(contract, client.abi.encodeSymbol()),
      );
      if (!symbol) throw assetError('the token has no symbol');
      return { symbol, decimals: Number(decimals) };
    },
    normalizeTokenRef: (ref) => {
      const contract = tokenOf(ref);
      if (!client.isAddress(contract)) throw assetError('not an EVM contract address');
      return { standard: 'erc20', contract: client.checksum(contract) };
    },
  };
}

export function createEvmSequence(client: EvmClient): SequenceSource {
  return {
    pending: (address) => client.getTransactionCount(address, 'pending', MONITOR),
    latest: (address) => client.getTransactionCount(address, 'latest', MONITOR),
  };
}

export function createEvmExt(client: EvmClient): EvmExt {
  return {
    evm: {
      getNonce: async (address, block = 'latest') => {
        if (block !== 'latest' && block !== 'pending') {
          throw new ValidationError(
            'INVALID_INTENT',
            `block must be 'latest' or 'pending'`,
          );
        }
        const codec = createEvmAddressCodec(client);
        return client.getTransactionCount(
          codec.normalize(address).canonical,
          block,
          READ,
        );
      },
    },
  };
}
