---
title: Bitcoin networks
description: "Bitcoin: address types, coin selection, fees, replace and cancel, limits and safeguards."
---

# Bitcoin networks

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
  [security](#bitcoin-safeguards)). `bc.deriveAddress(wallet, index)` derives
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
  least 1 sat/vB (`FEE_TOO_LOW` below). That floor is Bitcoin Core's minimum relay fee
  before v30, which relays from 0.1 sat/vB: it keeps what the library builds relayable by
  older nodes, so no lower rate is built. A built transaction's fee is `exact`
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
  [transactions](../../build/send.md)). `unsigned.expectedRef` is the txid, except on `p2pkh`,
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
  itself; keep it on for hardware signers, which the BIP143 fee attack targets. That
  hardware wallets accept a segwit v0 input carrying it is assumed, not tested on devices:
  if yours refuses such a PSBT, turn the option off. Turning it off makes PSBTs smaller. A
  `p2tr` input never carries it: a taproot signature commits to every input's amount.
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

## Bitcoin safeguards

On Bitcoin, a wrong fee or change address burns funds, and an Esplora endpoint is trusted
for what it reports. The driver's guards:

- **Absurd fees.** A fee above `options.maxFeeRate` (1,000 sat/vB) or `options.maxFee`
  (0.1 BTC) fails with `INVALID_INTENT`, on every transfer, replacement and cancel,
  explicit overrides included. A fee estimate above `options.maxEstimatedFeeRate`
  (200 sat/vB) is not trusted, so one endpoint cannot set an absurd rate.
- **Change address.** Every transaction's change goes to `wallet.utxo.changeAddress` when it
  is set, so it must be an address the wallet's own key or `xpub` derives. Any other
  address fails with `CONFIG_INVALID`. `wallet.utxo.allowExternalChangeAddress: true` lifts
  that check for a change address of another key, such as a cold wallet's. With it, a
  mistyped but valid address loses every change output, so set it only for an address you
  have verified. A cancel always pays back to the sending address.
- **Input values.** Before anything is signed, each new input's previous transaction must
  be in a block the proof endpoints attest (except the wallet's own sent transactions under
  `minInputConfirmations: 0`), and every input's value and script are checked against that
  transaction, whose bytes must hash to the input's txid. So the indexer can neither
  misstate what you spend nor invent a coin for you to spend. Keep `options.nonWitnessUtxo` on (the default)
  for hardware signers: each `p2pkh` and segwit v0 input then carries that transaction in
  the PSBT, so the signer can check the fee itself. A `p2tr` input never carries it; its
  signature commits to every input's amount.
- **Endpoints.** With a single Esplora endpoint as the `provider`, its operator alone decides
  finality and whether a transfer was replaced. Use two independent endpoints, ideally
  three. A node's claim that your transaction is invalid ends a transfer only when the
  driver confirms it for the bytes it sent, so a lying endpoint cannot free your coins for a
  second payment. It can still refuse to relay them, which several endpoints and
  `lifecycle.broadcastFanout` of 2 or more route around.

The sections above give the defaults and how a refused transfer resolves.
