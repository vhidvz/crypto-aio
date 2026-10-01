# crypto-aio

[![npm](https://img.shields.io/npm/v/crypto-aio)](https://www.npmjs.com/package/crypto-aio)
[![CI](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml/badge.svg)](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml)
![npm](https://img.shields.io/npm/dm/crypto-aio)
[![Coverage](https://raw.githubusercontent.com/vhidvz/crypto-aio/main/coverage-badge.svg)](https://htmlpreview.github.io/?https://github.com/vhidvz/crypto-aio/blob/main/coverage/lcov-report/index.html)
[![License](https://img.shields.io/github/license/vhidvz/crypto-aio?style=flat)](LICENSE)
[![documentation](https://img.shields.io/badge/documentation-read_the_docs-c27cf4)](https://vhidvz.github.io/crypto-aio/)

**One TypeScript API for moving money on blockchains.** Balances, transfers, confirmations
and deposit scanning across EVM chains, Bitcoin, Tron, Solana, TON and the Avalanche X-Chain and
P-Chain, built for exchanges, wallets and payment systems.

[Documentation](https://vhidvz.github.io/crypto-aio/) ·
[Quick start](https://vhidvz.github.io/crypto-aio/start/quick-start.html) ·
[Learn from zero](https://vhidvz.github.io/crypto-aio/learn/) ·
[Examples](https://vhidvz.github.io/crypto-aio/build/examples.html) ·
[API](https://vhidvz.github.io/crypto-aio/reference/api.html)

## Why crypto-aio

Every chain has an SDK that can build, sign and send a transaction. None of them is a payment
system. The hard part of moving money is everything around the transaction: a reply that never
arrives, a process that dies between signing and sending, two servers sending from one wallet, a
node that says "final" about a block that is later replaced. crypto-aio is the layer that handles
those cases, written once, with the same API on every chain:

- **Pay exactly once.** Every transfer carries your own idempotency key. Repeat the call after a
  timeout, a crash or a lost reply, and you get the same payment back, never a second one.
- **Crash-safe.** A signed transaction is stored before it is sent. After a restart, the library
  sends those exact bytes again; recovery never signs.
- **Final means proven.** A transfer is final only on finalized chain data that a quorum of
  independent endpoints agree on, never on one node's word.
- **Deposits that survive reorgs.** Durable scanners deliver every block at least once, and roll
  back when the chain reorganizes.
- **Keys stay with signers.** In memory, or behind your HSM, KMS or MPC custody, with a policy
  hook before every signature. Logs, errors and events never carry a secret.
- **One shape, explicit differences.** What a chain cannot do is a named capability, not a silent
  difference.

**Who it is for:** backend developers building exchanges, custodial wallets, payment processors
and treasury systems on Node.js. New to crypto? The documentation teaches everything from first
principles, starting with [what a ledger is](https://vhidvz.github.io/crypto-aio/learn/foundations/ledgers.html).

## Supported networks

| Family | Chains | Through |
| --- | --- | --- |
| EVM | Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base, and any EVM chain you add | `ethers` 6 (default) or `web3` 4 |
| Bitcoin | mainnet, testnet, testnet4, signet, regtest | `bitcoinjs-lib` 7 and an Esplora indexer |
| Tron | mainnet, Shasta, Nile | `tronweb` 6 |
| Solana | mainnet, devnet, testnet | `@solana/web3.js` 1 |
| TON | mainnet, testnet | `@ton/ton` 16 and toncenter |
| Avalanche X-Chain and P-Chain | mainnet, Fuji | `@avalabs/avalanchejs` 5 and the Avalanche Data API |

What each network supports, family by family, is in
[Networks](https://vhidvz.github.io/crypto-aio/reference/networks/).

## Install

crypto-aio needs Node.js 22 or later (Solana: 22.12 or later). Install the package, and only the
SDK of each family you use:

```sh
npm install crypto-aio ethers           # EVM chains (or web3)
npm install crypto-aio bitcoinjs-lib    # Bitcoin
npm install crypto-aio tronweb          # Tron
npm install crypto-aio @solana/web3.js  # Solana
npm install crypto-aio @ton/ton @ton/core @ton/crypto  # TON
npm install crypto-aio @avalabs/avalanchejs  # Avalanche X-Chain and P-Chain
```

A handle whose SDK is missing fails with `DEPENDENCY_MISSING` and names the install command.

## Your first transfer, with no network and no keys

`crypto-aio/testing` ships an in-memory chain, so you can see the whole flow before you configure
anything:

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv(); // an in-memory chain, a funded wallet, and a handle
const sub = await env.run(
  env.bc.transfer({ to: env.stranger(), amount: '0.001' }, { idempotencyKey: 'order-42' }),
);
env.chain.mine(4); // the fake chain makes blocks when you ask
const { status } = await env.run(sub.wait({ finality: 'final' }));
console.log(status.state, status.evidence); // final proven
```

The [Quick start](https://vhidvz.github.io/crypto-aio/start/quick-start.html) explains each line.

## On a real network

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: {
    alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
    infura: { preset: 'infura', apiKey: secret(process.env.INFURA_KEY ?? '') },
  },
  signers: { hot: localSigner({ id: 'hot', secp256k1: secret(process.env.HOT_KEY ?? '') }) },
  wallets: { treasury: { signer: 'hot' } },
  chains: { ethereum: { network: 'sepolia', provider: ['alchemy', 'infura'], wallet: 'treasury' } },
  lifecycle: { requireIdempotencyKey: true },
});

const eth = Blockchain.create({ chain: 'ethereum' });
const me = await eth.walletAddress();
console.log((await eth.getBalance(me.canonical)).amount.format()); // e.g. '0.5 ETH'

const sub = await eth.transfer(
  { to: '0x3535353535353535353535353535353535353535', amount: '0.01' },
  { idempotencyKey: 'withdrawal-42' }, // your own id: repeating the call never pays twice
);
const { status } = await sub.wait({ finality: 'final' });
console.log(status.state, status.evidence); // 'final' 'proven'
```

The same calls work on every chain above. [Connect to a real
network](https://vhidvz.github.io/crypto-aio/build/connect.html) has the configuration for each
family.

## Where to go next

| If you… | Start here |
| --- | --- |
| Are new to cryptocurrency or blockchains | The [learning path](https://vhidvz.github.io/crypto-aio/learn/): money, keys, transactions and finality, then the engineering of safe payments, then a tour of crypto-aio |
| Know blockchains and want the model fast | [crypto-aio in 10 minutes](https://vhidvz.github.io/crypto-aio/start/mental-model.html), then the [hands-on tutorial](https://vhidvz.github.io/crypto-aio/start/tutorial.html) |
| Want to build now | [Examples](https://vhidvz.github.io/crypto-aio/build/examples.html) and the [Build guides](https://vhidvz.github.io/crypto-aio/build/) |
| Need an exact answer | [API](https://vhidvz.github.io/crypto-aio/reference/api.html), [Configuration](https://vhidvz.github.io/crypto-aio/reference/configuration.html), [Errors](https://vhidvz.github.io/crypto-aio/reference/errors.html) |
| Are going to production | [Production architecture](https://vhidvz.github.io/crypto-aio/tour/production.html) and the [checklist](https://vhidvz.github.io/crypto-aio/build/production.html) |
| Want to add a chain or a store | [Explore](https://vhidvz.github.io/crypto-aio/explore/): plugins, stores and the source map |

## Status

crypto-aio is at **0.1.0**, the first release of this API; the 0.0.x releases on npm are an older,
unrelated API. Before 1.0, some extension interfaces may still change
([what is stable](https://vhidvz.github.io/crypto-aio/reference/stability.html)). Only in-memory
stores ship: production needs durable stores of your own, proven with the contract suites in
`crypto-aio/testing`. Release notes are in the [changelog](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. `pnpm install` and `pnpm check` (lint, typecheck and tests)
are all a change needs locally; the [source map](https://vhidvz.github.io/crypto-aio/explore/source-map.html)
explains the repository, and [docs/README.md](docs/README.md) how the documentation is built and
tested.

## License

[MIT](LICENSE)
