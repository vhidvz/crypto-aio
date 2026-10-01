---
title: Capabilities
parent: Reference
nav_order: 5
description: What each capability means, and which chains have it.
---

# Capabilities

A **capability** is a named feature that a handle may or may not have. Generic code checks
`bc.supports(capability)` and adapts; a call that needs a missing capability throws
`UnsupportedCapabilityError` (`UNSUPPORTED_CAPABILITY`) before anything is stored.
[Chains, families and drivers](../tour/families.md#capabilities) explains where capabilities
come from.

## What each one means

| Capability | The handle can… | Used by |
| --- | --- | --- |
| `tokens` | Send and read tokens: ERC-20, TRC-20, SPL, jettons | `transfer({ asset })`, `getBalance(address, asset)` |
| `memo` | Attach a public memo or comment to a transfer | `transfer({ memo })` |
| `batch-transfer` | Pay several outputs in one transaction | `transfer({ outputs: [...] })` |
| `replace-fee` | Replace a pending transaction with a higher fee, in the same slot | `bc.replace(id, { fee })` |
| `cancel` | Cancel a pending transaction with a conflicting one | `bc.cancel(id)` |
| `expiry` | Prove a transaction expired, and re-issue it | `bc.rebuild(id)` |
| `block-scan` | Read blocks in order for deposits | `bc.scanner(…)` |
| `address-history` | List an address's transactions | `bc.history(address)` |
| `hd-public-derivation` | Derive addresses from an `xpub` | `bc.deriveAddress(wallet, index)` |
| `finality-tag` | Read finality from a `finalized` block tag rather than by depth | Verdicts and `mode: 'final'` scans |
| `fee-market-1559` | Price fees with an EIP-1559 base fee and tip | `estimateFee`, fee overrides |
| `contract-read` | Read contract state (reserved: no built-in family has it yet) | |

`KNOWN_CAPABILITIES` lists these names. A plugin may add its own.

## Which chains have which

Every network of a chain has the same capabilities. `test/docs/capabilities.test.ts` checks this
table against the library.

| Chain | `tokens` | `memo` | `batch-transfer` | `replace-fee` | `cancel` | `expiry` | `block-scan` | `address-history` | `hd-public-derivation` | `finality-tag` | `fee-market-1559` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ethereum` | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ |
| `bsc` | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | ✓ | |
| `polygon` | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ |
| `avalanche` (C-Chain) | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | | ✓ |
| `arbitrum` | ✓ | | | | | | ✓ | | ✓ | ✓ | ✓ |
| `optimism` | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ |
| `base` | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ |
| `bitcoin` | | | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | | |
| `tron` | ✓ | ✓ | | | | ✓ | ✓ | with an indexer | ✓ | | |
| `solana` | ✓ | ✓ | | | | ✓ | ✓ | ✓ | | | |
| `ton` | ✓ | ✓ | | | | ✓ | | ✓ | | | |
| `avalanche-x` | | ✓ | ✓ | | | | ✓ | ✓ | ✓ | | |
| `avalanche-p` | | | ✓ | | | | ✓ | ✓ | ✓ | | |
| `fakechain` (testing) | | ✓ | | ✓ | ✓ | | ✓ | | ✓ | ✓ | |
| `fakeexpiry` (testing) | | ✓ | | | | ✓ | ✓ | | ✓ | ✓ | |
| `fakeseqno` (testing) | | ✓ | | | | | ✓ | | ✓ | ✓ | |

A few things the table cannot show:

- **Arbitrum** has no public mempool, so nothing can be replaced or cancelled there.
- **Tron** serves address history through an indexer provider (`trongrid` or `public` as the
  handle's `indexer`); without one, `history()` is unsupported.
- **Bitcoin, TON and the Avalanche X-Chain and P-Chain** always need an `indexer`; Solana
  serves history from its RPC.
- **TON** has no block scan, because its chain is sharded: read deposits with `history()`.
- **The EVM chains** have no address history yet: it needs an indexer the family does not use
  yet.
- **Expiry and seqno chains** (Tron, Solana, TON) have no replace or cancel: a transaction that
  does not land expires, and `rebuild` re-issues it once the expiry is proven. TON's seqno
  ordering reports `expiry` too, since its messages also carry a deadline.

Each family page in [Networks](./networks/index.md) gives the details.
