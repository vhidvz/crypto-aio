---
title: Add networks to a family
description: Serve your own EVM chains with the built-in driver, and the registry rules that apply.
---

# Add networks to a family

A family driver is written once, and every chain and network it serves is data: a
`ChainInfo` with its `NetworkInfo` entries (identity, fee model, `FinalityPolicy`, default
confirmations, `reorgWindow`, replacement rules, explorer templates), plus provider presets
that map `(chain, network, apiKey)` to endpoints. So an EVM chain needs no new adapter.

`evmChainPlugin` from `crypto-aio/evm` serves your EVM chains with the built-in driver, with
ethers or the deprecated web3. It checks the data when called, or throws `CONFIG_INVALID`: family `evm`,
nonce ordering, the `secp256k1-ecdsa` scheme, and per network the decimal chain id as
`identity`, an `evm-1559` or `evm-legacy` fee model, and `finalized`-tag or confirmation
finality. A network removes the capabilities it lacks: `replace-fee` and `cancel` without a
mempool, `finality-tag` without the tag, and `fee-market-1559` on `evm-legacy`. The last two
are checked: `evmChainPlugin` refuses, with `CONFIG_INVALID`, a network that keeps
`finality-tag` without tag finality (or drops it with one), or `fee-market-1559` on any fee
model but `evm-1559` (or drops it on `evm-1559`).
Optional network `params` describe the chain further: `minPriorityFeePerGas` (a bigint tip
floor), `l1DataFee: 'op-stack'` (transactions also pay an OP Stack L1 data fee),
`systemLogs: 'bor'` (a bor client's system logs on every receipt, as on Polygon PoS, which
a plain transfer then ignores), and the network's own fee bounds, `maxFeePerGas` (wei per
gas) and `maxGasLimit` (gas), which apply unless a handle's or the chain's `options` set
them.

<!-- typecheck -->
```ts
import { CryptoAio, type ChainInfo } from 'crypto-aio';
import { evmChainPlugin } from 'crypto-aio/evm';

const acme: ChainInfo = {
  id: 'acmechain', family: 'evm', model: 'account', ordering: 'nonce', schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'ACME', decimals: 18 }, defaultNetwork: 'mainnet',
  networks: {
    mainnet: {
      id: 'mainnet', identity: '777', testnet: false, feeModel: 'evm-1559', // eth_chainId 777
      finality: { kind: 'confirmations', confirmations: 12 },
      capabilities: { remove: ['finality-tag'] }, // no `finalized` tag on this chain
      defaultConfirmations: 1, reorgWindow: 128, replacement: { minBumpPercent: 10 },
    },
  },
};
const aio = new CryptoAio({ plugins: [evmChainPlugin({ name: 'acme', chains: [acme] })] });
```

It registers as `evm:acme` and also takes `presets` and `assets`. An asset is an `erc20` ref,
registered under its EIP-55 checksummed contract whatever case it is given in, as the driver
names the token in its transfers and balances, so its alias and its transfers share one asset
id; a mixed-case contract with a wrong checksum is `CONFIG_INVALID`. Augment `ChainRegistry`
with `acmechain: { family: 'evm'; network: 'mainnet' }` to type the handle and `ext.evm`.

The registry rules that apply today already set the limits. A chain id registers once (a
second registration fails with `CONFIG_INVALID`, "already registered"), so nobody can add a
network to an existing chain id from outside. A plugin can add a new chain id, and it can add
presets, or adapters for another library, to chains that are already registered.

Only the EVM family has a helper like `evmChainPlugin`. The other families serve their
built-in networks, whose settings no plugin can change, since a chain id registers once.
