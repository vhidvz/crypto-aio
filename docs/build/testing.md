---
title: Test with the fake chain
parent: Build
nav_order: 10
description: "The testing kit: the fake chain, fake time, scripted nodes and crash injection."
---

# Test with the fake chain

`crypto-aio/testing` makes your tests deterministic and network-free: an in-memory chain, a
clock you control, scripted nodes, and stores that crash on demand. Use it to test your own
payment code, not only the library.

## Test your own code

`createFakeEnv()` returns a funded wallet on the fake chain, a container and a handle
(`env.bc`), so your code under test can take the handle it normally gets. `env.run(promise)`
drives the fake clock until the promise settles; `env.chain` lets you mine blocks, reorganize
the chain, and make an endpoint misbehave.

```ts
import { createFakeEnv } from 'crypto-aio/testing';
import { payOut } from '../src/payouts'; // your code: bc.transfer(…, { idempotencyKey: w.id })

it('pays a withdrawal once, even when the broadcast reply is lost', async () => {
  const env = await createFakeEnv({ transport: { maxAttempts: 1 } });
  // The node accepts the next broadcast, but its reply is lost (HTTP 504).
  env.chain.configureEndpoint('main', { acceptThenFail: true });
  const withdrawal = { id: 'w-1', to: env.stranger(), amount: '0.001' };

  await env.run(payOut(env.bc, withdrawal)).catch(() => undefined); // ambiguous
  await env.run(payOut(env.bc, withdrawal)); // your retry, with the same key
  env.chain.mine();
  expect(env.chain.balance(withdrawal.to)).toBe(100_000n); // 0.001 FAKE, paid once
});
```

| Tool | What it gives you |
| --- | --- |
| `createFakeEnv(options)` | A chain, a container and a funded handle. Options: `ordering` (`'nonce'`, `'expiry'` or `'seqno'`), `fund`, `endpoints`, `wallets`, `stores`, `transport`, `lifecycle`, `hooks` and extra container options under `aio` |
| `env.run(promise, stepMs?)` | Drives fake time until the promise settles |
| `env.stranger()` | A fresh address to pay |
| `env.restart({ killPrevious })` | A new process on the same stores and chain; with `killPrevious`, the old one can make no more progress |
| `env.chain.mine(n)`, `reorg(depth)` | Blocks appear only when you mine; a reorg replaces the newest blocks |
| `env.chain.configureEndpoint(name, patch)` | Make an endpoint lag, go down, lie about its identity, refuse a transaction, or accept one and lose the reply |
| `env.chain.balance(address)`, `nonce(address)`, `sendCount(id)` | Read the fake chain's truth directly |

The [Hands-on tutorial](../start/tutorial.md) uses each of these, step by step.

## Test an adapter or a store

The kit's lower-level parts test drivers and stores:

- `FakeFetch` scripts JSON-RPC and REST replies (`route`, `rpcResult`, `rpcError`, `hang`)
  and records calls. Pass `transport: { fetch: fake.fetch }` to a `CryptoAio`.
- `FakeClock` with `drive(clock, promise)` controls time: retries, timeouts and polling.
- `FaultyOperationStore` injects crashes at write boundaries, and `createFakeEnv().restart()`
  simulates a new process.

`createFakeEnv()` runs the fake family only. To test your own adapter, script its node with
`FakeFetch`, drive time with `FakeClock`, and register your plugin. The RPC method names
below are the acme driver's own:

```ts
import { CryptoAio } from 'crypto-aio';
import { FakeClock, FakeFetch, drive, rpcResult } from 'crypto-aio/testing';

it('reads a balance through the acme driver', async () => {
  const clock = new FakeClock();
  const node = new FakeFetch().route('https://acme.test', (request) => {
    const { method } = request.json<{ method: string }>();
    if (method === 'acme_chainId') return rpcResult(request, '0x2a'); // identity probe
    if (method === 'acme_blockNumber') return rpcResult(request, '0x10'); // height probe
    if (method === 'acme_getBalance') return rpcResult(request, '0x64');
    throw new Error(`unexpected ${method}`);
  });
  const aio = new CryptoAio({
    env: false,
    clock,
    plugins: [acmePlugin()],
    transport: { fetch: node.fetch },
    providers: { acme: { endpoints: [{ name: 'main', url: 'https://acme.test' }] } },
    chains: { acmechain: { provider: 'acme' } },
  });
  const bc = aio.blockchain({ chain: 'acmechain' });
  const balance = await drive(clock, bc.getBalance(someAcmeAddress));
  expect(balance.amount.base).toBe(100n);
  await aio.close();
});
```

To check a store of your own against the store contracts, see
[Write a durable store](../explore/stores.md).
