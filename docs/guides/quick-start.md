---
summary: Install crypto-aio, run a first transfer on the fake chain in 5 minutes, and configure a real EVM network.
---

# Quick start

This page takes about 5 minutes. You install the package, run a transfer to proven finality
on the fake chain, and configure a real EVM network.

## Install

crypto-aio needs Node.js 22 or later, and Solana needs Node.js 22.12 or later
([why](./networks.md#solana-networks)). The API in these guides is version 0.1, which is
**not on npm yet**. The 0.0.x releases on npm are an older, unrelated API. Until 0.1.0 is
published, you can build a package from source, but only once the 0.1 work is merged to the
repository's `main` branch:

```sh
git clone https://github.com/vhidvz/crypto-aio.git
cd crypto-aio && pnpm install && pnpm build && pnpm pack # writes crypto-aio-<version>.tgz
npm install /path/to/crypto-aio/crypto-aio-*.tgz # in your project
```

Once 0.1.0 is published, `npm install crypto-aio` is enough. The EVM, UTXO, Tron, Solana and
TON families are on `main` and in the next release. Install only the SDK you use next to the
package: for EVM chains `npm install ethers`, or `npm install web3` and `library: 'web3'` on
the handle, since ethers is the default; for Bitcoin `npm install bitcoinjs-lib`; for Tron
`npm install tronweb`; for Solana `npm install @solana/web3.js` (Node.js 22.12 or later); for
TON `npm install @ton/ton @ton/core @ton/crypto`. A missing SDK fails with
`DEPENDENCY_MISSING` and the exact install command. The package has eight entry points:

```ts
import { Blockchain, CryptoAio, configure, secret } from 'crypto-aio'; // the library
import { evmChainPlugin } from 'crypto-aio/evm'; // EVM extras and SDK client types
import 'crypto-aio/utxo'; // Bitcoin SDK client types (native(bc, 'bitcoinjs-lib'))
import { MAX_MEMO_BYTES } from 'crypto-aio/tron'; // Tron constants and the SDK client type
import { SOLANA_CAPABILITIES } from 'crypto-aio/solana'; // Solana extras and SDK client type
import 'crypto-aio/ton'; // TON constants and the SDK client type (native(bc, '@ton/ton'))
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

## Configuring a real network (Bitcoin)

Install the SDK with `npm install bitcoinjs-lib`. Bitcoin reads everything from Esplora
servers, named twice: as the `provider` (blocks, transactions, fee estimates, broadcasts and
proofs) and as the `indexer` (the wallet's unspent outputs, balances and history). The
`mempool` (mempool.space) and `blockstream` (blockstream.info) presets are free,
rate-limited public services, and `public` uses both. Run your own Esplora for production
and configure it as `{ endpoints: [{ url }] }`.

```ts
import { CryptoAio, localSigner, secret, type UtxoFeeOverride } from 'crypto-aio';

const aio = new CryptoAio({
  signers: { hot: localSigner({ secp256k1: secret(process.env.BTC_KEY ?? '') }) },
  wallets: { treasury: { signer: 'hot', utxo: { addressType: 'p2wpkh' } } },
  chains: {
    bitcoin: {
      network: 'mainnet', provider: ['mempool', 'blockstream'], indexer: 'mempool', wallet: 'treasury',
    },
  },
  lifecycle: { broadcastFanout: 2 }, // send each transaction to both providers
});
const btc = aio.blockchain({ chain: 'bitcoin' });
const fee: UtxoFeeOverride = { satPerVByte: '2.5' }; // or 'slow' | 'normal' | 'fast'
const sub = await btc.transfer(
  {
    outputs: [
      { to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: '0.001' },
      { to: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr', amount: 25_000n },
    ],
    fee,
  },
  { idempotencyKey: 'payout-42' },
);
await sub.wait({ finality: 'final' }); // 6 confirmations
```

Amounts are BTC as decimal strings or satoshis as `bigint`. Two independent providers let
proofs cross-check: with one Esplora endpoint, its operator alone decides finality. See
[Bitcoin networks](./networks.md#bitcoin-networks) for the address types, the fee options,
replace and cancel, and the limits, such as the public services' 500-output limit per
address.

## Configuring a real network (Solana)

Install the SDK next to the package, `npm install @solana/web3.js`, and run on Node.js 22.12
or later: on 22.0 to 22.11, loading the SDK fails with Node's `ERR_REQUIRE_ESM`. The
`alchemy`, `infura` and `ankr` presets serve mainnet and devnet with an `apiKey`. `public`,
the cluster's own endpoint, also serves testnet, but it is only for trying things out: its
rate limits let it prove that a transfer never landed only slowly, over many passes, so
such a transfer becomes `expired`, and can be rebuilt, minutes later than on a keyed
provider.

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: {
    alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
    ankr: { preset: 'ankr', apiKey: secret(process.env.ANKR_KEY ?? '') },
  },
  signers: {
    'sol-hot': localSigner({ id: 'sol-hot', ed25519: secret(process.env.SOL_SEED_HEX ?? '') }),
  },
  wallets: { payouts: { signer: 'sol-hot' } },
  chains: {
    solana: {
      network: 'devnet',
      provider: ['alchemy', 'ankr'],
      wallet: 'payouts',
      // The highest compute-unit price signed, in micro-lamports (default 10_000_000)
      options: { maxComputeUnitPrice: 2_000_000n },
    },
  },
  lifecycle: { requireIdempotencyKey: true },
});

const sol = Blockchain.create({ chain: 'solana' });
await sol.ready(); // loads @solana/web3.js; each endpoint must report devnet's genesis hash
const me = await sol.walletAddress(); // me.canonical is base58; fund it before sending
const sub = await sol.transfer(
  { asset: 'USDC', to: '<wallet address>', amount: '25', memo: 'invoice 42' },
  { idempotencyKey: 'payout-42' },
);
await sub.wait({ finality: 'final' }); // the finalized commitment
```

The key is the wallet's 32-byte ed25519 seed, as hex, not the 64-byte keypair of a Solana
CLI key file (its first 32 bytes are the seed). A decimal string is in the asset's units, so
`amount: '25'` is 25 USDC here, and a `bigint` is in base units (lamports for SOL). `to` is
the recipient's wallet, never its token account: the transfer pays into the wallet's
associated token account and creates it when it is missing, at the sender's cost (a `rent`
charge in the estimate). Solana has no replace or cancel: a transaction that never lands is
proven `expired` once its blockhash's window has passed, and `bc.rebuild(id)` then signs a
new transaction on a fresh blockhash. With one provider the proof quorum is 1, so in
production use two or three independent providers.
[Solana networks](./networks.md#solana-networks) covers the fees, the checks before signing,
expiry, refusals, scanning and history.

## Configuring a real network (TON)

Install the SDKs next to the package: `npm install @ton/ton @ton/core @ton/crypto`. TON reads
from two services, both named on the handle: the `provider` is toncenter's API v2 (account
state, fee emulation, sending) and the `indexer` is its API v3 (which transaction a message
became, message traces, history). The indexer is required. The `toncenter` preset serves
both with an API key; `public` is keyless, limited to one request per second across both
APIs, and only for trying things out.

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: { toncenter: { preset: 'toncenter', apiKey: secret(process.env.TONCENTER_KEY ?? '') } },
  signers: { 'ton-hot': localSigner({ id: 'ton-hot', ed25519: secret(process.env.TON_SEED_HEX ?? '') }) },
  wallets: { payouts: { signer: 'ton-hot', ton: { version: 'v5r1' } } },
  chains: { ton: { network: 'testnet', provider: 'toncenter', indexer: 'toncenter', wallet: 'payouts' } },
  lifecycle: { requireIdempotencyKey: true },
});

const ton = Blockchain.create({ chain: 'ton' });
const me = await ton.walletAddress(); // me.display: 0Q… on testnet; fund it before sending
const sub = await ton.transfer(
  { to: '0Q…', amount: '1.5', memo: 'invoice 42' }, // 1.5 GRAM, to a non-bounceable address
  { idempotencyKey: 'payout-42' },
);
await sub.wait({ finality: 'final' }); // masterchain inclusion and a completed message trace
```

The wallet's `ton` settings decide its address: `version` (`v4r2` or `v5r1`), and
optionally `workchain`, `subwalletId` (v4r2) or `subwalletNumber` (v5r1). A v5r1 wallet has
a different address on mainnet and testnet, and a wallet deploys itself with its first
transfer. The key is the wallet's 32-byte ed25519 seed, not its mnemonic
([Keys, signers and secrets](./security.md#local-signers)). The coin is Gram (ticker `GRAM`,
formerly Toncoin), and `TON` is an alias for it; `asset: 'USDT'` sends Tether's jetton on
mainnet. The address form decides bounce, a transfer has one output, and a wallet sends one
transfer at a time. With toncenter alone, the proof quorum is 1: in production, use two or
three independent providers. [TON networks](./networks.md#ton-networks) covers all of this.

## Next steps

- [Core concepts](./concepts.md): the vocabulary behind this example.
- [Tutorial](./tutorial.md): ten short, hands-on steps that exercise the main concepts.
- [Sending and receiving](./transactions.md): withdrawals, deposits, and error handling.
- [Keys, signers and secrets](./security.md): signers, policy hooks, and a production checklist.
- [Using any blockchain network](./networks.md): the EVM, Bitcoin, Tron, Solana and TON
  networks, and adding your own.
