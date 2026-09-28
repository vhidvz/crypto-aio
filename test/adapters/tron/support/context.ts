import { TRON_CHAIN } from '../../../../src/adapters/tron/chains';
import { tronwebCodec } from '../../../../src/adapters/tron/codec';
import { tronNetworkConfig } from '../../../../src/adapters/tron/network';
import type { TronContext } from '../../../../src/adapters/tron/reader';
import type { TronRawData } from '../../../../src/adapters/tron/types';
import { noopLogger } from '../../../../src/core/events/logger';
import type { NetworkInfo } from '../../../../src/core/model/chain';
import { encodeTransfer } from '../../../../src/adapters/tron/abi';
import { nodeTransport } from './harness';
import type { NodeOptions } from './node';
import { signedTransaction } from './signing';
import {
  KEY_ADDRESS,
  KEY_HEX,
  KEY_PUBLIC,
  RECIPIENT,
  RECIPIENT_HEX,
  USDT_HEX,
} from './vectors';

/** A Tron driver context for Nile over a scripted node. */
export function tronHarness(
  options: {
    readonly endpoints?: readonly string[];
    readonly node?: Partial<Omit<NodeOptions, 'clock'>>;
    readonly driverOptions?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const network = TRON_CHAIN.networks.nile as NetworkInfo;
  const t = nodeTransport(options.node, options.endpoints);
  const config = tronNetworkConfig(TRON_CHAIN, network, options.driverOptions);
  const ctx: TronContext = {
    api: t.api,
    codec: tronwebCodec,
    chain: TRON_CHAIN,
    network,
    config,
    clock: t.clock,
    log: noopLogger,
  };
  const keys = [{ scheme: 'secp256k1-ecdsa', publicKey: KEY_PUBLIC }];
  return { ...t, ctx, keys, from: KEY_ADDRESS };
}

/** Signs `contract` with the test key on the node's head block and broadcasts it. */
export async function submit(
  h: ReturnType<typeof tronHarness>,
  contract: 'trx' | 'trc20',
  extra: Partial<TronRawData> = {},
): Promise<string> {
  const head = h.node.block(h.node.head) as { id: string; timestamp: number };
  const raw: TronRawData = {
    refBlockBytes: head.id.slice(12, 16),
    refBlockHash: head.id.slice(16, 32),
    expiration: head.timestamp + 60_000,
    timestamp: head.timestamp + 1,
    ...(contract === 'trc20' ? { feeLimit: 100_000_000 } : {}),
    contract:
      contract === 'trx'
        ? { type: 'TransferContract', owner: KEY_HEX, to: RECIPIENT_HEX, amount: 1_000n }
        : {
            type: 'TriggerSmartContract',
            owner: KEY_HEX,
            contract: USDT_HEX,
            data: encodeTransfer(RECIPIENT, 25n),
          },
    ...extra,
  };
  const tx = signedTransaction(raw);
  const answer = (await h.run(
    h.api.broadcastHex(tx.hex, { purpose: 'broadcast', retry: 'ambiguous-on-failure' }),
  )) as { accepted: boolean; code?: string };
  if (!answer.accepted) throw new Error(`node refused: ${answer.code}`);
  return tx.id;
}
