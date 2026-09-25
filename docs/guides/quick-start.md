---
summary: Install crypto-aio and run a first transfer on the fake chain in 5 minutes.
---

# Quick start

This page takes about 5 minutes. You install the package, run a transfer to proven finality
on the fake chain, and see how a real network will be configured.

## Install

crypto-aio needs Node.js 22 or later. The API in these guides is version 0.1, which is **not
on npm yet**. The 0.0.x releases on npm are an older, unrelated API. Until 0.1.0 is
published, build a package from the repository and install that:

```sh
git clone https://github.com/vhidvz/crypto-aio.git
cd crypto-aio && pnpm install && pnpm build && pnpm pack
# in your project:
npm install /path/to/crypto-aio/crypto-aio-0.1.0-dev.0.tgz
```

Once 0.1.0 is published, `npm install crypto-aio` (or `pnpm add crypto-aio`) is enough.

The package has three entry points:

```ts
import { Blockchain, CryptoAio, configure, secret } from 'crypto-aio'; // the library
import { createFakeEnv } from 'crypto-aio/testing'; // test kit and the fake chain
import { native } from 'crypto-aio/native'; // escape hatch to the SDK client
```

The package is built as CommonJS, so `const { CryptoAio } = require('crypto-aio')` works too.

## Your first program (runs today, on the fake chain)

`createFakeEnv()` builds everything you need in memory:

- a fake chain;
- a container (`CryptoAio`) with the fake plugin, memory stores and a local signer;
- a handle (`env.bc`) for the chain `fakechain`, with a wallet funded with 0.01 FAKE.

The fake chain runs on fake time. Time moves only when the kit advances its clock, and
`env.run(promise)` does that until the promise settles. Blocks appear only when you call
`env.chain.mine()`.

```ts
import { createFakeEnv, type FakeEnv } from 'crypto-aio/testing';

/** The fake chain moves only when you mine; this mines one block per second of fake time. */
async function mineWhile<T>(env: FakeEnv, promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let blocks = 0; blocks < 100 && !done; blocks++) {
    env.chain.mine();
    await env.clock.advance(1_000);
  }
  return tracked;
}

async function main(): Promise<void> {
  // 1. A fake chain, a container with one funded wallet, and a handle for 'fakechain'.
  const env = await createFakeEnv();
  const bc = env.bc;

  // 2. Address and balance.
  const me = await env.run(bc.walletAddress());
  const balance = await env.run(bc.getBalance(me.canonical));
  console.log(me.canonical, balance.amount.format()); // fk1… 0.01 FAKE

  // 3. Send. The idempotency key makes a retry safe.
  const sub = await env.run(
    bc.transfer({ to: env.stranger(), amount: '0.001' }, { idempotencyKey: 'order-42' }),
  );
  console.log(sub.state, sub.attempt?.id); // submitted <transaction hash>

  // 4. Wait for proven finality while the fake chain mines.
  const final = await mineWhile(env, sub.wait({ finality: 'final' }));
  console.log(final.status.state, final.status.evidence); // final proven

  // 5. Read the Operation back.
  const op = await env.run(bc.getOperation(sub.operationId));
  console.log(op?.state, op?.outcome, op?.attempts.length); // final executed 1
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
```

What happened:

- `amount: '0.001'` is a decimal string, so it means 0.001 FAKE. A `bigint` would mean base
  units. A JS `number` is rejected.
- `transfer` created an **Operation**, signed one **Attempt**, stored it, then broadcast it.
  Calling it again with the key `order-42` returns the same Operation. It never pays twice.
- `wait({ finality: 'final' })` resolved only on **proven** evidence. That means finalized
  chain data, read with a proof quorum: by default, two healthy endpoints must agree when two
  exist. The fake env has one endpoint.

## Configuring a real network (planned)

> **Shape of the API once the adapter ships (planned).** No real chain family ships today.
> The EVM family (ethers, web3) is planned for Plan 2. This code does not run yet.

In production, you configure the default container once at startup with `configure`, or
you create one `new CryptoAio({ namespace })` per tenant. API keys and private keys go in a
`Secret`, so they never appear in logs, errors or events.

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: {
    alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
  },
  signers: {
    'hot-1': localSigner({ id: 'hot-1', secp256k1: secret(process.env.HOT_KEY ?? '') }),
  },
  wallets: { 'wallet-main': { signer: 'hot-1', tier: 'hot' } },
  chains: {
    ethereum: { network: 'mainnet', library: 'ethers', provider: 'alchemy', wallet: 'wallet-main' },
  },
  lifecycle: { requireIdempotencyKey: true },
});

const eth = Blockchain.create({ chain: 'ethereum' });
await eth.ready(); // loads the adapter and checks the provider serves the right network
```

The names `ethereum`, `ethers` and `alchemy` come from the design spec. The EVM plan (Plan 2)
fixes the final chain ids, preset names and preset URLs.

The configuration shape itself works today. The fake chain takes the same `providers`,
`signers`, `wallets`, `chains` and `lifecycle` keys; step 10 of
[the tutorial](./tutorial.md#step-10-secrets-never-leak) sets `providers` and `chains` by hand.
What is missing is the `ethereum` chain, its driver and the `alchemy` preset.

## Next steps

- [Core concepts](./concepts.md): the vocabulary behind this example.
- [Tutorial](./tutorial.md): ten short, hands-on steps that cover every core concept.
- [Sending and receiving](./transactions.md): withdrawals, deposits, and error handling.
- [Keys, signers and secrets](./security.md): signers, policy hooks, and a production checklist.
- [Using any blockchain network](./networks.md): how networks are added, and what is planned.
