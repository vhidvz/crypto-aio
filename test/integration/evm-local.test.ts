/**
 * Opt-in write-path checks against a local development EVM node, skipped unless
 * CRYPTO_AIO_IT_EVM_LOCAL_URL is set. `pnpm test:evm-local` (scripts/evm-local.mjs) starts
 * Foundry's anvil from the `@foundry-rs/anvil` devDependency, sets the variable, runs this
 * suite and stops the node. Another node works if it serves anvil's dev methods
 * (`evm_setAutomine`, `evm_mine`, `anvil_reorg`) and its first account is unlocked and
 * funded, as anvil's prefunded accounts are.
 *
 * Every other suite runs on nodes this repository scripted. These sign, broadcast and prove
 * real transactions on a real node implementation, through the public API only, so the
 * node's own texts, pool rules and encodings meet the library's. The suite turns automine
 * off: a transaction stays in the pool until a test mines, and the chain moves only when a
 * test says so. Each library gets a fresh random key, funded from the node's first
 * prefunded account: no real key is ever used.
 *
 * The chain registers through `evmChainPlugin` as `evmlocal:dev`. anvil serves the
 * `finalized` tag as its head less two epochs of 32 slots, a fixed depth with no consensus
 * behind it that `anvil_reorg` can reach past, so finality is by confirmations instead.
 */
import { randomBytes } from 'node:crypto';
import {
  CryptoAio,
  createMemoryStores,
  localSigner,
  secret,
  type AioEvent,
  type ChainId,
  type ChainInfo,
  type Signer,
  type Stores,
} from '../../src';
import { evmChainPlugin } from '../../src/adapters/evm';
import { CrashError, FaultyOperationStore } from '../../src/testing';

const url = process.env.CRYPTO_AIO_IT_EVM_LOCAL_URL;
const LIBRARIES = ['ethers', 'web3'] as const;
const suite = url ? describe.each(LIBRARIES) : describe.skip.each(LIBRARIES);

const CHAIN = 'evmlocal';
const NETWORK = 'dev';
/** A transfer in block `h` is final once the node holds block `h + 2`: three confirmations. */
const CONFIRMATIONS = 3;
const GWEI = 1_000_000_000n;
const ETHER = 10n ** 18n;
/** While a test waits, one block per this many milliseconds; the library polls faster. */
const MINE_INTERVAL_MS = 100;

/**
 * A minimal ERC-20, as solc 0.8.28 compiles it (optimizer on, 200 runs, `evmVersion`
 * `paris` so that any EVM node runs it, no metadata hash or CBOR suffix). Its source:
 *
 * ```solidity
 * contract Token {
 *     event Transfer(address indexed from, address indexed to, uint256 value);
 *     string public constant symbol = "TKN";
 *     uint8 public constant decimals = 6;
 *     mapping(address => uint256) public balanceOf;
 *     constructor(address holder, uint256 supply) {
 *         balanceOf[holder] = supply;
 *         emit Transfer(address(0), holder, supply);
 *     }
 *     function transfer(address to, uint256 value) external returns (bool) {
 *         balanceOf[msg.sender] -= value;
 *         balanceOf[to] += value;
 *         emit Transfer(msg.sender, to, value);
 *         return true;
 *     }
 * }
 * ```
 */
const TOKEN_BYTECODE =
  '0x6080604052348015600f57600080fd5b50604051610343380380610343833981016040819052602c91607d565b6001600160a01b038216600081815260208181526040808320859055518481527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a3505060b5565b60008060408385031215608f57600080fd5b82516001600160a01b038116811460a557600080fd5b6020939093015192949293505050565b61027f806100c46000396000f3fe608060405234801561001057600080fd5b506004361061004c5760003560e01c8063313ce5671461005157806370a082311461007057806395d89b411461009e578063a9059cbb146100cd575b600080fd5b610059600681565b60405160ff90911681526020015b60405180910390f35b61009061007e3660046101a9565b60006020819052908152604090205481565b604051908152602001610067565b6100c0604051806040016040528060038152602001622a25a760e91b81525081565b60405161006791906101cb565b6100e06100db366004610219565b6100f0565b6040519015158152602001610067565b33600090815260208190526040812080548391908390610111908490610259565b90915550506001600160a01b0383166000908152602081905260408120805484929061013e90849061026c565b90915550506040518281526001600160a01b0384169033907fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9060200160405180910390a35060015b92915050565b80356001600160a01b03811681146101a457600080fd5b919050565b6000602082840312156101bb57600080fd5b6101c48261018d565b9392505050565b602081526000825180602084015260005b818110156101f957602081860181015160408684010152016101dc565b506000604082850101526040601f19601f83011684010191505092915050565b6000806040838503121561022c57600080fd5b6102358361018d565b946020939093013593505050565b634e487b7160e01b600052601160045260246000fd5b8181038181111561018757610187610243565b808201808211156101875761018761024356';
/** `balanceOf(address)`. */
const BALANCE_OF = '0x70a08231';
/** The token's supply, all held by the test key: 1,000 TKN. */
const TOKEN_SUPPLY = 1_000_000_000n;

// ---- the node, read and driven over plain JSON-RPC ---------------------------------------

let rpcId = 0;

async function node<T = unknown>(
  method: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const response = await fetch(url as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const body = (await response.json()) as {
    readonly result?: T;
    readonly error?: { readonly message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

interface NodeTx {
  readonly blockHash: string | null;
  readonly nonce: string;
  readonly to: string | null;
  readonly value: string;
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
}

interface NodeReceipt {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly status: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly contractAddress: string | null;
}

const hex = (value: bigint): string => `0x${value.toString(16)}`;
/** A 32-byte ABI word of an address or a quantity. */
const word = (value: string): string => value.replace(/^0x/, '').padStart(64, '0');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const balance = async (address: string) =>
  BigInt(await node<string>('eth_getBalance', [address, 'latest']));
const nonce = async (address: string, block: 'latest' | 'pending') =>
  BigInt(await node<string>('eth_getTransactionCount', [address, block]));
const transaction = (hash: string) =>
  node<NodeTx | null>('eth_getTransactionByHash', [hash]);
const receipt = (hash: string) =>
  node<NodeReceipt | null>('eth_getTransactionReceipt', [hash]);
const tokenBalance = async (token: string, owner: string) =>
  BigInt(
    await node<string>('eth_call', [
      { to: token, data: BALANCE_OF + word(owner) },
      'latest',
    ]),
  );
const mine = async (blocks = 1) => {
  for (let i = 0; i < blocks; i++) await node('evm_mine');
};

/** A fresh address that holds nothing. */
const stranger = (): string => `0x${randomBytes(20).toString('hex')}`;

/** Mines a block every `MINE_INTERVAL_MS` until `promise` settles. */
async function mineWhile<T>(promise: Promise<T>, maxBlocks = 300): Promise<T> {
  let settled = false;
  const tracked = promise.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < maxBlocks && !settled; i++) {
    await mine();
    await sleep(MINE_INTERVAL_MS);
  }
  if (!settled) throw new Error(`did not settle within ${maxBlocks} blocks`);
  return tracked;
}

/** Sends from the node's first prefunded account, mines it and returns its receipt. */
async function fromFunder(request: Readonly<Record<string, string>>) {
  const [funder] = await node<string[]>('eth_accounts');
  const hash = await node<string>('eth_sendTransaction', [{ from: funder, ...request }]);
  await mine();
  const mined = await receipt(hash);
  if (mined?.status !== '0x1') throw new Error('a funding transaction failed');
  return mined;
}

/** A signer around `inner` that counts its `sign` calls. */
function counting(inner: Signer): { readonly signer: Signer; calls(): number } {
  let calls = 0;
  return {
    signer: {
      id: inner.id,
      schemes: inner.schemes,
      getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
      sign: (requests, ctx) => {
        calls += 1;
        return inner.sign(requests, ctx);
      },
    },
    calls: () => calls,
  };
}

/** The Operation id an error of `transfer` names. */
const operationOf = (error: unknown): string =>
  String((error as { context?: { operationId?: unknown } }).context?.operationId);

suite('EVM write path on a local node (%s)', (library) => {
  // A fresh random key per library: the two runs never share a nonce or a balance.
  const { signer: key } = localSigner.generate({ id: 'hot', curves: ['secp256k1'] });
  let chain: ChainInfo;
  let address: string;
  /** The token contract as the node's receipt prints it: lower case. */
  let token: string | undefined;

  /** A container over `stores`, its handle signing with `signer`, served by the node. */
  function open(options: { readonly stores?: Stores; readonly signer?: Signer } = {}) {
    const aio = new CryptoAio({
      env: false,
      plugins: [
        evmChainPlugin({
          name: 'local',
          chains: [chain],
          // Registered as the receipt prints it; the plugin checksums it, as the driver
          // names the token in its transfers.
          ...(token
            ? {
                assets: [
                  {
                    chain: CHAIN,
                    network: NETWORK,
                    ref: { standard: 'erc20', contract: token },
                    metadata: { symbol: 'TKN', decimals: 6 },
                    aliases: ['TKN'],
                  },
                ],
              }
            : {}),
        }),
      ],
      stores: options.stores ?? createMemoryStores(),
      providers: {
        local: { endpoints: [{ name: 'local', url: secret(url as string) }] },
      },
      signers: { hot: options.signer ?? key },
      wallets: { main: { signer: 'hot' } },
      chains: {
        [CHAIN]: { network: NETWORK, library, provider: 'local', wallet: 'main' },
      },
      lifecycle: {
        requireIdempotencyKey: true,
        pollIntervalMs: 50,
        // A transaction the node lost is resent after a second, so a test waits that long.
        droppedGracePeriodMs: 1_000,
        rebroadcastIntervalMs: 1_000,
        waitTimeoutMs: 60_000,
      },
      transport: { baseDelayMs: 10, maxDelayMs: 100 },
    });
    return { aio, bc: aio.blockchain({ chain: CHAIN as ChainId }) };
  }

  /** A unique idempotency key: runs share the node, and each container its own store. */
  const idempotencyKey = (name: string) =>
    `${library}-${name}-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    // The pool keeps every transaction until a test mines: a pending transfer stays pending.
    await node('evm_setAutomine', [false]);
    chain = {
      id: CHAIN,
      family: 'evm',
      model: 'account',
      ordering: 'nonce',
      schemes: ['secp256k1-ecdsa'],
      nativeAsset: { symbol: 'ETH', decimals: 18 },
      defaultNetwork: NETWORK,
      networks: {
        [NETWORK]: {
          id: NETWORK,
          identity: BigInt(await node<string>('eth_chainId')).toString(),
          testnet: true,
          // anvil prices EIP-1559 blocks, its base fee falling to 7 wei while they are empty.
          feeModel: 'evm-1559',
          finality: { kind: 'confirmations', confirmations: CONFIRMATIONS },
          capabilities: { remove: ['finality-tag'] },
          defaultConfirmations: 1,
          // Deeper than the reorgs a test makes.
          reorgWindow: 8,
          // geth's bump. anvil's pool takes any higher price, so the library's rule binds.
          replacement: { minBumpPercent: 10 },
        },
      },
    };
    const { aio, bc } = open();
    try {
      address = (await bc.walletAddress()).canonical;
    } finally {
      await aio.close();
    }
    await fromFunder({ to: address, value: hex(10n * ETHER) });
    const deployed = await fromFunder({
      data: TOKEN_BYTECODE + word(address) + word(hex(TOKEN_SUPPLY)),
    });
    token = deployed.contractAddress ?? undefined;
  });

  afterAll(async () => {
    // anvil's default, for whatever runs on the node next.
    await node('evm_setAutomine', [true]);
  });

  it('pays a native transfer, proven final at the third confirmation and not before', async () => {
    const { aio, bc } = open();
    try {
      await bc.ready();
      const to = stranger();
      const amount = ETHER / 1_000n;
      const before = await balance(address);
      const sub = await bc.transfer(
        { to, amount },
        { idempotencyKey: idempotencyKey('n') },
      );
      expect(sub).toMatchObject({
        state: 'submitted',
        attempt: { idKind: 'tx-hash', canonical: true },
      });
      const hash = sub.attempt?.id as string;
      // In the node's pool, and in no block until the test mines one.
      expect((await transaction(hash))?.blockHash).toBeNull();
      expect(await bc.getTransactionStatus(sub.operationId)).toMatchObject({
        state: 'mempool',
        finality: 'none',
      });
      const seen: unknown[] = [];
      for (let i = 0; i < CONFIRMATIONS; i++) {
        await mine();
        const status = await bc.getTransactionStatus(sub.operationId);
        seen.push([status.state, status.evidence, status.confirmations, status.finality]);
      }
      expect(seen).toEqual([
        ['included', 'observed', 1, 'probabilistic'],
        ['included', 'observed', 2, 'probabilistic'],
        ['final', 'proven', 3, 'final'],
      ]);
      const final = await sub.wait({ finality: 'final' });
      const mined = (await receipt(hash)) as NodeReceipt;
      expect(final.status).toMatchObject({
        state: 'final',
        evidence: 'proven',
        blockHash: mined.blockHash,
        blockHeight: BigInt(mined.blockNumber),
      });
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect(await balance(to)).toBe(amount);
      // The sender paid the amount and the receipt's fee, and nothing else.
      const fee = BigInt(mined.gasUsed) * BigInt(mined.effectiveGasPrice);
      expect(before - (await balance(address))).toBe(amount + fee);
      const tx = await bc.getTransaction(hash);
      expect(tx?.transfers).toEqual([
        expect.objectContaining({
          to: expect.objectContaining({
            canonical: (await bc.normalizeAddress(to)).canonical,
          }),
          amount: expect.objectContaining({ base: amount }),
        }),
      ]);
    } finally {
      await aio.close();
    }
  });

  it('returns the same Operation for a repeated idempotency key, and pays once', async () => {
    const { signer, calls } = counting(key);
    const { aio, bc } = open({ signer });
    try {
      const to = stranger();
      const amount = 12_345n;
      const k = idempotencyKey('repeat');
      const start = await nonce(address, 'pending');
      const first = await bc.transfer({ to, amount }, { idempotencyKey: k });
      // A repeat while the transaction is in the pool: the same Operation and Attempt.
      const pending = await bc.transfer({ to, amount }, { idempotencyKey: k });
      expect([pending.operationId, pending.attempt?.id]).toEqual([
        first.operationId,
        first.attempt?.id,
      ]);
      // A resend of the pooled bytes: anvil answers "transaction already imported", which
      // is the node holding them, not a refusal that would stall the transfer.
      expect((await bc.rebroadcast(first.operationId)).state).toBe('submitted');
      await mineWhile(first.wait({ finality: 'final' }));
      // A repeat once it is final: the final Operation, not a second payment.
      const late = await bc.transfer({ to, amount }, { idempotencyKey: k });
      expect([late.operationId, late.state, late.attempts.length]).toEqual([
        first.operationId,
        'final',
        1,
      ]);
      // Another intent under the same key is refused, never paid.
      await expect(
        bc.transfer({ to, amount: amount + 1n }, { idempotencyKey: k }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect([await balance(to), await nonce(address, 'pending'), calls()]).toEqual([
        amount,
        start + 1n,
        1,
      ]);
    } finally {
      await aio.close();
    }
  });

  it('lands concurrent transfers from one address on consecutive nonces', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const start = await nonce(address, 'pending');
      const subs = await Promise.all(
        [1n, 2n, 3n, 4n, 5n].map((amount) =>
          bc.transfer({ to, amount }, { idempotencyKey: idempotencyKey(`c${amount}`) }),
        ),
      );
      const nonces = await Promise.all(
        subs.map(async (s) =>
          BigInt((await transaction(s.attempt?.id as string))?.nonce ?? -1),
        ),
      );
      expect(nonces.sort((a, b) => Number(a - b))).toEqual(
        [0n, 1n, 2n, 3n, 4n].map((i) => start + i),
      );
      const finals = await mineWhile(
        Promise.all(subs.map((s) => s.wait({ finality: 'final' }))),
      );
      expect(finals.map((f) => f.status.state)).toEqual(Array(5).fill('final'));
      expect([await balance(to), await nonce(address, 'latest')]).toEqual([
        15n,
        start + 5n,
      ]);
    } finally {
      await aio.close();
    }
  });

  it('transfers an ERC-20 token by its alias, proven by its Transfer log, under one asset id', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const contract = (await bc.normalizeAddress(token as string)).canonical;
      const id = `${CHAIN}:${NETWORK}/erc20:${contract}`;
      // The alias of the lower-case registration and the token's ref name one asset.
      expect((await bc.resolveAsset('TKN')).id).toBe(id);
      expect(
        (await bc.resolveAsset({ standard: 'erc20', contract: token as string })).id,
      ).toBe(id);
      const sub = await bc.transfer(
        { to, amount: '1.5', asset: 'TKN' },
        { idempotencyKey: idempotencyKey('token') },
      );
      const final = await mineWhile(sub.wait({ finality: 'final' }));
      expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect(await tokenBalance(contract, to)).toBe(1_500_000n);
      const held = await bc.getBalance(to, 'TKN');
      expect([held.asset.id, held.amount.format()]).toEqual([id, '1.5 TKN']);
      // The chain's view, decoded from the node's receipt: the same asset id again.
      const tx = await bc.getTransaction(sub.attempt?.id as string);
      expect(tx?.transfers).toEqual([
        expect.objectContaining({
          source: 'token-event',
          asset: expect.objectContaining({ id }),
          amount: expect.objectContaining({ base: 1_500_000n }),
        }),
      ]);
    } finally {
      await aio.close();
    }
  });

  it('replaces a pending transfer on its nonce, and only the replacement lands', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const amount = 777n;
      const sub = await bc.transfer(
        { to, amount, fee: 'slow' },
        { idempotencyKey: idempotencyKey('replace') },
      );
      const originalHash = sub.attempt?.id as string;
      const original = (await transaction(originalHash)) as NodeTx;
      expect(original.blockHash).toBeNull();
      // Both prices well past the 10% bump: a speed's re-estimate on a quiet chain is not.
      const fee = {
        maxFeePerGas: 2n * BigInt(original.maxFeePerGas) + GWEI,
        maxPriorityFeePerGas: BigInt(original.maxPriorityFeePerGas) + GWEI,
      };
      const replaced = await bc.replace(sub.operationId, { fee });
      expect(replaced.attempts.map((a) => a.purpose)).toEqual([
        'original',
        'replacement',
      ]);
      const replacement = replaced.attempt?.id as string;
      // The node swapped it in for the original: one transaction per nonce in its pool.
      expect(await transaction(originalHash)).toBeNull();
      expect((await transaction(replacement))?.nonce).toBe(original.nonce);
      // The same fee again is the same replacement, not a third transaction.
      const again = await bc.replace(sub.operationId, { fee });
      expect([again.attempts.length, again.attempt?.id]).toEqual([2, replacement]);
      const final = await mineWhile(replaced.wait({ finality: 'final' }));
      expect(final.operation).toMatchObject({
        state: 'final',
        outcome: 'executed',
        activeAttempt: { id: replacement },
      });
      expect(
        final.operation?.attempts.map((a) => [a.status?.state, a.status?.evidence]),
      ).toEqual([
        ['replaced', 'proven'],
        ['final', 'proven'],
      ]);
      expect(await balance(to)).toBe(amount);
    } finally {
      await aio.close();
    }
  });

  it('stalls a transfer the node refuses below its base fee, then lands its replacement', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const start = await nonce(address, 'pending');
      // 1 wei per gas: anvil's base fee never falls below 7 wei.
      const error = await bc
        .transfer(
          { to, amount: 5n, fee: { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n } },
          { idempotencyKey: idempotencyKey('underpriced') },
        )
        .catch((e: unknown) => e);
      // anvil's "max fee per gas less than block base fee": a refusal that may pass, so the
      // Operation keeps its signed bytes and its nonce.
      expect(error).toMatchObject({ code: 'FEE_TOO_LOW', retryable: false });
      const operationId = operationOf(error);
      expect(await aio.operations.get(operationId)).toMatchObject({
        state: 'stalled',
        attempts: [{ status: { state: 'refused', reason: 'fee too low' } }],
      });
      expect(await nonce(address, 'pending')).toBe(start);
      const replaced = await bc.replace(operationId, {
        fee: { maxFeePerGas: 100n * GWEI, maxPriorityFeePerGas: GWEI },
      });
      expect(replaced.state).toBe('submitted');
      const final = await mineWhile(replaced.wait({ finality: 'final' }));
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
      expect([await balance(to), await nonce(address, 'latest')]).toEqual([
        5n,
        start + 1n,
      ]);
    } finally {
      await aio.close();
    }
  });

  it('cancels a pending transfer with a zero-value self-transfer on its nonce', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const sub = await bc.transfer(
        { to, amount: 999n, fee: 'slow' },
        { idempotencyKey: idempotencyKey('cancel') },
      );
      const original = (await transaction(sub.attempt?.id as string)) as NodeTx;
      const cancelled = await bc.cancel(sub.operationId);
      expect(cancelled.attempts.map((a) => a.purpose)).toEqual(['original', 'cancel']);
      const cancel = (await transaction(cancelled.attempt?.id as string)) as NodeTx;
      expect([cancel.to?.toLowerCase(), BigInt(cancel.value), cancel.nonce]).toEqual([
        address.toLowerCase(),
        0n,
        original.nonce,
      ]);
      const final = await mineWhile(cancelled.wait({ finality: 'final' }));
      expect(final.operation).toMatchObject({ state: 'final', outcome: 'cancelled' });
      expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
      expect(await balance(to)).toBe(0n);
      expect(await nonce(address, 'latest')).toBe(BigInt(original.nonce) + 1n);
    } finally {
      await aio.close();
    }
  });

  it('loses a cancel race to the mined original as NONCE_CONFLICT, and the payment stands', async () => {
    const { aio, bc } = open();
    try {
      const to = stranger();
      const sub = await bc.transfer(
        { to, amount: 99n },
        { idempotencyKey: idempotencyKey('late-cancel') },
      );
      await mine();
      // anvil's "nonce too low": the original holds the nonce, and the cancel can never land.
      await expect(bc.cancel(sub.operationId)).rejects.toMatchObject({
        code: 'NONCE_CONFLICT',
      });
      const final = await mineWhile(sub.wait({ finality: 'final' }));
      expect(final.operation).toMatchObject({
        state: 'final',
        outcome: 'executed',
        activeAttempt: { id: sub.attempt?.id },
      });
      expect(await balance(to)).toBe(99n);
    } finally {
      await aio.close();
    }
  });

  it('lands once after a crash between storing the signed Attempt and sending it', async () => {
    const stores = createMemoryStores();
    const faulty = new FaultyOperationStore(stores.operations);
    // The signed Attempt is stored, then the process dies before it broadcasts.
    faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
    const { signer, calls } = counting(key);
    const crashed = open({ stores: { ...stores, operations: faulty }, signer });
    const to = stranger();
    const amount = 4_242n;
    const k = idempotencyKey('crash');
    const start = await nonce(address, 'pending');
    await expect(
      crashed.bc.transfer({ to, amount }, { idempotencyKey: k }),
    ).rejects.toBeInstanceOf(CrashError);
    await crashed.aio.close();
    const stored = await stores.operations.getByKey('default', k);
    const hash = stored?.attempts[0]?.ref.id as string;
    expect(stored?.state).toBe('signed');
    expect([await transaction(hash), await nonce(address, 'pending')]).toEqual([
      null,
      start,
    ]);

    // A new process on the same stores: recovery sends the stored bytes, signing nothing.
    const { aio, bc } = open({ stores, signer });
    try {
      const report = await aio.operations.recover();
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      expect((await transaction(hash))?.blockHash).toBeNull();
      const final = await mineWhile(
        bc.waitForConfirmation(stored?.id as string, { finality: 'final' }),
      );
      expect(final.operation).toMatchObject({
        state: 'final',
        outcome: 'executed',
        activeAttempt: { id: hash },
      });
      const repeat = await bc.transfer({ to, amount }, { idempotencyKey: k });
      expect([repeat.operationId, repeat.attempts.length]).toEqual([stored?.id, 1]);
      expect([await balance(to), await nonce(address, 'latest'), calls()]).toEqual([
        amount,
        start + 1n,
        1,
      ]);
    } finally {
      await aio.close();
    }
  });

  it('recovers a transfer sent but never recorded, mined before the new process starts', async () => {
    const stores = createMemoryStores();
    const faulty = new FaultyOperationStore(stores.operations);
    // The broadcast happens, then the process dies before it records `submitted`.
    faulty.crashOn({
      method: 'update',
      timing: 'before',
      when: (args) =>
        (args[2] as { readonly state?: string } | undefined)?.state === 'submitted',
    });
    const { signer, calls } = counting(key);
    const crashed = open({ stores: { ...stores, operations: faulty }, signer });
    const to = stranger();
    const k = idempotencyKey('unrecorded');
    await expect(
      crashed.bc.transfer({ to, amount: 2_024n }, { idempotencyKey: k }),
    ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
    await crashed.aio.close();
    const stored = await stores.operations.getByKey('default', k);
    const hash = stored?.attempts[0]?.ref.id as string;
    expect(stored?.state).toBe('signed');
    await mine();
    expect((await receipt(hash))?.status).toBe('0x1');

    // The resend meets anvil's "nonce too low": the transaction itself holds the nonce, and
    // the check that follows finds it in its block.
    const { aio, bc } = open({ stores, signer });
    try {
      expect(await aio.operations.recover()).toMatchObject({ rebroadcast: 1, failed: 0 });
      const final = await mineWhile(
        bc.waitForConfirmation(stored?.id as string, { finality: 'final' }),
      );
      expect(final.operation).toMatchObject({
        state: 'final',
        outcome: 'executed',
        activeAttempt: { id: hash },
      });
      expect([await balance(to), calls()]).toEqual([2_024n, 1]);
    } finally {
      await aio.close();
    }
  });

  it('estimates the EIP-1559 fee from the node, and refuses what the wallet cannot pay', async () => {
    const { signer, calls } = counting(key);
    const { aio, bc } = open({ signer });
    try {
      const to = stranger();
      const estimate = await bc.estimateFee({ to, amount: 1n });
      const details = estimate.details as {
        readonly gasLimit: bigint;
        readonly maxFeePerGas: bigint;
        readonly maxPriorityFeePerGas: bigint;
        readonly baseFeePerGas: bigint;
      };
      expect(estimate).toMatchObject({ kind: 'evm-1559', bound: 'upper' });
      expect(details.gasLimit).toBe(21_000n);
      // The node's next base fee, allowed to double, plus the tip.
      const history = await node<{ readonly baseFeePerGas: readonly string[] }>(
        'eth_feeHistory',
        ['0x1', 'latest', []],
      );
      expect(details.baseFeePerGas).toBe(BigInt(history.baseFeePerGas.at(-1) as string));
      expect(details.maxFeePerGas).toBe(
        2n * details.baseFeePerGas + details.maxPriorityFeePerGas,
      );
      expect(estimate.charges[0]?.amount.base).toBe(21_000n * details.maxFeePerGas);

      const start = await nonce(address, 'pending');
      const available = await balance(address);
      // The whole balance leaves nothing for the fee; one wei more, anvil's gas estimate
      // still answers, so the balance check refuses both, before anything is signed.
      for (const amount of [available, available + 1n]) {
        const error = await bc
          .transfer({ to, amount }, { idempotencyKey: idempotencyKey('funds') })
          .catch((e: unknown) => e);
        expect(error).toMatchObject({
          code: 'INSUFFICIENT_FUNDS',
          details: { available: available.toString() },
        });
        const required = (error as { details: { required: string } }).details.required;
        expect(BigInt(required)).toBeGreaterThan(available);
        expect((await aio.operations.get(operationOf(error)))?.state).toBe('failed');
      }
      // A token shortfall: the transfer's gas estimate reverts, and the token balance says why.
      await expect(
        bc.transfer(
          { to, amount: '1000000', asset: 'TKN' },
          { idempotencyKey: idempotencyKey('token-funds') },
        ),
      ).rejects.toMatchObject({
        code: 'INSUFFICIENT_FUNDS',
        details: { required: '1000000000000' },
      });
      expect([calls(), await nonce(address, 'pending')]).toEqual([0, start]);
      // Every refusal released its nonce: the next transfer takes the same one, so no gap
      // holds it back.
      const next = await bc.transfer(
        { to, amount: 1n },
        { idempotencyKey: idempotencyKey('next') },
      );
      expect(BigInt((await transaction(next.attempt?.id as string))?.nonce ?? -1)).toBe(
        start,
      );
      await mineWhile(next.wait({ finality: 'final' }));
      expect(await balance(to)).toBe(1n);
    } finally {
      await aio.close();
    }
  });

  it('never reports a transfer final from a block a reorg dropped', async () => {
    const { aio, bc } = open();
    const reorgs: AioEvent<'tx.reorged'>[] = [];
    aio.on('tx.reorged', (event) => reorgs.push(event));
    try {
      const to = stranger();
      const amount = 31_337n;
      const sub = await bc.transfer(
        { to, amount },
        { idempotencyKey: idempotencyKey('reorg') },
      );
      const hash = sub.attempt?.id as string;
      await mine();
      const included = await bc.getTransactionStatus(sub.operationId);
      expect(included).toMatchObject({ state: 'included', confirmations: 1 });
      const orphan = included.blockHash as string;
      // The head block, ours, is replaced by an empty one. The transaction leaves the chain,
      // and anvil does not return it to the pool.
      await node('anvil_reorg', [1, []]);
      expect(await transaction(hash)).toBeNull();
      // Its old height now has the confirmations that would make it final.
      await mine(CONFIRMATIONS);
      const after = await bc.getTransactionStatus(sub.operationId);
      expect(after).toMatchObject({ confirmations: 0, finality: 'none' });
      expect(after.state).not.toBe('final');
      expect(after.blockHash).toBeUndefined();
      expect(reorgs).toEqual([
        expect.objectContaining({
          operationId: sub.operationId,
          previousBlockHash: orphan,
        }),
      ]);
      // The monitor resends the stored bytes once the node has lost them for the grace
      // period; they land in another block, once.
      const final = await mineWhile(sub.wait({ finality: 'final' }));
      expect(final.status).toMatchObject({ state: 'final', evidence: 'proven' });
      expect(final.status.blockHash).not.toBe(orphan);
      expect(final.status.blockHeight).toBeGreaterThan(included.blockHeight as bigint);
      expect(final.operation?.attempts).toHaveLength(1);
      expect(await balance(to)).toBe(amount);
    } finally {
      await aio.close();
    }
  });
});
