---
summary: Install crypto-aio, run a first transfer on the fake chain in 5 minutes, and configure a real EVM network.
---

# Quick start

This page takes about 5 minutes. You install the package, run a transfer to proven finality
on the fake chain, and configure a real EVM network.

## Install

crypto-aio needs Node.js 22 or later. The API in these guides is version 0.1, which is **not
on npm yet**. The 0.0.x releases on npm are an older, unrelated API. Until 0.1.0 is
published, you can build a package from source, but only once the 0.1 work is merged to the
repository's `main` branch:

```sh
git clone https://github.com/vhidvz/crypto-aio.git
cd crypto-aio && pnpm install && pnpm build && pnpm pack # writes crypto-aio-<version>.tgz
npm install /path/to/crypto-aio/crypto-aio-*.tgz # in your project
```

Once 0.1.0 is published, `npm install crypto-aio` is enough. The EVM and Tron families are on
`main` and in the next release. Install only the SDK you use next to the package: for EVM
chains `npm install ethers`, or `npm install web3` and `library: 'web3'` on the handle, since
ethers is the default; for Tron `npm install tronweb`. A missing SDK fails with
`DEPENDENCY_MISSING` and the exact install command. The package has five entry points:

```ts
import { Blockchain, CryptoAio, configure, secret } from 'crypto-aio'; // the library
import { evmChainPlugin } from 'crypto-aio/evm'; // EVM extras and SDK client types
import { MAX_MEMO_BYTES } from 'crypto-aio/tron'; // Tron constants and the SDK client type
import { createFakeEnv } from 'crypto-aio/testing'; // test kit and the fake chain
import { native } from 'crypto-aio/native'; // escape hatch to the SDK client
```

It is built as CommonJS, so `const { CryptoAio } = require('crypto-aio')` works too.

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
  Calling it again with the key `order-42` and the same intent returns the same Operation,
  so it never pays twice. The same key with another intent, such as a new `env.stranger()`
  address, throws `IDEMPOTENCY_CONFLICT`.
- `wait({ finality: 'final' })` resolved only on **proven** evidence. That means finalized
  chain data, read with a proof quorum: by default, two healthy endpoints must agree when two
  exist. The fake env has one endpoint.

## Configuring a real network (EVM)

The EVM family ships with ethers (the default library) and web3. In production, you
configure the default container once at startup with `configure`, or you create one
`new CryptoAio({ namespace })` per tenant. API keys and private keys go in a `Secret`, so
they never appear in logs, errors or events. Only in-memory stores ship, so production also
needs your own durable `OperationStore`, `LockManager`, `SequenceStore` and `CursorStore`,
passed as `stores` and validated with the contract suites in `crypto-aio/testing`
([how](./networks.md#testing-an-adapter-or-a-store)).

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: {
    alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
    infura: { preset: 'infura', apiKey: secret(process.env.INFURA_KEY ?? '') },
  },
  signers: {
    'hot-1': localSigner({ id: 'hot-1', secp256k1: secret(process.env.HOT_KEY ?? '') }),
  },
  wallets: { 'wallet-main': { signer: 'hot-1', tier: 'hot' } },
  chains: {
    ethereum: {
      network: 'mainnet', library: 'ethers', provider: ['alchemy', 'infura'], wallet: 'wallet-main',
    },
  },
  lifecycle: { requireIdempotencyKey: true },
});

const eth = Blockchain.create({ chain: 'ethereum' });
await eth.ready(); // loads the adapter and checks the provider serves the right network
```

Two providers let proofs cross-check: by default, two healthy endpoints must agree before
the library proves finality or a failure. With one endpoint, the proof quorum is 1.

The chains are `ethereum` (`mainnet`, `sepolia`, `hoodi`), `bsc` (`mainnet`, `testnet`),
`polygon` (`mainnet`, `amoy`), `avalanche` (`mainnet`, `fuji`), `arbitrum`, `optimism` and
`base` (`mainnet`, `sepolia`). The presets are `alchemy`, `infura` and `ankr` (with an
`apiKey`), and `public` for the free public endpoints some chains' documentation lists. It
is not for production; a handle with no provider configured falls back to it where it serves
the network, with a logged warning.
[Using any blockchain network](./networks.md#evm-networks) lists what each network supports.

A first read needs no key and no signer:

```ts
const fuji = Blockchain.create({ chain: 'avalanche', network: 'fuji', provider: 'public' });
await fuji.getBlockHeight();
```

From there, `transfer`, `waitForConfirmation` and `scanner` work as on the fake chain.
`amount: '0.01'` means 0.01 ETH on `ethereum`, and `asset: 'USDC'` sends USDC on mainnet.

Tron works the same way with `npm install tronweb` and `chain: 'tron'`.
[Tron networks](./networks.md#tron-networks) shows a configuration and what differs: TronGrid
keys, fees and fee limits, expiry instead of replacement, and why mainnet needs a key.

## Next steps

- [Core concepts](./concepts.md): the vocabulary behind this example.
- [Tutorial](./tutorial.md): ten short, hands-on steps that exercise the main concepts.
- [Sending and receiving](./transactions.md): withdrawals, deposits, and error handling.
- [Keys, signers and secrets](./security.md): signers, policy hooks, and a production checklist.
- [Using any blockchain network](./networks.md): the EVM and Tron networks, adding your own,
  and what is planned.
