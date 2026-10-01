# Crypto-AIO

All-In-One Crypto-Currency

[![CI](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml/badge.svg)](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/crypto-aio)](https://www.npmjs.com/package/crypto-aio)
![npm](https://img.shields.io/npm/dm/crypto-aio)
[![License](https://img.shields.io/github/license/vhidvz/crypto-aio?style=flat)](LICENSE)
[![documentation](https://img.shields.io/badge/documentation-click_to_read-c27cf4)](docs/guides/index.md)

One TypeScript API for balances, transfers, confirmations and deposit scanning across EVM
chains, Bitcoin, Tron, Solana and TON, built for exchanges, wallets and payment systems.
Transfers are idempotent and crash-safe, and a signed transaction ends only on proof from
finalized chain data, never on one endpoint's word.

## Install

crypto-aio needs Node.js 22 or later (Solana: 22.12 or later). Install the package, and only
the SDK of each family you use:

```sh
npm install crypto-aio ethers           # EVM chains (or web3)
npm install crypto-aio bitcoinjs-lib    # Bitcoin
npm install crypto-aio tronweb          # Tron
npm install crypto-aio @solana/web3.js  # Solana
npm install crypto-aio @ton/ton @ton/core @ton/crypto  # TON
```

A handle whose SDK is missing fails with `DEPENDENCY_MISSING` and the install command.

## Quick start

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

No key at hand? The [quick start](docs/guides/quick-start.md) runs this on the in-memory
fake chain from `crypto-aio/testing`.

## Configuration: global, scoped and per handle

`configure()` sets up the default container behind `Blockchain.create()`; use one isolated
`new CryptoAio({ namespace })` per tenant. A scope inherits and overrides, and a handle is
immutable: `with()` returns a new one.

```ts
import { CryptoAio, secret } from 'crypto-aio';

const tenant = new CryptoAio({
  namespace: 'tenant-a', // prefixes every store key
  providers: { node: { endpoints: [{ name: 'main', url: secret(process.env.RPC_URL ?? '') }] } },
  chains: { bsc: { network: 'testnet', provider: 'node' } },
});
const eu = tenant.scope({ chains: { bsc: { maxLagBlocks: 20 } } }); // shares the pool and stores
const bsc = eu.blockchain({ chain: 'bsc' });
const viaWeb3 = bsc.with({ library: 'web3' }); // `bsc` is unchanged
```

The most specific value wins: call, handle, scope, container, environment
(`CRYPTO_AIO_<CHAIN>_{NETWORK|LIBRARY|PROVIDER|RPC_URL|INDEXER_URL}`, routing only, never
keys), then built-in defaults.

## Many chains, one shape

```ts
const aio = new CryptoAio({ chains: { ton: { provider: 'public', indexer: 'public' } } });
for (const bc of [
  aio.blockchain({ chain: 'bitcoin', network: 'testnet4', provider: 'public', indexer: 'public' }),
  aio.blockchain({ chain: 'tron', network: 'nile', provider: 'public' }),
  aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'public' }),
  aio.blockchain({ chain: 'ton', network: 'testnet' }),
]) {
  console.log(bc.chain, await bc.getBlockHeight(), bc.supports('replace-fee'));
}
```

Every family has the same handle (`getBalance`, `estimateFee`, `transfer`,
`waitForConfirmation`, `scanner`, `history`) plus a typed `bc.ext.<family>`; what each
network supports is in [Using any blockchain network](docs/guides/networks.md).

## Integration matrix

| Library                                           | Status                                          | Chains                                                                          |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `ethers` 6                                        | Supported, the EVM default                      | Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base |
| `web3` 4                                          | Supported (sunset upstream; prefer ethers)      | the same EVM chains                                                             |
| `bitcoinjs-lib` 7                                 | Supported, over an Esplora indexer              | Bitcoin mainnet, testnet, testnet4, signet, regtest                             |
| `tronweb` 6                                       | Supported                                       | Tron mainnet, Shasta, Nile                                                      |
| `@solana/web3.js` 1                               | Supported                                       | Solana mainnet, devnet, testnet                                                 |
| `@ton/ton` 16, with `@ton/core` and `@ton/crypto` | Supported, with toncenter API v3 as the indexer | TON mainnet and testnet; the coin is Gram (formerly Toncoin)                    |
| `@tonconnect/sdk`                                 | Replaced by `@ton/ton`                          | TonConnect links dApps to user wallets; it is not a node SDK                    |
| `@avalabs/avalanchejs`                            | Deferred                                        | Avalanche X and P chains (the C-Chain is supported as EVM)                      |
| `@bnb-chain/javascript-sdk`                       | Unsupported                                     | BNB Beacon Chain, sunset in 2024 (BNB Smart Chain is supported as EVM)          |

Only in-memory stores ship. Production needs durable stores of your own (Postgres, Redis,
…), proven with the contract suites in `crypto-aio/testing`.

## Extending

A chain of an existing family is data, served by the built-in driver:

```ts
import { CryptoAio } from 'crypto-aio';
import { evmChainPlugin } from 'crypto-aio/evm';

const aio = new CryptoAio({ plugins: [evmChainPlugin({ name: 'acme', chains: [acmeChain] })] });
```

A provider preset is a plugin too; a custody signer (HSM, KMS, MPC) is three callbacks:

```ts
import { callbackSigner, reveal, secret, type ProviderPreset } from 'crypto-aio';

const acmeCloud: ProviderPreset = {
  name: 'acmecloud',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (chain) => chain === 'acmechain',
  endpoints: ({ apiKey }) => [
    { name: 'main', url: secret(`https://rpc.acme.example/v1/${reveal(apiKey ?? '')}`) },
  ],
};
aio.use({ name: 'acme-presets', presets: [acmeCloud] });

const custody = callbackSigner({
  id: 'mpc-1',
  schemes: ['secp256k1-ecdsa'],
  getPublicKey: async (scheme, keyRef) => vault.publicKey(scheme, keyRef?.id),
  sign: async (requests, ctx) => ({
    status: 'pending', // or { status: 'signed', signatures }
    ticket: await vault.submit(requests, ctx.operationId),
  }),
});
```

A new chain family is a plugin with an adapter: see
[the plugin API](docs/guides/networks.md#3-a-new-family-the-plugin-api).

## Documentation

- [Guides](docs/guides/index.md): concepts, a quick start, a tutorial, sending and receiving,
  keys and secrets (with the [production checklist](docs/guides/security.md#production-checklist)),
  and every network.
- API reference: run `pnpm doc` in a clone, then open `docs/api/index.html`.
- [Changelog](CHANGELOG.md), with the 0.1.0 migration notes.

## License

[MIT](LICENSE)
