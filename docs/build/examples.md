---
title: Examples
parent: Build
nav_order: 1
description: Short, working recipes for common tasks, from reading a balance to scanning deposits, custody signing and a custom EVM chain.
---

# Examples

Short recipes for common tasks. Recipes marked **runs offline** use the in-memory fake chain
from `crypto-aio/testing`, and are executed on every change to the library
(`test/docs/runnable.test.ts`); paste them into a file and run them with `npx tsx`. The others
show real-network configuration: [Connect to a real network](./connect.md) explains each
family's setup.

| Recipe | |
| --- | --- |
| [Read a balance](#read-a-balance) | [Send a payment, exactly once](#send-a-payment-exactly-once) |
| [Send a token](#send-a-token) | [Pay many recipients at once](#pay-many-recipients-at-once) |
| [Attach a memo](#attach-a-memo) | [Check the fee before sending](#check-the-fee-before-sending) |
| [Wait for finality, with a deadline](#wait-for-finality-with-a-deadline) | [Retry safely after an error](#retry-safely-after-an-error) |
| [Bump the fee of a stuck payment](#bump-the-fee-of-a-stuck-payment) | [Give each customer a deposit address](#give-each-customer-a-deposit-address) |
| [Scan deposits and credit each once](#scan-deposits-and-credit-each-once) | [Confirm a deposit with a second provider](#confirm-a-deposit-with-a-second-provider) |
| [Read an address's history](#read-an-addresss-history) | [Sign on an offline device](#sign-on-an-offline-device) |
| [Sign through a custody service](#sign-through-a-custody-service) | [Enforce a spending limit](#enforce-a-spending-limit) |
| [One container per tenant](#one-container-per-tenant) | [Send events to your metrics](#send-events-to-your-metrics) |
| [Use the SDK directly](#use-the-sdk-directly) | [Add your own EVM chain](#add-your-own-evm-chain) |

## Read a balance

**Runs offline.** `getBalance` returns an exact `Amount`; pass an asset for a token balance.

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const me = await env.run(env.bc.walletAddress());
const balance = await env.run(env.bc.getBalance(me.canonical));
console.log(balance.amount.format(), balance.amount.base); // 0.01 FAKE 1000000n
```

On a real chain: `await eth.getBalance(address)` for ETH, `await eth.getBalance(address, 'USDC')`
for a token, and `await eth.getBalances(address, ['native', 'USDC', 'USDT'])` for several.

## Send a payment, exactly once

**Runs offline.** The idempotency key comes from your own record; asking twice returns the same
payment.

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const withdrawal = { id: 'wd_1042', to: env.stranger(), amount: '0.002' }; // your stored record

const first = await env.run(
  env.bc.transfer({ to: withdrawal.to, amount: withdrawal.amount }, { idempotencyKey: withdrawal.id }),
);
const again = await env.run(
  env.bc.transfer({ to: withdrawal.to, amount: withdrawal.amount }, { idempotencyKey: withdrawal.id }),
);
console.log(first.state, again.operationId === first.operationId); // submitted true
```

## Send a token

Tokens are named by alias on the handle's own chain and network, or by contract.

```ts
const sub = await eth.transfer(
  { asset: 'USDC', to: '0x…', amount: '25' }, // 25 USDC: the asset's own decimals
  { idempotencyKey: 'payout-7' },
);
// Any ERC-20 by contract, with its decimals read from the chain:
await eth.transfer(
  { asset: { standard: 'erc20', contract: '0x…' }, to: '0x…', amount: '10' },
  { idempotencyKey: 'payout-8' },
);
```

The chain needs the `tokens` capability; [Send a transfer](./send.md) lists each family's tokens.

## Pay many recipients at once

On chains with `batch-transfer` (Bitcoin, the Avalanche X-Chain and P-Chain), one transaction pays
several outputs:

```ts
const sub = await btc.transfer(
  {
    outputs: [
      { to: 'bc1q…', amount: '0.001' },
      { to: 'bc1p…', amount: 25_000n }, // satoshis
    ],
    fee: 'normal',
  },
  { idempotencyKey: 'payout-batch-12' },
);
```

## Attach a memo

On chains with `memo` (Tron, Solana, TON, the Avalanche X-Chain). A memo is public forever.

```ts
if (bc.supports('memo')) {
  await bc.transfer({ to, amount: '10', memo: 'invoice 381' }, { idempotencyKey: 'inv-381' });
}
```

## Check the fee before sending

**Runs offline.** `feeTotal` sums the charges of one asset; compare it with the balance.

<!-- runnable -->
```ts
import { feeTotal } from 'crypto-aio';
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const native = await env.run(env.bc.resolveAsset('native'));
const estimate = await env.run(env.bc.estimateFee({ to: env.stranger(), amount: '0.001', fee: 'fast' }));
const fee = feeTotal(estimate, native.id);
console.log(fee?.format(), estimate.bound); // 0.00000003 FAKE exact
```

`bound` says how far to trust it: `exact`, `expected` or `upper`. Every family also refuses, before
signing, any fee above its configured ceiling ([Configuration](../reference/configuration.md#family-options)).

## Wait for finality, with a deadline

**Runs offline.** A timed-out wait changes nothing: the payment continues, and you can wait again.

<!-- runnable -->
```ts
import { isCryptoAioError } from 'crypto-aio';
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 1n }));
const result = await env
  .run(env.bc.waitForConfirmation(sub.operationId, { finality: 'final', timeoutMs: 5_000 }), 500)
  .catch((error: unknown) => error);
if (isCryptoAioError(result)) console.log(result.code, result.retryable); // TIMEOUT true
```

## Retry safely after an error

The pattern for any payment call: decide from the error and the Operation's stored state, and
never retry a payment that might land with a new key.

```ts
import { isCryptoAioError } from 'crypto-aio';

async function pay(bc, withdrawal) {
  try {
    return await bc.transfer(
      { to: withdrawal.to, amount: withdrawal.amount },
      { idempotencyKey: withdrawal.id },
    );
  } catch (error) {
    if (!isCryptoAioError(error)) throw error;
    if (error.ambiguous) return scheduleRetry(withdrawal.id); // same key, later
    const id = error.context.operationId;
    const op = id ? await bc.getOperation(String(id)) : null;
    if (op?.state === 'stalled') return alertOperator(op); // rebroadcast, replace or cancel
    if (!op || op.state === 'failed') return markFailed(withdrawal, error.code); // nothing in flight
    throw error;
  }
}
```

[Errors](../reference/errors.md#what-to-do-about-each-error) gives the safe action for every code.

## Bump the fee of a stuck payment

On EVM chains a replacement reuses the nonce and must raise both prices by at least 10%:

```ts
const sub = await eth.replace(operationId, {
  fee: { maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n }, // wei per gas
});
// Or give up on it: a zero-value self-transfer in the same nonce, which wins only if it lands first.
await eth.cancel(operationId);
```

[Fix a stuck transfer](./stalled.md) covers every family's rules.

## Give each customer a deposit address

**Runs offline.** Addresses come from an `xpub`, so no private key is on the server.

<!-- runnable -->
```ts
import { HDKey } from '@scure/bip32'; // npm install @scure/bip32
import { createFakeEnv } from 'crypto-aio/testing';

// A toy seed for the example; a real xpub comes from your cold wallet or custody.
const xpub = HDKey.fromMasterSeed(new Uint8Array(32).fill(7)).publicExtendedKey;
const env = await createFakeEnv({ wallets: { deposits: { xpub } } });
const customerIndex = 41; // your customer's number
const address = await env.run(env.bc.deriveAddress('deposits', customerIndex));
console.log(address.canonical.startsWith('fk1')); // true
```

## Scan deposits and credit each once

**Runs offline.** Credit on transfer ids, so a redelivered block credits nothing twice.

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv();
const depositAddresses = new Set([env.stranger()]);
const [customer] = depositAddresses;
await env.run(env.bc.transfer({ to: customer ?? '', amount: 7n }));
env.chain.mine(5);

const credited = new Map<string, bigint>(); // your table, unique on transfer id
const scanner = env.bc.scanner({
  cursorKey: 'deposits',
  from: 1n,
  mode: 'final',
  filter: { addresses: [...depositAddresses] },
});
const events = scanner[Symbol.asyncIterator]();
const result = await env.run(events.next(), 500);
if (result.done) throw new Error('the scanner stopped');
const event = result.value;
if (event.type === 'block') {
  for (const tx of event.transactions)
    for (const transfer of tx.transfers) {
      if (!depositAddresses.has(transfer.to.canonical) || transfer.amount === undefined) continue;
      if (!credited.has(transfer.id)) credited.set(transfer.id, transfer.amount.base);
    }
}
await event.ack(); // commit the cursor only after crediting
console.log([...credited.values()]); // [ 7n ]
```

In production, run the loop as `for await (const event of scanner)`, and handle `rollback`
events ([Receive deposits](./receive.md)).

## Confirm a deposit with a second provider

Before an automatic credit, read the deposit again through an independent provider:

```ts
const second = bc.with({ provider: 'independent' }); // a provider run by someone else
const check = await second.getTransaction(tx.id);
const agrees =
  check?.status.finality === 'final' &&
  check.transfers.some(
    (t) => t.id === transfer.id && t.to.canonical === transfer.to.canonical &&
      t.asset?.id === transfer.asset?.id && t.amount?.base === transfer.amount?.base,
  );
if (agrees) await creditOnce(transfer.id, transfer.amount);
```

## Read an address's history

On chains with `address-history`, page through with the cursor:

```ts
let cursor: string | undefined;
do {
  const page = await btc.history(address, { cursor, limit: 50 });
  for (const tx of page.items) await process(tx); // dedupe on transfer ids
  cursor = page.next;
} while (cursor);
```

## Sign on an offline device

**Runs offline.** A watch-only wallet prepares; another device signs; you submit the signatures.
Here `@noble/curves` plays the offline device.

<!-- runnable -->
```ts
import { secp256k1 } from '@noble/curves/secp256k1'; // the "offline device"
import { bytesToHex } from '@noble/hashes/utils';
import { createFakeEnv } from 'crypto-aio/testing';

const deviceKey = secp256k1.utils.randomPrivateKey(); // never leaves the device
const publicKey = bytesToHex(secp256k1.getPublicKey(deviceKey, true));
const env = await createFakeEnv({ wallets: { cold: { publicKey } } }); // watch-only
const cold = env.aio.blockchain({ chain: 'fakechain', wallet: 'cold' });
env.chain.fund((await env.run(cold.walletAddress())).canonical, 1_000_000n);

const prepared = await env.run(
  cold.prepareTransfer({ to: env.stranger(), amount: 5_000n }, { idempotencyKey: 'cold-1' }),
);
console.log(prepared.operation.state); // prepared

// On the device: sign each request's payload.
const signatures = (prepared.unsigned?.signingRequests ?? []).map((request) => {
  const signature = secp256k1.sign(request.payload, deviceKey, { lowS: true });
  return { requestId: request.id, bytes: signature.toCompactRawBytes(), recovery: signature.recovery };
});
const sub = await env.run(cold.submitSignatures(prepared.operation.id, signatures));
console.log(sub.state); // submitted
```

On Bitcoin, the prepared payload is a PSBT, and `submitSignatures` also takes the signed PSBT
back ([Cold and asynchronous signing](./cold-signing.md)).

## Sign through a custody service

A custody service that approves later answers `pending`; you finish with `submitSignatures`:

```ts
import { callbackSigner } from 'crypto-aio';

const custody = callbackSigner({
  id: 'custody',
  schemes: ['secp256k1-ecdsa'],
  getPublicKey: (scheme, keyRef) => vault.publicKey(scheme, keyRef?.id),
  sign: async (requests, ctx) => ({ status: 'pending', ticket: await vault.submit(requests, ctx.operationId) }),
  cancelRequest: (ticket) => vault.cancel(ticket),
});

// Later, when the vault calls your webhook with the signatures:
await bc.submitSignatures(operationId, signatures); // or bc.abandon(operationId) if rejected
```

## Enforce a spending limit

**Runs offline.** The `beforeSign` hook sees every signing round, and a throw vetoes it.

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const LIMIT = 500_000n; // base units
const env = await createFakeEnv({
  hooks: {
    beforeSign: (ctx) => {
      const total = ctx.summary.outputs.reduce((sum, out) => sum + BigInt(out.amount), 0n);
      if (total > LIMIT) throw new Error('needs approval');
    },
  },
});
const refused = await env
  .run(env.bc.transfer({ to: env.stranger(), amount: 600_000n }))
  .catch((e: { code: string }) => e.code);
console.log(refused); // POLICY_REJECTED
```

## One container per tenant

Each tenant gets its own container and namespace; tenants may share one database.

```ts
const containers = new Map<string, CryptoAio>();
function tenant(id: string): CryptoAio {
  let aio = containers.get(id);
  if (!aio) {
    aio = new CryptoAio({ namespace: `tenant-${id}`, stores: sharedStores, ...configFor(id) });
    containers.set(id, aio);
  }
  return aio;
}
```

## Send events to your metrics

Events carry operational data only, so any metrics system may receive them:

```ts
aio.on('operation.state', (e) => metrics.increment('payments.state', { chain: e.chain, to: e.to }));
aio.on('rpc.response', (e) => metrics.histogram('rpc.latency_ms', e.latencyMs, { endpoint: e.endpointId }));
aio.on('operation.stalled', (e) => pager.alert(`payment ${e.operationId} stalled: ${e.code}`));
```

## Use the SDK directly

For anything outside the API, get the SDK's own client, wired to the handle's transport:

```ts
import { native } from 'crypto-aio/native';
import 'crypto-aio/evm'; // types native(bc, 'ethers')

const provider = await native(eth, 'ethers'); // an ethers JsonRpcApiProvider
console.log(await provider.getBlockNumber());
```

`native()` is outside semver ([Keys, signers and
secrets](./keys.md#the-native-escape-hatch-crypto-aionative)).

## Add your own EVM chain

Any EVM chain is data for the built-in driver:

```ts
import { CryptoAio, type ChainInfo } from 'crypto-aio';
import { evmChainPlugin } from 'crypto-aio/evm';

const acme: ChainInfo = {
  id: 'acmechain', family: 'evm', model: 'account', ordering: 'nonce', schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'ACME', decimals: 18 }, defaultNetwork: 'mainnet',
  networks: {
    mainnet: {
      id: 'mainnet', identity: '777', testnet: false, feeModel: 'evm-1559',
      finality: { kind: 'confirmations', confirmations: 12 },
      capabilities: { remove: ['finality-tag'] },
      defaultConfirmations: 1, reorgWindow: 128, replacement: { minBumpPercent: 10 },
    },
  },
};
const aio = new CryptoAio({ plugins: [evmChainPlugin({ name: 'acme', chains: [acme] })] });
```

[Add networks to a family](../explore/custom-networks.md) explains every field.
