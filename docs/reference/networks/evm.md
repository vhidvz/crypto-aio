---
title: EVM networks
description: "The EVM chains: networks, fees, tokens, presets and the fee ceiling."
---

# EVM networks

One EVM driver serves every chain below, with either library: `ethers` (v6, the default) or
`web3` (v4). ChainSafe sunset web3.js in 2025, and 4.16.0 is its last release, with no
further fixes. crypto-aio keeps it working and tested, but prefer `ethers` for new work.
The [Build guides](../../build/index.md) cover EVM [fees](../../build/send.md#fees),
[replacements](../../build/stalled.md), [token verdicts and proofs](../../build/confirmations.md) and
[scans](../../build/receive.md); [Keys, signers and secrets](../../build/keys.md) covers the
ethers and web3 clients.

| Chain | Networks (chain id) | Fees | Finality | Replace / cancel |
| --- | --- | --- | --- | --- |
| `ethereum` | `mainnet` (1), `sepolia` (11155111), `hoodi` (560048) | `evm-1559` | `finalized` tag | yes |
| `bsc` | `mainnet` (56), `testnet` (97) | `evm-legacy` (the base fee is always 0) | `finalized` tag | yes |
| `polygon` | `mainnet` (137), `amoy` (80002) | `evm-1559`; mainnet tips at least 25 gwei | `finalized` tag | yes |
| `avalanche` | `mainnet` (43114), `fuji` (43113) | `evm-1559` | the `latest` block is final | yes |
| `arbitrum` | `mainnet` (42161), `sepolia` (421614) | `evm-1559` | `finalized` tag | no: there is no mempool |
| `optimism`, `base` | `mainnet` (10, 8453), `sepolia` (11155420, 84532) | `evm-1559` plus an `l1-data` charge | `finalized` tag | yes |

- **Tokens.** ERC-20 only. USDT (Ethereum, Avalanche) and USDC (every built-in mainnet but
  BNB Smart Chain) resolve by alias on mainnet, where their issuers deploy them natively. Any
  other token resolves by contract, with its symbol and decimals read from the chain under
  the proof quorum, so one endpoint cannot mis-scale amounts. A contract whose
  `decimals()` or `symbol()` reverts or answers nothing usable, or an address with no
  contract yet, stays unresolvable (`ASSET_RESOLUTION`) until the container restarts; any
  other node error stays retryable.
- **Presets.** `alchemy` and `infura` serve every network above; `ankr` the Ethereum, BNB
  Smart Chain, Avalanche, Arbitrum and Base mainnets; `public` the networks whose chain
  documents a public endpoint (not Ethereum). The public Base, Arbitrum and OP Sepolia
  endpoints may refuse Node's `fetch` (a Cloudflare 403, seen as `PROVIDER_UNAVAILABLE`).
- **Fee ceiling.** No transfer, replacement or cancel signs a price per gas above the
  `maxFeePerGas` option, in wei as a bigint (`chains.<id>.options` or a handle's `options`;
  1,000 gwei by default, `DEFAULT_MAX_FEE_PER_GAS` from `crypto-aio/evm`; a custom network
  may set `params.maxFeePerGas`). A node's suggestion is clamped to it, and an explicit fee
  or a cancel's least bump above it fails with `INVALID_INTENT` before signing
  (`details.required`, `details.maxFeePerGas`). If the base fee rises above the ceiling,
  transfers stall as `FEE_TOO_LOW` until it falls or you raise the option. Any other key in
  the EVM options fails with `CONFIG_INVALID`.
- **Not in this release:** address history (it needs an indexer; `history()` throws
  `UNSUPPORTED_CAPABILITY`), contract calls other than ERC-20 `transfer`, and `ext.evm`
  beyond `getNonce`.
