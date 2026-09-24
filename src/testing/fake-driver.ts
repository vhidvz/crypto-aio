import type {
  AddressCodec,
  BlockSource,
  Broadcaster,
  BroadcastResult,
  BuildContext,
  ChainDriver,
  ChainReader,
  DriverBlock,
  DriverContext,
  DriverFactory,
  DriverTransaction,
  ProofSource,
  ReplacementPolicy,
  SequenceSource,
  TxBuilder,
} from '../core/driver/types';
import {
  ChainError,
  ProviderError,
  SigningError,
  StateError,
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
} from '../core/errors/error';
import type { Capability } from '../core/model/capability';
import { assetId, type AssetRef } from '../core/model/asset';
import type { FeeEstimateDraft, FeeOverride, FeeSpeed } from '../core/model/fee';
import type { DriverIntent } from '../core/model/intent';
import type { OrderingData } from '../core/model/ordering';
import type { UnsignedTx } from '../core/model/transaction';
import type { CallOptions } from '../core/transport/types';
import { toHex } from '../core/util/bytes';
import { canonicalJson } from '../core/util/json';
import {
  encodeEnvelope,
  fakeAddress,
  fakeDigest,
  fakeTxId,
  isFakeAddress,
  type FakeUnsigned,
  type FakeWireBlock,
  type FakeWireTx,
} from './fake-chain';

export interface FakeExt {
  readonly fake: {
    nonceOf(address: string): Promise<bigint>;
    head(): Promise<bigint>;
  };
}

export interface FakeNativeClient {
  readonly id: number;
  readonly settings: Record<string, unknown>;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

let nativeClients = 0;

const REJECTED =
  /malformed transaction|invalid chain id|invalid sender|invalid signature/;

function classify(message: string): BroadcastResult {
  if (/already known/.test(message)) return { kind: 'already-known' };
  if (REJECTED.test(message)) return { kind: 'rejected', reason: message };
  if (/insufficient funds/.test(message))
    return { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: message };
  if (/underpriced|fee too low/.test(message))
    return { kind: 'refused', code: 'FEE_TOO_LOW', reason: message };
  if (/nonce too low|seqno mismatch/.test(message))
    return { kind: 'refused', code: 'NONCE_CONFLICT', reason: message };
  if (/expired/.test(message))
    return { kind: 'refused', code: 'TX_EXPIRED', reason: message };
  return { kind: 'refused', code: 'TX_REFUSED', reason: message };
}

function toDriverBlock(wire: FakeWireBlock): DriverBlock {
  return {
    height: BigInt(wire.height),
    hash: wire.hash,
    parentHash: wire.parentHash,
    timestamp: wire.timestamp,
    transactionIds: wire.txIds,
  };
}

function toDriverTx(wire: FakeWireTx): DriverTransaction {
  const included = wire.blockHeight !== undefined && wire.blockHash !== undefined;
  return {
    id: wire.id,
    observation: included
      ? {
          seen: 'block',
          txHash: wire.id,
          blockHeight: BigInt(wire.blockHeight as string),
          blockHash: wire.blockHash as string,
          success: wire.success ?? true,
        }
      : { seen: wire.pending ? 'mempool' : 'none' },
    fee: [{ asset: 'native', amount: BigInt(wire.fee) }],
    transfers:
      wire.success === false
        ? []
        : [
            {
              locator: 'native',
              from: [wire.from],
              to: wire.to,
              asset: 'native',
              amount: BigInt(wire.amount),
              source: 'native',
              ...(wire.memo !== undefined ? { memo: wire.memo } : {}),
            },
          ],
    decoding: 'complete',
    details: wire.nonce !== undefined ? { nonce: wire.nonce } : {},
  };
}

export const fakeDriverFactory: DriverFactory = {
  async create(ctx: DriverContext): Promise<ChainDriver> {
    const { transport, chain, network, clock } = ctx;
    const ordering = chain.ordering;
    const expiryBlocks = BigInt(
      typeof ctx.options.expiryBlocks === 'number' ? ctx.options.expiryBlocks : 5,
    );
    const minBump = BigInt(network.replacement?.minBumpPercent ?? 10);
    const nativeAsset = assetId(chain.id, network.id, 'native');

    transport.setProbes({
      identity: (call) => call.rpc<string>('fake_identity'),
      ...(network.identity !== undefined ? { expectedIdentity: network.identity } : {}),
      height: async (call) => BigInt(await call.rpc<string>('fake_blockNumber')),
    });

    const call = <T>(method: string, params: unknown[] = [], options: CallOptions = {}) =>
      transport.rpc<T>(method, params, options);
    const read = <T>(method: string, params: unknown[] = []) => call<T>(method, params);
    const monitor = <T>(method: string, params: unknown[] = []) =>
      call<T>(method, params, { purpose: 'monitor' });
    const proof = <T>(method: string, params: unknown[] = []) =>
      call<T>(method, params, { quorum: 'proof' });

    const assertNative = (asset: AssetRef): void => {
      if (asset !== 'native') {
        throw new UnsupportedCapabilityError(
          'UNSUPPORTED_CAPABILITY',
          'the fake chain has no tokens',
        );
      }
    };

    const address: AddressCodec = {
      validate: (value) => isFakeAddress(value),
      normalize: (value) => {
        if (!isFakeAddress(value))
          throw new ValidationError('INVALID_ADDRESS', 'not a fake-chain address');
        const canonical = value.toLowerCase();
        return { canonical, display: canonical };
      },
      fromPublicKey: (publicKey) => {
        const canonical = fakeAddress(publicKey);
        return { canonical, display: canonical };
      },
    };

    const feeFor = async (fee: FeeSpeed | FeeOverride): Promise<FeeEstimateDraft> => {
      if (typeof fee === 'object') {
        const amount = fee.fee;
        if (typeof amount !== 'bigint') {
          throw new ValidationError(
            'INVALID_INTENT',
            'fake fee overrides look like { fee: bigint }',
          );
        }
        return {
          kind: 'fake',
          speed: 'custom',
          charges: [{ asset: 'native', amount, label: 'network' }],
          bound: 'exact',
          details: { fee: amount },
        };
      }
      const rate = BigInt(await read<string>('fake_feeRate'));
      const amount = rate * (fee === 'slow' ? 1n : fee === 'normal' ? 2n : 3n);
      return {
        kind: 'fake',
        speed: fee,
        charges: [{ asset: 'native', amount, label: 'network' }],
        bound: 'exact',
        details: { fee: amount },
      };
    };

    const buildUnsigned = async (
      intent: DriverIntent,
      fee: FeeEstimateDraft,
      build: BuildContext,
      fixedOrdering?: OrderingData,
    ): Promise<UnsignedTx> => {
      assertNative(intent.asset);
      const output = intent.outputs[0];
      if (!output || intent.outputs.length !== 1) {
        throw new ValidationError(
          'INVALID_INTENT',
          'the fake chain supports exactly one output',
        );
      }
      const key = build.keys[0];
      if (!key)
        throw new SigningError(
          'SIGNER_UNAVAILABLE',
          'no public key for the sending wallet',
        );
      let order: OrderingData;
      if (ordering === 'expiry') {
        const head = BigInt(await read<string>('fake_blockNumber'));
        order = fixedOrdering ?? { kind: 'expiry', lastValidHeight: head + expiryBlocks };
      } else {
        const allocated = fixedOrdering ?? build.ordering;
        if (!allocated || allocated.kind !== ordering) {
          throw new StateError(
            'INVALID_TRANSITION',
            `missing ${ordering} allocation for the fake chain`,
          );
        }
        order =
          ordering === 'seqno' && allocated.kind === 'seqno'
            ? { kind: 'seqno', seqno: allocated.seqno, validUntil: clock.now() + 60_000 }
            : allocated;
      }
      const feeAmount = fee.charges.reduce((sum, c) => sum + c.amount, 0n);
      const slot =
        order.kind === 'nonce'
          ? { nonce: order.nonce.toString() }
          : order.kind === 'seqno'
            ? { nonce: order.seqno.toString() }
            : order.kind === 'expiry' && order.lastValidHeight !== undefined
              ? { lastValidHeight: order.lastValidHeight.toString() }
              : {};
      const tx: FakeUnsigned = {
        chainId: network.identity ?? 'fake-local',
        from: intent.from,
        to: output.to,
        amount: output.amount.toString(),
        fee: feeAmount.toString(),
        ...slot,
        ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
      };
      return {
        payload: { encoding: 'json', data: canonicalJson(tx) },
        signingRequests: [
          {
            id: 'r0',
            scheme: 'secp256k1-ecdsa',
            payload: fakeDigest(tx),
            payloadKind: 'digest',
            publicKey: key.publicKey,
            ...(key.keyRef ? { keyRef: key.keyRef } : {}),
          },
        ],
        ordering: order,
        fee,
        summary: {
          asset: nativeAsset,
          outputs: [{ to: output.to, amount: output.amount.toString() }],
          ...(intent.memo !== undefined ? { memo: intent.memo } : {}),
        },
      };
    };

    const builder: TxBuilder = {
      estimateFee: async (intent) => {
        assertNative(intent.asset);
        return feeFor(intent.fee);
      },
      checkFunds: async (intent, fee) => {
        const available = BigInt(
          await read<string>('fake_getBalance', [intent.from, 'latest']),
        );
        const required =
          intent.outputs.reduce((sum, o) => sum + o.amount, 0n) +
          fee.charges.reduce((sum, c) => sum + c.amount, 0n);
        return available >= required
          ? { ok: true }
          : { ok: false, asset: 'native', required, available };
      },
      build: (intent, fee, build) => buildUnsigned(intent, fee, build),
      assemble: async (unsigned, signatures) => {
        const request = unsigned.signingRequests[0];
        const signature = signatures.find((s) => s.requestId === 'r0');
        if (!request || !signature || signature.recovery === undefined) {
          throw new SigningError('SIGNING_FAILED', 'missing signature for request r0');
        }
        const tx = JSON.parse(unsigned.payload.data) as FakeUnsigned;
        const raw = encodeEnvelope({
          tx,
          sig: toHex(signature.bytes),
          recovery: signature.recovery,
          pub: toHex(request.publicKey),
        });
        return {
          raw: { encoding: 'base64', data: raw },
          ref: { id: fakeTxId(raw), idKind: 'tx-hash', canonical: true },
        };
      },
    };

    const broadcaster: Broadcaster = {
      async broadcast(signed, options = {}) {
        try {
          await call<string>('fake_sendRawTransaction', [signed.raw.data], {
            retry: 'ambiguous-on-failure',
            purpose: 'broadcast',
            ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          return { kind: 'accepted' };
        } catch (error) {
          if (isCryptoAioError(error, 'RPC_ERROR')) {
            return classify(String(error.details?.rpcMessage ?? error.message));
          }
          throw error;
        }
      },
    };

    const reader: ChainReader = {
      getBalance: async (value, asset) => {
        assertNative(asset);
        return BigInt(await read<string>('fake_getBalance', [value, 'latest']));
      },
      getBlockHeight: async () => BigInt(await monitor<string>('fake_blockNumber')),
      getFinalizedHeight: async () =>
        BigInt((await monitor<{ height: string }>('fake_finalizedBlock')).height),
      getBlock: async (ref) => {
        const wire = await read<FakeWireBlock | null>('fake_getBlock', [
          typeof ref === 'bigint' ? ref.toString() : ref,
          false,
        ]);
        return wire ? toDriverBlock(wire) : null;
      },
      getTransaction: async (id) => {
        const wire = await read<FakeWireTx | null>('fake_getTransaction', [id]);
        return wire ? toDriverTx(wire) : null;
      },
      observe: async (ref) => {
        const wire = await monitor<FakeWireTx | null>('fake_getTransaction', [ref.id]);
        return wire ? toDriverTx(wire).observation : { seen: 'none' };
      },
    };

    const finalizedHead = async () => {
      const head = await proof<{ height: string; hash: string; timestamp: number }>(
        'fake_finalizedBlock',
      );
      return { height: BigInt(head.height), hash: head.hash, timestamp: head.timestamp };
    };

    const proofs: ProofSource = {
      finalizedHead,
      includedFinal: async (ref) => {
        const wire = await proof<FakeWireTx | null>('fake_getFinalizedTransaction', [
          ref.id,
        ]);
        if (!wire || wire.blockHeight === undefined || wire.blockHash === undefined)
          return { included: false };
        return {
          included: true,
          success: wire.success ?? true,
          blockHeight: BigInt(wire.blockHeight),
          blockHash: wire.blockHash,
          txHash: wire.id,
        };
      },
      slotConsumed: async (order, from, level) => {
        if (order.kind !== 'nonce' && order.kind !== 'seqno') return false;
        const slot = order.kind === 'nonce' ? order.nonce : order.seqno;
        const fetchNonce = level === 'finalized' ? proof : monitor;
        const next = BigInt(
          await fetchNonce<string>('fake_getNonce', [
            from,
            level === 'finalized' ? 'finalized' : 'latest',
          ]),
        );
        return next > slot;
      },
      expired: async (order) => {
        if (order.kind !== 'expiry' || order.lastValidHeight === undefined) return false;
        return (await finalizedHead()).height >= order.lastValidHeight;
      },
    };

    const sequence: SequenceSource | undefined =
      ordering === 'expiry'
        ? undefined
        : {
            pending: async (value) =>
              BigInt(await monitor<string>('fake_getNonce', [value, 'pending'])),
            latest: async (value) =>
              BigInt(await monitor<string>('fake_getNonce', [value, 'latest'])),
          };

    const previousTx = (previous: UnsignedTx): FakeUnsigned =>
      JSON.parse(previous.payload.data) as FakeUnsigned;
    const previousFee = (previous: UnsignedTx): bigint =>
      previous.fee.charges.reduce((sum, c) => sum + c.amount, 0n);

    const replacement: ReplacementPolicy | undefined =
      ordering === 'nonce'
        ? {
            replace: true,
            cancel: true,
            async buildReplacement(previous, fee, build) {
              const next = await feeFor(fee);
              const nextFee = next.charges.reduce((sum, c) => sum + c.amount, 0n);
              if (nextFee * 100n < previousFee(previous) * (100n + minBump)) {
                throw new ChainError(
                  'FEE_TOO_LOW',
                  `replacement fee must be at least ${minBump}% higher`,
                );
              }
              const tx = previousTx(previous);
              return buildUnsigned(
                {
                  asset: 'native',
                  outputs: [{ to: tx.to, amount: BigInt(tx.amount) }],
                  from: tx.from,
                  fee,
                  ...(tx.memo !== undefined ? { memo: tx.memo } : {}),
                },
                next,
                build,
                previous.ordering,
              );
            },
            async buildCancel(previous, build) {
              const bumped = (previousFee(previous) * (100n + minBump) + 99n) / 100n;
              const fee: FeeEstimateDraft = {
                kind: 'fake',
                speed: 'custom',
                charges: [{ asset: 'native', amount: bumped, label: 'network' }],
                bound: 'exact',
                details: { fee: bumped },
              };
              const tx = previousTx(previous);
              return buildUnsigned(
                {
                  asset: 'native',
                  outputs: [{ to: tx.from, amount: 0n }],
                  from: tx.from,
                  fee: { fee: bumped },
                },
                fee,
                build,
                previous.ordering,
              );
            },
          }
        : undefined;

    const blocks: BlockSource = {
      header: async (height) => {
        const wire = await monitor<FakeWireBlock | null>('fake_getBlock', [
          height.toString(),
          false,
        ]);
        return wire ? toDriverBlock(wire) : null;
      },
      transactions: async (block, filter) => {
        const wire = await monitor<FakeWireBlock | null>('fake_getBlock', [
          block.height.toString(),
          true,
        ]);
        if (!wire || wire.hash !== block.hash) {
          throw new ProviderError(
            'PROVIDER_INCONSISTENT',
            `block ${block.height} changed while scanning`,
            { retryable: true },
          );
        }
        const txs = (wire.txs ?? []).map(toDriverTx);
        if (!filter?.addresses?.length) return txs;
        const wanted = new Set(filter.addresses.map((a) => a.toLowerCase()));
        return txs.filter((t) =>
          t.transfers.some(
            (tr) => wanted.has(tr.to) || tr.from.some((f) => wanted.has(f)),
          ),
        );
      },
    };

    const capabilities = new Set<Capability>([
      'memo',
      'block-scan',
      'finality-tag',
      'hd-public-derivation',
    ]);
    if (ordering === 'nonce') {
      capabilities.add('replace-fee');
      capabilities.add('cancel');
    }
    if (ordering === 'expiry') capabilities.add('expiry');

    return {
      ordering,
      capabilities,
      address,
      reader,
      builder,
      broadcaster,
      proofs,
      ...(sequence ? { sequence } : {}),
      ...(replacement ? { replacement } : {}),
      blocks,
      // Written as a fresh literal here (not a separately-typed `const ext: FakeExt = ...`):
      // `ChainDriver.ext` is a generic `Record<string, Record<string, (...args) => Promise<unknown>>>`,
      // and a named interface like `FakeExt` has no index signature, so passing it through a
      // typed intermediate fails TS2322 ("index signature missing"). A fresh object literal at
      // the assignment site is checked structurally instead and satisfies both `ChainDriver.ext`
      // and, via the `fake` module augmentation, `FakeExt`.
      ext: {
        fake: {
          nonceOf: async (value: string) =>
            BigInt(await read<string>('fake_getNonce', [value, 'latest'])),
          head: async () => BigInt(await read<string>('fake_blockNumber')),
        },
      } satisfies FakeExt,
      limits: () => ({ maxOutputs: 1 }),
      createNativeClient: (): FakeNativeClient => ({
        id: ++nativeClients,
        settings: {},
        rpc: <T>(method: string, params: unknown[] = []) =>
          transport.rpc<T>(method, params),
      }),
    };
  },
};
