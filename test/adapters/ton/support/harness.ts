/**
 * The scripted toncenter node behind two real `HttpTransport`s (`rpc` = v2, `indexer` =
 * v3), and a signing helper for tests that talk to the node without the driver.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { beginCell, storeOutList, type Cell, type MessageRelaxed } from '@ton/core';
import { TonApi } from '../../../../src/adapters/ton/api';
import {
  SEND_MODE,
  normalizedHash,
  resolveIdentity,
  signedRequest,
  unsignedRequest,
  walletAddress,
  walletIdOf,
} from '../../../../src/adapters/ton/wallets';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { ScriptedTonNode, type TonNodeOptions } from './node';
import { KEY, PUBLIC_KEY } from './vectors';

/** A fake clock that starts at a realistic chain time (seconds matter for `valid_until`). */
export function tonClock(): FakeClock {
  return new FakeClock(1_790_000_000_000);
}

export function tonNode(
  options: Omit<TonNodeOptions, 'clock'> = {},
  endpoints: readonly string[] = ['main'],
  /** The transports' lag tolerance (the pool resolves it per R36; default 5). */
  maxLagBlocks?: number,
) {
  const clock = tonClock();
  const node = new ScriptedTonNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = (api: 'v2' | 'v3') =>
    new HttpTransport(
      endpoints.map((name) => ({ name, url: node.endpoint(name, api) })),
      {
        clock,
        events,
        log: noopLogger,
        // Deterministic (lesson 1, R46): a fixed id and backoff jitter, never `Math.random`.
        id: `ton-${api}`,
        random: () => 0.5,
        options: {
          fetch: node.fetch.fetch,
          baseDelayMs: 1,
          maxDelayMs: 2,
          ...(maxLagBlocks !== undefined ? { maxLagBlocks } : {}),
        },
      },
    );
  const rpc = transport('v2');
  const indexer = transport('v3');
  const api = new TonApi(rpc, indexer);
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, rpc, indexer, api, run, seen };
}

const PK = Buffer.from(PUBLIC_KEY, 'hex');

/** The test key's wallet address for a version on a network. */
export function testWallet(version: 'v4r2' | 'v5r1', globalId: number): string {
  return walletAddress(resolveIdentity({ ton: { version } }, globalId), PK);
}

/**
 * A v5r1 signed request relayed in an internal message (`internal_signed`, gasless), from
 * the test key's wallet, signed by `seed` (hex; default the test key, so another seed
 * forges it).
 */
export function relayedBody(
  globalId: number,
  args: {
    readonly seqno: number;
    readonly validUntil: number;
    readonly messages: readonly MessageRelaxed[];
    readonly seed?: string;
  },
): Cell {
  const identity = resolveIdentity({ ton: { version: 'v5r1' } }, globalId);
  const actions = beginCell()
    .store(
      storeOutList(
        args.messages.map((outMsg) => ({ type: 'sendMsg', mode: SEND_MODE, outMsg })),
      ),
    )
    .endCell();
  const signing = beginCell()
    .storeUint(0x73696e74, 32)
    .storeInt(walletIdOf(identity, PK), 32)
    .storeUint(args.validUntil, 32)
    .storeUint(args.seqno, 32)
    .storeMaybeRef(args.messages.length > 0 ? actions : null)
    .storeBit(false)
    .endCell();
  const signature = ed25519.sign(signing.hash(), Buffer.from(args.seed ?? KEY, 'hex'));
  return beginCell()
    .storeSlice(signing.beginParse())
    .storeBuffer(Buffer.from(signature))
    .endCell();
}

/**
 * A signed external request from the test key's wallet, as the driver would build it;
 * signed by `seed` (hex) when given, so another seed makes one up.
 */
export async function signedBoc(
  version: 'v4r2' | 'v5r1',
  globalId: number,
  args: {
    readonly seqno: number;
    readonly validUntil: number;
    readonly deploy: boolean;
    readonly messages: readonly MessageRelaxed[];
    readonly seed?: string;
  },
): Promise<{ readonly boc: string; readonly hashNorm: string }> {
  const identity = resolveIdentity({ ton: { version } }, globalId);
  const unsigned = await unsignedRequest(identity, PK, args);
  const signature = ed25519.sign(unsigned.digest, Buffer.from(args.seed ?? KEY, 'hex'));
  const signed = signedRequest(unsigned.message, unsigned.digest, signature);
  return {
    boc: signed.toBoc().toString('base64'),
    hashNorm: Buffer.from(normalizedHash(signed)).toString('hex'),
  };
}
