---
title: EVM networks
description: "The EVM chains: networks, fees, tokens, presets and the fee ceiling."
---

# EVM networks

One EVM driver serves every chain below, with either library: `ethers` (v6, the default) or
`web3` (v4). ChainSafe sunset web3.js in 2025, and 4.16.0 is its last release, with no
further fixes, so `library: 'web3'` is **deprecated**: crypto-aio keeps it working and
tested through 1.x (unless a security issue in web3 forces its removal sooner, as a safety
fix the changelog announces), warns once per process (a `DeprecationWarning`, code
`CRYPTO_AIO_WEB3`), and removes it in 2.0. Use `ethers`.
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
| `optimism`, `base` | `mainnet` (10, 8453), `sepolia` (11155420, 84532) | `evm-1559` plus `l1-data` and `operator` charges | `finalized` tag | yes |

- **Tokens.** ERC-20 only. USDT (Ethereum, Avalanche) and USDC (every built-in mainnet but
  BNB Smart Chain) resolve by alias on mainnet, where their issuers deploy them natively. Any
  other token resolves by contract, with its symbol and decimals read from the chain under
  the proof quorum, so one endpoint cannot mis-scale amounts. A contract whose
  `decimals()` or `symbol()` reverts or answers nothing usable, or an address with no
  contract yet, stays unresolvable (`ASSET_RESOLUTION`) until the container restarts; any
  other node error stays retryable.
- **Deprecated tokens.** Tether's USDT contract on Ethereum (`TetherToken`) can deprecate
  itself in favour of an upgraded contract (its `upgradedAddress()`). A transfer then still
  moves the money through the new contract, which emits the `Transfer` event, but the token
  verdict reads the event of the contract you sent to. So every token estimate first reads
  the contract's `deprecated()` (one `eth_call` from one endpoint), and a token that answers
  `true` is refused before signing with `ASSET_RESOLUTION`, whose message names no address.
  Send to the upgraded contract by contract, or register it as an asset. The `USDT` alias
  keeps naming the contract it names now through 1.x: the intent hash behind an idempotency
  key covers the resolved asset, so moving an alias would change it, and an alias moves only
  in a major release. A contract without the method (a revert, an empty answer, or anything
  but an ABI `bool`) is not deprecated, and a failed read stays retryable.
- **OP Stack fees.** On OP Mainnet, Base, their testnets and a custom network with
  `params.l1DataFee: 'op-stack'`, every estimate, replacement and cancel also reads the
  `GasPriceOracle` predeploy, two calls side by side. `l1-data` is its `getL1Fee` for the
  unsigned bytes (`details.l1Fee`). `operator`, since the Isthmus upgrade, is its
  `getOperatorFee` for the whole gas limit (`details.operatorFee`): an upper bound, since
  the fee grows with the gas used, by the formula of the chain's fork (Jovian changed it).
  Both count in `details.expected` and the funds check, and the bound is `expected`: the L1
  fee moves with L1 prices, the operator fee with the chain's operator settings. A chain
  before Isthmus (the call reverts or answers nothing) or a zero operator fee adds no
  `operator` charge; a failed or malformed answer stays retryable. A confirmed
  transaction's reported fee includes its receipt's L1 fee, not the operator fee.
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
  transfers stall as `FEE_TOO_LOW` until it falls or you raise the option. Any key in the
  EVM options but `maxFeePerGas` and `maxGasLimit` fails with `CONFIG_INVALID`.
- **Gas-limit bound.** No transfer, replacement or cancel signs a gas limit above the
  `maxGasLimit` option, in gas as a bigint from 21,000 to 2^64 − 1 (set like
  `maxFeePerGas`; a custom network may set `params.maxGasLimit`). The default is 16,777,216
  (2^24, `DEFAULT_MAX_GAS_LIMIT`), the per-transaction cap Ethereum enforces since Fusaka
  (EIP-7825): far above what a transfer needs, it stops an absurd estimate or override, not
  an expensive one, so set your own (with the fee ceiling it bounds the `network` charge at
  `maxGasLimit × maxFeePerGas`). The gas limit a transfer would sign, the node's
  `eth_estimateGas` plus its 20% headroom, an override's `gasLimit`, or the original's gas
  limit that a replacement keeps, fails above it with `INVALID_INTENT` before signing
  (`details.required`, `details.maxGasLimit`); it is never cut down, since a call given
  less gas than it needs runs out and still pays. An explicit `gasLimit` above it is
  refused before any request. Arbitrum's estimates count the L1 data fee in L2 gas, so
  they grow with L1 prices: leave that bound generous.
- **Addresses.** EIP-55 checksummed. `bc.deriveAddress(wallet, index)` derives addresses
  from a wallet's `xpub` (`xpubPath`, default `0/{index}`) on every network.
- **Types.** The declarations of `crypto-aio/evm` name both ethers' and web3's types, so with
  only one of them installed keep `skipLibCheck: true` (the `tsc --init` default), or install
  the other too.
- **Not supported:** address history (it needs an indexer; `history()` throws
  `UNSUPPORTED_CAPABILITY`), contract calls other than ERC-20 `transfer`, and `ext.evm`
  beyond `getNonce`.

## Fee overrides, fee details and `ext.evm`

These shapes, exported as types from `crypto-aio/evm`, are what semver covers for the EVM
family ([Versioning and stability](../stability.md)). The core types they fill
(`TransferIntent.fee`, `FeeEstimate.details`) stay plain records.

- **`EvmFeeOverride`**, an explicit `fee` for a transfer, `replace` or `cancel`, in wei and
  gas as `bigint`s: `{ maxFeePerGas, maxPriorityFeePerGas, gasLimit? }` on an `evm-1559`
  chain, `{ gasPrice, gasLimit? }` on an `evm-legacy` one; any other key, a non-`bigint`, a
  tip above the fee cap, or a `gasLimit` below 21,000 fails with `INVALID_INTENT`. An
  override is signed as given within `maxFeePerGas` and `maxGasLimit`: the chain's own tip
  floor (Polygon's 25 gwei) applies to estimates, not to overrides, so an override below it
  is signed and then stalls.
- **`EvmFeeDetails`**, the `details` of an EVM `FeeEstimate`: `gasLimit`, `expected` (what
  the transaction is expected to pay, in wei), `maxFeePerGas` and `maxPriorityFeePerGas`
  (`evm-1559`) or `gasPrice` (`evm-legacy`), `baseFeePerGas` (`evm-1559`: the base fee the
  estimate expects for the next block), and on OP Stack chains `l1Fee` and `operatorFee`.
  The `network` charge is the upper bound of `expected`.
- **`ext.evm.getNonce(address, block?)`** returns the address's transaction count as a
  `bigint`, at `'latest'` (the default) or `'pending'`, from one endpoint.
