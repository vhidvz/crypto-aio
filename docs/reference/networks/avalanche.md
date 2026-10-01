---
title: Avalanche X-Chain and P-Chain
description: "The Avalanche X-Chain and P-Chain: fees, spending, finality and limits."
---

# Avalanche X-Chain and P-Chain networks

The Avalanche family serves the primary network's two UTXO chains through
`@avalabs/avalanchejs` 5 (`npm install @avalabs/avalanchejs`): `avalanche-x`, the X-Chain
(AVM), and `avalanche-p`, the P-Chain (PlatformVM), each on `mainnet` (the default) and
`fuji`. The C-Chain is an EVM chain: it stays `avalanche`, in the EVM family. AVAX has 9
decimals here (a `bigint` amount is in nAVAX), not the C-Chain's 18.

| Chain | Networks (network id) | Fees | Memo | Address |
| --- | --- | --- | --- | --- |
| `avalanche-x` | `mainnet` (1), `fuji` (5) | fixed, 0.001 AVAX per transaction (`avm.getTxFee`) | yes, up to 256 bytes | `X-avax1…`, `X-fuji1…` |
| `avalanche-p` | `mainnet` (1), `fuji` (5) | dynamic gas price (Etna) | no (refused since Durango) | `P-avax1…`, `P-fuji1…` |

- **A provider and an indexer.** `provider` is a node's chain API, JSON-RPC at the chain's
  own URL (`https://node.example/ext/bc/X`, `…/ext/bc/P`). AvalancheGo says whether a
  transaction is accepted but not which block holds it, so the **Avalanche Data API** is the
  required `indexer`: it locates a transaction's block, which the node then proves under
  the proof quorum, and it serves `history`. A transaction the indexer does not know yet is
  looked for in the node's newest 16 blocks. `public` names Ava Labs' public API and the
  keyless Data API, for trying things out, not for production; `glacier` is the Data API
  with an `apiKey`, sent in the `x-glacier-api-key` header as a `Secret`. Every endpoint's
  health check reads the id of the chain's block at height 0, so an endpoint of another
  network or chain is refused.
- **Finality.** Snowman never reverts an accepted block: a transaction in an accepted block
  is final (`finality: 1 confirmation`), and `waitForConfirmation` proves it as soon as it
  is accepted. The X-Chain shows no mempool, so an issued transaction reads as not seen
  until it is accepted, usually within seconds.
- **Spending.** A transfer spends plain AVAX outputs the wallet signs alone (threshold 1, no
  lock), largest first, at most 128 per transaction, with change back to the sending
  address; the balance counts those outputs only (stake-locked, time-locked and multi-owner
  outputs are listed by `ext.avalanche.listUnspent`, not spent). Outputs held by another live
  Operation are left out. Every input is signed with the same secp256k1 signature, over the
  SHA-256 of the unsigned transaction; the id is known only after signing.
- **Fees.** The X-Chain fee is read under the proof quorum and every speed pays it. The
  P-Chain fee is the transaction's gas times a gas price: the endpoint's current price times
  1.1 (`slow`), 1.5 (`normal`) or 2 (`fast`), or `{ gasPrice }` (nAVAX per gas). Two options
  bound them: `options.maxFee` (default 0.1 AVAX) and, on the P-Chain, `options.maxGasPrice`
  (default 10,000). A P-Chain transaction that burns less than the price at the time it is
  verified is refused (`FEE_TOO_LOW`) and stays `stalled` until the price falls and it is
  sent again.
- **No replace or cancel.** AvalancheGo keeps the first of two conflicting transactions,
  and an accepted one is final.
- **Broadcasts.** A node's refusal never ends a transfer as `TX_REJECTED`: the driver checks
  every transaction before it is signed, so each refusal is `refused` (`FEE_TOO_LOW` or
  `TX_REFUSED`, with a fixed reason, never the node's text), and the transfer stalls with
  its inputs held, since the node may have relayed it. So one lying endpoint cannot free
  your outputs for a second payment. Never retry the payment as a new transfer (a new
  idempotency key): it spends other outputs, and both can be accepted. Repeat the call with
  the same key, or use `rebroadcast`; the transfer ends once a node accepts it, or `failed`
  (`TX_REPLACED`) once a transaction that spent one of its inputs is final.
- **Reading.** `getTransaction`, scans and history decode each plain AVAX output to one
  address as a transfer (`out:<index>`); the senders are the addresses the signatures
  recover to. An export, a staking or subnet transaction, a reward, an Avalanche native
  token or a multi-owner output makes the decoding `partial`. An X-Chain transaction
  accepted before the chain's linearization (April 2023) has no block and reads as not seen.
- **Keys.** The derivation path is BIP44's `m/44'/9000'/0'/0/i`. Avalanche wallets export an
  `xpub` on every network, so `deriveAddress` accepts one on Fuji too.
- **Not yet.** Avalanche native tokens (ANTs), cross-chain import and export, staking.
- **Live checks (this repository).** `CRYPTO_AIO_INTEGRATION=1` runs the read-only checks in
  `test/integration/avalanche.test.ts` against Fuji (`CRYPTO_AIO_IT_AVALANCHE_NETWORK=mainnet`
  for mainnet); `CRYPTO_AIO_IT_AVALANCHE_{X,P}_RPC_URL` and `…_INDEXER_URL` point them at
  other endpoints.
