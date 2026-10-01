---
summary: How chain families and networks are supported, how to write a family plugin and driver, how to test it, and what is stable before 1.0.
---

# Using any blockchain network

crypto-aio reaches a network through a **chain family plugin**. The plugin contributes data:
chains, networks, native assets, tokens and provider presets. It also contributes one
**adapter manifest** per SDK, whose `load()` pulls in the **driver**. The core holds no chain
data and imports no SDK. There are three ways a network becomes available.

## 1. Built-in families

| Family | Chains (networks) | Ordering | Status |
| --- | --- | --- | --- |
| fake | `fakechain`, `fakeexpiry`, `fakeseqno` (`local`) | nonce, expiry, seqno | **Works today**, from `crypto-aio/testing` (register `fakePlugin()`) |
| EVM (ethers, web3) | Ethereum, BSC, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base | nonce | **Works today**, built in ([details](#evm-networks)) |
| UTXO (bitcoinjs-lib + Esplora) | Bitcoin mainnet, testnet, testnet4, signet, regtest | inputs | **Works today**, built in ([details](#bitcoin-networks)) |
| Tron (tronweb) | mainnet, shasta, nile | expiry | **Works today**, built in ([details](#tron-networks)) |
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | **Works today**, built in ([details](#solana-networks)) |
| TON (@ton/ton) | mainnet, testnet | seqno + expiry | **Works today**, built in; needs an indexer ([details](#ton-networks)) |

Built-in families, today the EVM, UTXO, Tron, Solana and TON families, register in the
package's composition root. Install only the SDK you use (`npm install crypto-aio ethers`,
or `bitcoinjs-lib` for Bitcoin, `tronweb` for Tron, `@solana/web3.js` for Solana, or
`@ton/ton @ton/core @ton/crypto` for TON); a missing one fails with `DEPENDENCY_MISSING`.

### EVM networks

One EVM driver serves every chain below, with either library: `ethers` (v6, the default) or
`web3` (v4). ChainSafe sunset web3.js in 2025, and 4.16.0 is its last release, with no
further fixes. crypto-aio keeps it working and tested, but prefer `ethers` for new work.
[Sending and receiving](./transactions.md) covers EVM [fees](./transactions.md#fees),
replacements, [token verdicts and proofs](./transactions.md#waiting-and-watching) and
[scans](./transactions.md#receiving); [Keys, signers and secrets](./security.md) covers the
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
  other token resolves by contract, with its symbol and decimals read from the chain.
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

### Bitcoin networks

The UTXO driver serves `bitcoin` with bitcoinjs-lib 7 (ECC over `@noble/curves`, no WASM). It
reads everything from Esplora servers: the `provider` serves blocks, transactions, fee
estimates, broadcasts and proofs, and the `indexer`, which is required, serves the wallet's
unspent outputs, balances and history. A handle without a `provider` or an `indexer` falls
back to the `public` preset for it, with a logged warning.

| Network | Presets | Explorer |
| --- | --- | --- |
| `mainnet` | `mempool`, `blockstream`, `public` | blockstream.info |
| `testnet` (v3) | `mempool`, `blockstream`, `public` | blockstream.info/testnet |
| `testnet4` | `mempool`, `public` (mempool.space only) | none |
| `signet` | `mempool`, `blockstream`, `public` | blockstream.info/signet |
| `regtest` | none: configure your own Esplora | none |

The driver's options go in `chains.bitcoin.options`, and an unknown one fails with
`CONFIG_INVALID`. Fee rates are `bigint` sat/kvB (1,000 sat/kvB is 1 sat/vB):

| Option | Default | What it does |
| --- | --- | --- |
| `maxFeeRate` | `1_000_000n` (1,000 sat/vB) | The highest fee rate a transaction may pay |
| `maxFee` | `10_000_000n` sat (0.1 BTC) | The highest fee a transaction may pay |
| `maxEstimatedFeeRate` | `200_000n` (200 sat/vB) | The highest rate a fee estimate may set |
| `nonWitnessUtxo` | `true` | Each segwit v0 input carries its previous transaction in the PSBT |
| `minInputConfirmations` | `1` | The confirmations an output needs before it is spent (`0`: also unconfirmed outputs of your own sent transactions) |
| `coinSelection` | `'accumulative'` | `'accumulative'` or `'all'` |
| `rbf` | `true` | Every input signals BIP125 replaceability |

- **Endpoints.** Each endpoint must answer the network's genesis hash at `/block-height/0`,
  or it is disabled. A custom signet shares the default signet's genesis block, so it passes
  this check: point a `signet` handle only at the signet you mean. mempool.space and
  blockstream.info publish no rate limit, so the presets set none; a 429 is retried with
  backoff (`RATE_LIMITED`). Both refuse to list more than 500 unspent outputs of one
  address: `/address/:address/utxo` answers HTTP 400, a non-retryable `RPC_ERROR`, so a
  wallet with more cannot estimate or send through them. For production, and for any large
  wallet, run your own Esplora (electrs) and configure it as `{ endpoints: [{ url }] }`, as
  both the `provider` and the `indexer`; give an endpoint a `rateLimit` (`{ rps, burst? }`)
  when its operator sets one.
- **Wallets.** `wallet.utxo.addressType` is `p2wpkh` (the default), `p2sh-p2wpkh`, `p2pkh` or
  `p2tr` (key path only, BIP86). Change goes to the sending address, or to
  `wallet.utxo.changeAddress`, which must be an address the wallet derives: one of the four
  types of the wallet's key or, with an `xpub`, one of the first 20 addresses of the wallet's
  type on its `xpubPath` (default `0/{index}`) or on `1/{index}`. Another address fails with
  `CONFIG_INVALID` before anything is signed, so a mistyped address can never receive your
  change. To send change to another key's address on purpose, also set
  `wallet.utxo.allowExternalChangeAddress: true` (see
  [security](./security.md#bitcoin-safeguards)). `bc.deriveAddress(wallet, index)` derives
  addresses of the wallet's type from its `xpub`. An extended public key made for the other
  network class (a mainnet key on a test network, or a test-network key on mainnet) fails
  with `CONFIG_INVALID`.
- **Outputs.** A destination may be any p2pkh, p2sh, p2wpkh, p2wsh or p2tr address of the
  network; other witness versions fail with `INVALID_ADDRESS`. An amount below its output's
  dust threshold (546 sat for p2pkh, 540 for p2sh, 294 for p2wpkh, 330 for p2wsh and p2tr)
  fails with `INVALID_AMOUNT`. A transfer pays at most 1,000 outputs, and a transaction
  above the standard 400,000 weight units fails with `INVALID_INTENT`.
- **Fees.** `slow`, `normal` and `fast` read Esplora's estimates for 144, 6 and 2 blocks (or
  the nearest faster target the endpoint has), never below 1 sat/vB. Without an estimate, a
  test network pays 1 sat/vB and mainnet fails with a retryable `PROVIDER_UNAVAILABLE`.
  Overrides are `{ satPerVByte: 3n }` or `{ satPerVByte: '2.5' }` (`UtxoFeeOverride`), at
  least 1 sat/vB (`FEE_TOO_LOW` below). A built transaction's fee is `exact`
  (`details.satPerKvB`, `details.vsize`); its size counts the largest possible signatures,
  so the real rate is never lower. `estimateFee` is `expected`, since the build selects the
  coins again. A fee above `maxFeeRate` or `maxFee` fails with `INVALID_INTENT` before
  anything is signed, explicit overrides included: raise them on purpose.
- **Fee estimates above the cap.** An estimate above `maxEstimatedFeeRate` is taken for a
  faulty endpoint: it decides nothing, and the call fails with a retryable
  `PROVIDER_UNAVAILABLE`. During a fee spike, `fast` and `normal` can exceed it; raise the
  option, use a slower speed, or pass an explicit `{ satPerVByte }`. testnet3's estimates
  can be far above it (264 sat/vB for up to 6 blocks in September 2026), even for `slow`:
  pass `{ satPerVByte }` there, or raise `maxEstimatedFeeRate` on that handle.
- **Coins.** `accumulative` (the default) spends the largest outputs first; `all` spends
  every eligible output (a sweep). Only outputs with `minInputConfirmations` confirmations
  are spent, and each new input's transaction must be in a block the proof endpoints
  attest. `0` also spends unconfirmed outputs of your own transactions that this handle's
  driver sent (it keeps their bytes; after a restart they wait for a block); an unconfirmed
  output of anyone else's transaction fails with a retryable `PROVIDER_UNAVAILABLE` until a
  block holds it. A transfer that spends an output of a transaction that is then replaced,
  or dropped for good, can never confirm, and the library cannot prove it failed, so its
  Operation stays open with its inputs held. This is not only a risk of `0`: a reorg after
  the build that double-spends a parent shallower than finality freezes a transfer the same
  way, at any `minInputConfirmations` below 6, the finality depth. `minInputConfirmations: 6`
  spends only final outputs and removes that risk. Outputs held by another live Operation
  are never selected, and change below the dust threshold goes to the fee.
  `bc.ext.utxo.listUnspent(address)` lists an address's unspent outputs, and
  `bc.ext.utxo.coinSelection({ from, outputs, fee?, exclude? })`, with amounts in
  satoshis, previews a selection without signing.
- **Signing.** One request per input: ECDSA (BIP143, or legacy for `p2pkh`) for `p2wpkh`,
  `p2sh-p2wpkh` and `p2pkh`, and Schnorr with the BIP341 key-path tweak for `p2tr`. A `p2tr`
  request's `publicKey` is the tweaked output key and its `params.tweak` the tweak, so a
  `callbackSigner` signs with the private key tweaked as BIP341 describes (`localSigner`
  does this). A `p2tr` wallet needs a signer with a `secp256k1-schnorr` key: an ECDSA-only
  signer, such as a KMS key, fails at signing, before anything is broadcast.
- **Cold signing.** `prepareTransfer` returns the PSBT (base64) as `unsigned.payload` for a
  cold or hardware signer; hand the signed PSBT back to `submitSignatures` (see
  [transactions](./transactions.md)). `unsigned.expectedRef` is the txid, except on `p2pkh`,
  whose txid depends on its signatures. The PSBT carries no key origins (BIP32 derivation
  paths), so a hardware wallet that needs them to find its key needs a coordinator that adds
  them. The signed PSBT may add signatures, final scripts, key origins, the fields a
  coordinator adds for its change outputs, and proprietary keys, and it may be written as
  PSBT version 0. A coordinator may also add the previous transaction of a non-`p2tr` input
  that lacks one (up to 4 MB of them in all); it must hash to the input's txid and pay the
  output spent. Anything that
  could change the spend, and any unknown field, fails with `INVALID_INTENT`. A signer
  whose PSBT is refused can still return signature bundles, one per request.
- **Input values.** Before anything is signed, the driver asks the proof endpoints whether
  each new input's previous transaction is in a block, attested at that block's height
  (the wallet's own unconfirmed transactions aside, above); until they all agree, the call
  fails with a retryable `PROVIDER_UNAVAILABLE`. It then reads that transaction, whose
  bytes must hash to the input's txid, and checks the indexer's value and script against
  it, for every address type and whatever `nonWitnessUtxo` says. A mismatch, or an output
  that transaction does not have, fails with a retryable `PROVIDER_INCONSISTENT`. So the
  indexer can neither misstate what you spend nor make you sign over a coin no chain holds.
  An output it wrongly lists as unspent makes the node refuse the transfer, which then ends
  once the spend that took that output is final (`TX_REPLACED`). Previous transactions are
  read four at a time, in one linear pass, and kept per txid. Each `p2pkh` input, and each segwit v0 input while `nonWitnessUtxo` is on,
  also carries its previous transaction in the PSBT, so a hardware wallet can check the fee
  itself; keep it on for hardware signers, which the BIP143 fee attack targets. Turning it
  off makes PSBTs smaller. A `p2tr` input never carries it: a taproot signature commits to
  every input's amount.
- **Broadcasts.** A node's claim that a transaction is invalid ends a transfer
  (`TX_REJECTED`) only when the driver confirms it for the bytes it sent: bytes that do not
  decode, or a consensus rule that the bytes alone break. Every other claim, and every
  policy refusal, is `refused`, and the transfer stalls with its inputs held, since the
  node may have relayed it. So one lying endpoint cannot free your coins for a second
  payment, but it can refuse every broadcast. Configure several endpoints and set
  `lifecycle.broadcastFanout` to 2 or more: `transfer`, `rebroadcast`, `replace` and
  `cancel` then send to that many endpoints at once, and one acceptance is enough.
- **Stalled transfers.** A signed transfer that a node refused is `stalled` (`FEE_TOO_LOW`,
  or `TX_REFUSED`, for example when an input is missing or already spent). `abandon`
  refuses it (`INVALID_TRANSITION`): its signed bytes may already be relayed and can still
  be mined, so its inputs stay held for it. Never retry the payment as a new transfer (a new
  idempotency key): the new Operation spends other coins, and both can confirm. Repeat the
  call with the same key, or use `rebroadcast`, `replace` or `cancel`. Workers keep
  observing it, and it moves on by itself once a node holds it or a block includes it.
  Otherwise, `rebroadcast` it after fixing the cause, or `replace` or `cancel` it: each
  replacement or cancel spends all of the original's inputs, so at most one of them lands.
  If another transaction spends one of its inputs at finality (the key spent those coins
  outside the library, for example), it fails with `TX_REPLACED` and its inputs are
  released.
- **Replace and cancel** use BIP125 RBF. A replacement or cancel spends every input of the
  transaction it replaces (a replacement may add confirmed outputs of the wallet), and it
  must pay the old fee plus 1 sat/vB of its own size, at a higher rate. Below that it fails
  with `FEE_TOO_LOW`; it never raises the fee on its own, so a speed that estimates too low
  fails too: pass a higher `{ satPerVByte }`. A cancel pays everything but its fee back to
  the sending address, never to a `changeAddress`, at the least valid fee unless you pass
  one. If the recipient already spent an output with a child transaction (CPFP), the node
  also counts the child's fee: the replacement fails with `FEE_TOO_LOW`, the original stays
  live, and a higher explicit fee, one that also covers the child, resolves it. Once the
  original is mined, a replacement or cancel fails with `TX_REFUSED` until the workers see
  that block, then with `INVALID_TRANSITION`; nothing new can land.
- **Finality** is 6 confirmations on every network, attested by the proof quorum;
  `waitForConfirmation` waits for 1 confirmation by default. Proofs read the `provider`
  endpoints. With one endpoint, a proof quorum of 1, that one operator decides finality and
  whether a transfer was replaced: it is fully trusted. Configure at least two independent
  endpoints, ideally three: with two, an outage of one eventually leaves the other deciding
  alone. The `public` preset uses mempool.space and blockstream.info, except on testnet4,
  where it has mempool.space only.
- **Reorgs.** A full-mode Esplora (electrs), such as the public services, keeps serving a
  transaction that a reorg took out of its block as unconfirmed, even when no mempool holds
  it. The library observes your Operations through their first input, so it sees such an
  Attempt as dropped and rebroadcasts it. A lookup by transaction id alone
  (`getTransaction`, or the status of a transaction the library does not manage) still
  shows it as unconfirmed.
- **Malleated transactions.** A miner can mine a `p2pkh` transaction under another txid (the
  same effect, with a different encoding of its signature script). The library recognises
  the copy as your payment: the Operation becomes `final` and `executed`, the observation's
  `txHash` is the copy's txid, and the Attempt keeps the original id. So
  `getTransaction(original)` is `null` while `getTransaction(copy)` shows the payment, and
  `replacedBy` on sibling Attempts names the original id. Segwit and taproot txids cannot be
  malleated.
- **Known limits.** No tokens and no OP_RETURN memo (a `memo` fails with
  `UNSUPPORTED_CAPABILITY`, and a network whose `capabilities.add` names a capability the
  driver lacks, such as `memo` or `tokens`, fails with `CONFIG_INVALID`). `getBalance` and `history()` count confirmed transactions only.
  Newly mined coins (coinbase outputs) are not told apart: a wallet that receives block
  rewards cannot spend them for 100 confirmations, and a transfer that selects one earlier
  is refused by the node; `rebroadcast` it once the output has matured.

`native(bc, 'bitcoinjs-lib')` returns `{ bitcoin, network, esplora(path) }`: the bitcoinjs-lib
module (with this library's ECC backend installed), the network's parameters and a GET to
the handle's `provider` through its transport. Import `crypto-aio/utxo` once to type it.
That entry names bitcoinjs-lib's types, so a project that type-checks libraries
(`skipLibCheck: false`) needs bitcoinjs-lib installed to import it; `crypto-aio` itself never
does.

### Tron networks

The Tron family serves the `tron` chain on `mainnet`, `shasta` and `nile` with tronweb 6
(`npm install tronweb`). A transfer moves TRX or one TRC-20 token to one recipient, with an
optional memo. [Sending and receiving](./transactions.md) covers what else differs on Tron:
[refused transfers](./transactions.md#error-handling),
[token verdicts and proofs](./transactions.md#waiting-and-watching) and
[scans](./transactions.md#receiving).

- **Addresses.** Base58check `T…` is canonical; `address.format({ hex: true })` gives the
  `41…` hex form, and both are accepted as input. Derive keys at `m/44'/195'/0'/0/<i>`
  (SLIP-44 coin type 195) through the wallet's `keyRef.path`. A TRX transfer to its own
  sender is refused (`INVALID_INTENT`); a TRC-20 one is valid on chain and allowed. A TRX
  transfer to a contract is refused before signing only on a network whose
  `getForbidTransferToContract` parameter is 1, as java-tron would refuse it there; it is 0 on
  mainnet, Shasta and Nile today, where such a transfer is valid.
- **Fees (`tron`).** Every charge is in TRX, and `bandwidth` and `energy` may be 0 when staked
  or free resources cover them (`activation` and `memo` are chain fees that no resource
  covers): `bandwidth` (the signed transaction's size plus 64 bytes, at the chain's price per
  byte), `energy` (TRC-20 only), `activation` (a TRX transfer to an address that was never
  activated: 1 TRX today, and its bandwidth is then a flat 0.1 TRX unless staked bandwidth
  covers it, since free bandwidth never applies) and `memo` (1 TRX today). Prices come from
  the chain's parameters on every estimate, and the charges are an `upper` bound;
  `fee.details` (`TronFeeDetails`) shows the bandwidth, the energy, their prices and the fee
  limit. `slow`, `normal` and `fast` give the same estimate: Tron has no fee market. Before
  signing, the sender needs TRX for every charge, plus the amount of a TRX transfer or the
  tokens of a TRC-20 one, and an account that was never activated cannot send
  (`INSUFFICIENT_FUNDS`).
- **Energy and the fee limit.** TRC-20 energy is simulated on the node and gets a 20% margin
  (`chains.tron.options.energyMarginPercent`, an integer from 0 to 1,000). The transaction's
  `feeLimit` covers all of it, because Tron caps a call's energy by `feeLimit` even when
  staked TRX pays for it; the `energy` charge is the fee limit less what your staked energy
  covers. The node reports the simulated energy, the energy price and the network's maximum
  fee limit (`getMaxFeeLimit`, 15,000 TRX today), and a call that fails on chain can burn its
  whole fee limit. So the fee limit is also bounded by your own
  `chains.tron.options.maxFeeLimit`, which no endpoint can raise: sun as a bigint, from 1 to
  2^53 − 1, and 100 TRX by default (`DEFAULT_MAX_FEE_LIMIT`, enough for a transfer to a new
  holder, about 130,000 energy, at 420 sun per energy with the margin). The fee limit is the
  estimate plus its margin, at most the network's maximum and at most `maxFeeLimit`. A
  transfer whose simulated energy alone needs more is refused with `INVALID_INTENT` before
  signing; when `maxFeeLimit` is the bound, the message names it and `error.details` carries
  `required` and `maxFeeLimit` (sun, as decimal strings), so raise it for a costlier token.
  The only override is `{ feeLimit }` in sun, as a bigint (`TronFeeOverride`), on TRC-20
  transfers, from the estimate up to both bounds: a lower cap fails on chain
  (`OUT_OF_ENERGY`) and still pays. A token's energy use can rise after the estimate (dynamic
  energy); when the margin, or a bound that cut it, is not enough, the transfer is proven
  failed (`TX_REVERTED`, reason `out of energy`) and its fee is burned. For a tighter policy
  per transfer, compare `ctx.fee` in your `beforeSign` hook
  ([Keys, signers and secrets](./security.md)) with your own limit.
- **Expiry, not replacement.** A transaction expires about `expirationMs` after its
  reference block, the head it was built on (or after the local clock, if that is earlier):
  60 s by default, from 10 s to 5 minutes (`chains.tron.options.expirationMs`). A build
  refuses a head more than half that window older than the local clock, and one dated more
  than half the window ahead of it (a retryable `PROVIDER_UNAVAILABLE`), so keep the server
  clock in sync (NTP): a clock running ahead of the chain sees every head as too old, and
  one running behind would build transactions that expire at birth, so both refuse builds.
  Tron has no replace and no cancel (`UNSUPPORTED_CAPABILITY`). A transaction that never
  lands is proven `expired` once a solidified block passes its expiration and a scan of
  every block that could hold it shows it absent, about a minute after the expiration; then
  `bc.rebuild(id)` re-issues it. With `prepareTransfer` or a `pending` signer, submit the
  signatures within the window. `rebuild` signs on the spot, so it needs a synchronous
  signer.
- **Finality.** `final` is the solidified block, about 19 blocks (a minute) below the head.
  `waitForConfirmation` waits for inclusion by default; credit deposits on `final`.
- **Tokens.** TRC-20. USDT is registered by alias on mainnet; any other token resolves by
  contract (`{ standard: 'trc20', contract: 'T…' }`), with its symbol and decimals read from
  the chain under the proof quorum and cached for the container's life. A token transfer
  counts as executed only with its `Transfer` event from the token contract
  ([token verdicts](./transactions.md#waiting-and-watching)). TRC-10 tokens are not
  supported, and TRC-10 transfers are not decoded.
- **Memos** are UTF-8 text of at most 256 bytes (`MAX_MEMO_BYTES`), public forever, and each
  costs the memo fee. A deposit's memo arrives as `transfer.memo`.
- **Scanning and history.** Blocks carry TRX transfers and TRC-20 `Transfer` events; any
  contract call is `decoding: 'partial'`. Address history comes from TronGrid's `/v1` API:
  name the `trongrid` or `public` preset as the handle's `indexer` (without one, `history()`
  throws `UNSUPPORTED_CAPABILITY`). It lists solidified entries only, at most 200 per page,
  and reads each one back through the handle's `provider`. It pages through TronGrid's
  `/transactions` first: the account's own transactions, TRX sent to it and, for a contract
  account, other accounts' calls to it. Then `/transactions/trc20`: every TRC-20 transfer
  from or to the account (a spender's `transferFrom` out of it included), less the account's
  own calls, listed already. A wallet's incoming TRC-20 transfer comes once, in the second
  part (TronGrid, checked on Nile in September 2026), but a call to a contract account that
  moves its own tokens comes in both parts, so dedupe on `transfer.id`, as for scans.
- **Presets and endpoints.** `trongrid` requires a key and sends it in the
  `TRON-PRO-API-KEY` header, as a `Secret`. `public` is TronGrid without a key, for trying
  things out on Shasta and Nile, not for production; a `tron` handle with no provider falls
  back to it, with a logged warning. **Mainnet needs `trongrid` with a key, or another
  provider:** keyless TronGrid answers most mainnet requests with HTTP 429. An endpoint
  that rate-limits a health check keeps its last good height and is checked again after its
  `Retry-After`, but one that has never answered a check is never confirmed, and the handle
  then finds no healthy endpoint. TronGrid publishes no rate limit, so neither preset sets `rateLimit`; to
  pace a busy service, configure the endpoint yourself with a `rateLimit` (a 429 answer is
  retried with backoff). An endpoint of your own must serve `/wallet`, `/walletsolidity` and
  `/jsonrpc` under one base URL, as TronGrid does: its identity check reads block 0 from all
  three. A bare java-tron node serves them on separate ports, so put a reverse proxy in front
  of it. A custom `indexer` endpoint must serve TronGrid's `/v1` API, and also answer
  `/wallet/getblockbynum` and `/wallet/getblock` (its health checks).
- **Proven verdicts need independent providers.** `trongrid` and `public` are one endpoint
  each, on the same TronGrid backend, so either alone gives a proof quorum of 1: a lagging
  backend decides nothing, but a wrong one is trusted, for verdicts, for a token's decimals,
  and for "not included", which would let `rebuild` pay twice. For proven verdicts on
  mainnet, configure independent providers, for example `provider: ['tron', 'own-node']`.
  With exactly two, both must answer while both are up, but once one has been down for about
  three health intervals (45 s by default) it leaves the proof count and the other decides
  alone. So use three for production proofs: two tolerate an outage, not a liar during one.
  If you set a `rateLimit` on an endpoint that serves proofs, give it `burst: 2` or more
  (the default is the rate rounded up): with a burst of 1, an endpoint that recovers from an
  outage may never rejoin the proof quorum.
- **A refusal is not a failure.** A node's refusal leaves the Operation `stalled` with
  `TX_REFUSED`, `TX_EXPIRED` or `INSUFFICIENT_FUNDS`, and the transaction may still land:
  never pay again with a new key ([what to do](./transactions.md#error-handling)). A
  node that caches transaction ids answers "duplicate" to bytes it refused before, which the
  library reads as sent. So after a top-up, `rebroadcast` may not reach that node's pool;
  the Operation then ends at its proven expiry, and `rebuild` sends the transfer again. Set
  `lifecycle.broadcastFanout` to 2 or more to send each broadcast to that many endpoints, so
  one refusing or id-caching node does not keep a transfer out of the others' pools.
- **Identical payouts.** Tron has no nonce. Each build gets a unique timestamp and
  expiration, so two identical transfers built in the same millisecond still differ.
- **Very large transfers.** Balances and deposits of any size are read exactly. A single TRX
  transfer above 2^53 − 1 sun (about 9 billion TRX) is refused with `INVALID_AMOUNT` before
  signing; split it.
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unchanged, `refBlockHash` included: the expiry proof relies on it
  ([why](#testing-an-adapter-or-a-store)).
- **Types.** `crypto-aio/tron` names tronweb's types, so a project with
  `skipLibCheck: false` needs tronweb installed to import it.
- **Integration tests.** The opt-in suite (`CRYPTO_AIO_INTEGRATION=1`) reads Nile through
  `public` by default. `CRYPTO_AIO_IT_TRON_NETWORK` picks the network, and
  `CRYPTO_AIO_IT_TRON_URL` an endpoint base URL, which mainnet needs.

```ts
import { Blockchain, configure, localSigner, secret, type TronFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/tron'; // types native(tron, 'tronweb')

configure({
  providers: {
    tron: { preset: 'trongrid', apiKey: secret(process.env.TRONGRID_API_KEY ?? '') },
    // An independent second provider: your node behind a proxy that serves /wallet,
    // /walletsolidity and /jsonrpc under one base URL.
    'own-node': {
      endpoints: [{ name: 'node', url: secret(process.env.TRON_NODE_URL ?? '') }],
    },
  },
  signers: { hot: localSigner({ secp256k1: secret(process.env.TRON_HOT_KEY ?? '') }) },
  wallets: { 'tron-hot': { signer: 'hot' } },
  chains: {
    tron: {
      network: 'mainnet',
      provider: ['tron', 'own-node'], // proofs cross-check both while both answer; use three
      indexer: 'tron', // address history (TronGrid /v1)
      wallet: 'tron-hot',
      // expirationMs: default 60_000, from 10_000 to 300_000; maxFeeLimit: sun, default 100 TRX
      options: { expirationMs: 120_000, maxFeeLimit: 50_000_000n },
    },
  },
});
const tron = Blockchain.create({ chain: 'tron' });
await tron.ready(); // loads tronweb; every endpoint must serve mainnet's block 0
const fee = await tron.estimateFee({ asset: 'USDT', to, amount: '25' });
// `fee.details` holds the `TronFeeDetails` fields but is typed as a plain record: cast each
const feeLimit = fee.details.feeLimit as bigint | undefined;
const sub = await tron.transfer(
  { asset: 'USDT', to, amount: '25', memo: 'order 7' },
  { idempotencyKey: 'withdrawal-42' },
);
await sub.wait({ finality: 'final' }); // the solidified block
const cap: TronFeeOverride = { feeLimit: 30_000_000n }; // as `fee`: sun, estimate to maxFeeLimit
const { energy } = await tron.ext.tron.getResources(to);
const client = await native(tron, 'tronweb'); // a TronWeb on the same transport
```

### Solana networks

The Solana family serves the `solana` chain on three clusters with `@solana/web3.js` (v1),
installed next to crypto-aio: `npm install @solana/web3.js`. A transfer moves SOL or one
classic SPL token to one recipient, with an optional memo. The driver sends every request
itself, through the handle's transport; the SDK only derives token account addresses,
compiles messages and backs `native()`.
[Configuring a real network (Solana)](./quick-start.md#configuring-a-real-network-solana)
shows a configuration.

**Solana needs Node.js 22.12 or later.** `@solana/web3.js` 1.99 depends, through
`rpc-websockets`, on an ESM-only `uuid`, which `require` can load only from Node 22.12. On
Node 22.0 to 22.11, the first use of a Solana handle (`ready()`, a read or `native()`)
fails with Node's own `ERR_REQUIRE_ESM`, not with `DEPENDENCY_MISSING`. The rest of
crypto-aio needs Node 22.

| Network | Identity (genesis hash) | Presets |
| --- | --- | --- |
| `mainnet` | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `public`, `alchemy`, `infura`, `ankr` |
| `devnet` | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | `public`, `alchemy`, `infura`, `ankr` |
| `testnet` | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY` | `public` |

- **Endpoints and presets.** Every endpoint must report its cluster's genesis hash
  (`getGenesisHash`), or it is refused (`PROVIDER_MISCONFIGURED`). `alchemy`, `infura` and
  `ankr` need an `apiKey`, which goes in the URL as a `Secret`, and serve mainnet and devnet
  only (testnet is `CONFIG_INVALID`); Infura documents its Solana access as limited to
  select customers. `public` is the cluster's own endpoint
  (`https://api.<cluster>.solana.com`), which Solana says is not for production; a `solana`
  handle with no provider falls back to it, with a logged warning. An endpoint of your own
  is `{ endpoints: [{ url }] }`. A node that reports itself unhealthy or behind (JSON-RPC
  `-32005`) shows as `RATE_LIMITED`, and is retried like one.
- **The `public` preset proves that a transfer never landed only slowly.** Solana publishes
  100 requests per 10 s per IP, and 40 per 10 s for one method, and the `public` preset
  paces each endpoint at 4 requests per second. But in September 2026 devnet and testnet
  answered HTTP 429 (`Retry-After: 10`) after about 6 or 7 `getBlock` calls per 10 s.
  Proving a transaction absent reads every block of its window, over 150 `getBlock` calls,
  and a proof read that meets a 429 fails at once. Each pass keeps what it has verified in
  memory (the window's frame, and how far the read got), and the next pass resumes there,
  so over `public` the proof completes only after many monitor passes: about 26 at 6 calls
  per 10 s, several minutes or more. Until then a transfer that never landed is not
  `expired`, and `rebuild` stays refused; a restart of the process starts the read over.
  No funds are at risk. A block scan also reads two `getBlock` calls per block (its header,
  then its transactions, and in `head` mode a few more lookups per block that is not final
  yet), but it waits out each 429, so it falls behind without stopping. Senders should use
  keyed or self-hosted providers for their proofs.
- **Proven verdicts need independent providers.** Each proof is a quorum over your
  endpoints, and an endpoint is a URL: a single URL, load-balanced or not, is trusted for
  everything it answers. A backend that lags, was pruned or lacks blocks never decides
  anything, but only a second, independent provider catches one that answers wrongly, and a
  wrong "not included" would let `rebuild` pay twice. Configure two or more independent
  providers, ideally three, for example `provider: ['alchemy', 'ankr', 'own-node']`: with
  exactly two, both must answer, and once one has been down for about three health
  intervals the other decides alone until the first rejoins; a third keeps proofs
  cross-checked meanwhile. If you set a `rateLimit` on an endpoint that serves proofs, give
  it `burst: 2` or more (the default is the rate rounded up): with a burst of 1, an endpoint
  that recovers from an outage may never rejoin the proof quorum.
- **Retention.** Endpoints must serve transaction history (`getTransaction`, `getBlock`,
  `getSignaturesForAddress`), and providers keep different amounts: Ankr documents about 16
  hours of ledger. A proof reads the block of the transaction's blockhash and every block of
  its window. An endpoint that no longer holds them decides nothing (the call waits and
  retries) rather than guessing, so an Operation left unwatched for longer than your
  providers keep, such as through a day-long outage, waits for an endpoint that still holds
  those blocks. History ends at a provider's retention too.
- **Transfers.** SOL (a System Program transfer) or classic SPL tokens (`transferChecked`),
  one output per transfer. Tokens move between associated token accounts: the sender's for
  the mint pays, and the recipient's receives. When the recipient has none, the transfer
  creates it (`CreateIdempotent`) and the sender pays its rent-exempt deposit (1,488,440
  lamports today, read from the node). The estimate shows that deposit as a `rent` charge,
  an `upper` bound: if someone creates the account first, no rent is paid. `getBalance` of a
  token sums every classic token account the owner holds for the mint, and
  `bc.ext.solana.getTokenAccounts(owner, mint?)` lists them; tokens outside the sender's
  associated token account count in that balance but cannot be sent (`INSUFFICIENT_FUNDS`).
  Token-2022 mints throw `UNSUPPORTED_CAPABILITY`.
- **Checks before signing.** These are refused before anything is signed: SOL to an account
  the System Program does not own, such as a program, a token account or a stake account
  (`INVALID_INTENT`; to fund one on purpose, use `native()`); SOL that would create an
  account below the rent-exempt minimum (`INVALID_AMOUNT`); tokens to a program itself
  (send them to a wallet or a PDA instead) or to a token account instead of its owner
  (`INVALID_INTENT`); a frozen token account, the sender's or the recipient's
  (`INVALID_INTENT`); and a transfer that would leave the sender with lamports between 0 and
  its rent-exempt minimum (650,240 lamports for an empty account today), which fails with
  `INSUFFICIENT_FUNDS` and its `details.required` and `details.available`.
- **Fees (`solana`).** Every charge is in SOL: `network` (the signature fee the node quotes
  for the message, 5,000 lamports per signature today), `priority` (the compute-unit price,
  in micro-lamports, times the compute-unit limit, rounded up to whole lamports; it is
  charged on the limit, not on what the transaction uses) and, when the recipient's token
  account is created, `rent`. The bound is `exact`, or `upper` with a `rent` charge;
  `fee.details` is `SolanaFeeDetails`. The `network` charge, and so the `exact` bound, is
  one endpoint's `getFeeForMessage` quote: it is never signed, and the chain charges its own
  signature fee, so a wrong quote changes only the estimate and the balance check (a short
  balance is then refused by the node and stalls, rather than paying more). `slow`, `normal`
  and `fast` take the 25th, 50th and 75th percentile of the node's
  `getRecentPrioritizationFees` for the accounts the transfer writes (0 when it reports
  none), and the limit is a simulation plus 20% and 1,000 units (the runtime's default of
  200,000 units per instruction when the simulation fails). One endpoint reports that price
  and runs that simulation, so the price is also bounded by your own
  `chains.solana.options.maxComputeUnitPrice`, which no endpoint can raise: micro-lamports
  per compute unit as a bigint, from 999 to 2^64 − 1, and 10,000,000 by default
  (`DEFAULT_MAX_COMPUTE_UNIT_PRICE`). A speed's percentile is clamped to the bound less 999
  before the build's variant is added, so a speed never signs more than the bound. At the
  1,400,000-unit maximum limit, the default bound caps a transfer's priority fee at
  14,000,000 lamports (0.014 SOL), whatever an endpoint answers. The override is
  `{ computeUnitPrice, computeUnitLimit? }` (`SolanaFeeOverride`), as bigints only: the
  price in micro-lamports per compute unit, kept exactly, and optionally a limit from 1 to
  1,400,000 instead of the simulation. An override price above the bound is refused with
  `INVALID_INTENT` before anything is signed: the message names `maxComputeUnitPrice`, and
  `error.details` carries `required` and `maxComputeUnitPrice` (decimal strings), so raise
  the option for a costlier transfer. The build checks the same bound, and that the priority
  fee matches the price and limit, wherever the estimate came from. Any other key in
  `chains.solana.options` is `CONFIG_INVALID`. For a tighter policy per transfer, compare
  `ctx.fee` in your `beforeSign` hook ([Solana safeguards](./security.md#solana-safeguards))
  with your own limit.
- **Identical transfers.** ed25519 signatures are deterministic, so two identical transfers
  on the same blockhash would be one transaction, and one payment would be lost. Each build
  adds 0 to 1,023 units to the compute-unit limit, an explicit limit included, and a speed
  adds 0 to 999 micro-lamports to the price, which costs at most about one lamport per 1,000
  compute units. When two Operations would still sign the same bytes (an explicit fee at the
  1,400,000-unit maximum, where no variant fits, or a rare collision between processes), the
  library refuses the second one before anything is sent (`NONCE_CONFLICT` with
  `details.heldBy`).
- **Expiry instead of replacement.** A transaction names a recent blockhash, valid for 150
  blocks, about a minute at today's block times, and it can still land in the block after
  its last valid block height (`lastValidBlockHeight + 1`). There is no replace and no
  cancel (`UNSUPPORTED_CAPABILITY`). While the transaction is not seen, the workers resend
  the same bytes. It becomes `expired` (`TX_EXPIRED`) only once the proof quorum attests the
  blockhash's own block (its height plus 150 is the last valid height; the height the build
  recorded is only a hint), has finalized the block after the last valid one, and serves
  every block of the window, each chained to the one before by height and parent hash,
  without the transaction. Then `bc.rebuild(id)` signs a new one on a fresh blockhash. With
  `prepareTransfer` or a `pending` signer, submit the signatures while the blockhash is
  valid; `rebuild` signs on the spot, so it needs a synchronous signer.
- **A refusal is not a failure.** A node's refusal leaves the Operation `stalled` with
  `TX_REFUSED` or `INSUFFICIENT_FUNDS`, and the transaction may still land until its window
  has passed: never pay again with a new key
  ([what to do](./transactions.md#error-handling)). The common case is
  `blockhash not found` on the first broadcast, from an endpoint that lags behind the one
  that served the blockhash. While the blockhash is valid, `bc.rebroadcast(id)` retries it;
  otherwise the workers prove it `expired`, and `bc.rebuild(id)` signs a new one. A node's
  claim that the signature is invalid ends a transfer only when the library finds, with its
  own check, that the bytes it sent really carry a bad signature; otherwise the claim is a
  `TX_REFUSED` refusal too, since a lying endpoint may have relayed the bytes anyway. The
  workers never resend a `stalled` transfer on their own, so after any refusal, even a
  false one, retry only with `bc.rebroadcast(id)` or by repeating the call with the same
  idempotency key, never as a new transfer.
- **Finality and heights.** `final` is the `finalized` commitment. `waitForConfirmation`
  waits for inclusion at `confirmed` by default, so credit deposits on `final`. Heights are
  block heights, not slots, so skipped slots never leave a gap in scans or confirmations,
  and `bc.getBlock()` takes a height (a hash is `UNSUPPORTED_CAPABILITY`).
- **Verdicts.** A verdict reads the finalized transaction under the proof quorum. A
  transaction that failed on chain is proven `failed` (`TX_REVERTED`, with the reason
  `transaction failed`), and its fee is paid. An SPL transfer counts as executed only when
  the token balances show tokens leaving the sender's account and reaching the recipient's;
  missing or contradictory balances decide nothing.
- **Memos** are UTF-8 text of at most 256 bytes, sent through the Memo program, and public
  forever. A received memo (Memo v1 or v2) arrives as `transfer.memo` on the transfers of a
  transaction that carries exactly one memo.
- **Scanning.** Blocks carry SOL transfers, including those a program makes
  (`source: 'internal'`), and classic SPL transfers, whose `from` and `to` are the token
  accounts' owners when the node reports them. Transfers are checked against the
  transaction's balance changes: whatever they do not explain, such as a Token-2022
  transfer, makes it `decoding: 'partial'`. Vote transactions are skipped.
  `filter.addresses` may hold wallets, token accounts (associated or not) or both. A
  filtered scan returns every transaction that may move funds for a watched address, an SPL
  transfer into or out of a watched token account included; one it cannot fully attribute is
  returned as `partial` rather than dropped. An SPL transfer's `to` is the owner wallet
  whenever the node reports the owner, never the token account (only a `partial` transaction
  whose owner was not reported names the token account), so credit token deposits by owner:
  a service that watches token accounts matches `transfer.to` against their owners too. A
  token transfer that creates the recipient's token account also shows the rent deposit as
  an internal SOL transfer to that account.
- **History** comes from the RPC (`getSignaturesForAddress`), newest first, without an
  indexer: `bc.history(address)` lists transactions from `confirmed` on, at most 1,000 per
  page, and reads each one back, so a page costs two requests per item (`getTransaction`,
  then a header-only `getBlock` for its height and hash). An SPL deposit into an
  existing token account appears in that account's history, not the owner's. A handle's
  `indexer`, when you set one, serves history instead; any Solana RPC endpoint can be one.
- **Tokens.** USDC (mainnet, devnet) and USDT (mainnet) are registered by alias. Any other
  classic mint resolves by address (`{ standard: 'spl', contract: '<mint>' }`), with its
  decimals read from the chain under the proof quorum and the first eight characters of its
  address as its symbol, since SPL mints carry no symbol.
- **Keys.** Solana keys are ed25519. `localSigner({ ed25519: secret(seedHex) })` takes the
  32-byte seed; a Solana CLI key file holds 64 bytes, the seed and then the public key.
  Mnemonic signers derive with SLIP-10, hardened segments only, at the wallet's
  `keyRef.path`; wallets commonly use `m/44'/501'/0'/0'`. An address is the base58 public
  key.
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unmodified, `blockhash` included: the expiry proof relies on it
  ([why](#testing-an-adapter-or-a-store)).
- **Types.** `crypto-aio/solana` exports `SOLANA_CAPABILITIES`, `SOLANA_PEER_DEPENDENCIES`
  and the SDK-free types (`SolanaExpiryOrdering`, `SolanaExt`, `SolanaFeeDetails`,
  `SolanaFeeOverride`, `SolanaTokenAccount`, also exported from `crypto-aio`), and types
  `native(bc, '@solana/web3.js')`. It names `@solana/web3.js`'s `Connection`, so a project
  with `skipLibCheck: false` needs `@solana/web3.js` installed to import it.
- **Integration tests.** The opt-in suite (`CRYPTO_AIO_INTEGRATION=1`) reads devnet through
  `public` by default. `CRYPTO_AIO_IT_SOLANA_NETWORK` picks the cluster, and
  `CRYPTO_AIO_IT_SOLANA_RPC_URL` an endpoint (paced at 4 requests per second); the test that
  proves a transaction absent from a whole window runs only with
  `CRYPTO_AIO_IT_SOLANA_WINDOW=1`, and needs a keyed or self-hosted endpoint in that URL.
- **Not in this release:** durable nonces, Token-2022, building versioned transactions with
  address lookup tables (received ones are decoded), a whole signed transaction in
  `submitSignatures` (submit signature bundles), a Solana network of your own (a local test
  validator has its own genesis hash), and `@solana/kit`.

`native(bc, '@solana/web3.js')` returns a `Connection` wired to the handle's transport, so it
never sees the real URL or key. It speaks HTTP JSON-RPC only: subscriptions have no bridge.
Import `crypto-aio/solana` once to type it. The `Connection` parses JSON itself, so numbers
above 2^53 are rounded there; the driver's own reads keep u64 amounts exact. A transaction
you send through it is not an Operation, and the library does not track it.

### TON networks

The TON family serves the `ton` chain on `mainnet` (the default) and `testnet` through
`@ton/ton` 16, which needs `@ton/core` 0.63 and `@ton/crypto` 3 next to it (`npm install
@ton/ton @ton/core @ton/crypto`). The coin is Gram (ticker `GRAM`, formerly Toncoin), with 9
decimals: a `bigint` amount is in nanograms, and `asset: 'GRAM'` and its alias `'TON'` both
name it. A transfer moves Gram or one jetton to one recipient, with an optional text memo.
[Sending and receiving](./transactions.md) covers what else differs on TON:
[verdicts and proofs](./transactions.md#waiting-and-watching),
[refusals](./transactions.md#error-handling) and
[receiving](./transactions.md#receiving).

| Network | Global id (identity) | Explorer |
| --- | --- | --- |
| `mainnet` (default) | -239 | tonviewer.com |
| `testnet` | -3 | testnet.tonviewer.com |

- **A provider and an indexer.** `provider` is toncenter's API v2, a liteserver proxy
  (account state, get-methods, fee emulation, sending), and `indexer` is its API v3 (which
  transaction a message became, message traces, history). The indexer is required: without
  it no transfer could ever be proven `final`. A handle without a `provider`, or without an
  `indexer`, falls back to the keyless `public` preset for it, with a logged warning, so
  name both. Every endpoint's health check reads the network's global id, so an endpoint of
  the other network is refused (`PROVIDER_MISCONFIGURED`). A custom pair is any
  toncenter-compatible v2 and v3: `{ endpoints: [{ url: 'https://…/api/v2' }] }` and
  `{ endpoints: [{ url: 'https://…/api/v3', kind: 'indexer' }] }`.
- **Presets and rate limits.** `toncenter` needs an `apiKey`, which travels in the
  `X-API-Key` header as a `Secret`, never in a URL; named as a `provider` it is API v2, and
  as an `indexer` API v3. `public` is the same service without a key, for trying things out,
  not for production. toncenter allows one request per second per network without a key
  (per IP) and 10 with a free key (per key), shared by v2 and v3, so each preset endpoint
  takes half: 0.5 requests per second keyless, 5 with a key, each with a burst of 1. Health
  checks take their tokens from the same buckets, and a 429 answer is a retryable
  `RATE_LIMITED`. A paid key allows more: configure it as a custom pair with your own
  `rateLimit`, half of your plan's limit on each (on testnet, `testnet.toncenter.com`):

  ```ts
  const headers = { 'X-API-Key': secret(process.env.TONCENTER_KEY ?? '') };
  const rateLimit = { rps: 12.5, burst: 2 }; // half of your plan's limit (25 per second here)
  const providers = {
    'tc-v2': { endpoints: [{ url: 'https://toncenter.com/api/v2', headers, rateLimit }] },
    'tc-v3': {
      endpoints: [{ url: 'https://toncenter.com/api/v3', kind: 'indexer' as const, headers, rateLimit }],
    },
  };
  ```

  A rate limit belongs to a transport, and every container, and every handle whose
  `options` or `maxLagBlocks` differ from another's, gets its own driver and transport. So
  several of them in one process can together exceed toncenter's limit for your IP or key:
  keep one configuration per network, set once in `chains.ton`.
- **Proof endpoints and their burst.** The presets' burst of 1 keeps them near toncenter's
  limit, and costs liveness: a proof read first refreshes a recovering
  endpoint's health, which spends a burst-1 endpoint's only token, so the endpoint may skip
  the trial request that would let it rejoin the proof quorum, for as long as proof reads
  keep it busy. On endpoints you configure for proofs, set `burst: 2` or more where your
  plan allows it.
- **Two or three independent providers.** `toncenter` and `public` are one service:
  configured together they count as two endpoints, yet they are one source, so toncenter
  alone then decides finality, bounces, a jetton's decimals and whether a transfer is
  proven absent, which `rebuild` acts on. Proofs read the provider and the indexer under the
  proof quorum, so configure two or more independent toncenter-compatible pairs, ideally
  three, for example toncenter and your own: with three, a quorum of two survives one
  outage. With two, once one has failed its health checks for about three refreshes, the
  other decides alone until the first recovers.
- **Archival endpoints for proofs.** Proofs walk a wallet's transactions back through a
  message's lifetime and run jetton get-methods at a transfer's own block, and history runs
  those get-methods at each jetton deposit's block. A node that has pruned a block answers
  "not ready", or "no state" (exit code -13) for the jetton wallet asked; neither decides
  anything: the proof, or the history read that holds the deposit, waits until an endpoint
  that has the block answers. Run archival nodes behind the endpoints you configure.
  toncenter answered for old blocks on both networks when this was written.
- **Wallets.** `wallets.<name>.ton` names the wallet contract, and every field decides the
  address: `{ version: 'v4r2', workchain?, subwalletId? }` (default `698983191` plus the
  workchain) or `{ version: 'v5r1', workchain?, subwalletNumber?, networkGlobalId? }`
  (default subwallet 0; the network id defaults to the network's and may only equal it, so
  a v5r1 wallet has another address on each network). `workchain` is 0 (the default) or -1.
  `bc.walletAddress()` shows the address as wallet apps do (`UQ…`, or `0Q…` on testnet):
  compare it with your wallet app before you fund it. An undeployed wallet can receive, and
  its first transfer deploys it. A watch-only wallet needs its `ton` settings too:
  `{ publicKey: '<hex>', ton: { version: 'v5r1' } }`. `Blockchain.estimateFee` needs the
  handle's wallet, since the fee is emulated with its code: without one it fails with
  `INVALID_INTENT`, or with `CONFIG_INVALID` when the intent names a `from`.
  For keys, see [Local signers](./security.md#local-signers).
- **One output per transfer.** A TON wallet delivers each output of a batch in its own
  transaction, so a batch can partly land: one output can bounce while the others are
  credited, and a single verdict for the whole transfer would either invite a resend that
  pays the landed outputs twice or hide a failed one. So in this release a TON transfer
  carries exactly one output: `batch-transfer` is not a TON capability, `bc.limits()`
  answers `{ maxOutputs: 1 }`, and more than one output fails with `UNSUPPORTED_CAPABILITY`
  before anything is built. Batch payouts are not supported yet.
- **Addresses and bounce.** Canonical addresses are raw (`0:<hex>`, lower case); `display`
  keeps the form you wrote, and `address.format({ raw: true })` gives the raw one. The form
  decides bounce: `UQ…` and `0Q…` never bounce, while `EQ…`, `kQ…` and raw addresses do. To
  pay a fresh (undeployed) wallet, use its `UQ…` form: a bounceable message to it comes
  back, less fees, and the transfer fails with `transfer bounced`. Some wallet apps switch a
  non-bounceable address to bounceable when the recipient is an active contract; the
  library never changes the flag: it sends what you wrote. Mainnet refuses the testnet-only
  forms `kQ…` and `0Q…` (`INVALID_ADDRESS`).
- **Address forms and idempotency.** The bounce flag is part of the intent, so the same
  recipient written as `UQ…` and as `EQ…` (or raw) is two intents: reusing an idempotency
  key with the other form fails with `IDEMPOTENCY_CONFLICT`. The testnet flag and the base64
  alphabet only change how an address is shown: every spelling with the same bounce flag is
  the same intent.
- **Transfer ids.** An Attempt's id is the normalized hash (TEP-467) of its external message,
  in hex (`idKind: 'message-hash'`, `canonical: false`). Once the indexer has the
  transaction, its hash appears as `txHash` in the status. `getTransaction` takes either.
- **Seqno and expiry.** A wallet sends one transfer at a time: another transfer from it
  fails with `SEQUENCE_BUSY` (retryable, with `context.blockingOperationId`) until the first
  is `included` or has ended. For more throughput, send from several wallets: another
  subwallet id or number gives the same key another address. A message lives 60 seconds of
  chain time from its build (`validForSeconds`, fixed in this release). A build refuses an
  endpoint whose chain time is more than 5 minutes from your server's clock (a retryable
  `PROVIDER_INCONSISTENT`), so keep the clock in sync: builds refused for chain-time skew
  mean fix the clock, not the endpoint. An endpoint and a clock both more than 5 minutes
  ahead at a build could let a later proof miss a wallet reset, the one case this check
  cannot catch. A message that never lands is proven
  `expired` about a minute after its build, and `bc.rebuild(id)` then signs it again at the
  wallet's next seqno. `rebuild` signs on the spot, so it needs a synchronous signer; with
  `prepareTransfer` or a `pending` signer, sign within that minute. TON has no replace and
  no cancel (`UNSUPPORTED_CAPABILITY`).
- **Refusals.** toncenter answers every refused message with HTTP 500, which the library
  treats as "maybe sent": the transfer surfaces as ambiguous, and a node that answers "not
  ready" or "busy" is treated the same way. Another v2-compatible endpoint's definitive
  refusal leaves the Operation `stalled` (`NONCE_CONFLICT`, `TX_EXPIRED`, `TX_REFUSED` or
  `INSUFFICIENT_FUNDS`). Either way the message may still land within its lifetime, and the
  Operation ends only on proof: `final` or `failed` if it landed, or `expired`, after which
  `rebuild` sends it again. Only bytes that are no TON message at all are `rejected`, and
  the library never builds those. Never pay again with a new key while the Operation lives.
- **Resends.** A wallet reset (emptied and deleted, then re-funded or deployed again with
  its seqno back at 0) makes a message that already ran runnable again. So before the TON
  driver sends signed bytes again (a caller's retry with the same key, a rebroadcast of a
  dropped transfer, `bc.rebroadcast`, `recover()`, or `bc.broadcast` of a wallet message),
  it checks the wallet's chain: from the newest state an endpoint serves, linked to the
  state the proof quorum attests, back to the message's build time (for bytes this process
  did not build, the longest lifetime a message can have, a day). A message that already
  ran is not sent again (`already-known`). While a deletion or a new deployment cannot be
  ruled out, or the check cannot finish (a rate limit, an indexer that is behind), nothing
  is sent: the call fails with a retryable, ambiguous `PROVIDER_UNAVAILABLE`, and the proof
  decides later. The first send of bytes built in the same process, and any send once the
  wallet's seqno is past the message's, go out without the check. That first send skips it
  only within 2 seconds of assembling the signed bytes, so a later one (after a slow store
  write or a paused process) is checked too: several processes sharing one store are
  covered only through that bound. The check costs a few quorum reads, plus one per 32
  wallet transactions it has not read before; on the keyless preset allow several seconds.
  It protects only the library's own sends: after a reset under a shared key, anyone who
  saw the message can send it again while it is valid, and no client can prevent that.
- **Replaced.** TON never reports an observed `replaced` for your own message: masterchain
  state is final, so a transfer that landed but is not indexed yet stays `submitted` or
  `included` until the indexer catches up. A proven `replaced` (`TX_REPLACED`) means that a
  request signed with the wallet's key, not this transfer, used its seqno: something else
  is sending from the wallet. Never share a wallet's key with other software
  ([why](./security.md#local-signers)).
- **Fees (`ton`).** `slow`, `normal` and `fast` give the same estimate: the network config
  sets every price. A Gram transfer's fee is one `network` charge, with an `expected` bound:
  the import, gas and storage fees from the endpoint's emulation, plus the forward fee,
  never below the config's own formula (one more request per estimate). `fee.details`
  (`TonFeeDetails`) splits it and says whether the transfer deploys the wallet. A jetton
  transfer adds an `attached` charge, the Gram sent along to your jetton wallet (0.05 GRAM
  by default, the unspent part refunded), and its bound is `upper`. The only override is
  `{ attached }` in nanograms, as a bigint (`TonFeeOverride`), on jetton transfers; it must
  exceed the 1-nanogram forward amount. An estimate whose `network` charge exceeds 1 GRAM
  (a basechain wallet) or 100 GRAM (a masterchain wallet) is not trusted: it is a retryable
  `PROVIDER_INCONSISTENT`, so one endpoint cannot fail a transfer for good with an inflated
  fee. TON signs no fee, so the chain charges its own prices either way. Set the ceiling in
  nanograms with the `maxNetworkFee` option, `{ basechain?, masterchain? }` as bigints, in
  `chains.ton.options` or a handle's `options` (a network of a plugin may also set it in its
  `params`); for each workchain the option wins, then the network's value, then the
  default. It is the TON driver's only option: any other key is refused with
  `CONFIG_INVALID`. Set it once per chain rather than per handle: handles with different
  options get their own transports, so two keyless handles make twice the requests
  toncenter allows one address.
- **Funds.** Before signing, the wallet needs Gram for the fee and the amount, or for the
  fee and the attached value plus the jettons (`INSUFFICIENT_FUNDS`). A wallet that cannot
  pay can already fail the estimate with `INSUFFICIENT_FUNDS`; its `details.required` is
  then a lower bound: the amount (or the attached value), the forward fee, and the flat gas
  price every wallet run pays (config param 21, or 20 for a masterchain wallet). Leave
  room for the rest of the gas: a wallet that covers
  that bound but not the whole run gets a retryable `PROVIDER_INCONSISTENT` from the
  estimate instead, so a transfer of nearly the whole balance keeps failing with it. Right after a wallet's first transfer deploys it, an
  endpoint that lags can answer that way too until it catches up.
- **Finality.** `final` needs masterchain inclusion and a completed message trace in which
  the value moved. A masterchain block is final once it exists, so `getFinalizedHeight()` is
  the masterchain head, while proofs attest a block 10 below it. An endpoint more than 150
  masterchain blocks (about a minute) behind the best is lagging.
- **Jettons.** `asset: { standard: 'jetton', contract: <master> }`, or the alias `USDT` on
  mainnet (Tether's master `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs`, 6 decimals);
  testnet has no catalog tokens. A transfer goes through your jetton wallet, the one the
  master names for your wallet under the proof quorum (`bc.ext.ton.jettonWallet(owner,
  master)` shows it). It forwards 1 nanogram so the recipient gets a notification, which
  carries the memo, and the excess comes back to you. A jetton transfer ignores the
  recipient address's bounce flag: the jetton standard (TEP-74) decides bouncing on the
  jetton wallets' own messages. It is `final` only when the recipient's jetton wallet, the
  one the master names for the recipient, received a positive amount from yours.
- **Jetton decimals.** A jetton's symbol and decimals are read under the proof quorum and
  cached for the container's life. Metadata kept wholly on chain states them, or means 9
  decimals (TEP-64's default). Metadata that links to an off-chain document takes them from
  the indexer's copy of that document, never from a default: while it states no decimals,
  or the indexer has not fetched it, the jetton stays unresolved, and that is never cached,
  so a later read resolves it once the indexer has it. A history page or `getTransaction`
  that holds a transfer of it still reads: the transfer arrives unresolved, with its raw
  amount in base units and the code `PROVIDER_UNAVAILABLE`
  ([unresolved assets](./transactions.md#receiving)), and never counts as a deposit
  until you know its decimals. Anyone can send such a jetton to your address. A call that
  needs the decimals, such as a transfer of the jetton, fails with a non-retryable
  `PROVIDER_UNAVAILABLE` before anything is signed. That refusal records nothing, not even
  an Operation under the idempotency key, so the same call can simply be repeated later,
  once the indexer has the metadata. Register the decimals of a jetton you use yourself,
  from its issuer, with a plugin of your own; the library then trusts them as you wrote
  them:

  ```ts
  aio.use({
    name: 'my-jettons',
    assets: [{
      chain: 'ton', network: 'mainnet', aliases: ['XYZ'],
      ref: { standard: 'jetton', contract: '0:<master, raw, lower case>' },
      metadata: { symbol: 'XYZ', decimals: 9 },
    }],
  });
  ```

  A jetton you register this way is never read from the chain, so never register one you
  do not accept: leave it unresolved, and never credit it.
- **Memos** are text comments of at most 1,024 UTF-8 bytes, public forever. A deposit's memo
  arrives as `transfer.memo`: a Gram deposit's from its message, a jetton deposit's from the
  forward payload its arrival carries (the notification repeats it).
- **Receiving.** There is no block scanner (TON is sharded): `bc.scanner()` throws
  `UNSUPPORTED_CAPABILITY`. `bc.history(address, { cursor?, limit? })` lists the address's
  transactions from the indexer, newest first, at most 1,000 per page, and only those the
  indexer reports final. A Gram deposit is the `msg:in` transfer of the transaction that
  received it; a bounce that brings your own value back is `source: 'internal'`, a refund,
  not a deposit. A jetton deposit is decoded only from a jetton wallet that the master itself
  names for the owner, since anyone can deploy a contract that claims a master. **Credit a
  jetton deposit only from its arrival**: the `msg:in:jetton` transfer in the history of
  the owner's jetton wallet (`bc.ext.ton.jettonWallet(owner, master)`), whose `to` is the
  owner. Every jetton transfer arrives there, one sent with no forward amount included. The
  owner's own history shows the same movement a second time, from the notification the
  jetton wallet sends on (also `msg:in:jetton`, with another transfer id and the same
  `details.traceId`): never credit that one, or one deposit counts twice. One trace (one
  external request) may carry several genuine transfers to the same owner, so a trace id
  is not a dedupe key; dedupe on the arrival's transfer id.
- **Crediting deposits.** History entries are reads of one provider and one indexer, so
  their evidence is `observed` (with `finality: 'final'`), never `proven`, as every family's
  deposits are ([Crediting deposits](./transactions.md#crediting-deposits)), and a jetton
  deposit's genuineness also rests on the provider's get-methods. So before you credit any deposit automatically (or any above your risk
  threshold), read it again through an independent provider **and** indexer pair, for
  example `bc.with({ provider: 'own-v2', indexer: 'own-v3' }).getTransaction(tx.id)`, and
  credit it only when both reads are final and agree on the transaction hash, the
  recipient, the asset, the amount and the memo.
- **Extras and types.** `bc.ext.ton.getSeqno(address)` reads a wallet's seqno (0 while it
  is undeployed), and `bc.ext.ton.jettonWallet(owner, master)` the jetton wallet the master
  names for an owner. `crypto-aio/ton` exports `TON_CAPABILITIES`,
  `TON_INDEXER_CAPABILITIES` and `TON_PEER_DEPENDENCIES`, and importing it types
  `native(bc, '@ton/ton')` as a `TonClient` ([Keys, signers and secrets](./security.md));
  the root entry exports the `Ton*` types, and both entries export `TonSeqnoOrdering`, an
  Attempt's TON ordering, for store authors (below).
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unchanged, every property included. On TON it is a `TonSeqnoOrdering`,
  `{ kind: 'seqno', seqno, validUntil, validFrom }`: the seqno as a `bigint`; `validUntil`,
  the chain time in seconds at which the message expires; and `validFrom`, the chain time
  the build ran at. The proofs read all three from the store, not from the signed bytes. A
  changed seqno, or a `validUntil` changed or rounded down, can prove a transfer that landed
  `expired` or `replaced`. A `validFrom` that is lost only costs time (the proof then reads
  back through the longest lifetime a message can have), but one moved later hides a wallet
  reset that happened before it: a false "not included", and `rebuild` then pays twice.
  The contract suites do not check this yet ([stores](#testing-an-adapter-or-a-store)).
- **Live checks (this repository).** `CRYPTO_AIO_INTEGRATION=1` runs the read-only checks in
  `test/integration/ton.test.ts` against testnet (`CRYPTO_AIO_IT_TON_NETWORK=mainnet` for
  mainnet) through the keyless `public` preset. `CRYPTO_AIO_IT_TON_RPC_URL` and
  `CRYPTO_AIO_IT_TON_INDEXER_URL` point them at other v2 and v3 endpoints: use them for
  keyed or self-hosted endpoints. The suite gives each such endpoint the keyless preset's
  rate limit, `rateLimit: { rps: 0.5 }`; set one on any keyless toncenter endpoint you
  configure yourself, since without it toncenter answers a burst with HTTP 429.

## 2. More networks of an existing family

A family driver is written once, and every chain and network it serves is data: a
`ChainInfo` with its `NetworkInfo` entries (identity, fee model, `FinalityPolicy`, default
confirmations, `reorgWindow`, replacement rules, explorer templates), plus provider presets
that map `(chain, network, apiKey)` to endpoints. So an EVM chain needs no new adapter.

`evmChainPlugin` from `crypto-aio/evm` serves your EVM chains with the built-in driver, for
both libraries. It checks the data when called, or throws `CONFIG_INVALID`: family `evm`,
nonce ordering, the `secp256k1-ecdsa` scheme, and per network the decimal chain id as
`identity`, an `evm-1559` or `evm-legacy` fee model, and `finalized`-tag or confirmation
finality. A network removes the capabilities it lacks: `finality-tag` without the tag,
`fee-market-1559` on `evm-legacy`, and `replace-fee` and `cancel` without a mempool.
Optional network `params` describe the chain further: `minPriorityFeePerGas` (a bigint tip
floor), `l1DataFee: 'op-stack'` (transactions also pay an OP Stack L1 data fee), and
`systemLogs: 'bor'` (a bor client's system logs on every receipt, as on Polygon PoS, which
a plain transfer then ignores).

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

It registers as `evm:acme` and also takes `presets` and `assets`. Augment `ChainRegistry`
with `acmechain: { family: 'evm'; network: 'mainnet' }` to type the handle and `ext.evm`.

The registry rules that apply today already set the limits. A chain id registers once (a
second registration fails with `CONFIG_INVALID`, "already registered"), so nobody can add a
network to an existing chain id from outside. A plugin can add a new chain id, and it can add
presets, or adapters for another library, to chains that are already registered.

The TON family has no helper like `evmChainPlugin`: its two networks are built in, and this
release offers no way to change their settings.

## 3. A new family: the plugin API

A `Plugin` is plain, SDK-free data plus lazy loaders. You register it on a root container.

```ts
import type { AdapterManifest, ChainInfo, DriverFactory, Plugin, ProviderPreset } from 'crypto-aio';
import { reveal, secret } from 'crypto-aio';

const acmechain: ChainInfo = {
  id: 'acmechain',
  family: 'acme',
  model: 'account',
  ordering: 'nonce', // 'nonce' | 'seqno' | 'inputs' | 'expiry'
  schemes: ['secp256k1-ecdsa'],
  nativeAsset: { symbol: 'ACME', decimals: 18 },
  defaultNetwork: 'mainnet',
  networks: {
    mainnet: {
      id: 'mainnet',
      identity: '0x2a', // what the driver's identity probe must return
      testnet: false,
      feeModel: 'acme',
      finality: { kind: 'confirmations', confirmations: 12 },
      defaultConfirmations: 12,
      reorgWindow: 64,
      replacement: { minBumpPercent: 10 },
    },
  },
};

const acmeManifest: AdapterManifest = {
  family: 'acme',
  library: 'acme-sdk',
  chains: ['acmechain'],
  capabilities: ['block-scan', 'replace-fee', 'cancel', 'memo'],
  peerDependencies: [{ name: 'acme-sdk', range: '^3.0.0' }],
  // The only place the SDK is loaded. `require`, so it works under CommonJS and Jest.
  load: async (): Promise<DriverFactory> => require('./acme-driver').acmeDriverFactory,
};

const acmeCloud: ProviderPreset = {
  name: 'acmecloud',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (chain, network) => chain === 'acmechain' && network === 'mainnet',
  endpoints: ({ apiKey }) => [
    { name: 'main', url: secret(`https://rpc.acme.example/v1/${reveal(apiKey ?? '')}`) },
  ],
};

export function acmePlugin(): Plugin {
  return { name: 'acme', chains: [acmechain], adapters: [acmeManifest], presets: [acmeCloud] };
}

// Required: without the ChainRegistry entry, `ChainId` does not include 'acmechain', and
// `aio.blockchain({ chain: 'acmechain' })` does not compile. FamilyRegistry types
// `bc.ext.acme` and the library; NativeClientMap types `native()`. AcmeExt and AcmeClient
// are your own types.
declare module 'crypto-aio' {
  interface ChainRegistry { acmechain: { family: 'acme'; network: 'mainnet' } }
  interface FamilyRegistry { acme: { library: 'acme-sdk'; ext: AcmeExt } }
  interface NativeClientMap { 'acme-sdk': AcmeClient }
}
```

Register it with `new CryptoAio({ plugins: [acmePlugin()] })` or `aio.use(acmePlugin())`.
Plugins go on a root container only. Registering the same plugin again does nothing, so
`use()` is safe to repeat, and so does a fresh `acmePlugin()` that builds the same data around
the same functions. Define `load` and every other function once, at module level, as above: a
plugin whose functions are rebuilt on each call, or capture other values, is a different
plugin. A different plugin under a name already registered throws `CONFIG_INVALID`, so give
each plugin a unique name (custom EVM chains register as `evm:<name>`). A plugin may also bring `assets` (tokens
with aliases, per chain and network) and `schemes`. The built-in schemes are
`secp256k1-ecdsa`, `secp256k1-schnorr` and `ed25519`.

**Reference implementations:** the fake family (`src/testing/fake-plugin.ts` and
`fake-driver.ts`) and the EVM family (`src/adapters/evm/`). Read them next to this section.

### The driver

`DriverFactory.create(ctx)` receives a `DriverContext`: `chain`, `network`, `library`,
`transport`, an optional `indexer` transport, `clock`, `log` and handle `options`. It returns
a `ChainDriver` that implements the ports in `src/core/driver/types.ts`:

| Port | Job |
| --- | --- |
| `ordering`, `capabilities` | Required: `'nonce'`, `'seqno'`, `'inputs'` or `'expiry'`, and the capabilities the driver really has |
| `address` | `validate`, `normalize` (throw `INVALID_ADDRESS`), `fromPublicKey` |
| `reader` | balance, block height, finalized height, blocks, transactions, `observe(ref)` |
| `builder` | `estimateFee`, `checkFunds`, `build` (an `UnsignedTx` with signing requests), `assemble` |
| `broadcaster` | `broadcast` → `accepted`, `already-known`, `refused` (may still land) or `rejected` (never valid) |
| `proofs` | finalized-state checks behind `proven` verdicts, including `blockHash(height, level)` |
| `sequence?` | pending and latest nonce or seqno (`nonce` and `seqno` ordering) |
| `replacement?` | the `replace` and `cancel` booleans, `buildReplacement`, `buildCancel` (capabilities `replace-fee`, `cancel`) |
| `blocks?`, `history?` | block source for the scanner (`block-scan`), indexer history (`address-history`) |
| `ext?`, `limits?`, `createNativeClient?`, `close?` | family extras, output limits, the native client, cleanup |

The JSDoc of `ChainDriver` holds the **per-method contract table**: the request purpose, the
retry class, the quorum and the throw rules for each method. Follow it exactly. The core
relies on these rules most:

- **No keys, no tenant state.** Drivers never sign and are shared across tenants. Cache only
  immutable chain data, such as token metadata.
- **All I/O goes through `ctx.transport`** (`rpc`, `rpcRaw`, `http`, or `createFetch` for an
  SDK, which only sees `PLACEHOLDER_ORIGIN`). Call `transport.setProbes(...)` exactly once in
  `create()`, before any traffic, on every transport you receive. Set an identity probe that
  matches `network.identity`, and a height probe.
- **Tag reads.** Heights, `observe`, `sequence` and block sources use `purpose: 'monitor'`.
  The `proofs` methods use `purpose: 'proof'` and `quorum: 'proof'`; the table names the one
  exception. When endpoints disagree, the transport throws a retryable
  `PROVIDER_INCONSISTENT`, and the core decides nothing.
- **A proof says "no" only on a definitive negative.** On a proof path (`proofs.*`), only a
  definitive negative proof may answer "no" (`included: false`, a slot not consumed, a
  `null` block hash). Every other RPC error, including state or history not available,
  pruned data, an index still being built, or an endpoint's non-definitive error, must throw
  a retryable `ProviderError('PROVIDER_UNAVAILABLE')`, which decides nothing.
- **Broadcast is `ambiguous-on-failure`.** Classify a node's answer only when the error is
  not ambiguous. Rethrow an ambiguous `RPC_ERROR` unclassified, even if it reads like "nonce
  too low". Keep refusal reasons short and address-free.
- **Block sources.** Heights are dense (use block height, not a slot number). Serve headers
  at least about 2 × `reorgWindow` below the head. `filter.addresses: []` means no filter.
  `filter.assets` is only a hint.
- **Replacements.** Honour `buildCancel`'s `fee`. Never set or read `fee.details.requestedFee`,
  which the core reserves.
- **Native client.** `createNativeClient()` returns `{ client, close? }`, with a **fresh** SDK
  instance on every call. `CryptoAio.close()` calls `close`.
- Amounts reach drivers in base units only. `DriverContext` has no asset resolver, and
  `DriverIntent` carries no decimals. This is still open and may change.
- **Wallet options.** `BuildContext.wallet`, `limits(wallet)` and `address.fromPublicKey`'s
  `options` (when the core resolves a wallet or derives from its `xpub`) carry the wallet's
  `options`, its family settings (`utxo`, `ton`) and, when it has an `xpub`,
  `hd: { xpub, xpubPath?, xpubVersions? }` (`WalletHdOptions`, always a readable public
  extended key). `hd` is always the core's: neither a wallet's own `options.hd` nor the
  `options` a caller passes to `Blockchain.addressFromPublicKey` bring an `hd` to a
  driver. The core does not check `hd` against the network class when it resolves the
  wallet: a UTXO driver passes `{ testnet }` to `deriveXpubChild` when it derives from it.
- **Exact integers.** Pass `exactIntegers: true` on a read whose JSON answer carries amounts
  as numbers: integers beyond 2^53 − 1 then arrive as `bigint`, and a quorum compares them
  exactly.
- **Output variants.** `DriverIntent.outputs[i].variant` is the recipient address's
  `variant` (for example TON's bounce flag) when it has one; it is part of the intent hash.
  Your codec's `normalize` must return a variant of JSON scalars only (strings, finite
  numbers, booleans, `null`) under string keys: anything else fails the transfer with
  `INVALID_ADDRESS`.
- **Failure reasons.** With `success: false`, `observe` and `includedFinal` may return a
  short fixed `reason` (no addresses or amounts); the core shows it as `TxStatus.reason`.
- **Signed payloads.** The optional `builder.signaturesFrom(unsigned, signed)` lets
  `submitSignatures` take a whole transaction signed elsewhere. Return only its signatures,
  with no I/O, and throw `INVALID_INTENT` when it is not the prepared transaction.

## Testing an adapter or a store

The testing kit makes everything deterministic and network-free:

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

Every store must pass the contract suites. They take your framework's `describe` and `it`,
so they run under Jest, Vitest or `node:test`. Each `create()` must return a fresh, empty
store, such as a new schema or key prefix per test:

```ts
import {
  describeCursorStoreContract, describeLockManagerContract,
  describeOperationStoreContract, describeSequenceStoreContract,
} from 'crypto-aio/testing';

const api = { describe, it };
describeOperationStoreContract(api, async () => ({ operations: await pgOperations(), advance: sleep }));
describeLockManagerContract(api, async () => ({ locks: await redisLocks(), advance: sleep }));
describeSequenceStoreContract(api, async () => ({ sequences: await redisSequences() }));
describeCursorStoreContract(api, async () => ({ cursors: await pgCursors() }));
```

`advance(ms)` moves the store's notion of time forward: a fake clock, or a real sleep. The
suites include stale-worker cases. A worker pauses, its lease expires, another takes over,
and the stale write must fail with `FENCING` or `VERSION_CONFLICT`. crypto-aio ships only the
store ports, the in-memory stores and these suites. Durable stores, such as Redis or
Postgres, are yours to write, and the suites define what they must do.

One expectation reaches beyond the suites, which test one store instance: `findByRef` is
read-your-writes consistent across every process that shares the store. It sees any
`appendAttempt` another instance committed before the call, so no read replica or
eventually consistent index may serve it. The guard that stops two Operations from
recording the same transaction relies on it. Its guarantee also assumes that `appendAttempt`
completes within `lifecycle.leaseMs`, since the ref lease is not renewed. A slower store
weakens it.

Every Attempt's `ordering` must also read back whole and unchanged, whatever its kind, with
every property the driver put in it and its type, and so must an Operation's `reservation`.
The operation-store suite checks one ordering of each built-in family, with bigints beyond
2^53 (`SAMPLE_ORDERINGS` in `crypto-aio/testing`), after the append and after a later
write. A Tron Attempt's ordering is a `TronExpiryOrdering`: the core `expiry` ordering,
with `expiresAtMs` and its optional `lastValidHeight` (a bigint), which Tron always sets to
the reference block's height plus 65,536, plus `refBlockHash`, the reference block bytes the
transaction signs. The expiry proof reads them from the store, not from the signed bytes, to
find every block that could hold the transaction, so keeping them exact is a safety
precondition, not only a liveness one. A lost `refBlockHash` or `lastValidHeight` only stalls
the proof, but a changed one of either (a `lastValidHeight` with other low 16 bits makes the
proof search the wrong heights), or an `expiresAtMs` rounded down (to whole seconds, say),
can prove a transaction `expired` although a block holds it, and `rebuild` then pays twice.
A prepared transfer whose stored ordering changed cannot be signed (`SIGNING_FAILED`).

A Solana Attempt's ordering is a `SolanaExpiryOrdering`: `kind: 'expiry'` and
`lastValidHeight` (a bigint), plus `blockhash` (base58 text) and `blockhashSlot` (a
bigint), all recorded by the build. The expiry proof reads them from the store, not from
the signed bytes, to find every block that could hold the transaction, so keeping them
exact is a safety precondition, not only a liveness one. A lost or unreadable property at
worst leaves the Attempt undecided, never `expired`, so `rebuild` stays refused. But a
changed `blockhash` misplaces the window: the proof can then find the transaction absent
from blocks that could never hold it and prove it `expired` although it landed, and
`rebuild` then pays twice.

A TON Attempt's ordering is a `TonSeqnoOrdering`: `kind: 'seqno'` and `seqno` (a bigint),
plus `validUntil`, the chain time in seconds at which the message expires, and `validFrom`,
the chain time the build ran at, both numbers. The proofs read all three from the store,
not from the signed bytes, so keeping them exact is a safety precondition, not only a
liveness one. A lost `validFrom` only costs time, but a changed seqno, or a `validUntil`
changed or rounded down, can prove a transfer that landed `expired` or `replaced`, and a
`validFrom` moved later hides a wallet reset that happened before it; either way `rebuild`
then pays twice ([TON networks](#ton-networks)).

Never store a key set to `undefined` as a value, such as `NULL`, whether it is in an
`OperationStore` patch or in an observation:

- In an `update` or `appendAttempt` patch, the stored field keeps its value. Only `clear`
  removes a field.
- `putObservation` replaces the whole observation, so a field that is left out or set to
  `undefined` reads back `undefined` (never `null`). The core relies on this to clear a
  stale failure reason or an orphaned block.

## What is stable before 1.0

crypto-aio is pre-1.0 (`0.x`). Breaking changes can happen in a minor release, and they are
listed in the changelog. Recent changes are an example: `Transfer` became a union
with an unresolved-asset variant, `TERMINAL_STATES` became an array, and `Scanner` became a
type-only export (get a scanner from `bc.scanner()`).

| Surface | Expectation |
| --- | --- |
| Handle and container API, configuration shape, `Amount` / `Address` / asset model, error codes, event names and payloads, store ports and their contract suites | Intended to stay; changes only for real-adapter findings |
| Driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverContext` | **Likely to change** while real families are added. It changed recently (`ProofSource.blockHash`, `createNativeClient` returning `{ client, close? }`) and has open questions, such as how drivers get token decimals |
| Family `ext` APIs and fee override shapes | Defined by each family's adapter |
| `crypto-aio/testing` | Public and documented; the fake chain's wire protocol is not an API |
| `crypto-aio/native` | **Outside semver.** The SDK's API is the SDK's |
