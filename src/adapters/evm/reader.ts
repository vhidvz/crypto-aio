/**
 * EVM addresses, reads, nonces and the `ext.evm` API. Every call carries the tags of the
 * `ChainDriver` contract table (`src/core/driver/types.ts`): `read` for point queries,
 * `monitor` for heights, observations and nonces.
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
 * The highest final block: the `finalized` tag, or the head minus the confirmations. The
 * head is a single `monitor` read (with the signal of `tags`); `tags` apply to the
 * `finalized` block read and, under `proof`, to the quorum read of the head block.
 */
export async function finalizedHeight(
  ctx: EvmContext,
  tags: EvmCallTags,
): Promise<bigint> {
  const { finality } = ctx.config;
  if (finality.kind === 'confirmations') {
    const head = await ctx.client.blockNumber(withSignal(MONITOR, tags.signal));
    // R67: a proof never rests on one endpoint's head. The quorum must hold that block, so
    // an endpoint that over-reports its head cannot advance the final height.
    if (tags.purpose === 'proof') {
      const block = await ctx.client.getBlock(head, tags);
      if (block?.number !== head) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          'the endpoints do not agree on the head block',
        );
      }
    }
    const height = head - BigInt(finality.confirmations) + 1n;
    return height < 0n ? 0n : height;
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
      return await client.call({ to: contract, data }, 'latest', READ);
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
