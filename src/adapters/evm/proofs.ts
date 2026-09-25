/**
 * Proofs and block scanning (spec §6.7, §10). Every proof read is a quorum read under
 * `PROOF` (R33), comparing only consensus facts (`rpc.ts`, R59). No proof lets one endpoint
 * choose the final height (R74): a proof attests the fact it needs at that fact's own
 * height, so honest endpoints disagree only while it is final on one and not yet on another,
 * which decides nothing. The block source serves dense heights with native transfers and
 * ERC-20 `Transfer` logs, as the chain reports them (R68).
 */
import type { BlockSource, ProofSource } from '../../core/driver/types';
import { ProviderError } from '../../core/errors/error';
import { decodeTransaction, tokenTransferLanded } from './decode';
import {
  MONITOR,
  PROOF,
  finalBlockAt,
  provenFinal,
  toDriverBlock,
  type EvmContext,
} from './reader';
import type { EvmTx } from './types';

/**
 * R74: a quorum key under which every endpoint whose nonce is past `nonce` agrees. A
 * malformed answer throws, which the transport counts as a disagreement.
 */
function nonceAbove(nonce: bigint): (result: unknown) => boolean {
  return (result) => {
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]+$/.test(result)) {
      throw new TypeError('not a nonce');
    }
    return BigInt(result) > nonce;
  };
}

export function createEvmProofs(ctx: EvmContext): ProofSource {
  const { client, config } = ctx;
  return {
    async finalizedHead() {
      const { height, block } = await provenFinal(ctx, PROOF);
      const final = block ?? (await client.getBlock(height, PROOF));
      if (!final) {
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          'the endpoints serve no finalized block',
        );
      }
      return { height: final.number, hash: final.hash, timestamp: final.timestamp };
    },

    async includedFinal(ref) {
      const receipt = await client.getReceipt(ref.id, PROOF);
      if (!receipt) return { included: false };
      const final = await finalBlockAt(ctx, receipt.blockNumber, PROOF);
      if (!final) return { included: false };
      // The endpoints agree on a receipt from a block that is not the final one at its
      // height: the chain reorganized between the reads, or their receipt index lags. The
      // transaction may be final elsewhere, so this decides nothing (R74).
      if (final.hash !== receipt.blockHash) {
        throw new ProviderError(
          'PROVIDER_INCONSISTENT',
          'the receipt is not in the final block at its height',
        );
      }
      let success = receipt.status === 1;
      if (success) {
        // R50: a token transfer that logged nothing moved nothing (read from the ref alone).
        // The core proves only its own Attempts, so this is always a verdict (R68).
        const tx = await client.getTransaction(ref.id, PROOF);
        if (!tx) {
          throw new ProviderError(
            'PROVIDER_INCONSISTENT',
            'a receipt without its transaction',
            { retryable: true },
          );
        }
        success = tokenTransferLanded(client.abi, tx, receipt);
      }
      return {
        included: true,
        success,
        blockHeight: receipt.blockNumber,
        blockHash: receipt.blockHash,
        txHash: receipt.transactionHash,
      };
    },

    async slotConsumed(ordering, from, level) {
      if (ordering.kind !== 'nonce') return false;
      if (level === 'latest') {
        return (
          (await client.getTransactionCount(from, 'latest', MONITOR)) > ordering.nonce
        );
      }
      // R74: every quorum endpoint states whether the slot is consumed in its own final
      // state. That flips once, when the consuming transaction becomes final there, so
      // honest endpoints disagree only then (deciding nothing), and one that over-reports
      // its finalized block cannot consume the slot alone. Confirmation networks have no
      // tag: they read the nonce at the height the quorum attests.
      const at =
        config.finality.kind === 'tag'
          ? 'finalized'
          : (await provenFinal(ctx, PROOF)).height;
      const count = await client.getTransactionCount(from, at, {
        ...PROOF,
        quorumKey: nonceAbove(ordering.nonce),
      });
      return count > ordering.nonce;
    },

    // Nonce ordering: an EVM transaction never expires.
    expired: async () => false,

    async blockHash(height, level) {
      if (level === 'finalized') {
        return (await finalBlockAt(ctx, height, PROOF))?.hash ?? null;
      }
      return (await client.getBlock(height, PROOF))?.hash ?? null;
    },
  };
}

const changed = (height: bigint) =>
  new ProviderError('PROVIDER_INCONSISTENT', `block ${height} changed while scanning`, {
    retryable: true,
  });

export function createEvmBlocks(ctx: EvmContext): BlockSource {
  const { client, config } = ctx;
  return {
    async header(height) {
      const block = await client.getBlock(height, MONITOR);
      return block ? toDriverBlock(block) : null;
    },

    async transactions(block, filter) {
      const full = await client.getBlockWithTransactions(block.height, MONITOR);
      if (!full || full.hash !== block.hash) throw changed(block.height);
      let selected: readonly EvmTx[] = full.transactions;
      if (filter?.addresses?.length) {
        const wanted = new Set(filter.addresses.map((a) => a.toLowerCase()));
        const watched = (address: string | null) =>
          address !== null && wanted.has(address.toLowerCase());
        const logs = await client.getLogs(
          { blockHash: block.hash, topics: [client.abi.transferTopic] },
          MONITOR,
        );
        const tokenTxs = new Set(
          logs
            .filter((log) => {
              const transfer = client.abi.decodeTransfer(log);
              return (
                transfer !== null && (watched(transfer.from) || watched(transfer.to))
              );
            })
            .map((log) => log.transactionHash),
        );
        selected = full.transactions.filter(
          (tx) => watched(tx.from) || watched(tx.to) || tokenTxs.has(tx.hash),
        );
      }
      const receipts = await Promise.all(
        selected.map((tx) => client.getReceipt(tx.hash, MONITOR)),
      );
      return selected.map((tx, i) => {
        const receipt = receipts[i] ?? null;
        if (!receipt || receipt.blockHash !== block.hash) throw changed(block.height);
        // The chain's view (R68), with the network's config so bor's system logs do not
        // make a plain Polygon transfer `partial` (R69, R70).
        return decodeTransaction(client.abi, tx, receipt, full.timestamp, config);
      });
    },
  };
}
