---
title: Glossary
description: Every blockchain, engineering and crypto-aio term these pages use, defined in a sentence or two, with a link to where it is explained.
---

# Glossary

Every term these pages use, in a sentence or two, with a link to the page that explains it.
Blockchain and engineering terms link to the [learning path](../learn/index.md); crypto-aio's own
terms link to [Core concepts](./concepts.md) or the [Developer tour](../tour/index.md).

[A](#a) · [B](#b) · [C](#c) · [D](#d) · [E](#e) · [F](#f) · [G](#g) · [H](#h) · [I](#i) ·
[J](#j) · [K](#k) · [L](#l) · [M](#m) · [N](#n) · [O](#o) · [P](#p) · [Q](#q) · [R](#r) · [S](#s) ·
[T](#t) · [U](#u) · [V](#v) · [W](#w) · [X](#x)

## A

### Account model

Keeping a balance per address, as Ethereum, Tron, Solana and TON do. Compare
[UTXO](#utxo). [Lesson 7](../learn/foundations/ordering.md).

### Address

A shareable name for an account, computed from a public key in a format each chain defines. In
crypto-aio, an `Address` object has a `canonical` and a `display` form.
[Lesson 3](../learn/foundations/wallets.md).

### Address lease

A short, renewable lock on one sending address, held while an ordering slot is reserved and
signed, so concurrent transfers get distinct nonces. [Stop 5](../tour/ordering.md).

### Ambiguous

An error after which nobody can know whether the action happened, such as a lost reply to a
broadcast. `error.ambiguous === true`: retry with the same idempotency key, never a new one.
[Lesson 10](../learn/engineering/failure.md).

### API key

A secret that identifies your account with a provider; often part of the endpoint URL. Wrap it
in `secret()`. [Lesson 9](../learn/foundations/nodes.md).

### Archive node

A node that keeps the chain's state at every past block, needed for some historical proofs.
[Lesson 9](../learn/foundations/nodes.md).

### Asset, asset id

What a transfer moves: a native coin or a token. An asset id such as
`ethereum:mainnet/erc20:0x…` names it on one chain and network.
[Lesson 4](../learn/foundations/assets.md).

### At-least-once delivery

Retrying until acknowledged, so a message may arrive twice; safe with idempotent processing.
Scanners deliver blocks this way. [Lesson 11](../learn/engineering/idempotency.md).

### Attempt

One signed transaction for an Operation, stored before it is broadcast and never changed.
Replacements, cancels and rebuilds add Attempts. [Stop 3](../tour/transfer.md).

## B

### Backoff

Waiting longer between each retry (200 ms, 400 ms, 800 ms, …), with some randomness (jitter).
[Lesson 10](../learn/engineering/failure.md).

### Bandwidth, energy

Tron's resources: bandwidth pays for a transaction's size, energy for contract execution, either
from staked TRX or burned TRX. [Tron networks](./networks/tron.md).

### Base fee

The part of an EIP-1559 fee set by the protocol from recent demand, and burned.
[Lesson 8](../learn/foundations/fees.md).

### Base unit

An asset's smallest unit (satoshi, wei, lamport, sun, nanogram). Amounts are whole numbers of
base units. [Lesson 4](../learn/foundations/assets.md).

### Batch transfer

One transaction that pays several outputs, on chains with the `batch-transfer` capability.
[Send a transfer](../build/send.md).

### BIP32, BIP39, BIP44

Bitcoin standards reused across chains: hierarchical key derivation, mnemonic phrases, and the
`m/44'/coin'/account'/change/index` path layout. [Lesson 3](../learn/foundations/wallets.md).

### Block, block height, block hash

A batch of transactions with a header; its position in the chain; the hash that identifies it
and that the next block links to. [Lesson 6](../learn/foundations/blocks.md).

### Broadcast

Sending a signed transaction's raw bytes to a node, which passes it to the network.
[Lesson 5](../learn/foundations/transactions.md).

## C

### Capability

A named feature a handle may have, such as `tokens` or `replace-fee`; `bc.supports(name)`.
[Capabilities](./capabilities.md).

### Chain, network, library

A blockchain (`ethereum`), one of its deployments (`mainnet`, `sepolia`), and the SDK used for it
(`ethers`). A handle is bound to one of each. [Core concepts](./concepts.md#chain-network-and-library).

### Chain family

Chains that share a design and a driver, such as the EVM family.
[Stop 2](../tour/families.md).

### Chain id

A number that identifies an EVM network (1 for Ethereum mainnet), signed into every transaction
so it cannot be replayed on another chain. [Lesson 5](../learn/foundations/transactions.md).

### Change

The output of a UTXO transaction that returns the remainder to the sender.
[Lesson 7](../learn/foundations/ordering.md).

### Circuit breaker

Stops sending to a failing endpoint for a while (`failureThreshold`, `openMs`).
[Lesson 10](../learn/engineering/failure.md).

### Claim

A worker's expiring, fenced lease on one Operation. [Stop 4](../tour/recovery.md).

### Coin selection

Choosing which UTXOs a transaction spends. [Lesson 7](../learn/foundations/ordering.md).

### Cold wallet

Keys kept offline, signing by hand. [Lesson 3](../learn/foundations/wallets.md).

### Confirmations

The blocks on top of a transaction's block, its own included.
[Lesson 6](../learn/foundations/blocks.md).

### Consensus

How a network's nodes agree on one history: proof of work, proof of stake, and others.
[Lesson 6](../learn/foundations/blocks.md).

### Container

`CryptoAio`: owns configuration, stores, signers, hooks, plugins, the driver pool and events. One
per tenant. [Stop 1](../tour/architecture.md).

### Contract suites

Tests from `crypto-aio/testing` that a store implementation must pass.
[Write a durable store](../explore/stores.md).

### Cursor

A scanner's durable position, moved only when you `ack()` an event.
[Stop 7](../tour/receiving.md).

### Custody

How and where private keys are held and used: hot wallets, HSMs, KMS, MPC, cold storage.
[Lesson 15](../learn/engineering/secrets.md).

## D

### Decimals

How many digits of an asset's amount sit after the decimal point.
[Lesson 4](../learn/foundations/assets.md).

### Deposit

A transfer to one of your addresses, made by someone else; read, not proven.
[Receive deposits](../build/receive.md).

### Derivation path

The path in an HD key tree that picks one key, such as `m/44'/60'/0'/0/0`.
[Lesson 3](../learn/foundations/wallets.md).

### Double spend

Spending the same money twice; what a ledger, and finality, exist to prevent.
[Lesson 1](../learn/foundations/ledgers.md).

### Driver

The code that speaks one chain family's language, behind the core's ports. Loaded on first use.
[Stop 2](../tour/families.md).

### Dropped

A transaction no healthy endpoint has seen for a while. Never terminal: the workers resend it.
[Stop 4](../tour/recovery.md).

## E

### ECDSA, Schnorr, EdDSA

Signature algorithms: ECDSA and Schnorr on secp256k1 (Bitcoin, EVM, Tron), EdDSA on ed25519
(Solana, TON). [Lesson 2](../learn/foundations/cryptography.md).

### EIP-1559

Ethereum's fee design: a protocol base fee plus a priority tip, capped by a maximum fee per gas.
[Lesson 8](../learn/foundations/fees.md).

### Endpoint

One URL of a provider: an RPC node or an indexer. [Lesson 9](../learn/foundations/nodes.md).

### ERC-20, TRC-20, SPL, jetton

The token standards of the EVM chains, Tron, Solana and TON.
[Lesson 4](../learn/foundations/assets.md).

### Esplora

The REST API, run by mempool.space, blockstream.info or yourself, that the Bitcoin family reads.
[Bitcoin networks](./networks/bitcoin.md).

### Evidence

What a status rests on: `observed` (one endpoint's view) or `proven` (finalized data, agreed by a
quorum). [Stop 6](../tour/evidence.md).

### EVM

The Ethereum Virtual Machine, and the family of chains that share its design: Ethereum, BNB Smart
Chain, Polygon, the Avalanche C-Chain, Arbitrum, Optimism, Base. [EVM networks](./networks/evm.md).

### Expiry

A deadline after which a transaction can never land (Tron, Solana); proven expiry lets
`rebuild` re-issue it. [Lesson 7](../learn/foundations/ordering.md).

### Extended public key (xpub)

See [xpub](#xpub).

## F

### Fee market

Competition for block space that sets the fee needed to be included soon.
[Lesson 8](../learn/foundations/fees.md).

### Fencing token

A number that grows with every new lease; storage refuses writes that carry an older one.
`FENCING`. [Lesson 13](../learn/engineering/concurrency.md).

### Finality, final

The point after which a transaction can never be undone: probabilistic (deep enough) or
deterministic (finalized). [Lesson 6](../learn/foundations/blocks.md).

### Finalized tag

An EVM block tag that names the newest finalized block (`finality-tag`).
[EVM networks](./networks/evm.md).

## G

### Gas, gas limit

A unit of EVM computation; the most a transaction may use. A failed call still pays its gas.
[Lesson 8](../learn/foundations/fees.md).

### Genesis block

The first block of a chain; its hash identifies the network.
[Lesson 6](../learn/foundations/blocks.md).

## H

### Handle

`Blockchain`: an immutable object bound to one chain, network, library, provider set and wallet,
that you call methods on. [Stop 1](../tour/architecture.md).

### Hash

A fixed-size fingerprint of data: deterministic and one-way.
[Lesson 2](../learn/foundations/cryptography.md).

### HD wallet

A hierarchical deterministic wallet: a tree of keys derived from one secret.
[Lesson 3](../learn/foundations/wallets.md).

### Hot wallet

Keys on an online server, for automatic payouts. [Lesson 3](../learn/foundations/wallets.md).

### HSM, KMS

A hardware security module, or a cloud key management service: signs on request, never exports
the key. [Lesson 15](../learn/engineering/secrets.md).

## I

### Idempotency, idempotency key

Doing something twice has the effect of doing it once; the caller's unique id for one payment
that makes retries safe. [Lesson 11](../learn/engineering/idempotency.md).

### Included

In a block, but not final yet. [Lesson 6](../learn/foundations/blocks.md).

### Indexer

A service that answers history questions (an address's transactions) from its own database.
[Lesson 9](../learn/foundations/nodes.md).

### Intent, intentHash

What you want to happen (`{ to, amount, … }`); a hash of its normalized form, compared when an
idempotency key repeats. [Lesson 11](../learn/engineering/idempotency.md).

## J

### JSON-RPC

A protocol for calling a server's named methods with JSON, used by EVM and Solana nodes.
[Lesson 9](../learn/foundations/nodes.md).

## K

### Key pair

A private key and the public key computed from it. [Lesson 2](../learn/foundations/cryptography.md).

## L

### Lagging endpoint

An endpoint more than `maxLagBlocks` behind the best known height; it decides nothing.
[Lesson 14](../learn/engineering/trust.md).

### Lease

A lock that expires unless renewed. [Lesson 13](../learn/engineering/concurrency.md).

### Ledger

A record of accounts, balances and every change. [Lesson 1](../learn/foundations/ledgers.md).

## M

### Mainnet, testnet

The network with real money; a network with free coins for testing.
[Lesson 1](../learn/foundations/ledgers.md).

### Masterchain

TON's coordinating chain; a transaction is final once a masterchain block includes it.
[TON networks](./networks/ton.md).

### Memo

A public note attached to a transaction, on chains with the `memo` capability.
[Lesson 5](../learn/foundations/transactions.md).

### Mempool

Where valid transactions wait until a block includes them.
[Lesson 5](../learn/foundations/transactions.md).

### Mnemonic

Words that encode the master secret of an HD wallet (BIP39).
[Lesson 3](../learn/foundations/wallets.md).

### MPC, multisig

Signing that needs several parties (multi-party computation) or several keys.
[Lesson 15](../learn/engineering/secrets.md).

## N

### Namespace

A container's prefix for every store key; one per tenant. [Configuration](./configuration.md).

### Native coin

The coin a chain's own rules count, which also pays its fees: ETH, BTC, TRX, SOL, Gram, AVAX.
[Lesson 4](../learn/foundations/assets.md).

### Node

A server that runs a chain's software and keeps a copy of its ledger.
[Lesson 9](../learn/foundations/nodes.md).

### Nonce, nonce gap

An account's transaction counter (EVM); a missing nonce that blocks later transactions
(`nonce.gap`). [Lesson 7](../learn/foundations/ordering.md).

## O

### Observed

Evidence from one endpoint's current view; it can change. [Stop 6](../tour/evidence.md).

### Operation

One payment as a stored business record, unique per idempotency key, with a state and an
outcome. [Stop 3](../tour/transfer.md).

### Ordering slot

What orders a wallet's transactions: a nonce, a seqno, a set of inputs or an expiry. Reserved
per Operation. [Stop 5](../tour/ordering.md).

## P

### Plugin

SDK-free data that adds chains, networks, assets, presets and adapters.
[Write a chain family plugin](../explore/plugins.md).

### Preset

A provider recipe, such as `alchemy` or `trongrid`, that turns an API key into endpoints.
[Networks](./networks/index.md#provider-presets).

### Priority fee (tip)

The part of a fee that goes to the block producer. [Lesson 8](../learn/foundations/fees.md).

### Private key, public key

The secret that controls funds; the shareable key computed from it.
[Lesson 2](../learn/foundations/cryptography.md).

### Proof quorum, proven

The number of endpoints that must agree on a proof read (`proofQuorum`, 2); evidence from
finalized data under that quorum. [Stop 6](../tour/evidence.md).

### Provider

A named set of endpoints: a preset with a key, or your own URLs.
[Lesson 9](../learn/foundations/nodes.md).

### PSBT

A partially signed Bitcoin transaction: the format hardware wallets sign.
[Cold and asynchronous signing](../build/cold-signing.md).

## Q

### Quorum read

A read accepted only when enough independent endpoints agree.
[Lesson 14](../learn/engineering/trust.md).

## R

### Rate limit

A cap on how many requests a client may send; `429 Too Many Requests` when exceeded.
[Lesson 9](../learn/foundations/nodes.md).

### Raw transaction

A signed transaction's bytes, ready to broadcast. [Lesson 5](../learn/foundations/transactions.md).

### Rebroadcast, replace, cancel, rebuild

Resend the same bytes; a new Attempt in the same slot with a higher fee; a conflicting
self-transfer; re-issue after proven expiry. [Fix a stuck transfer](../build/stalled.md).

### Receipt

An EVM transaction's result: success or failure, and the events it logged.
[Lesson 6](../learn/foundations/blocks.md).

### Recovery

`aio.operations.recover()`: finishing in-flight work after a restart, without signing.
[Stop 4](../tour/recovery.md).

### Redaction

Replacing a secret with `[REDACTED]` before any output. [Lesson 15](../learn/engineering/secrets.md).

### Reorg, reorg window, rollback

The network replacing its newest blocks; how many blocks a scanner keeps to detect it; the
scanner event that reports it. [Lesson 6](../learn/foundations/blocks.md),
[Stop 7](../tour/receiving.md).

### Retry class

How a request may be retried: `safe`, `ambiguous-on-failure` or `never-auto`.
[Stop 6](../tour/evidence.md).

### RPC

A remote procedure call: calling a server's named method over the network.
[Lesson 9](../learn/foundations/nodes.md).

## S

### sat/vB

Satoshis per virtual byte: Bitcoin's fee rate. [Lesson 8](../learn/foundations/fees.md).

### Scanner

`bc.scanner()`: reads blocks in order for deposits, with a durable cursor and rollbacks.
[Stop 7](../tour/receiving.md).

### Scope

`aio.scope()`: inherits and overrides a container's configuration, sharing its stores; not a
tenant boundary. [Stop 1](../tour/architecture.md).

### Secret

A value whose disclosure causes harm; in crypto-aio, a `Secret` wrapper that prints as
`[REDACTED]`. [Lesson 15](../learn/engineering/secrets.md).

### secp256k1, ed25519

The two elliptic curves in use: secp256k1 for Bitcoin, EVM, Tron and Avalanche; ed25519 for
Solana and TON. [Lesson 2](../learn/foundations/cryptography.md).

### Seqno

A TON wallet contract's message counter. [Lesson 7](../learn/foundations/ordering.md).

### Signature, signature scheme

Proof that a private key approved one exact message; the exact recipe a chain expects
(`secp256k1-ecdsa`, `secp256k1-schnorr`, `ed25519`). [Lesson 2](../learn/foundations/cryptography.md).

### Signer, signing request

The only place keys live (`localSigner`, `callbackSigner`); what the library asks it to sign.
[Stop 8](../tour/keys.md).

### Smart contract

A program stored and run on a blockchain. [Lesson 4](../learn/foundations/assets.md).

### Solidified

Tron's finalized block, about 19 blocks below the head. [Tron networks](./networks/tron.md).

### Stalled

An Operation a node refused, whose bytes may still land. Not a failure: rebroadcast, replace or
cancel it. [Fix a stuck transfer](../build/stalled.md).

### Stores

`OperationStore`, `LockManager`, `SequenceStore` and `CursorStore`: where crypto-aio keeps its
state. [Write a durable store](../explore/stores.md).

## T

### Timeout

The deadline after which a client stops waiting. [Lesson 10](../learn/engineering/failure.md).

### Token

A balance kept by a smart contract. [Lesson 4](../learn/foundations/assets.md).

### Transaction, transaction hash

A signed instruction to change the ledger; its id, usually the hash of its signed bytes.
[Lesson 5](../learn/foundations/transactions.md).

### Transport

crypto-aio's own HTTP layer under every driver: timeouts, retries, rate limits, health checks,
quorum reads, redaction. [Stop 6](../tour/evidence.md).

## U

### UTXO

An unspent transaction output: a coin on a UTXO chain (Bitcoin, the Avalanche X-Chain and
P-Chain), spent whole as an input. [Lesson 7](../learn/foundations/ordering.md).

## V

### Version (optimistic concurrency)

A number on each stored record; an update that expects an older one fails
(`VERSION_CONFLICT`). [Lesson 12](../learn/engineering/persistence.md).

## W

### Wallet

Whatever holds the keys that sign for an account. In crypto-aio, a named configuration that says
which key sends. [Lesson 3](../learn/foundations/wallets.md).

### Watch-only

A wallet with public information only: it reads, and with a `publicKey` it can prepare unsigned
transactions, but it never signs.
[Lesson 3](../learn/foundations/wallets.md).

### Wei, satoshi, lamport, sun, nanogram

The base units of ETH, BTC, SOL, TRX and Gram. [Lesson 4](../learn/foundations/assets.md).

### Workers

Background loops (`aio.monitor.start()`) that follow every Operation to a verdict.
[Stop 4](../tour/recovery.md).

### Write-ahead

Recording an intended change durably before acting on it; crypto-aio stores each signed
transaction before broadcasting it. [Lesson 12](../learn/engineering/persistence.md).

## X

### X-Chain, P-Chain, C-Chain

Avalanche's exchange chain (UTXO), platform chain (UTXO, staking) and contract chain (EVM).
[Avalanche X-Chain and P-Chain](./networks/avalanche.md).

### xpub

An extended public key: derives child addresses without any private key.
[Lesson 3](../learn/foundations/wallets.md).
