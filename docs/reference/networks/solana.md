---
title: Solana networks
description: "Solana: priority fees, SPL tokens, expiry, scanning, history and safeguards."
---

# Solana networks

The Solana family serves the `solana` chain on three clusters with `@solana/web3.js` (v1),
installed next to crypto-aio: `npm install @solana/web3.js`. A transfer moves SOL or one
classic SPL token to one recipient, with an optional memo. The driver sends every request
itself, through the handle's transport; the SDK only derives token account addresses,
compiles messages and backs `native()`.
[Configuring a real network (Solana)](../../build/connect.md#solana)
shows a configuration.

**Solana needs Node.js 22.12 or later.** `@solana/web3.js` 1.99 depends, through
`rpc-websockets`, on an ESM-only `uuid`, which `require` can load only from Node 22.12. On
Node 22.0 to 22.11, the first use of a Solana handle (`ready()`, a read or `native()`)
fails with Node's own `ERR_REQUIRE_ESM`, not with `DEPENDENCY_MISSING`. The rest of
crypto-aio needs Node 22.

**A harmless install warning.** Installing `@solana/web3.js` can warn of an unmet peer
`utf-8-validate@^5`: its `jayson` depends on `ws` 7, whose optional helper is
`utf-8-validate` 5, while `ws` 8 elsewhere in the tree brings 6. Ignore it. `ws` runs
without that helper, and the driver sends every request through the handle's transport,
never over a WebSocket.

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
  `ctx.fee` in your `beforeSign` hook ([Solana safeguards](#solana-safeguards))
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
  ([what to do](../errors.md#what-to-do-about-each-error)). The common case is
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
  and `bc.getBlock()` takes a height (a hash is `UNSUPPORTED_CAPABILITY`). The driver
  finds a height's slot by counting back from the head with `getBlocks`, at most about 8
  million slots (about five weeks) deep: an older height, in `getBlock()` or as a scan's
  start, fails with a retryable `PROVIDER_UNAVAILABLE`.
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
  existing token account appears in that account's history, not the owner's. Behind a
  load-balanced URL, a backend that does not hold a page's cursor answers `-32020`, and
  the page fails with a retryable `PROVIDER_UNAVAILABLE`: ask again. A handle's
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
  ([why](../../explore/stores.md)).
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

## Solana safeguards

On Solana, one endpoint's answers set a transfer's price and compute limit, and a proof
decides whether a transfer can be sent again. The driver's guards:

- **Priority fee.** The compute-unit price is at most
  `chains.solana.options.maxComputeUnitPrice` (10,000,000 micro-lamports per compute unit by
  default, `DEFAULT_MAX_COMPUTE_UNIT_PRICE`), which no endpoint can raise. A speed is
  clamped below it, an override above it fails with `INVALID_INTENT` before signing (naming
  the option, with `details.required` and `details.maxComputeUnitPrice`), and the build
  checks it again. With the limit at its 1,400,000-unit maximum, the default bound caps a
  transfer's priority fee at 0.014 SOL, so one lying endpoint cannot spend the wallet. Any
  other key in `chains.solana.options` fails with `CONFIG_INVALID`. For a tighter policy per
  transfer, compare `ctx.fee` in `beforeSign`.
- **Proof providers.** A proof that a transfer never landed is what lets `rebuild` sign a
  new one, so a wrong one pays twice. Each proof is a quorum over your endpoints: use two or
  three independent keyed or self-hosted providers. The `public` preset's rate limits let it
  prove absence only slowly, over many passes, so a transfer that never landed stays
  unresolved for minutes there.
- **A refusal is not a failure.** A `stalled` transfer (`TX_REFUSED`, `INSUFFICIENT_FUNDS`)
  may still land until its blockhash's window has passed. Retry only with
  `bc.rebroadcast(id)` or by repeating the call with the same idempotency key, never as a
  new transfer. A node's claim that the signature is invalid ends a transfer only when the
  driver confirms it for the bytes it sent.
- **Stores.** A custom `OperationStore` must keep each Attempt's `ordering` whole and
  unmodified, `blockhash` included: a changed blockhash misplaces the expiry proof's window
  ([why](../../explore/stores.md)).
- **The native client.** `native(bc, '@solana/web3.js')` returns a `Connection` wired to the
  handle's transport, so it never sees the real URL or key. It speaks HTTP JSON-RPC only
  (no subscriptions), and it parses numbers itself, so values above 2^53 are rounded there;
  the driver's own reads keep u64 amounts exact. Import `crypto-aio/solana` once to type it;
  with `skipLibCheck: false`, that needs `@solana/web3.js` installed.

The sections above give the defaults, how a refused
transfer resolves, and which addresses a scan filter matches.
