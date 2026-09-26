# Solana Family (Plan 5 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the built-in Solana family (mainnet, devnet, testnet) on `@solana/web3.js` v1: native SOL and classic SPL transfers (with the recipient's associated token account created idempotently and its rent charged separately), memos, `expiry` ordering on `lastValidBlockHeight`, `finalized`-commitment finality with quorum proofs, dense-height block scanning over skipped slots, address history, provider presets, a token catalog and the `crypto-aio/solana` entry.

**Architecture:** One SDK-free Solana driver (`src/adapters/solana/{rpc,fees,errors,decode,heights,reader,builder,proofs,history,driver}.ts`) sends every request straight to the core transport as one JSON-RPC call carrying that driver method's tags (lesson 1). `@solana/web3.js` is used in exactly one module (`web3.ts`) for codec work (legacy message compilation, associated-token-address derivation) and for the `crypto-aio/native` `Connection`, which reaches the same transport through `transport.createFetch`. Instructions (System, SPL Token, Associated Token Account, Memo, ComputeBudget), account layouts, keys and the signed wire format are SDK-free and checked against real devnet transactions and an independent `@noble`/`@scure` encoder. Block heights, not slots, are the dense heights the core requires; a per-driver index maps them to slots with `getBlocks`. Everything is tested offline against a test-only scripted Solana node.

**Tech Stack:** TypeScript 5.9.3 (CommonJS, `module`/`moduleResolution: node16`); Node ≥ 22; Jest 30 + ts-jest 29.4.12; pnpm 10.5.2; `@solana/web3.js` `1.99.0` (exact devDependency; optional peerDependency `^1.99.0`); `@noble/curves` 1.9, `@noble/hashes` 1.8, `@scure/base` 1.2 (already dependencies).

**Spec:** `docs/superpowers/specs/2026-09-23-blockchain-adapter-layer-design.md`

**Also read:** `docs/superpowers/plans/2026-09-23-plan-1-core-handoff.md` (§3 adapter obligations bind this plan), the `ChainDriver` contract table in `src/core/driver/types.ts`, and Plan 2 (`docs/superpowers/plans/2026-09-25-plan-2-evm.md`), whose final shape this plan follows for the composition root, packaging, the family entry, the guides and the crash-test fence.

**Plan series:** Plan 1 (core, merged), Plan 2 (EVM), **Plan 2.5 (core prerequisites for Plans 3–6; Task 0 below is lifted into it, ruling A11)**, Plans 3–6 (UTXO, Tron, **Solana: this document**, TON), Plan 7 (release).

**Executes after:** Plan 2 is merged into `main` (its Task 11 provides `src/testing/generation.ts`) and Plan 2.5 is merged: Task 0's `CallOptions.exactIntegers`, A14 (a height liar cannot shrink the proof quorum), A15 (no two live Operations share an `AttemptRef`) and A17 (health probes respect rate limits). Work on a branch from `main` named `feat/plan-5-solana`.

**Pre-flight review applied** (`preflight-plan-5.md`: 1 Critical, 5 Important, 12 Minor): C1 → D7 and Task 8 (the window scan); I1 → D6, Tasks 4, 8, 10 and the guide; I2 → D14 and Task 5; I3 → D4 and Task 6; I4 → D13 and Tasks 5, 8; I5 → Task 9; M1–M12 as noted in each task.

**Re-review applied** (`preflight-plan-5.md`, "Re-review"; lesson 18 widened): R1 → `undecided` in Task 2, used by Tasks 6 and 8 (no RPC error on a proof path is a verdict; the node models agave's BigTable `getBlocks` failure); R2 → Task 8's one-endpoint C1 tests, each failing against the old composition, plus the hidden-index regression; R3 → D14 and Task 5 (token instructions with none by the sender decide nothing); R4 → D13 and Task 5 (no token balances: a token program that ran keeps the transaction).

## Global Constraints

- Runtime: "Node.js ≥ 22, backend only" (`engines.node >= 22`). Toolchain pinned: "TypeScript 5.9", "Jest 30 + ts-jest", "ESLint 9 flat config". `@solana/web3.js` 1.99 needs Node ≥ 22.12 at runtime (its `rpc-websockets` → `uuid@14` is ESM-only and loads through `require(esm)`); the workspace override of Task 3 keeps Jest working (ruling A13).
- "The core (`src/core/**`) imports no blockchain SDK; SDKs are optional peer dependencies loaded lazily." `src/core/**` must not import `src/adapters/**` or `src/testing/**`.
- "Each family ships an SDK-free **plugin** module (`src/adapters/<family>/plugin.ts`)"; "A manifest is static metadata plus `load()`. Only `load()` pulls in the adapter module and, with it, the SDK." "Lazy loading uses `require()` inside `load()`, not `import()`."
- "Hard `dependencies`: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `debug`" (plus `@scure/bip39`, as today). No new runtime dependency.
- "Optional `peerDependencies` … `@solana/web3.js` … All of them are also `devDependencies`, pinned to those tested versions." Here: `@solana/web3.js` `1.99.0` / `^1.99.0`.
- "If a lazy load fails because the SDK is missing ⇒ `DEPENDENCY_MISSING` with the exact install command."
- "`exports`: `.`, `./evm`, `./utxo`, `./tron`, `./solana`, `./ton`, `./testing`, `./native` (CJS + `.d.ts`; `typesVersions` for older resolvers)."
- Spec §15, Solana column: account / `expiry`; no batch outputs; fee kind "`solana` base + priority; **ATA rent** as a separate charge"; "1 per required signer, `ed25519` over message"; AttemptRef "`signature` after signing (canonical)"; finality "`finalized` commitment"; replace/cancel "no / no"; block scan "yes (by slot; skipped slots handled)"; history "yes (`getSignaturesForAddress`)"; tokens "SPL classic (Token-2022 ⇒ `UNSUPPORTED_CAPABILITY`)"; memo "yes (Memo program)".
- Spec §15 note: "Transfers use SystemProgram and SPL `transferChecked`. `createAssociatedTokenAccountIdempotent` is added when the recipient's ATA is missing, and its rent is shown as a charge. These instructions are built without `@solana/spl-token`. Decoding uses `jsonParsed` including inner instructions, and the result is checked against pre/post balances: a mismatch ⇒ `partial`."
- Spec §11: "Solana `getGenesisHash`" is the identity check; the SDK bridge is "`new Connection(placeholderUrl, { fetch })` → transport"; "SDKs never see real URLs or API keys; secrets stay in the transport."
- Spec §20: "Solana durable nonces, Token-2022 extensions, `@solana/kit` driver" are out of scope.
- "Drivers never hold keys and never sign." "Drivers are shared across tenants, so they hold no wallet, tenant or operation state. The only exception is caches of immutable chain data" (the finalized height → slot cache of Task 6).
- Store records hold plain data only (R11): `UnsignedTx`, `SignedTx`, orderings, `fee.details` and observations never carry SDK objects.
- "Events carry only `operational`-class data … Raw transactions, signatures, signing payloads, addresses, amounts and memos are never emitted by default." Broadcast reasons are short, fixed literals (R24).
- "`bigint` always means base units." Lamports, token amounts, compute units and micro-lamport prices are `bigint`; u64 JSON numbers are parsed exactly (Task 0).
- Every I/O call carries the tags of the `ChainDriver` contract table (purpose, retry class, quorum, fanout, signal); no driver request path waits on a real timer (lesson 1); the Tasks 3, 8 and 10 I/O suites must pass 100 consecutive runs.
- Proofs follow lesson 17's final form (ruling R75): each fact is attested at its own height with a monotone predicate or a finality-scoped read; no endpoint proposes a height; a stale answer decides nothing; "not included" only when provably caught up (lesson 16, sharpened: a load-balanced URL is not monotone, so every read that proves absence must certify itself).
- "Unit tests make no network calls; a guard fails any test that tries." "Integration (opt-in): `CRYPTO_AIO_INTEGRATION=1` runs read-only testnet checks." Environment variables carry flags and routing only, never keys.
- Process: TDD for every module (red, green, commit); stage explicit paths only; never stage `.claude/`, `.superpowers/` or `.env`; never push. **Before every commit run `pnpm format && pnpm lint && pnpm typecheck && pnpm test`** (add `pnpm doc` when exports or docs change). Prettier may reflow code copied from this plan; that is expected. All subagents run on opus (R21).
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

These five inputs are the most likely to bite a real user, and no spec example exercises them. Each has a pinned test in the task named.

1. **A transfer that looks dead to one endpoint but can still land, or did land.** A lagging, pruned, snapshot-jumped or storage-gapped backend, often behind a single load-balanced URL (quorum 1), or the ~200 ms movement of the finalized head, must never produce `included: false` or a proven `expired` while the transaction could be in the chain. Expected: nothing is decided until the finalized chain is past `lastValidBlockHeight` (so the window's last block, `lastValidBlockHeight + 1`, is final) and every block of the window has been read under finality, height by height and parent by parent, without the transaction. Pinned in Task 8 ("never answers "not included" for a landed transfer when a backend lags", "never answers "not included" when a backend's ledger lacks the transaction's block", "never answers "not included" when the index hides a transaction the window holds", "decides nothing when long-term storage fails below the local ledger", "proves a transfer included at lastValidBlockHeight + 1 as included, never absent", "answers "not included" only past the window…") and Task 10 ("never calls an expired-looking transfer dead while it can still land", "ends final, never expired, when the transfer lands at lastValidBlockHeight + 1").
2. **Two honest providers formatting the same finalized transaction differently** (`jsonParsed` variance: `uiAmount` as `null`, no `owner` on token balances, `stackHeight: null`, extra `costUnits`, other log lines, `blockTime: null`) must still reach the proof quorum, while a different token amount decides nothing (`PROVIDER_INCONSISTENT`, retryable). Pinned in Task 2 ("ignores formatting that honest providers differ on", "disagrees on any fact a verdict reads") and Task 8 ("agrees across formatting differences and decides nothing on a different fact").
3. **Two Operations with identical intents** (same sender, recipient, amount, memo and fee, built on the same blockhash) would sign byte-identical messages and share one signature: one payment silently lost. Expected: two different signatures and two payments (build variants, D10; ruling A15's core guard behind them). Pinned in Task 7 ("gives two identical Operations different bytes", "honours an explicit price exactly, and varies every build's limit") and Task 10 ("keeps two identical Operations apart").
4. **A recipient or amount that would lose funds or fail after signing:** SOL to a program-owned account, SPL to a token account instead of its owner or to a program id, a new account below the rent-exempt minimum, a frozen token account, or a sender left between 0 and its rent-exempt minimum. Expected: a pre-signing refusal (`INVALID_INTENT`, `INVALID_AMOUNT`, or `INSUFFICIENT_FUNDS` with `{ required, available }`), nothing signed. Pinned in Task 7 ("refuses recipients that would lose the funds", "keeps the sender at zero or above the rent-exempt minimum").
5. **Skipped slots and ledger gaps under a scanner.** Heights must stay dense: every height up to the head has one block, `header(h)` is `null` only while `h` is not visible (never for a pruned height, which is a retryable error), a list with a gap is refused, and a block over skipped slots links to its parent. Pinned in Task 6 ("maps every height to its block, skipping empty slots", "refuses a list that leaves out a block, and caches nothing from it", "answers a height a pruned endpoint no longer holds with a retryable error, in bounded calls", "turns any other RPC error into a retryable one that decides nothing") and Task 8 ("scans dense heights over skipped slots, filtered by address, without votes").

## Decisions recorded by the plan author

The common brief (lessons 1–17, with lesson 17 in its final form) and the scope rulings for Plan 5 bind this plan. Where they and the spec were silent, these decisions were made; each names what it costs if wrong.

- **D1. One JSON-RPC request per driver call; the SDK does codec work only (lesson 1).** Every driver request is `rpc.ts`'s `call(transport, method, params, tags)`, one `transport.rpc` call with the tags of the calling `ChainDriver` method. `@solana/web3.js` compiles legacy messages, derives associated token addresses and provides the native `Connection`; it never sends a driver request. web3.js's `Connection` retries HTTP 429 on a real `setTimeout` and would hide the tags, so it stays off the request path; a `setTimeout` spy pins this (Task 8). Cost: none; the SDK's request plumbing is not needed.
- **D2. Legacy messages, one signer, SDK-free wire format.** The unsigned payload is the legacy message (base64). The only required signer is the sender, who is also the fee payer, so there is one `ed25519` signing request (`payloadKind: 'message'`, the message bytes). `assemble` writes the signed transaction itself (compact-u16 signature count, signatures, message: `wire.ts`), after checking that the message header's signer keys equal the requests' public keys; no SDK parses our own bytes. The Attempt ref is the base58 first signature (`idKind: 'signature'`, canonical). Versioned (v0) transactions are decoded when received, never built. Cost: address lookup tables are unavailable (not needed for one-output transfers).
- **D3. Blockhash and preflight at `confirmed`.** `getLatestBlockhash` and `sendTransaction`'s `preflightCommitment` both use `confirmed` (Solana's confirmation guide). During authoring, devnet refused a transaction built on a `confirmed` blockhash with "Blockhash not found" under the default `finalized` preflight. Cost: a blockhash from a `confirmed` block that is later abandoned expires unused; `rebuild` recovers.
- **D4. Dense heights are block heights (handoff §3); the driver maps them to slots, and believes only verified pairs (I3).** `HeightIndex` resolves a height by anchoring on the endpoint's head block (`getSlot` + `getBlock`) and counting back through `getBlocks`, which lists produced slots only. A list can have gaps (a ledger jump to a snapshot, a long-term-storage gap, pruning), so a page is believed only after a read of its first block confirms the counted height; a list with a gap is `PROVIDER_INCONSISTENT` and caches nothing. A height at or below the endpoint's finalized height resolves on the finalized chain, and verified pairs from it upward are cached (8,192 per driver; immutable chain data, spec §7), so a forward scan costs one `getBlock` per height. The downward search is bounded (16 pages of 500,000 slots); a height the endpoint no longer holds is a retryable `PROVIDER_UNAVAILABLE` (decides nothing), never `null`, which means only "not visible yet". The RPC codes are split: "not yet" (`-32004`, `-32014`, `-32016`) → `null`; "gone" (`-32001`, `-32009`, `-32011`, `-32019`) → retryable error; "skipped" (`-32007`, which agave also answers for a slot missing after a ledger jump to a snapshot) for a listed slot → `PROVIDER_INCONSISTENT` (retryable, decides nothing), and the cache is dropped. `reader.getBlock` takes a height; a string (a blockhash) throws `UNSUPPORTED_CAPABILITY`, since Solana has no block-by-hash RPC. Any other RPC error from `header` or `getBlocks` decides nothing too (lesson 18 widened, R1: proofs reach the index), for example `-32602 "BigTable query failed"` from `getBlocks` below a backend's local ledger. No core change (ruling: adapter-local mapping accepted). Cost: one extra `getBlock` per page; a scan more than about 8 M slots below the head decides nothing.
- **D5. The scripted Solana node is test-only** (`test/adapters/solana/support/node.ts`), as Plan 2 D5. It decodes transactions with `@solana/web3.js` and verifies signatures with `@noble/curves`, so shipping it in `crypto-aio/testing` would make the testing kit depend on an optional peer. Its fidelity rules are listed in its header and pinned by `node.test.ts` (lesson 8). Cost: users script their own node for their tests.
- **D6. Proofs in lesson 17's final form; the window ends at `lastValidBlockHeight + 1` (I1).** agave checks a blockhash's age against the including block's *parent* (a bank registers its own hash only after its transactions ran), so a transaction whose `lastValidBlockHeight` is `L` can land in block `L + 1`; the window is `L − 149 … L + 1` (151 blocks). `expired(ordering)` is one quorum read of `getBlockHeight({ commitment: 'finalized' })` keyed on the monotone predicate `height > L`, which holds exactly when block `L + 1` is final. `includedFinal` is a finality-scoped quorum read of `getTransaction(signature, { commitment: 'finalized' })` keyed on the consensus facts a verdict reads, then the including block by slot at `finalized`; an unfinalized or stale answer decides nothing. `blockHash(h, level)` quorum-reads `getBlock(slot, { commitment })` keyed on consensus fields, after (for `finalized`) the predicate "my finalized height ≥ h". `finalizedHead()` is the one unanchored head: one endpoint's finalized height minus a peer skew of 2, then attested. `slotConsumed` is always `false` (expiry ordering has no slot another transaction could consume), which closes R76's composed-call window for Solana. Cost: a lagging peer delays verdicts by a poll.
- **D7. "Not included" is proven by reading the window, block by block (C1, lesson 16 sharpened).** An index that shows nothing proves nothing: behind one load-balanced URL, `getTransaction` can reach a backend that lags, was pruned (Ankr keeps about 16 hours), jumped to a snapshot, or swallows a long-term-storage error, and agave 4.3.0 ignores `getTransaction`'s `minContextSlot`. So `includedFinal` answers `{ included: false }` only after: (1) the finalized `getTransaction` quorum read found nothing; (2) the predicate "finalized height > `L`" holds (block `L + 1` is final); (3) the window's first and last blocks are attested by height; (4) `getBlocks` over their slots, at `finalized` with `minContextSlot`, lists exactly one slot per height (151); (5) every block is read whole (`transactionDetails: 'signatures'`) under the proof quorum, sits at the next height, names the previous block as its parent, and ends at the attested last block, and none holds the signature. Every block read certifies itself, so a lagging, pruned or gapped backend can only answer "not available", which decides nothing. Lesson 18, widened (R1): only this definitive negative proof answers "no"; every other RPC error on a proof path (for example agave 4.3.0's `-32602 "BigTable query failed"` when a window lies below a backend's local ledger and its long-term storage fails) becomes a retryable `PROVIDER_UNAVAILABLE` through `undecided`, and every `ProofSource` method is wrapped so that none escapes. A block that holds the transaction while the index showed nothing is `PROVIDER_INCONSISTENT` (a stale answer, lesson 17). A proven absence is remembered per driver (1,024 entries, immutable chain data), so `rebuild`'s re-proof costs one read. Cost: about 152 quorum block reads (0.1–0.3 MB each on mainnet) once per Attempt that really expired unlanded; with one provider, everything that provider answers is trusted, so proven expiry wants two independent providers (the guide says so), and A14 guards the quorum.
- **D8. Library policies for the clusters.** `finality: { kind: 'commitment', level: 'finalized' }`; `defaultConfirmations: 1` (a default `waitForConfirmation` waits for inclusion; credit on `final`); `reorgWindow: 64`; `maxLagBlocks: 150` (a blockhash lives 150 blocks, so an endpoint further behind cannot judge expiry). The driver never reads `maxLagBlocks` (the pool resolves it, R36). Cost: a user may override per chain (R36).
- **D9. Fees.** The `network` charge is the signature fee the node quotes for the exact message (`getFeeForMessage`, minus our priority fee); the `priority` charge is `ceil(price × limit / 1e6)`; a created recipient account adds a `rent` charge (`getMinimumBalanceForRentExemption(165)`). Speeds take the 25th, 50th and 75th nearest-rank percentile of `getRecentPrioritizationFees` over the accounts the transaction writes. The limit is the simulated usage plus 20% and 1,000 units (`simulateTransaction`, `sigVerify: false`, `replaceRecentBlockhash: true`), or 200,000 per instruction when a simulation fails (for example an unfunded sender, which `checkFunds` then explains). `bound` is `exact`, or `upper` when rent is charged (someone else may create the account first). Overrides: `{ computeUnitPrice, computeUnitLimit? }`. Cost: two extra reads per estimate; percentiles are a library policy.
- **D10. Build variants against identical transfers (Review Focus 3; defense in depth next to ruling A15's core guard).** Each estimate draws a variant from a per-driver counter with a crypto-random start (0 to 1,023,999): 0–1,023 extra compute units on the limit, an explicit limit included (M3), and, for a speed, 0–999 extra micro-lamports on the price (at most about one lamport per 1,000 compute units). An explicit price is used exactly. The variant lives in `fee.details`, so `build` reproduces it and the estimate stays exact. At the protocol maximum limit (1,400,000) no variant fits, and A15 is the only guard. Cost: up to about 25 lamports more priority fee on a token transfer; an explicit fee pays for up to 1,023 more compute units.
- **D11. Pre-signing refusals that protect funds (Review Focus 4).** SOL to an account that exists and is executable or not owned by the System Program: `INVALID_INTENT` ("the recipient is a program-owned account"); SPL to a program id (M4: "the recipient is a program; send to a wallet or a PDA owner") or to a token account (classic or Token-2022 owner) instead of its owner: `INVALID_INTENT`; SOL to a missing account below `getMinimumBalanceForRentExemption(0)`: `INVALID_AMOUNT`; a frozen source or recipient token account, or a recipient token account for another mint or owner: `INVALID_INTENT`. `checkFunds` keeps the sender at 0 or at least the rent-exempt minimum (the runtime refuses anything in between). To fund a program account deliberately, use `crypto-aio/native`. Cost: those sends need the native client.
- **D12. SPL scope.** Classic Token program only; a Token-2022 mint is `UNSUPPORTED_CAPABILITY` (spec §15). `getBalance(owner, spl)` sums every classic token account the owner holds for the mint; a transfer spends only the owner's associated token account, so `checkFunds` reports that account's balance as `available`. `ext.solana.getTokenAccounts(owner, mint?)` lists them. An unregistered mint's symbol is the first 8 characters of its address (SPL mints carry no symbol; metadata is display only, spec §6.2). Cost: tokens held outside the ATA must be moved by the owner first.
- **D13. Decoding, and a scan filter that never drops a deposit (I4).** System `transfer`, `transferWithSeed`, `createAccount`, `createAccountWithSeed` and classic Token `transfer`/`transferChecked`, outer and inner (`source: 'internal'` for inner). Token transfers name the token accounts' owners (from the token balances), falling back to the token accounts, as `partial`, when a node omits owners. Every lamport and token balance change must be explained by the decoded moves and the fee, else `partial` (spec §15). A memo is attached to the transfers only when the transaction has exactly one. Failed transactions report the fee and no transfers (lesson 15). Vote transactions are skipped by the block source. The address filter is a conservative superset (handoff §3, "at least every transaction"): a decoded transfer names a watched address; a watched account's lamports changed; a token balance owned by a watched address changed, or one with no owner reported changed; the node reported no token balances and a token program ran (a deposit into an existing token account then names no owner, R4); or the transaction is `partial` and names a watched account. Cost: other value-moving instructions (stake, close account, Token-2022) make a transaction `partial`, and the filter returns a few transactions that turn out unrelated.
- **D14. The phantom-success guard, in the board's final wording (lessons 7 and 15; I2).** On verdict paths only (`observe` with an ordering, and `includedFinal`), a transaction that carries token instructions counts as executed only when the balances show a transfer **from the sender's account to the intended recipient's account of a positive amount**; the exact amount is not required (fee-on-transfer tokens exist). The intended recipient is the destination of the sender's own signed instruction, which its signature makes authentic (as the EVM verdict trusts calldata). A zero-amount record, a failed transaction, or balances that show no move from the sender's account to the recipient's is `success: false` (`reason: 'token transfer failed'`); missing evidence (no token balances, an unparsed token instruction, accounts missing from the keys) decides nothing (retryable `PROVIDER_UNAVAILABLE`), never a proven `failed`; so do token instructions of which none is the sender's, since the sender's own signed message carries its `transferChecked` (an answer that contradicts it is retryable `PROVIDER_INCONSISTENT`; lesson 18 widened, R3). A native transfer's verdict is the chain's own status (a transaction with no token instruction; the re-review accepted this). General decoding reports the chain's own status and the amounts that actually moved. Cost: none for honest nodes.
- **D15. Broadcast classification (lesson 3).** `already-known`: "Transaction simulation failed: This transaction has already been processed". `rejected` (only bytes invalid by construction on every node): the anchored signature-verification texts under codes `-32002` and `-32003` (agave ≥ 4.0 answers `-32002` under preflight; `-32003` is kept for older nodes, harmless; with `skipPreflight` agave forwards a bad signature unverified, and the leader drops it, M1). `refused` with `INSUFFICIENT_FUNDS`: the anchored debit, fee, rent and "custom program error: 0x1" / "insufficient funds for instruction" texts (error 1 is insufficient funds in both the System and Token programs). Everything else, including "Blockhash not found" (a lagging node may not know it yet), undeserializable bytes and version or size limits, is `refused` `TX_REFUSED` with a fixed reason. Only a definitive, non-ambiguous `RPC_ERROR` is classified (R16/R17). Cost: an unlisted permanent text is reported refused (the safe direction); a first broadcast answered "Blockhash not found" by a lagging endpoint stalls until `rebroadcast` or expiry (M5, documented).
- **D16. Memos** are at most 256 UTF-8 bytes (a library policy well inside the 1,232-byte packet limit) and must be well-formed text (no lone UTF-16 surrogate); otherwise `INVALID_INTENT`. Memos are never logged (spec §12 classifies them sensitive). Cost: longer memos need the native client.
- **D17. History.** `getSignaturesForAddress` (newest first, at most 1,000 per page, `before` = the cursor), then `getTransaction` for each signature. A backend that does not know the cursor answers `-32020`, which is a retryable `PROVIDER_UNAVAILABLE` (M2: another backend may). The indexer transport is used when configured (handoff §3). An SPL deposit into an existing associated token account names the token account, not the owner, so it appears in the token account's history (listed by `ext.solana.getTokenAccounts`), not the owner's; the block scanner matches owners. History and proofs reach back only as far as the provider's ledger (Ankr: about 16 hours); older history decides nothing. Cost: one request per history item.
- **D18. The identity guard (lesson 5).** A Solana transaction embeds no cluster id; its recent blockhash binds it to one cluster. So: the genesis-hash identity probe runs on every transport, including the indexer, before any traffic (M12, R19); the blockhash is read only through identity-checked endpoints; `assemble` refuses a message whose signer keys differ from the signing requests. Cost: none.
- **D19. Exact u64 integers (P5-A, ruling A12).** Solana sends lamports as JSON numbers; above 2^53 − 1 (≈ 9 M SOL) `JSON.parse` rounds them. Task 0 adds `CallOptions.exactIntegers` to the core (lifted into Plan 2.5), and every Solana call sets it. A rounded number is refused as malformed. Cost: one core option (a Plan 7 changelog item).
- **D20. The Jest workspace override (P5-B, ruling A13).** `pnpm-workspace.yaml` overrides `rpc-websockets>uuid` to `^11.1.1` (CommonJS and ESM), so Jest 30 on Node 22 can load `@solana/web3.js` 1.99.0. It affects only this workspace's installs. Cost: none for consumers; users need Node ≥ 22.12 (documented).
- **D21. Crash tests use `fenceGeneration` with `restart({ killPrevious: true })`** (handoff R20, ruling A5, Plan 2 Task 11's notes): `test/adapters/solana/support/env.ts` consumes `src/testing/generation.ts`, keeps the raw clock, stores and signer counter, never closes a killed container, and the first crash test pins that a call on the dead handle never settles (M11). Cost: none.
- **D22. Guides are edited by hand**, not run through Prettier (as Plan 2 D16). `README.md` and `CHANGELOG.md` stay Prettier-clean.
- **D23. Integration routing.** `CRYPTO_AIO_IT_SOLANA_NETWORK` (`mainnet`, `devnet` (default) or `testnet`) and `CRYPTO_AIO_IT_SOLANA_RPC_URL` (default: the `public` preset). The test pauses 2 s between steps, because the public endpoints are rate-limited and, until A17 lands, health probes do not wait for the limit. During authoring it passed live on mainnet, devnet and testnet (Agave 4.3.0).

## Proposals and rulings this plan builds on

- **P5-A → A12 (accepted and amended, in Plan 2.5):** `CallOptions.exactIntegers` on `rpc`, `rpcRaw` and `http`. Task 0 below is its self-contained specification, marked "(lifted into Plan 2.5)", written on Plan 4's `parseJson` helper so the two Task 0s merge into one implementation. Tasks 2–10 consume it.
- **P5-B → A13 (accepted, here):** the `pnpm-workspace.yaml` override of Task 3.
- **Lesson 17, final form (R75, binding):** D6. **Lesson 16:** D7. **R76** (the core's `whenAbsent` composes two proof calls): D7 keeps "not included" strict to shrink its window.
- **A5:** crash tests consume `fenceGeneration` (D21). **A14** (N5, a height liar shrinking the proof quorum), **A15** (a core guard against two Operations sharing an `AttemptRef`) and **A17** (health probes respect rate limits) land in Plan 2.5; D10 stays as defense in depth.
- **Plan 2 Task 10's final family shape** (R79–R82): Task 9 follows it (`SOLANA_PEER_DEPENDENCIES` keyed by library, per-manifest lazy tests, the peer-pin test, the SDK-free main-entry guard, `USE_ACME` in both file orders, bare peer names).
- **The phantom-success rule, final wording:** D14.
- **Lesson 18, widened (binding for all families):** on a proof path only a definitive negative proof answers "no"; every other RPC error decides nothing (D4, D7, `undecided` in Task 2), and so does a decoding contradiction (D14).
- Adapter-local dense heights: accepted with no core change (D4).

## File Structure

```
src/
  index.ts                         MODIFY: type exports (Task 1); register solanaPlugin() (Task 9)
  core/transport/{types,http-transport}.ts   MODIFY: CallOptions.exactIntegers (Task 0, lifted into Plan 2.5)
  adapters/solana/
    types.ts      SDK-free types: SolanaExt, SolanaFeeDetails, SolanaFeeOverride, SolanaTokenAccount,
                  SolanaCallTags, SolanaInstruction, SolanaCodec; registry augmentation
    keys.ts       strict base58 keys and signatures; ed25519 public key → address (SDK-free)
    programs.ts   program ids, account sizes, limits; the instructions we build; mint and token
                  account layouts (SDK-free)
    chains.ts     SOLANA_CHAIN: mainnet, devnet, testnet (verified data); deepFreeze
    presets.ts    SOLANA_PRESETS: public, alchemy, infura, ankr
    tokens.ts     SOLANA_TOKENS: USDC (mainnet, devnet), USDT (mainnet)
    network.ts    solanaNetworkConfig: validated network data; SOLANA_CAPABILITIES
    rpc.ts        call(): the path to the transport; tags; RPC codes; answer validation; quorum keys
    fees.ts       fee policy: percentiles, limits, priority fee, overrides, build variants (pure)
    errors.ts     broadcast classification with fixed reasons (pure)
    web3.ts       the only SDK module: createWeb3Codec (messages, ATAs, native Connection);
                  web3DriverFactory (Task 8)
    wire.ts       compact-u16, message signers, signed transaction bytes (SDK-free)
    decode.ts     jsonParsed transactions → DriverTransaction; reconciliation; tokenTransfersLanded
    heights.ts    HeightIndex: dense block height ↔ slot
    reader.ts     SolanaContext; address codec; ChainReader; ext.solana; account helpers
    builder.ts    TxBuilder (estimate, funds, build, assemble) and Broadcaster
    proofs.ts     ProofSource (lesson 17 final form) and BlockSource
    history.ts    AddressHistorySource (getSignaturesForAddress)
    driver.ts     solanaDriverFactory(makeCodec): probes, ports, capabilities
    plugin.ts     solanaPlugin, solanaManifest, SOLANA_PEER_DEPENDENCIES (SDK-free)
    index.ts      `crypto-aio/solana`: public constants and types; NativeClientMap augmentation
test/
  core/transport/exact-integers.test.ts                       (Task 0)
  adapters/solana/
    support/vectors.ts   test keys; an independent legacy-message encoder (lesson 11)
    support/node.ts      ScriptedSolanaNode (test-only, D5)
    support/harness.ts   nodeTransport, recording, solanaHarness
    support/tx.ts        signedTx helper
    support/fixtures.ts  a real devnet transferChecked transaction (jsonParsed)
    support/env.ts       createSolanaEnv, countingSigner (fenced restarts)
    data, keys, programs, policy, codec, node, decode, heights, reader, builder, driver,
    plugin, dependency, lazy, e2e (.test.ts)
  integration/solana.test.ts                                   opt-in, read-only
  architecture/registry-augmentation.test.ts                   MODIFY: Solana typing
package.json, pnpm-lock.yaml, pnpm-workspace.yaml, typedoc.json   MODIFY
docs/guides/{index,quick-start,networks,transactions}.md, README.md, CHANGELOG.md   MODIFY
```

Only `web3.ts` imports the SDK at runtime (and `index.ts` imports its *types* for `NativeClientMap`). `driver.ts` imports no SDK module, so `web3.ts` → `driver.ts` has no cycle.

## Task overview

| Task | Delivers | Consumes | Plan 2 / 2.5 shape it relies on |
|---|---|---|---|
| 0 | `CallOptions.exactIntegers` (lifted into Plan 2.5) | core transport | — |
| 1 | types, keys, programs, chain data, presets, tokens, network config | core model | R55 type-only exports in `src/index.ts` |
| 2 | `rpc.ts`, `fees.ts`, `errors.ts` | Task 0, Task 1 | — |
| 3 | SDK dependency, `web3.ts` codec, `wire.ts`, vectors | Tasks 1–2 | `package.json` after Plan 2 Task 10 |
| 4 | scripted node, harness | Task 3 | — |
| 5 | `decode.ts` | Task 2 | — |
| 6 | `heights.ts`, `reader.ts` | Tasks 2–5 | — |
| 7 | `builder.ts` (builder, broadcaster) | Tasks 2–6 | — |
| 8 | `proofs.ts`, `history.ts`, `driver.ts`, `web3DriverFactory` | Tasks 2–7 | Plan 2 Task 9's factory shape |
| 9 | plugin, `crypto-aio/solana`, composition root, packaging, lazy and peer-pin tests | Task 8 | Plan 2 Task 10's final shape (R79–R82) |
| 10 | end-to-end suite | everything | Plan 2 Task 11's `src/testing/generation.ts` |
| 11 | opt-in integration test | public API | Plan 2 Task 12's routing pattern |
| 12 | guides, README, CHANGELOG | shipped behaviour | Plan 2 Task 13's guide layout |

Tasks 1, 2 and 5 are pure and can be reviewed independently; Tasks 3–4 are test infrastructure; Tasks 6–8 build the driver in dependency order.

---

### Task 0: Exact u64 integers in the transport (lifted into Plan 2.5)

This task is self-contained so the controller can lift it into Plan 2.5 (ruling A11). **It merges with Plan 4's Task 0 into one Plan 2.5 implementation** (M12): both use the same `parseJson(text, exactIntegers)` helper in `src/core/util/json.ts` and the same `CallOptions.exactIntegers` field with the same doc comment; Plan 4's specifies `http`, this one `rpc`, `rpcRaw` and `http`, and whichever lands first adds the field and the helper. Both create `test/core/transport/exact-integers.test.ts`: Plan 2.5 keeps one file with both plans' assertions. If Plan 2.5 has already delivered all of this, verify that its test pins `rpc`, `rpcRaw`, `http` and quorum keys, and skip to Task 1.

**Files:**
- Modify: `src/core/util/json.ts` (add `parseJson`), `src/core/transport/types.ts` (`CallOptions.exactIntegers`), `src/core/transport/http-transport.ts` (thread the flag from `rpc`, `rpcRaw` and `http` to the JSON parse)
- Test: `test/core/transport/exact-integers.test.ts`

**Interfaces:**
- Consumes: `HttpTransport`, `CallOptions`, `FakeFetch`, `drive`, the transport test `setup` helper (Plan 1); Node ≥ 22 `JSON.parse` source-text access.
- Produces:
  - `parseJson(text: string, exactIntegers?: boolean): unknown` in `src/core/util/json.ts`: with the flag, every integer literal outside `Number.MIN_SAFE_INTEGER..MAX_SAFE_INTEGER` becomes a `bigint` read from its source text; safe integers, fractions and exponents are unchanged.
  - `CallOptions.exactIntegers?: boolean` (default `false`). `Transport.rpc`, `rpcRaw` and `http` parse the answer with it; a `quorumKey` sees the revived values. The health probes (`#direct`) keep plain parsing. Consumers: every Solana call (Task 2's `call`); Plan 4 for Tron amounts (ruling A12).

**Review points:**
- Opt-in: without the flag every answer parses exactly as before.
- Only integer literals outside the safe range become bigints; `1.5`, `1e21` and safe integers keep their type.
- The flag reaches all three request paths, never the probes; the `http` assertion uses its own endpoint, so it pins parsing, not failover (M6).
- A quorum over revived values compares exact integers (`canonicalJson` encodes bigints).
- A Plan 7 changelog item: "`CallOptions.exactIntegers` (A12)".

- [ ] **Step 1: Write the failing test**

`test/core/transport/exact-integers.test.ts`:

```ts
import type { EndpointConfig } from '../../../src/core/transport/types';
import { parseJson } from '../../../src/core/util/json';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const A: EndpointConfig = { name: 'a', url: 'https://a.test/rpc' };
const B: EndpointConfig = { name: 'b', url: 'https://b.test/rpc' };
const C: EndpointConfig = { name: 'c', url: 'https://c.test' };
const BODY =
  '{"lamports":18446744073709551615,"small":5,"negative":-9007199254740993,"float":1.5,"exp":1e21,"list":[9007199254740993]}';
const EXACT = {
  lamports: 18_446_744_073_709_551_615n,
  small: 5,
  negative: -9_007_199_254_740_993n,
  float: 1.5,
  exp: 1e21,
  list: [9_007_199_254_740_993n],
};

/** A JSON-RPC answer written as raw text, so its numbers are exactly what a node sends. */
const rpcAnswer = (request: FakeRequest, result: string) => ({
  text: `{"jsonrpc":"2.0","id":${request.json<{ id: number }>().id},"result":${result}}`,
  headers: { 'content-type': 'application/json' },
});

describe('exact JSON integers (P5-A, A12)', () => {
  it('parseJson revives integers beyond 2^53 − 1 as bigints, and only them', () => {
    expect(parseJson(BODY, true)).toEqual(EXACT);
    expect((parseJson(BODY) as { lamports: unknown }).lamports).toBe(
      18_446_744_073_709_552_000,
    );
  });

  it('applies to rpc and rpcRaw answers with the flag, and never without it', async () => {
    const fake = new FakeFetch().route('https://a.test', (req) => rpcAnswer(req, BODY));
    const { transport, clock } = setup([A], fake);
    expect(await drive(clock, transport.rpc('m', [], { exactIntegers: true }))).toEqual(
      EXACT,
    );
    const lossy = await drive(clock, transport.rpc<{ lamports: unknown }>('m', []));
    expect(lossy.lamports).toBe(18_446_744_073_709_552_000);
    expect(
      await drive(
        clock,
        transport.rpcRaw({ jsonrpc: '2.0', id: 1, method: 'm' }, { exactIntegers: true }),
      ),
    ).toMatchObject({ result: { lamports: 18_446_744_073_709_551_615n } });
  });

  it('applies to http answers (their own endpoint: this pins parsing, not failover)', async () => {
    const fake = new FakeFetch().route('https://c.test', () => ({
      text: BODY,
      headers: { 'content-type': 'application/json' },
    }));
    const { transport, clock } = setup([C], fake);
    expect(
      await drive(
        clock,
        transport.http({ method: 'GET', path: '/x' }, { exactIntegers: true }),
      ),
    ).toEqual(EXACT);
    expect(fake.calls).toHaveLength(1);
  });

  it('lets quorum keys see the revived values', async () => {
    const fake = new FakeFetch()
      .route('https://a.test', (req) => rpcAnswer(req, BODY))
      .route('https://b.test', (req) => rpcAnswer(req, BODY));
    const { transport, clock } = setup([A, B], fake);
    const seen: unknown[] = [];
    await drive(
      clock,
      transport.rpc('m', [], {
        exactIntegers: true,
        quorum: 2,
        quorumKey: (result) => {
          seen.push((result as { lamports: unknown }).lamports);
          return result;
        },
      }),
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((value) => value === 18_446_744_073_709_551_615n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/core/transport/exact-integers.test.ts`
Expected: FAIL: `parseJson` is not exported from `src/core/util/json`.

- [ ] **Step 3: Add the parser**

In `src/core/util/json.ts`, add before `export function sha256Hex(`:

```ts
/**
 * `JSON.parse`, optionally exact for integers (A12): with `exactIntegers`, every integer
 * literal outside the safe range becomes a `bigint` read from its source text (Node ≥ 22
 * `JSON.parse` source text access), so a u64 amount is never rounded. Safe integers stay
 * numbers, so answers keep their shape for ordinary values.
 */
export function parseJson(text: string, exactIntegers = false): unknown {
  if (!exactIntegers) return JSON.parse(text);
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { readonly source?: string }) =>
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      /^-?\d+$/.test(context.source)
        ? BigInt(context.source)
        : value,
  );
}
```

- [ ] **Step 4: Add the option**

In `src/core/transport/types.ts`, insert before `/** Send to this many endpoints concurrently (raw-transaction broadcasts). */`:

```ts
  /**
   * A12: parse JSON answers with exact integers: an integer outside the safe range becomes a
   * `bigint` instead of a rounded number (`rpc`, `rpcRaw` and `http`). A quorum key sees the
   * revived values.
   */
  readonly exactIntegers?: boolean;
```

- [ ] **Step 5: Thread it through `rpc`, `rpcRaw` and `http`**

In `src/core/transport/http-transport.ts`:

1. Change `import { canonicalJson } from '../util/json';` to `import { canonicalJson, parseJson } from '../util/json';`.
2. In `rpc()`, change `this.#rpcOnce<T>(endpoint, method, id, body, signal),` to `this.#rpcOnce<T>(endpoint, method, id, body, signal, options.exactIntegers),`.
3. In `rpcRaw()`, the `this.#exchange(…)` call ends with the argument `'rpc',`; add after it:
   ```ts
        label,
        options.exactIntegers,
   ```
4. In `http()`, change `(endpoint, signal) => this.#httpOnce<T>(endpoint, request, bodyText, signal),` to:
   ```ts
      (endpoint, signal) =>
        this.#httpOnce<T>(endpoint, request, bodyText, signal, options.exactIntegers),
   ```
5. Give `#rpcOnce` a last parameter `exactIntegers = false,` (after `signal: AbortSignal,`), and add after its `#exchange` call's `'rpc',` argument:
   ```ts
      method,
      exactIntegers,
   ```
6. Give `#httpOnce` a last parameter `exactIntegers = false,` (after `signal: AbortSignal,`), and pass `exactIntegers,` as the last argument of its `this.#exchange(…)` call, after the `` `${request.method} ${request.path}`, `` error label.
7. Give `#exchange` a last parameter `exactIntegers = false,` (after `errorLabel: string = label,`), and replace `json = text.length > 0 ? JSON.parse(text) : null;` with `json = text.length > 0 ? parseJson(text, exactIntegers) : null;`.

`#direct` (health probes) keeps calling `#rpcOnce` and `#httpOnce` without the flag.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm jest test/core/transport`
Expected: PASS: every transport suite, including 4 new tests in `exact-integers.test.ts`.

- [ ] **Step 7: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all green; `pnpm doc` 0 warnings.

```bash
git add src/core/util/json.ts src/core/transport/types.ts src/core/transport/http-transport.ts test/core/transport/exact-integers.test.ts
git commit -m "feat(core): exact JSON integers for rpc, rpcRaw and http answers (A12)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 1: Solana types, keys, programs, chain data, presets and tokens

**Files:**
- Create: `src/adapters/solana/{types,keys,programs,chains,presets,tokens,network}.ts`
- Modify: `src/index.ts` (type-only exports, R55)
- Test: `test/adapters/solana/{data,keys,programs}.test.ts`

**Interfaces:**
- Consumes: `ChainInfo`, `NetworkInfo`, `Capability`, `ProviderPreset`, `PresetInput`, `AssetRegistration`, `secret`/`reveal`, `ConfigError`, `ValidationError`, `@noble/curves/ed25519`, `@scure/base`.
- Produces:
  - `types.ts`: `SolanaExt`, `SolanaTokenAccount`, `SolanaFeeDetails`, `SolanaFeeOverride`, `SolanaCallTags` (purpose, retry, quorum, quorumKey, fanout, signal), `Commitment = 'confirmed' | 'finalized'`, `SolanaInstruction`, `SolanaCodec` (`associatedTokenAddress(owner, mint)`, `compileMessage(payer, blockhash, instructions)`, `createNative()`); the `ChainRegistry`/`FamilyRegistry` augmentation (`solana` × `mainnet | devnet | testnet`, library `'@solana/web3.js'`).
  - `keys.ts`: `decodeBase58(value, length)`, `encodeBase58(bytes)`, `isAddress`, `isSignature`, `addressFromPublicKey(publicKey)` (throws `INVALID_ADDRESS`).
  - `programs.ts`: program ids (`SYSTEM_PROGRAM`, `TOKEN_PROGRAM`, `TOKEN_2022_PROGRAM`, `ASSOCIATED_TOKEN_PROGRAM`, `MEMO_PROGRAM`, `MEMO_V1_PROGRAM`, `COMPUTE_BUDGET_PROGRAM`, `VOTE_PROGRAM`), `MINT_SIZE`, `TOKEN_ACCOUNT_SIZE`, `MAX_TRANSACTION_SIZE`, `MAX_COMPUTE_UNIT_LIMIT`, `DEFAULT_INSTRUCTION_COMPUTE_UNITS`, `MAX_MEMO_BYTES`; builders `setComputeUnitLimit`, `setComputeUnitPrice`, `systemTransfer`, `createAssociatedTokenAccountIdempotent`, `transferChecked`, `memo`; decoders `decodeMint`, `decodeTokenAccount`.
  - `chains.ts`: `SOLANA_CHAIN`, `deepFreeze`. `presets.ts`: `SOLANA_PRESETS`. `tokens.ts`: `SOLANA_TOKENS`.
  - `network.ts`: `SOLANA_CAPABILITIES` (`tokens`, `memo`, `block-scan`, `address-history`, `expiry`), `SolanaNetworkConfig { genesisHash, capabilities }`, `solanaNetworkConfig(chain, network)` (throws `CONFIG_INVALID`).
  - `crypto-aio` exports the types `SolanaExt`, `SolanaFeeDetails`, `SolanaFeeOverride`, `SolanaTokenAccount` (R55: in the same task that first references them).

**Review points:**
- Every value in `chains.ts`, `presets.ts` and `tokens.ts` matches Appendix A; nothing unverified was added (lesson 12). Deep-frozen (R56).
- Keyed preset URLs are `Secret`s; an empty or missing key throws `CONFIG_INVALID` without naming it (lesson 10).
- `addressFromPublicKey` refuses a 64-byte secret key, 33-byte keys, off-curve and small-order points (lesson 4, R58); `decodeBase58` accepts only canonical text of the exact length.
- Instruction data and account orders equal real devnet transactions (the `programs.test.ts` fixtures).
- Until Task 9 registers the plugin, the types advertise `solana` while the runtime rejects it as an unknown chain (as Plan 2 between its Tasks 2 and 10). Task 9 must land before any release.

- [ ] **Step 1: Write the failing tests**

`test/adapters/solana/data.test.ts`:

```ts
import { SOLANA_CHAIN } from '../../../src/adapters/solana/chains';
import {
  SOLANA_CAPABILITIES,
  solanaNetworkConfig,
} from '../../../src/adapters/solana/network';
import { SOLANA_PRESETS } from '../../../src/adapters/solana/presets';
import { SOLANA_TOKENS } from '../../../src/adapters/solana/tokens';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { reveal, secret } from '../../../src/core/secret/secret';

const preset = (name: string) => SOLANA_PRESETS.find((p) => p.name === name)!;
const urls = (name: string, network: string, apiKey?: string) =>
  preset(name)
    .endpoints({
      chain: 'solana',
      network,
      ...(apiKey !== undefined ? { apiKey: secret(apiKey) } : {}),
    })
    .map((e) => reveal(e.url));

describe('Solana chain data', () => {
  it('has the three clusters with their genesis hashes and the finalized commitment', () => {
    expect(SOLANA_CHAIN).toMatchObject({
      id: 'solana',
      family: 'solana',
      model: 'account',
      ordering: 'expiry',
      schemes: ['ed25519'],
      nativeAsset: { symbol: 'SOL', decimals: 9 },
      defaultNetwork: 'mainnet',
    });
    expect(
      Object.values(SOLANA_CHAIN.networks).map((n) => [n.id, n.identity, n.testnet]),
    ).toEqual([
      ['mainnet', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', false],
      ['devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', true],
      ['testnet', '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', true],
    ]);
    for (const network of Object.values(SOLANA_CHAIN.networks)) {
      expect(network).toMatchObject({
        feeModel: 'solana',
        finality: { kind: 'commitment', level: 'finalized' },
        defaultConfirmations: 1,
        reorgWindow: 64,
        maxLagBlocks: 150,
      });
      expect(network.replacement).toBeUndefined();
    }
    expect(SOLANA_CHAIN.networks.devnet?.explorer).toEqual({
      tx: 'https://explorer.solana.com/tx/{id}?cluster=devnet',
      address: 'https://explorer.solana.com/address/{address}?cluster=devnet',
    });
    expect(SOLANA_CHAIN.networks.mainnet?.explorer?.tx).toBe(
      'https://explorer.solana.com/tx/{id}',
    );
  });

  it('is deeply frozen (R56)', () => {
    expect(Object.isFrozen(SOLANA_CHAIN)).toBe(true);
    expect(Object.isFrozen(SOLANA_CHAIN.networks.mainnet?.finality)).toBe(true);
    expect(Object.isFrozen(SOLANA_TOKENS[0]?.ref)).toBe(true);
    expect(Object.isFrozen(SOLANA_PRESETS)).toBe(true);
  });

  it('registers USDC and USDT by mint, only where their issuers list them', () => {
    expect(
      SOLANA_TOKENS.map((t) => [
        t.network,
        t.metadata.symbol,
        t.ref === 'native' ? '' : t.ref.contract,
        t.metadata.decimals,
      ]),
    ).toEqual([
      ['mainnet', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6],
      ['mainnet', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6],
      ['devnet', 'USDC', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 6],
    ]);
    expect(
      SOLANA_TOKENS.every((t) => t.ref !== 'native' && t.ref.standard === 'spl'),
    ).toBe(true);
  });
});

describe('Solana provider presets', () => {
  it('serves the verified URL templates, keyed URLs as secrets', () => {
    expect(urls('public', 'mainnet')).toEqual(['https://api.mainnet.solana.com']);
    expect(urls('public', 'testnet')).toEqual(['https://api.testnet.solana.com']);
    expect(urls('alchemy', 'devnet', 'k1')).toEqual([
      'https://solana-devnet.g.alchemy.com/v2/k1',
    ]);
    expect(urls('infura', 'mainnet', 'k2')).toEqual([
      'https://solana-mainnet.infura.io/v3/k2',
    ]);
    expect(urls('ankr', 'devnet', 'k3')).toEqual([
      'https://rpc.ankr.com/solana_devnet/k3',
    ]);
    const [endpoint] = preset('alchemy').endpoints({
      chain: 'solana',
      network: 'mainnet',
      apiKey: 'k4',
    });
    expect(String(endpoint?.url)).toBe('[REDACTED]');
    expect(preset('public').production).toBe(false);
  });

  it('supports only the documented clusters, and refuses an empty key without naming it', () => {
    expect(preset('alchemy').supports('solana', 'testnet')).toBe(false);
    expect(preset('ankr').supports('solana', 'testnet')).toBe(false);
    expect(preset('public').supports('ethereum', 'mainnet')).toBe(false);
    expect(preset('public').supports('solana', 'toString')).toBe(false);
    for (const key of ['', '   ']) {
      expect(() => urls('infura', 'devnet', key)).toThrow(
        expect.objectContaining({
          code: 'CONFIG_INVALID',
          message: expect.not.stringContaining(`'${key}'`),
        }),
      );
    }
  });
});

describe('solanaNetworkConfig', () => {
  const devnet = SOLANA_CHAIN.networks.devnet as NetworkInfo;
  const withNetwork = (network: Partial<NetworkInfo>) => () =>
    solanaNetworkConfig(SOLANA_CHAIN, { ...devnet, ...network });

  it('derives the genesis hash and the capabilities', () => {
    const config = solanaNetworkConfig(SOLANA_CHAIN, devnet);
    expect(config.genesisHash).toBe('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
    expect([...config.capabilities].sort()).toEqual([...SOLANA_CAPABILITIES].sort());
    expect(
      [
        ...solanaNetworkConfig(SOLANA_CHAIN, {
          ...devnet,
          capabilities: { remove: ['memo'] },
        }).capabilities,
      ].sort(),
    ).toEqual(['address-history', 'block-scan', 'expiry', 'tokens']);
  });

  it('refuses data the driver cannot serve with CONFIG_INVALID (M3)', () => {
    const cases: (() => unknown)[] = [
      withNetwork({ identity: 'not-base58!' }),
      withNetwork({ identity: '1111' }),
      withNetwork({ feeModel: 'evm-1559' }),
      withNetwork({ finality: { kind: 'confirmations', confirmations: 32 } }),
      withNetwork({ replacement: { minBumpPercent: 10 } }),
      withNetwork({ capabilities: { add: ['replace-fee'] } }),
      withNetwork({ capabilities: { remove: ['expiry'] } }),
      () =>
        solanaNetworkConfig(
          { ...SOLANA_CHAIN, schemes: ['secp256k1-ecdsa'] } as ChainInfo,
          devnet,
        ),
      () =>
        solanaNetworkConfig({ ...SOLANA_CHAIN, ordering: 'nonce' } as ChainInfo, devnet),
    ];
    for (const run of cases) {
      expect(run).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    }
  });
});
```

`test/adapters/solana/keys.test.ts`:

```ts
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import {
  addressFromPublicKey,
  decodeBase58,
  isAddress,
  isSignature,
} from '../../../src/adapters/solana/keys';

const SEED = '97710888410ad41b69cb42c4f84f954f7c842f259ca6af5be39872a9ded1f3d1';
const ADDRESS = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
const SIGNATURE =
  '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv';

describe('strict Solana keys (lesson 4)', () => {
  it('accepts only canonical base58 of the exact length', () => {
    expect(isAddress(ADDRESS)).toBe(true);
    expect(isAddress('11111111111111111111111111111111')).toBe(true);
    expect(isAddress(SIGNATURE)).toBe(false);
    expect(isSignature(SIGNATURE)).toBe(true);
    expect(isSignature(ADDRESS)).toBe(false);
    // Not base58, 0/O/I/l, padding, whitespace, other types.
    for (const bad of [
      '',
      `${ADDRESS} `,
      ADDRESS.replace('7', '0'),
      ADDRESS.replace('7', 'l'),
      `0x${'ab'.repeat(32)}`,
      32,
      null,
      ['77PL'],
    ]) {
      expect(isAddress(bad)).toBe(false);
    }
    // A leading '1' is a zero byte: 33 bytes is not an address.
    expect(isAddress(`1${ADDRESS}`)).toBe(false);
    expect(decodeBase58(ADDRESS, 32)).toEqual(ed25519.getPublicKey(SEED));
  });

  it('derives the address of an ed25519 public key only', () => {
    expect(addressFromPublicKey(ed25519.getPublicKey(SEED))).toBe(ADDRESS);
    const refused = (key: Uint8Array) =>
      expect(() => addressFromPublicKey(key)).toThrow(
        expect.objectContaining({ code: 'INVALID_ADDRESS' }),
      );
    // A 64-byte secret key (seed ‖ public key), a 33-byte key, an empty key.
    refused(new Uint8Array([...Buffer.from(SEED, 'hex'), ...ed25519.getPublicKey(SEED)]));
    refused(new Uint8Array(33).fill(2));
    refused(new Uint8Array());
    // The identity point is on the curve but of small order.
    refused(ed25519.ExtendedPoint.ZERO.toRawBytes());
    // A y coordinate with no x on the curve.
    let offCurve: Uint8Array | undefined;
    for (let i = 1; !offCurve; i++) {
      const candidate = new Uint8Array(32);
      candidate[0] = i;
      try {
        ed25519.ExtendedPoint.fromHex(candidate);
      } catch {
        offCurve = candidate;
      }
    }
    refused(offCurve);
    expect(base58.encode(offCurve)).not.toBe(ADDRESS);
  });
});
```

`test/adapters/solana/programs.test.ts` (account data from devnet, Appendix A):

```ts
import { base58 } from '@scure/base';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  createAssociatedTokenAccountIdempotent,
  decodeMint,
  decodeTokenAccount,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Account data read from devnet (Plan 5 appendix): the devnet USDC mint and a holder. */
const USDC_MINT_DATA =
  'AQAAAOuFRM+RGCd6ljLpmVBmZRu/sUCLhXPrwC5T76tavw4Lh9zMk85BBuIGAQEAAACoBjP/Bn2I36XUNXv0TibOzM8IZmiBA8a6YJ+kTBjSCA==';
const TOKEN_ACCOUNT_DATA =
  'O0Qss5EhV/E6kz0BNCgtAytf/s0Botvxt3kGCN8ALqdaN3JklJOAkxqwIMNQ2zW6E99wSN2reC/e0jJPIzobcxh2OBYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('Solana instructions, as devnet encodes them', () => {
  it('matches the instruction data of a real transferChecked transaction', () => {
    // Devnet 4DETGWWs…sixv: limit 20000, price 1, transferChecked 1000 (6 decimals), memo.
    expect(hex(setComputeUnitLimit(20_000n).data)).toBe('02204e0000');
    expect(hex(setComputeUnitPrice(1n).data)).toBe('030100000000000000');
    const ix = transferChecked(
      '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
      '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
      1_000n,
      6,
    );
    expect(hex(ix.data)).toBe('0ce80300000000000006');
    expect(ix.programId).toBe(TOKEN_PROGRAM);
    expect(ix.accounts).toEqual([
      {
        address: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
        signer: false,
        writable: true,
      },
      {
        address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        signer: false,
        writable: false,
      },
      {
        address: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
        signer: false,
        writable: true,
      },
      {
        address: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        signer: true,
        writable: false,
      },
    ]);
    expect(
      Buffer.from(memo('83c873a1f7d4c4bcfd6c095906248332').data).toString('utf8'),
    ).toBe('83c873a1f7d4c4bcfd6c095906248332');
  });

  it('matches a real CreateIdempotent and encodes a System transfer', () => {
    // Devnet 3CaZnr7H…3QDY: [payer, ata, wallet, mint, system, token], data 01.
    const ix = createAssociatedTokenAccountIdempotent(
      'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
      'H5ri5hFMzV2WUoaR4WBPELgf9ZxRvHCAnxUro4TGn6C4',
      'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
      'CSqx1AjNB5q71a1Z2uT32LCNVbtcGCQamkgdQQUKk7CA',
    );
    expect(ix.programId).toBe(ASSOCIATED_TOKEN_PROGRAM);
    expect(hex(ix.data)).toBe('01');
    expect(ix.accounts.map((a) => [a.address.slice(0, 6), a.signer, a.writable])).toEqual(
      [
        ['AieRQ9', true, true],
        ['H5ri5h', false, true],
        ['AieRQ9', false, false],
        ['CSqx1A', false, false],
        ['111111', false, false],
        ['Tokenk', false, false],
      ],
    );
    const transfer = systemTransfer(SYSTEM_PROGRAM, TOKEN_PROGRAM, 1_000_000_000n);
    expect(hex(transfer.data)).toBe('0200000000ca9a3b00000000');
  });

  it('decodes classic mints and token accounts strictly', () => {
    const mint = new Uint8Array(Buffer.from(USDC_MINT_DATA, 'base64'));
    expect(decodeMint(mint)).toEqual({ decimals: 6 });
    expect(decodeMint(mint.slice(0, 81))).toBeNull();
    const uninitialized = mint.slice();
    uninitialized[45] = 0;
    expect(decodeMint(uninitialized)).toBeNull();
    const account = new Uint8Array(Buffer.from(TOKEN_ACCOUNT_DATA, 'base64'));
    const decoded = decodeTokenAccount(account);
    expect(decoded && base58.encode(decoded.mint)).toBe(
      '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    expect(decoded && base58.encode(decoded.owner)).toBe(
      '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
    );
    expect(decoded).toMatchObject({ amount: 372_799_000n, frozen: false });
    const frozen = account.slice();
    frozen[108] = 2;
    expect(decodeTokenAccount(frozen)).toMatchObject({ frozen: true });
    const closed = account.slice();
    closed[108] = 0;
    expect(decodeTokenAccount(closed)).toBeNull();
    expect(decodeTokenAccount(mint)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm jest test/adapters/solana/data.test.ts test/adapters/solana/keys.test.ts test/adapters/solana/programs.test.ts`
Expected: FAIL: TypeScript reports "Cannot find module '../../../src/adapters/solana/chains'" (and the other new modules).

- [ ] **Step 3: Write the SDK-free types**

`src/adapters/solana/types.ts`:

```ts
/**
 * SDK-free types of the Solana family: the `ext.solana` API, fee details and overrides, and
 * the narrow `SolanaCodec` that the `@solana/web3.js` module implements (spec §15). Nothing
 * here imports an SDK, so the composition root can export these types.
 */
import type { DisposableNativeClient } from '../../core/driver/types';
import type { CallOptions } from '../../core/transport/types';

// R37: augment the registries through the package entry, as users do with 'crypto-aio'.
declare module '../../index' {
  interface ChainRegistry {
    solana: { family: 'solana'; network: 'mainnet' | 'devnet' | 'testnet' };
  }
  interface FamilyRegistry {
    solana: { library: '@solana/web3.js'; ext: SolanaExt; fee: SolanaFeeDetails };
  }
}

/** One SPL token account (classic Token program) of an owner. */
export interface SolanaTokenAccount {
  /** The token account's own address (an associated token account or any other). */
  readonly address: string;
  readonly mint: string;
  /** Base units of the mint. */
  readonly amount: bigint;
  readonly frozen: boolean;
}

/** `bc.ext.solana`: the Solana family extension (spec §5.5). */
export interface SolanaExt {
  readonly solana: {
    /**
     * The owner's classic SPL token accounts, optionally for one mint, at the `confirmed`
     * commitment. Token-2022 accounts are not listed (Token-2022 is unsupported).
     */
    getTokenAccounts(
      owner: string,
      mint?: string,
    ): Promise<readonly SolanaTokenAccount[]>;
  };
}

/**
 * `FeeEstimate.details` of the `solana` fee kind (lamports; compute-unit price in
 * micro-lamports). The charges are `network` (the signature fee), `priority`
 * (`ceil(computeUnitPrice × computeUnitLimit / 1_000_000)`) and, when the recipient's
 * associated token account is created, `rent`.
 */
export interface SolanaFeeDetails {
  readonly signatures: number;
  /** The signature fee the node quoted for the message (`getFeeForMessage` minus priority). */
  readonly baseFee: bigint;
  readonly computeUnitLimit: bigint;
  /** Micro-lamports per compute unit. */
  readonly computeUnitPrice: bigint;
  readonly priorityFee: bigint;
  /** The rent-exempt deposit of a created associated token account; `0n` otherwise. */
  readonly rent: bigint;
  /** Whether the transaction creates the recipient's associated token account. */
  readonly createsRecipientAccount: boolean;
}

/**
 * An explicit Solana fee (`TransferIntent.fee`): the compute-unit price in micro-lamports
 * and, optionally, the compute-unit limit (1 to 1,400,000), which otherwise comes from a
 * simulation of the transaction.
 */
export interface SolanaFeeOverride {
  readonly computeUnitPrice: bigint;
  readonly computeUnitLimit?: bigint;
}

/**
 * The transport tags every Solana I/O call carries: purpose, retry, quorum, fanout, signal,
 * and optionally the caller's own `quorumKey` (lesson 17), which replaces the method's
 * default consensus key.
 */
export type SolanaCallTags = Pick<
  CallOptions,
  'purpose' | 'retry' | 'quorum' | 'quorumKey' | 'fanout' | 'signal'
>;

export type Commitment = 'confirmed' | 'finalized';

/** One instruction of a transaction we build: program, accounts and data. */
export interface SolanaInstruction {
  readonly programId: string;
  readonly accounts: readonly {
    readonly address: string;
    readonly signer: boolean;
    readonly writable: boolean;
  }[];
  readonly data: Uint8Array;
}

/**
 * The codec work the driver delegates to `@solana/web3.js` (spec §15): program-derived
 * addresses and legacy message compilation. Inputs are already-validated canonical base58
 * keys; outputs are plain bytes and strings, never SDK objects (R11).
 */
export interface SolanaCodec {
  /** The associated token account of `owner` for `mint` (classic Token program). */
  associatedTokenAddress(owner: string, mint: string): string;
  /** The legacy message bytes: header, account keys, recent blockhash, instructions. */
  compileMessage(
    payer: string,
    recentBlockhash: string,
    instructions: readonly SolanaInstruction[],
  ): Uint8Array;
  /** A fresh `Connection` on the same transport, for `crypto-aio/native` (R34). */
  createNative(): DisposableNativeClient;
}
```

- [ ] **Step 4: Write the keys, programs and data modules**

`src/adapters/solana/keys.ts`:

```ts
/**
 * Strict, SDK-free decoding of Solana keys and signatures (lesson 4, R58). Only canonical
 * base58 of exactly 32 (keys) or 64 (signatures) bytes is accepted, so the driver never
 * relies on an SDK's leniency (`new PublicKey()` also takes numbers, arrays and BNs).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import { ValidationError } from '../../core/errors/error';

const ALPHABET = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** The bytes of a canonical base58 string of `length` bytes, or `null`. */
export function decodeBase58(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 90) return null;
  if (!ALPHABET.test(value)) return null;
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    return null;
  }
  // Canonical: exactly `length` bytes, and re-encoding gives the same text back.
  if (bytes.length !== length || base58.encode(bytes) !== value) return null;
  return bytes;
}

export const encodeBase58 = (bytes: Uint8Array): string => base58.encode(bytes);

/** A 32-byte account address (on or off the ed25519 curve: PDAs are addresses too). */
export const isAddress = (value: unknown): value is string =>
  decodeBase58(value, 32) !== null;

/** A 64-byte transaction signature. */
export const isSignature = (value: unknown): value is string =>
  decodeBase58(value, 64) !== null;

/**
 * The address of a wallet's ed25519 public key: exactly 32 bytes that decode to a point on
 * the curve and not of small order. Anything else (a 64-byte secret key, a 32-byte seed
 * that is off the curve, the identity point) is refused with `INVALID_ADDRESS`.
 */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'a Solana public key is exactly 32 bytes',
    );
  }
  let point: ReturnType<typeof ed25519.ExtendedPoint.fromHex>;
  try {
    point = ed25519.ExtendedPoint.fromHex(publicKey);
  } catch {
    throw new ValidationError(
      'INVALID_ADDRESS',
      'the public key is not a point on the ed25519 curve',
    );
  }
  if (point.isSmallOrder()) {
    throw new ValidationError('INVALID_ADDRESS', 'the public key has small order');
  }
  return base58.encode(publicKey);
}
```

`src/adapters/solana/programs.ts`:

```ts
/**
 * Solana program ids, account layouts and the instructions the driver builds, SDK-free (spec
 * §15: "built without `@solana/spl-token`"). Every encoding is checked against a real devnet
 * transaction and `@solana/web3.js`'s own builders (Plan 5 appendix and `codec.test.ts`).
 */
import type { SolanaInstruction } from './types';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** The first Memo program; still parsed on received transactions. */
export const MEMO_V1_PROGRAM = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';

/** Classic Token program account sizes (bytes). */
export const MINT_SIZE = 82;
export const TOKEN_ACCOUNT_SIZE = 165;
/** A transaction's maximum serialized size (the network packet limit). */
export const MAX_TRANSACTION_SIZE = 1232;
/** The compute-unit limit of one transaction, and the default per instruction. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;
export const DEFAULT_INSTRUCTION_COMPUTE_UNITS = 200_000n;
/** Memo text limit (UTF-8 bytes): a library policy that keeps every transfer well under
 *  the packet limit. */
export const MAX_MEMO_BYTES = 256;

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

const bytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const signer = (address: string, writable: boolean) => ({
  address,
  signer: true,
  writable,
});
const account = (address: string, writable: boolean) => ({
  address,
  signer: false,
  writable,
});

/** ComputeBudget `SetComputeUnitLimit` (2, u32). */
export function setComputeUnitLimit(units: bigint): SolanaInstruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: bytes(Uint8Array.of(2), u32(Number(units))),
  };
}

/** ComputeBudget `SetComputeUnitPrice` (3, u64 micro-lamports). */
export function setComputeUnitPrice(microLamports: bigint): SolanaInstruction {
  return {
    programId: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: bytes(Uint8Array.of(3), u64(microLamports)),
  };
}

/** System `Transfer` (2, u64 lamports). */
export function systemTransfer(
  from: string,
  to: string,
  lamports: bigint,
): SolanaInstruction {
  return {
    programId: SYSTEM_PROGRAM,
    accounts: [signer(from, true), account(to, true)],
    data: bytes(u32(2), u64(lamports)),
  };
}

/** Associated Token Account `CreateIdempotent` (1). */
export function createAssociatedTokenAccountIdempotent(
  payer: string,
  associated: string,
  owner: string,
  mint: string,
): SolanaInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      signer(payer, true),
      account(associated, true),
      account(owner, false),
      account(mint, false),
      account(SYSTEM_PROGRAM, false),
      account(TOKEN_PROGRAM, false),
    ],
    data: Uint8Array.of(1),
  };
}

/** Token `TransferChecked` (12, u64 amount, u8 decimals). */
export function transferChecked(
  source: string,
  mint: string,
  destination: string,
  authority: string,
  amount: bigint,
  decimals: number,
): SolanaInstruction {
  return {
    programId: TOKEN_PROGRAM,
    accounts: [
      account(source, true),
      account(mint, false),
      account(destination, true),
      signer(authority, false),
    ],
    data: bytes(Uint8Array.of(12), u64(amount), Uint8Array.of(decimals)),
  };
}

/** Memo v2: the UTF-8 text, no accounts. */
export function memo(text: string): SolanaInstruction {
  return { programId: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode(text) };
}

/** A classic Token mint (82 bytes): its decimals, when initialized. */
export function decodeMint(data: Uint8Array): { readonly decimals: number } | null {
  if (data.length !== MINT_SIZE || data[45] !== 1) return null;
  return { decimals: data[44] as number };
}

/** A classic Token account (165 bytes): mint, owner, amount and state. */
export function decodeTokenAccount(data: Uint8Array): {
  readonly mint: Uint8Array;
  readonly owner: Uint8Array;
  readonly amount: bigint;
  readonly frozen: boolean;
} | null {
  if (data.length !== TOKEN_ACCOUNT_SIZE) return null;
  const state = data[108];
  if (state !== 1 && state !== 2) return null;
  return {
    mint: data.slice(0, 32),
    owner: data.slice(32, 64),
    amount: new DataView(data.buffer, data.byteOffset + 64, 8).getBigUint64(0, true),
    frozen: state === 2,
  };
}
```

`src/adapters/solana/chains.ts`:

```ts
/**
 * The built-in Solana chain and its clusters (spec §2). Every value is verified against the
 * source named in the Plan 5 appendix, or is a documented library policy:
 * - `identity`: the cluster's genesis hash (`getGenesisHash`), checked on every endpoint.
 * - `finality`: the `finalized` commitment.
 * - `defaultConfirmations: 1`: `waitForConfirmation` waits for inclusion at `confirmed` by
 *   default; credit deposits on `final`.
 * - `reorgWindow: 64` and `maxLagBlocks: 150`: library policies in block heights (a
 *   blockhash is valid for 150 blocks, so an endpoint further behind cannot judge expiry).
 */
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';

const EXPLORER = 'https://explorer.solana.com';

function cluster(
  id: 'mainnet' | 'devnet' | 'testnet',
  genesisHash: string,
  explorerCluster?: 'devnet' | 'testnet',
): NetworkInfo {
  const query = explorerCluster ? `?cluster=${explorerCluster}` : '';
  return {
    id,
    identity: genesisHash,
    testnet: id !== 'mainnet',
    feeModel: 'solana',
    finality: { kind: 'commitment', level: 'finalized' },
    defaultConfirmations: 1,
    reorgWindow: 64,
    maxLagBlocks: 150,
    explorer: {
      tx: `${EXPLORER}/tx/{id}${query}`,
      address: `${EXPLORER}/address/{address}${query}`,
    },
  };
}

/** Freezes plain data all the way down (R56). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const SOLANA_CHAIN: ChainInfo = deepFreeze({
  id: 'solana',
  family: 'solana',
  model: 'account',
  ordering: 'expiry',
  schemes: ['ed25519'],
  nativeAsset: { symbol: 'SOL', decimals: 9, name: 'Solana' },
  defaultNetwork: 'mainnet',
  networks: {
    mainnet: cluster('mainnet', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    devnet: cluster('devnet', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'devnet'),
    testnet: cluster(
      'testnet',
      '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
      'testnet',
    ),
  },
});
```

`src/adapters/solana/presets.ts`:

```ts
/**
 * Solana provider presets (spec §11). Only URL templates verified against the provider's
 * own documentation are listed (Plan 5 appendix); a preset refuses every other cluster with
 * `CONFIG_INVALID`. Keyed URLs are `Secret`s, so the key never reaches logs or errors.
 */
import { ConfigError } from '../../core/errors/error';
import type { PresetInput, ProviderPreset } from '../../core/registry/providers';
import { reveal, secret } from '../../core/secret/secret';
import type { EndpointConfig } from '../../core/transport/types';

type Table = Readonly<Record<string, string>>;

/** The rate-limited public endpoints the Solana documentation lists (not for production). */
const PUBLIC: Table = {
  mainnet: 'https://api.mainnet.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

/** `https://<host>.g.alchemy.com/v2/<key>`. */
const ALCHEMY: Table = { mainnet: 'solana-mainnet', devnet: 'solana-devnet' };

/** `https://<host>.infura.io/v3/<key>`. */
const INFURA: Table = { mainnet: 'solana-mainnet', devnet: 'solana-devnet' };

/** `https://rpc.ankr.com/<path>/<key>`. */
const ANKR: Table = { mainnet: 'solana', devnet: 'solana_devnet' };

const supports =
  (table: Table) =>
  (chain: string, network: string): boolean =>
    chain === 'solana' && Object.hasOwn(table, network);

function entry(table: Table, input: PresetInput): string {
  const value = Object.hasOwn(table, input.network) ? table[input.network] : undefined;
  // Unreachable through the catalog, which asks `supports` first.
  if (value === undefined)
    throw new Error(`no entry for ${input.chain}:${input.network}`);
  return value;
}

/** The revealed key; the error names the preset and network, never the key. */
function apiKeyOf(name: string, input: PresetInput): string {
  const key: unknown = input.apiKey === undefined ? undefined : reveal(input.apiKey);
  if (typeof key !== 'string' || key.trim() === '') {
    throw new ConfigError(
      'CONFIG_INVALID',
      `provider preset '${name}' requires a non-empty apiKey for ${input.chain}:${input.network}`,
    );
  }
  return key;
}

function keyed(
  name: string,
  table: Table,
  url: (value: string, key: string) => string,
): ProviderPreset {
  return {
    name,
    kind: 'rpc',
    requiresApiKey: true,
    supports: supports(table),
    endpoints: (input): readonly EndpointConfig[] => [
      { name, url: secret(url(entry(table, input), apiKeyOf(name, input))) },
    ],
  };
}

export const SOLANA_PRESETS: readonly ProviderPreset[] = Object.freeze([
  {
    name: 'public',
    kind: 'rpc',
    production: false,
    supports: supports(PUBLIC),
    endpoints: (input: PresetInput) => [{ name: 'public', url: entry(PUBLIC, input) }],
  },
  keyed('alchemy', ALCHEMY, (host, key) => `https://${host}.g.alchemy.com/v2/${key}`),
  keyed('infura', INFURA, (host, key) => `https://${host}.infura.io/v3/${key}`),
  keyed('ankr', ANKR, (path, key) => `https://rpc.ankr.com/${path}/${key}`),
]);
```

`src/adapters/solana/tokens.ts`:

```ts
/**
 * Well-known SPL tokens (spec §6.2): USDC and USDT where their issuers list a Solana mint
 * (Circle's USDC addresses page, Tether's supported-protocols page). All are classic Token
 * program mints with 6 decimals, read from the chain (Plan 5 appendix).
 */
import type { AssetRegistration } from '../../core/registry/assets';
import { deepFreeze } from './chains';

function token(
  network: 'mainnet' | 'devnet',
  symbol: 'USDC' | 'USDT',
  mint: string,
): AssetRegistration {
  return {
    chain: 'solana',
    network,
    ref: { standard: 'spl', contract: mint },
    metadata: { symbol, decimals: 6 },
    aliases: [symbol],
  };
}

export const SOLANA_TOKENS: readonly AssetRegistration[] = deepFreeze([
  token('mainnet', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  token('mainnet', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  token('devnet', 'USDC', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
]);
```

`src/adapters/solana/network.ts`:

```ts
/**
 * What the Solana driver needs from a network's registry entry, validated once when a
 * driver is created, so inconsistent data fails with `CONFIG_INVALID` instead of
 * misbehaving (M3).
 */
import { ConfigError } from '../../core/errors/error';
import type { Capability } from '../../core/model/capability';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import { decodeBase58 } from './keys';

/** Every capability a Solana network has; a network may remove some. */
export const SOLANA_CAPABILITIES: readonly Capability[] = Object.freeze([
  'tokens',
  'memo',
  'block-scan',
  'address-history',
  'expiry',
]);

export interface SolanaNetworkConfig {
  /** The genesis hash every endpoint must report (`getGenesisHash`). */
  readonly genesisHash: string;
  readonly capabilities: ReadonlySet<Capability>;
}

export function solanaNetworkConfig(
  chain: ChainInfo,
  network: NetworkInfo,
): SolanaNetworkConfig {
  const fail = (reason: string): never => {
    throw new ConfigError(
      'CONFIG_INVALID',
      `Solana network ${chain.id}:${network.id}: ${reason}`,
    );
  };
  if (chain.model !== 'account' || chain.ordering !== 'expiry') {
    fail('the chain must use the account model and expiry ordering');
  }
  if (chain.schemes.length !== 1 || chain.schemes[0] !== 'ed25519') {
    fail(`its only scheme must be 'ed25519'`);
  }
  if (chain.nativeAsset.decimals !== 9)
    fail('the native asset has 9 decimals (lamports)');
  if (decodeBase58(network.identity, 32) === null) {
    fail('its identity must be the base58 genesis hash');
  }
  if (network.feeModel !== 'solana') fail(`its fee model must be 'solana'`);
  const { finality } = network;
  if (finality.kind !== 'commitment' || finality.level !== 'finalized') {
    fail(`its finality must be the 'finalized' commitment`);
  }
  if (network.replacement !== undefined) fail('Solana has no replace or cancel');
  const capabilities = new Set<Capability>(SOLANA_CAPABILITIES);
  for (const c of network.capabilities?.add ?? []) capabilities.add(c);
  for (const c of network.capabilities?.remove ?? []) capabilities.delete(c);
  for (const c of ['replace-fee', 'cancel', 'batch-transfer'] as const) {
    if (capabilities.has(c)) fail(`the Solana driver cannot offer '${c}'`);
  }
  if (!capabilities.has('expiry')) fail(`'expiry' is how Solana orders transactions`);
  return { genesisHash: network.identity as string, capabilities };
}
```

- [ ] **Step 5: Export the public types from the package root (R55)**

`types.ts` augments `FamilyRegistry` with `SolanaExt` and `SolanaFeeDetails`, so `pnpm doc` needs them exported now. Append to `src/index.ts`, after the EVM type exports that Plan 2 added:

```ts
export type {
  SolanaExt,
  SolanaFeeDetails,
  SolanaFeeOverride,
  SolanaTokenAccount,
} from './adapters/solana/types';
```

(Plan 2 Task 10 changed the comment above its export to name `crypto-aio/evm`; Task 9 extends it to name `crypto-aio/solana` too.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm jest test/adapters/solana/data.test.ts test/adapters/solana/keys.test.ts test/adapters/solana/programs.test.ts`
Expected: PASS, 12 tests (7 + 2 + 3).

- [ ] **Step 7: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all green; `pnpm doc` 0 warnings.

```bash
git add src/adapters/solana/types.ts src/adapters/solana/keys.ts src/adapters/solana/programs.ts src/adapters/solana/chains.ts src/adapters/solana/presets.ts src/adapters/solana/tokens.ts src/adapters/solana/network.ts src/index.ts test/adapters/solana/data.test.ts test/adapters/solana/keys.test.ts test/adapters/solana/programs.test.ts
git commit -m "feat(solana): chain data, presets, tokens, keys, programs and SDK-free types

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: The transport path, the fee policy and broadcast classification

**Files:**
- Create: `src/adapters/solana/rpc.ts`, `src/adapters/solana/fees.ts`, `src/adapters/solana/errors.ts`
- Test: `test/adapters/solana/policy.test.ts`

**Interfaces:**
- Consumes: Task 0 (`CallOptions.exactIntegers`); Task 1 (`SolanaCallTags`, `Commitment`, `SolanaFeeDetails`, `SolanaFeeOverride`, `DEFAULT_INSTRUCTION_COMPUTE_UNITS`, `MAX_COMPUTE_UNIT_LIMIT`); `Transport`, `ProviderError`, `ValidationError`, `isCryptoAioError`, `canonicalJson`, `BroadcastResult`, `FeeEstimateDraft`.
- Produces:
  - `rpc.ts`: tag constants `READ`, `MONITOR`, `PROOF`, `BROADCAST`, `withSignal(tags, signal?)`; `RPC_CODES` (incl. `FILTER_TRANSACTION_NOT_FOUND: -32020`); `rpcCode(error)`, `rpcMessage(error)`; the split "cannot show it" predicates (I3) `isNotYet` (`-32004`, `-32014`, `-32016`), `isGone` (`-32001`, `-32009`, `-32011`, `-32019`), `isSkipped` (`-32007`) and their union `isNotAvailable`; error makers `notYet(what)` and `gone(what)` (retryable `PROVIDER_UNAVAILABLE`), `malformed(what)` (retryable `PROVIDER_UNAVAILABLE`), `inconsistent(what)` (retryable `PROVIDER_INCONSISTENT`), `undecided(error, what)` (lesson 18, widened: an `RPC_ERROR` becomes a retryable `PROVIDER_UNAVAILABLE` with the node's message; any other error is returned unchanged; used by Tasks 6 and 8, R1); validators `u64(value, what)`, `amountString(value, what)`, `contextValue(result, what)`, `blockHeader(result): BlockHeader { blockhash, previousBlockhash, parentSlot, blockHeight, blockTime? }`; `pick(value, keys)` and `BLOCK_FIELDS` (a block's consensus fields); `quorumKeyFor(method)`; `call(transport, method, params, tags)` (sets `exactIntegers: true`; a caller `quorumKey` in the tags replaces the method's default); `headerOptions(commitment)`, `parsedOptions(commitment)`.
  - `fees.ts`: `SPEED_PERCENTILE`, `computeUnitLimitFor(units)`, `fallbackComputeUnitLimit(instructions)`, `VARIANTS`, `variantOffsets(variant)`, `variantCounter(start)`, `priorityFee(price, limit)`, `priceForSpeed(recent, speed)`, `parseOverride(fee)`, `feeDraft(speed, details)`, `detailsOf(fee)`, `lamportsCharged(fee)`.
  - `errors.ts`: `classifyBroadcastError(code, message): BroadcastResult` (frozen results).

**Review points:**
- Every call sets `exactIntegers: true` (D19) and passes the caller's tags unchanged; a caller `quorumKey` wins (lesson 17 plumbing).
- The `getTransaction` quorum key covers every field a verdict reads (slot, error, signatures, account keys, token balances, token-transfer instructions) and ignores formatting, including the order of the token balances (lesson 2, R59, M7); a throwing key counts as a disagreement.
- "Not yet" and "gone" are distinct (I3): only "not yet" may become `null` downstream.
- `rejected` only for the two anchored signature texts under their own codes; the default is `TX_REFUSED` with a fixed reason; no reason carries an address or amount (lesson 3, R24).
- "Not available" codes are matched only on definitive, non-ambiguous `RPC_ERROR`s; on proof paths every other `RPC_ERROR` goes through `undecided` (Tasks 6 and 8), so no RPC error is ever a verdict.
- Fee math is bigint only; the priority fee rounds up; overrides reject unknown keys and out-of-range values.

- [ ] **Step 1: Write the failing test**

`test/adapters/solana/policy.test.ts`:

```ts
import { classifyBroadcastError } from '../../../src/adapters/solana/errors';
import {
  VARIANTS,
  computeUnitLimitFor,
  detailsOf,
  fallbackComputeUnitLimit,
  feeDraft,
  parseOverride,
  priceForSpeed,
  priorityFee,
  variantCounter,
  variantOffsets,
} from '../../../src/adapters/solana/fees';
import {
  MONITOR,
  PROOF,
  amountString,
  blockHeader,
  call,
  contextValue,
  isGone,
  isNotAvailable,
  isNotYet,
  isSkipped,
  quorumKeyFor,
  rpcCode,
  u64,
} from '../../../src/adapters/solana/rpc';
import type { Transport } from '../../../src/core/transport/types';
import { ProviderError } from '../../../src/core/errors/error';
import { canonicalJson } from '../../../src/core/util/json';

const rpcError = (code: number, message: string, ambiguous = false) =>
  new ProviderError('RPC_ERROR', `x failed: ${message}`, {
    details: { rpcCode: code, rpcMessage: message },
    ambiguous,
  });

describe('Solana answers', () => {
  it('reads u64 values exactly, and never a rounded JSON number', () => {
    expect(u64(0, 'x')).toBe(0n);
    expect(u64(Number.MAX_SAFE_INTEGER, 'x')).toBe(9_007_199_254_740_991n);
    expect(u64(18_446_744_073_709_551_615n, 'x')).toBe(2n ** 64n - 1n);
    // Every call parses with exactIntegers, so a rounded number is refused, never guessed.
    for (const bad of [2 ** 60, -1, 1.5, '5', null, 2n ** 64n, -1n]) {
      expect(() => u64(bad, 'x')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
    expect(amountString('18446744073709551615', 'x')).toBe(2n ** 64n - 1n);
    for (const bad of ['18446744073709551616', '01', '-1', '1.0', 5]) {
      expect(() => amountString(bad, 'x')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
      );
    }
    expect(contextValue({ context: { slot: 1 }, value: null }, 'x')).toBeNull();
    expect(() => contextValue({ value: 1 }, 'x')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
    expect(() =>
      blockHeader({
        blockhash: 'a',
        previousBlockhash: 'b',
        parentSlot: 1,
        blockHeight: null,
      }),
    ).toThrow(expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }));
  });

  it('treats only definitive "cannot show it" codes as not available, split by meaning (I3)', () => {
    for (const code of [-32001, -32004, -32007, -32009, -32011, -32014, -32016, -32019]) {
      expect(isNotAvailable(rpcError(code, 'x'))).toBe(true);
    }
    const kinds = (code: number) =>
      [isNotYet, isGone, isSkipped].map((is) => is(rpcError(code, 'x')));
    expect([-32004, -32014, -32016].map(kinds)).toEqual(
      Array(3).fill([true, false, false]),
    );
    expect([-32001, -32009, -32011, -32019].map(kinds)).toEqual(
      Array(4).fill([false, true, false]),
    );
    expect(kinds(-32007)).toEqual([false, false, true]);
    expect(isNotAvailable(rpcError(-32004, 'x', true))).toBe(false);
    expect(isNotAvailable(rpcError(-32002, 'x'))).toBe(false);
    expect(isNotAvailable(new ProviderError('PROVIDER_UNAVAILABLE', 'down'))).toBe(false);
    expect(rpcCode(rpcError(-32002, 'x', true))).toBeUndefined();
    expect(rpcCode(new Error('foreign'))).toBeUndefined();
  });
});

describe('call()', () => {
  it('parses every answer with exact integers and carries the caller tags (P5-A, lesson 17)', async () => {
    const seen: unknown[] = [];
    const transport = {
      rpc: (method: string, params: unknown, options: unknown) => {
        seen.push({ method, params, options });
        return Promise.resolve(null);
      },
    } as unknown as Transport;
    const key = (value: unknown) => value;
    await call(transport, 'getBlockHeight', [], MONITOR);
    await call(transport, 'getBlock', [1], PROOF);
    await call(transport, 'getBlockHeight', [], { ...PROOF, quorumKey: key });
    expect(seen).toEqual([
      {
        method: 'getBlockHeight',
        params: [],
        options: { purpose: 'monitor', retry: 'safe', exactIntegers: true },
      },
      {
        method: 'getBlock',
        params: [1],
        options: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          quorumKey: expect.any(Function),
          exactIntegers: true,
        },
      },
      {
        method: 'getBlockHeight',
        params: [],
        options: {
          purpose: 'proof',
          retry: 'safe',
          quorum: 'proof',
          quorumKey: key,
          exactIntegers: true,
        },
      },
    ]);
  });
});

describe('quorum keys (lesson 2, Review Focus 2)', () => {
  const key = quorumKeyFor('getTransaction')!;
  /** A finalized transaction as two honest providers format it differently. */
  const base = (overrides: Record<string, unknown> = {}) => ({
    slot: 42,
    blockTime: 1_790_000_000,
    meta: {
      err: null,
      fee: 5000,
      computeUnitsConsumed: 1234,
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          owner: 'O',
          programId: 'T',
          uiTokenAmount: {
            amount: '10',
            decimals: 6,
            uiAmount: 0.00001,
            uiAmountString: '0.00001',
          },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          owner: 'O',
          programId: 'T',
          uiTokenAmount: {
            amount: '7',
            decimals: 6,
            uiAmount: 0.000007,
            uiAmountString: '0.000007',
          },
        },
      ],
      innerInstructions: [],
      logMessages: ['Program log: x'],
      ...overrides,
    },
    transaction: {
      signatures: ['S'],
      message: {
        accountKeys: [
          { pubkey: 'A', signer: true, writable: true, source: 'transaction' },
          { pubkey: 'B', signer: false, writable: true },
        ],
        instructions: [
          {
            program: 'spl-token',
            programId: 'T',
            parsed: {
              type: 'transferChecked',
              info: {
                source: 'B',
                destination: 'C',
                authority: 'A',
                mint: 'M',
                tokenAmount: { amount: '3', decimals: 6, uiAmount: 0.000003 },
              },
            },
            stackHeight: 1,
          },
        ],
      },
    },
    version: 'legacy',
  });

  it('ignores formatting that honest providers differ on', () => {
    const other = base({
      computeUnitsConsumed: undefined,
      costUnits: 99,
      logMessages: [],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          uiTokenAmount: { amount: '10', decimals: 6, uiAmount: null },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: 'M',
          uiTokenAmount: { amount: '7', decimals: 6, uiAmount: null },
        },
      ],
    });
    (other.transaction.message.instructions[0] as Record<string, unknown>).stackHeight =
      null;
    (other as Record<string, unknown>).blockTime = null;
    expect(canonicalJson(key(other))).toBe(canonicalJson(key(base())));
    // M7: another implementation may list token balances in another order.
    const second = { accountIndex: 0, mint: 'M', uiTokenAmount: { amount: '1' } };
    const ordered = base({
      postTokenBalances: [second, ...(base().meta.postTokenBalances as object[])],
    });
    const reordered = base({
      postTokenBalances: [...(base().meta.postTokenBalances as object[]), second],
    });
    expect(canonicalJson(key(reordered))).toBe(canonicalJson(key(ordered)));
  });

  it('disagrees on any fact a verdict reads', () => {
    const facts = canonicalJson(key(base()));
    const changed = [
      base({ err: { InstructionError: [0, { Custom: 1 }] } }),
      base({
        postTokenBalances: [
          { accountIndex: 1, mint: 'M', uiTokenAmount: { amount: '8' } },
        ],
      }),
      { ...base(), slot: 43 },
    ];
    for (const tx of changed) expect(canonicalJson(key(tx))).not.toBe(facts);
    expect(key(null)).toBeNull();
    expect(() => key(5)).toThrow();
    expect(
      canonicalJson(
        quorumKeyFor('getBlock')!({
          blockhash: 'h',
          previousBlockhash: 'p',
          parentSlot: 1,
          blockHeight: 2,
          blockTime: 9,
          rewards: [],
        }),
      ),
    ).toBe(
      canonicalJson({
        blockhash: 'h',
        previousBlockhash: 'p',
        parentSlot: 1,
        blockHeight: 2,
      }),
    );
    expect(quorumKeyFor('getBalance')).toBeUndefined();
  });
});

describe('the fee policy', () => {
  it('prices speeds by percentile of recent prioritization fees', () => {
    const recent = [0, 0, 10, 20, 30, 40, 50, 60].map((fee, slot) => ({
      prioritizationFee: fee,
      slot,
    }));
    expect(priceForSpeed(recent, 'slow')).toBe(0n);
    expect(priceForSpeed(recent, 'normal')).toBe(20n);
    expect(priceForSpeed(recent, 'fast')).toBe(40n);
    expect(priceForSpeed([], 'fast')).toBe(0n);
    for (const bad of [
      null,
      [{ prioritizationFee: -1 }],
      [{ prioritizationFee: 1.5 }],
      [{}],
    ]) {
      expect(() => priceForSpeed(bad, 'normal')).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
  });

  it('computes limits and priority fees in bigint, rounding the fee up', () => {
    expect(computeUnitLimitFor(10_000n)).toBe(13_000n);
    expect(computeUnitLimitFor(1_300_000n)).toBe(1_400_000n);
    expect(fallbackComputeUnitLimit(3)).toBe(600_000n);
    expect(fallbackComputeUnitLimit(8)).toBe(1_400_000n);
    expect(priorityFee(1n, 20_000n)).toBe(1n);
    expect(priorityFee(0n, 1_400_000n)).toBe(0n);
    expect(priorityFee(1_000_001n, 30_000n)).toBe(30_001n);
  });

  it('keeps build variants distinct and small', () => {
    const next = variantCounter(VARIANTS - 1);
    expect([next(), next(), next()]).toEqual([VARIANTS - 1, 0, 1]);
    expect(variantOffsets(0)).toEqual({ limit: 0n, price: 0n });
    expect(variantOffsets(VARIANTS - 1)).toEqual({ limit: 1_023n, price: 999n });
    const seen = new Set<string>();
    for (let v = 0; v < 5_000; v++) seen.add(canonicalJson(variantOffsets(v)));
    expect(seen.size).toBe(5_000);
  });

  it('accepts only a well-formed override', () => {
    expect(parseOverride({ computeUnitPrice: 5n })).toEqual({ computeUnitPrice: 5n });
    expect(parseOverride({ computeUnitPrice: 0n, computeUnitLimit: 1_400_000n })).toEqual(
      {
        computeUnitPrice: 0n,
        computeUnitLimit: 1_400_000n,
      },
    );
    for (const bad of [
      {},
      { computeUnitPrice: 5 },
      { computeUnitPrice: -1n },
      { computeUnitPrice: 2n ** 64n },
      { computeUnitPrice: 1n, computeUnitLimit: 0n },
      { computeUnitPrice: 1n, computeUnitLimit: 1_400_001n },
      { computeUnitPrice: 1n, gasPrice: 1n },
    ]) {
      expect(() => parseOverride(bad)).toThrow(
        expect.objectContaining({ code: 'INVALID_INTENT' }),
      );
    }
  });

  it('charges network, priority and rent, and bounds the estimate by the rent', () => {
    const details = {
      signatures: 1,
      baseFee: 5_000n,
      computeUnitLimit: 26_000n,
      computeUnitPrice: 1_000n,
      priorityFee: 26n,
      rent: 1_488_440n,
      createsRecipientAccount: true,
    };
    const draft = feeDraft('fast', details);
    expect(draft).toMatchObject({ kind: 'solana', speed: 'fast', bound: 'upper' });
    expect(draft.charges.map((c) => [c.label, c.amount])).toEqual([
      ['network', 5_000n],
      ['priority', 26n],
      ['rent', 1_488_440n],
    ]);
    const exact = feeDraft('custom', {
      ...details,
      rent: 0n,
      createsRecipientAccount: false,
    });
    expect([exact.bound, exact.charges.length]).toEqual(['exact', 2]);
    expect(detailsOf(draft)).toEqual(details);
    expect(() => detailsOf({ ...draft, kind: 'evm-1559' })).toThrow(
      expect.objectContaining({ code: 'INVALID_INTENT' }),
    );
  });
});

describe('broadcast classification (lesson 3, R24)', () => {
  const pre = 'Transaction simulation failed: ';
  it.each([
    [
      -32002,
      `${pre}This transaction has already been processed`,
      { kind: 'already-known' },
    ],
    [
      -32002,
      `${pre}Transaction did not pass signature verification`,
      { kind: 'rejected', reason: 'invalid signature' },
    ],
    [
      -32003,
      'Transaction signature verification failure',
      { kind: 'rejected', reason: 'invalid signature' },
    ],
    [
      -32002,
      `${pre}Blockhash not found`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'blockhash not found' },
    ],
    [
      -32002,
      `${pre}Attempt to debit an account but found no record of a prior credit.`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    [
      -32002,
      `${pre}Insufficient funds for fee`,
      {
        kind: 'refused',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'insufficient funds for fee',
      },
    ],
    [
      -32002,
      `${pre}Transaction results in an account (1) with insufficient funds for rent`,
      {
        kind: 'refused',
        code: 'INSUFFICIENT_FUNDS',
        reason: 'insufficient funds for rent',
      },
    ],
    [
      -32002,
      `${pre}Error processing Instruction 3: custom program error: 0x1`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    [
      -32002,
      `${pre}Error processing Instruction 2: insufficient funds for instruction`,
      { kind: 'refused', code: 'INSUFFICIENT_FUNDS', reason: 'insufficient funds' },
    ],
    // State, fork, version or node policy: refused, never rejected.
    [
      -32002,
      `${pre}Error processing Instruction 3: custom program error: 0x11`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction version is unsupported`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction failed to sanitize accounts offsets correctly`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32602,
      'failed to deserialize solana_transaction::versioned::VersionedTransaction: io error',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32005,
      'Node is behind by 42 slots',
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    // A signature text under an unrelated code, or with a suffix, is not trusted.
    [
      -32602,
      `${pre}Transaction did not pass signature verification`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
    [
      -32002,
      `${pre}Transaction did not pass signature verification (key 7xKX…)`,
      { kind: 'refused', code: 'TX_REFUSED', reason: 'refused by the node' },
    ],
  ])('%i %s', (code, message, expected) => {
    const result = classifyBroadcastError(code, message);
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    if ('reason' in result)
      expect(result.reason).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/policy.test.ts`
Expected: FAIL: "Cannot find module '../../../src/adapters/solana/errors'".

- [ ] **Step 3: Write the transport path**

`src/adapters/solana/rpc.ts`:

```ts
/**
 * The Solana driver's path to the core transport (spec §11, lesson 1). Every JSON-RPC call
 * is one direct `transport.rpc` call carrying the tags of the `ChainDriver` method that made
 * it; `@solana/web3.js` is never on a request path. Answers are validated here: a malformed
 * answer is a retryable `PROVIDER_UNAVAILABLE`, never a foreign error (lesson 6).
 */
import {
  ProviderError,
  isCryptoAioError,
  type CryptoAioError,
} from '../../core/errors/error';
import type { Transport } from '../../core/transport/types';
import { canonicalJson } from '../../core/util/json';
import type { Commitment, SolanaCallTags } from './types';

export const READ: SolanaCallTags = Object.freeze({ purpose: 'read', retry: 'safe' });
export const MONITOR: SolanaCallTags = Object.freeze({
  purpose: 'monitor',
  retry: 'safe',
});
export const PROOF: SolanaCallTags = Object.freeze({
  purpose: 'proof',
  retry: 'safe',
  quorum: 'proof',
});
export const BROADCAST: SolanaCallTags = Object.freeze({
  purpose: 'broadcast',
  retry: 'ambiguous-on-failure',
});

export const withSignal = (tags: SolanaCallTags, signal?: AbortSignal): SolanaCallTags =>
  signal ? { ...tags, signal } : tags;

/** Solana's JSON-RPC server errors (agave `rpc-client-api/src/custom_error.rs`). */
export const RPC_CODES = Object.freeze({
  BLOCK_CLEANED_UP: -32001,
  SEND_TRANSACTION_PREFLIGHT_FAILURE: -32002,
  TRANSACTION_SIGNATURE_VERIFICATION_FAILURE: -32003,
  BLOCK_NOT_AVAILABLE: -32004,
  SLOT_SKIPPED: -32007,
  LONG_TERM_STORAGE_SLOT_SKIPPED: -32009,
  TRANSACTION_HISTORY_NOT_AVAILABLE: -32011,
  BLOCK_STATUS_NOT_AVAILABLE_YET: -32014,
  MIN_CONTEXT_SLOT_NOT_REACHED: -32016,
  LONG_TERM_STORAGE_UNREACHABLE: -32019,
  FILTER_TRANSACTION_NOT_FOUND: -32020,
});

/** "Not yet": the endpoint has not reached that slot or state. */
const NOT_YET = new Set<number>([
  RPC_CODES.BLOCK_NOT_AVAILABLE,
  RPC_CODES.BLOCK_STATUS_NOT_AVAILABLE_YET,
  RPC_CODES.MIN_CONTEXT_SLOT_NOT_REACHED,
]);

/** "No longer, or never here": pruned, not in long-term storage, or no history at all. */
const GONE = new Set<number>([
  RPC_CODES.BLOCK_CLEANED_UP,
  RPC_CODES.LONG_TERM_STORAGE_SLOT_SKIPPED,
  RPC_CODES.TRANSACTION_HISTORY_NOT_AVAILABLE,
  RPC_CODES.LONG_TERM_STORAGE_UNREACHABLE,
]);

/** The JSON-RPC code of a definitive, non-ambiguous `RPC_ERROR`; otherwise `undefined`. */
export function rpcCode(error: unknown): number | undefined {
  if (!isCryptoAioError(error, 'RPC_ERROR') || error.ambiguous) return undefined;
  const code = error.details?.rpcCode;
  return typeof code === 'number' ? code : undefined;
}

/** The node's message of a definitive, non-ambiguous `RPC_ERROR`. */
export function rpcMessage(error: CryptoAioError): string {
  return String(error.details?.rpcMessage ?? error.message);
}

const hasCode = (error: unknown, codes: ReadonlySet<number>): boolean => {
  const code = rpcCode(error);
  return code !== undefined && codes.has(code);
};

/** The endpoint has not reached that block or state yet (`null`, decides nothing). */
export const isNotYet = (error: unknown): boolean => hasCode(error, NOT_YET);

/** The endpoint no longer holds that block or history, or never did (decides nothing). */
export const isGone = (error: unknown): boolean => hasCode(error, GONE);

/** The endpoint says the slot holds no block (`-32007`). */
export const isSkipped = (error: unknown): boolean =>
  rpcCode(error) === RPC_CODES.SLOT_SKIPPED;

/** Any answer meaning "this endpoint cannot show that": it never decides anything. */
export const isNotAvailable = (error: unknown): boolean =>
  isNotYet(error) || isGone(error) || isSkipped(error);

/** A retryable error that decides nothing: the endpoint no longer holds what was asked. */
export const gone = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `the endpoint no longer holds ${what}`);

/** A retryable error that decides nothing: the endpoints cannot show this yet. */
export const notYet = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `the endpoints cannot show ${what} yet`);

/**
 * Lesson 18, widened: on a proof path only a definitive negative proof answers "no". Any
 * other definitive RPC error (agave 4.3.0's `getBlocks` answers `-32602 "BigTable query
 * failed"` for a range below its local ledger, `-32603` on a blockstore error) decides
 * nothing: it becomes a retryable `PROVIDER_UNAVAILABLE`. Every other error (retryable
 * ones, `PROVIDER_MISCONFIGURED`) is returned unchanged.
 */
export function undecided(error: unknown, what: string): unknown {
  if (!isCryptoAioError(error, 'RPC_ERROR')) return error;
  return new ProviderError(
    'PROVIDER_UNAVAILABLE',
    `the endpoints cannot show ${what}: ${rpcMessage(error)}`,
    {
      cause: error,
      context: error.context,
      ...(error.details ? { details: error.details } : {}),
    },
  );
}

export const malformed = (what: string) =>
  new ProviderError('PROVIDER_UNAVAILABLE', `malformed ${what} answer`);

export const inconsistent = (what: string) =>
  new ProviderError('PROVIDER_INCONSISTENT', what, { retryable: true });

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * An unsigned 64-bit JSON integer (lamports, slots, heights) as a `bigint`. Every call
 * parses with `exactIntegers` (P5-A), so a value above 2^53 − 1 arrives as a `bigint`; a
 * number outside the safe range was rounded somewhere and is refused as malformed.
 */
export function u64(value: unknown, what: string): bigint {
  if (typeof value === 'bigint' && value >= 0n && value < 2n ** 64n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw malformed(what);
}

/** A decimal string of base units (token amounts), as a `bigint`. */
export function amountString(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw malformed(what);
  }
  const amount = BigInt(value);
  if (amount >= 2n ** 64n) throw malformed(what);
  return amount;
}

/** The `value` of an RPC response with context (`{ context: { slot }, value }`). */
export function contextValue(result: unknown, what: string): unknown {
  const body = record(result);
  if (!body || !record(body.context) || !('value' in body)) throw malformed(what);
  return body.value;
}

/** A block header as `getBlock` returns it with `transactionDetails: 'none'`. */
export interface BlockHeader {
  readonly blockhash: string;
  readonly previousBlockhash: string;
  readonly parentSlot: bigint;
  readonly blockHeight: bigint;
  /** Unix seconds, when the node estimates one. */
  readonly blockTime?: number;
}

export function blockHeader(result: unknown): BlockHeader {
  const block = record(result);
  if (!block) throw malformed('getBlock');
  const { blockhash, previousBlockhash, parentSlot, blockHeight, blockTime } = block;
  if (typeof blockhash !== 'string' || typeof previousBlockhash !== 'string') {
    throw malformed('getBlock');
  }
  // Blocks from before block heights were recorded (2020) carry `blockHeight: null`.
  if (blockHeight === null) throw malformed('getBlock (no block height)');
  return {
    blockhash,
    previousBlockhash,
    parentSlot: u64(parentSlot, 'parent slot'),
    blockHeight: u64(blockHeight, 'block height'),
    ...(typeof blockTime === 'number' && Number.isSafeInteger(blockTime)
      ? { blockTime }
      : {}),
  };
}

export const pick = (value: unknown, keys: readonly string[]): unknown => {
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(keys.map((key) => [key, object[key] ?? null]));
};

/** The consensus fields of a block header, compared under a quorum. */
export const BLOCK_FIELDS = [
  'blockhash',
  'previousBlockhash',
  'parentSlot',
  'blockHeight',
] as const;

/** The token-program instructions (outer and inner) projected to what a verdict reads. */
function tokenInstructions(tx: Record<string, unknown>): unknown[] {
  const message = record(record(tx.transaction)?.message);
  const meta = record(tx.meta);
  const outer = Array.isArray(message?.instructions) ? message.instructions : [];
  const inner = Array.isArray(meta?.innerInstructions)
    ? meta.innerInstructions.flatMap((group) => {
        const list = record(group)?.instructions;
        return Array.isArray(list) ? list : [];
      })
    : [];
  return [...outer, ...inner].flatMap((ix) => {
    const instruction = record(ix);
    const parsed = record(instruction?.parsed);
    const info = record(parsed?.info);
    if (instruction?.program !== 'spl-token' || !parsed || !info) return [];
    return [
      {
        programId: instruction.programId ?? null,
        type: parsed.type ?? null,
        source: info.source ?? null,
        destination: info.destination ?? null,
        authority: info.authority ?? info.multisigAuthority ?? null,
        mint: info.mint ?? null,
        amount: info.amount ?? record(info.tokenAmount)?.amount ?? null,
      },
    ];
  });
}

/** Token balances by account index (M7: providers may list them in another order). */
const tokenBalances = (list: unknown): unknown =>
  Array.isArray(list)
    ? list
        .map((entry) => {
          const balance = record(entry);
          return {
            accountIndex: balance?.accountIndex ?? null,
            mint: balance?.mint ?? null,
            amount: record(balance?.uiTokenAmount)?.amount ?? null,
          };
        })
        .sort((a, b) => Number(a.accountIndex) - Number(b.accountIndex))
    : null;

/**
 * R59, lesson 2: a finalized transaction's consensus facts, as far as a verdict reads them
 * (slot, error, signatures, account keys, token balances, token transfer instructions).
 * Formatting that honest providers differ on (`uiAmount` floats, `stackHeight`, `owner` and
 * `programId` on balances, log messages, compute units, `blockTime`) is left out.
 */
function transactionKey(result: unknown): unknown {
  if (result === null) return null;
  const tx = record(result);
  if (!tx) throw malformed('getTransaction');
  const meta = record(tx.meta);
  const message = record(record(tx.transaction)?.message);
  const keys = Array.isArray(message?.accountKeys)
    ? message.accountKeys.map((key) => record(key)?.pubkey ?? key)
    : null;
  return {
    slot: tx.slot ?? null,
    err: canonicalJson(meta?.err ?? null),
    signatures: record(tx.transaction)?.signatures ?? null,
    accountKeys: keys,
    preTokenBalances: tokenBalances(meta?.preTokenBalances),
    postTokenBalances: tokenBalances(meta?.postTokenBalances),
    tokenInstructions: tokenInstructions(tx),
  };
}

/**
 * The consensus facts compared under a quorum, per method (lesson 2). A key that throws
 * counts as a disagreement (a retryable `PROVIDER_INCONSISTENT`).
 */
export function quorumKeyFor(method: string): ((result: unknown) => unknown) | undefined {
  switch (method) {
    case 'getBlock':
      return (result) => pick(result, BLOCK_FIELDS);
    case 'getTransaction':
      return transactionKey;
    default:
      return undefined;
  }
}

/**
 * One JSON-RPC call through the transport, under the calling driver method's tags. Solana
 * sends u64 values (lamports) as JSON numbers, so every answer is parsed with
 * `exactIntegers` (P5-A): nothing above 2^53 − 1 is ever rounded.
 */
export function call(
  transport: Transport,
  method: string,
  params: readonly unknown[],
  tags: SolanaCallTags,
): Promise<unknown> {
  const quorumKey =
    tags.quorum !== undefined ? (tags.quorumKey ?? quorumKeyFor(method)) : undefined;
  return transport.rpc(method, params, {
    ...tags,
    ...(quorumKey ? { quorumKey } : {}),
    exactIntegers: true,
  });
}

/** `getBlock` options for a header (no transactions, no rewards). */
export const headerOptions = (commitment: Commitment) => ({
  commitment,
  transactionDetails: 'none',
  rewards: false,
});

/** `getBlock`/`getTransaction` options for decoding (every transaction version we parse). */
export const parsedOptions = (commitment: Commitment) => ({
  commitment,
  encoding: 'jsonParsed',
  maxSupportedTransactionVersion: 0,
});
```

- [ ] **Step 4: Write the fee policy and the classification**

`src/adapters/solana/fees.ts`:

```ts
/**
 * The Solana fee policy (spec §6.5, §15: base fee plus priority), pure and bigint-only. The
 * priority fee is `ceil(computeUnitPrice × computeUnitLimit / 1_000_000)` lamports, charged
 * on the requested limit (Solana's fee documentation, Plan 5 appendix).
 */
import { ProviderError, ValidationError } from '../../core/errors/error';
import type {
  FeeChargeDraft,
  FeeEstimateDraft,
  FeeOverride,
  FeeSpeed,
} from '../../core/model/fee';
import { DEFAULT_INSTRUCTION_COMPUTE_UNITS, MAX_COMPUTE_UNIT_LIMIT } from './programs';
import type { SolanaFeeDetails, SolanaFeeOverride } from './types';

/** Library policy: the percentile of recent prioritization fees each speed pays. */
export const SPEED_PERCENTILE: Readonly<Record<FeeSpeed, number>> = Object.freeze({
  slow: 25,
  normal: 50,
  fast: 75,
});

/** Library policy: the compute-unit limit is the simulated usage plus 20% and 1,000 units. */
export function computeUnitLimitFor(unitsConsumed: bigint): bigint {
  const limit = unitsConsumed + unitsConsumed / 5n + 1_000n;
  return limit > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : limit;
}

/** The runtime's own default when a simulation cannot measure the transaction. */
export function fallbackComputeUnitLimit(instructions: number): bigint {
  const limit = DEFAULT_INSTRUCTION_COMPUTE_UNITS * BigInt(instructions);
  return limit > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : limit;
}

/**
 * Build variants (Plan 5 D10): identical intents built on the same blockhash would
 * sign byte-identical messages, so a second Operation would silently share the first one's
 * signature and one payment would be lost. Each estimate therefore adds a variant to the
 * compute-unit limit (0 to 1,023 units) and, for a speed, to the price (0 to 999
 * micro-lamports): at most about one lamport of priority fee per 1,000 compute units.
 */
export const VARIANTS = 1_024 * 1_000;

export function variantOffsets(variant: number): {
  readonly limit: bigint;
  readonly price: bigint;
} {
  return {
    limit: BigInt(variant % 1_024),
    price: BigInt(Math.floor(variant / 1_024) % 1_000),
  };
}

/** A per-driver counter from a random start: distinct in-process, rare across processes. */
export function variantCounter(start: number): () => number {
  let next = start % VARIANTS;
  return () => {
    const variant = next;
    next = (next + 1) % VARIANTS;
    return variant;
  };
}

export function priorityFee(computeUnitPrice: bigint, computeUnitLimit: bigint): bigint {
  return (computeUnitPrice * computeUnitLimit + 999_999n) / 1_000_000n;
}

/**
 * The nearest-rank percentile of `getRecentPrioritizationFees` answers (micro-lamports per
 * compute unit); `0n` when the node reports none. A malformed entry is a retryable
 * `PROVIDER_UNAVAILABLE`.
 */
export function priceForSpeed(recent: unknown, speed: FeeSpeed): bigint {
  if (!Array.isArray(recent)) {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'malformed getRecentPrioritizationFees answer',
    );
  }
  const fees = recent.map((entry: unknown) => {
    const fee = (entry as { prioritizationFee?: unknown } | null)?.prioritizationFee;
    if (typeof fee === 'bigint' && fee >= 0n) return fee;
    if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0) {
      throw new ProviderError(
        'PROVIDER_UNAVAILABLE',
        'malformed getRecentPrioritizationFees answer',
      );
    }
    return BigInt(fee);
  });
  if (fees.length === 0) return 0n;
  fees.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.ceil((SPEED_PERCENTILE[speed] / 100) * fees.length);
  return fees[Math.max(0, rank - 1)] as bigint;
}

/** A validated `SolanaFeeOverride`; anything else is `INVALID_INTENT`. */
export function parseOverride(fee: FeeOverride): SolanaFeeOverride {
  const invalid = (reason: string) =>
    new ValidationError('INVALID_INTENT', `Solana fee override: ${reason}`);
  const keys = Object.keys(fee);
  if (keys.some((key) => key !== 'computeUnitPrice' && key !== 'computeUnitLimit')) {
    throw invalid('only computeUnitPrice and computeUnitLimit are allowed');
  }
  const { computeUnitPrice, computeUnitLimit } = fee;
  if (
    typeof computeUnitPrice !== 'bigint' ||
    computeUnitPrice < 0n ||
    computeUnitPrice >= 2n ** 64n
  ) {
    throw invalid('computeUnitPrice must be a bigint of micro-lamports in the u64 range');
  }
  if (
    computeUnitLimit !== undefined &&
    (typeof computeUnitLimit !== 'bigint' ||
      computeUnitLimit < 1n ||
      computeUnitLimit > MAX_COMPUTE_UNIT_LIMIT)
  ) {
    throw invalid('computeUnitLimit must be a bigint from 1 to 1,400,000');
  }
  return {
    computeUnitPrice,
    ...(computeUnitLimit !== undefined ? { computeUnitLimit } : {}),
  };
}

/**
 * The fee draft: `network` (the signature fee), `priority` and, when the recipient's token
 * account is created, `rent`. The bound is `exact` unless rent is charged: that deposit is
 * skipped when someone else creates the account first, so it is an upper bound.
 */
export function feeDraft(
  speed: FeeSpeed | 'custom',
  details: SolanaFeeDetails,
): FeeEstimateDraft {
  const charges: FeeChargeDraft[] = [
    { asset: 'native', amount: details.baseFee, label: 'network' },
    { asset: 'native', amount: details.priorityFee, label: 'priority' },
  ];
  if (details.createsRecipientAccount) {
    charges.push({ asset: 'native', amount: details.rent, label: 'rent' });
  }
  return {
    kind: 'solana',
    speed,
    charges,
    bound: details.createsRecipientAccount ? 'upper' : 'exact',
    details: { ...details },
  };
}

/** The `SolanaFeeDetails` of a draft this driver made; anything else is `INVALID_INTENT`. */
export function detailsOf(fee: FeeEstimateDraft): SolanaFeeDetails {
  const d = fee.details as Partial<SolanaFeeDetails>;
  if (
    fee.kind !== 'solana' ||
    typeof d.computeUnitLimit !== 'bigint' ||
    typeof d.computeUnitPrice !== 'bigint' ||
    typeof d.baseFee !== 'bigint' ||
    typeof d.priorityFee !== 'bigint' ||
    typeof d.rent !== 'bigint' ||
    typeof d.signatures !== 'number' ||
    typeof d.createsRecipientAccount !== 'boolean'
  ) {
    throw new ValidationError('INVALID_INTENT', 'not a Solana fee estimate');
  }
  return {
    signatures: d.signatures,
    baseFee: d.baseFee,
    computeUnitLimit: d.computeUnitLimit,
    computeUnitPrice: d.computeUnitPrice,
    priorityFee: d.priorityFee,
    rent: d.rent,
    createsRecipientAccount: d.createsRecipientAccount,
  };
}

/** The lamports every fee charge of `fee` adds up to. */
export const lamportsCharged = (fee: FeeEstimateDraft): bigint =>
  fee.charges.reduce((sum, charge) => sum + charge.amount, 0n);
```

`src/adapters/solana/errors.ts`:

```ts
/**
 * Broadcast classification (spec §6.7, §8.3; lesson 3). `rejected` is only for bytes that
 * are invalid by construction on every node: a signature that does not verify. Everything
 * that depends on state, time, fork or node policy (an unknown or expired blockhash,
 * balances, rent, account locks, versions, sizes) is `refused`, and so is every text not
 * listed. Reasons are fixed literals that never repeat the node's text (R24). Texts are
 * agave's `TransactionError` displays behind `sendTransaction`'s preflight prefix.
 */
import type { BroadcastResult } from '../../core/driver/types';
import { RPC_CODES } from './rpc';

const PREFLIGHT = 'Transaction simulation failed: ';

/** Anchored, whole-message texts. */
const ALREADY_KNOWN = [`${PREFLIGHT}This transaction has already been processed`];

const REJECTED: readonly { readonly text: string; readonly reason: string }[] = [
  {
    text: `${PREFLIGHT}Transaction did not pass signature verification`,
    reason: 'invalid signature',
  },
  { text: 'Transaction signature verification failure', reason: 'invalid signature' },
];

type Refused = Extract<BroadcastResult, { kind: 'refused' }>;

const refused = (code: Refused['code'], reason: string): Refused =>
  Object.freeze({ kind: 'refused', code, reason });

const REFUSED: readonly { readonly pattern: RegExp; readonly result: Refused }[] = [
  {
    pattern: /^Transaction simulation failed: Blockhash not found$/,
    result: refused('TX_REFUSED', 'blockhash not found'),
  },
  {
    pattern:
      /^Transaction simulation failed: Attempt to debit an account but found no record of a prior credit\.$/,
    result: refused('INSUFFICIENT_FUNDS', 'insufficient funds'),
  },
  {
    pattern: /^Transaction simulation failed: Insufficient funds for fee$/,
    result: refused('INSUFFICIENT_FUNDS', 'insufficient funds for fee'),
  },
  {
    pattern:
      /^Transaction simulation failed: Transaction results in an account \(\d+\) with insufficient funds for rent$/,
    result: refused('INSUFFICIENT_FUNDS', 'insufficient funds for rent'),
  },
  {
    // System `ResultWithNegativeLamports` and Token `InsufficientFunds` are both error 1,
    // the only programs of ours that return it.
    pattern:
      /^Transaction simulation failed: Error processing Instruction \d+: custom program error: 0x1$/,
    result: refused('INSUFFICIENT_FUNDS', 'insufficient funds'),
  },
  {
    pattern:
      /^Transaction simulation failed: Error processing Instruction \d+: insufficient funds for instruction$/,
    result: refused('INSUFFICIENT_FUNDS', 'insufficient funds'),
  },
];

const DEFAULT_REFUSAL = refused('TX_REFUSED', 'refused by the node');

/** Classifies a definitive `sendTransaction` error (code and message). */
export function classifyBroadcastError(
  code: number | undefined,
  message: string,
): BroadcastResult {
  if (ALREADY_KNOWN.includes(message)) return Object.freeze({ kind: 'already-known' });
  const rejected = REJECTED.find((entry) => entry.text === message);
  if (
    rejected &&
    (code === RPC_CODES.SEND_TRANSACTION_PREFLIGHT_FAILURE ||
      code === RPC_CODES.TRANSACTION_SIGNATURE_VERIFICATION_FAILURE)
  ) {
    return Object.freeze({ kind: 'rejected', reason: rejected.reason });
  }
  return REFUSED.find((entry) => entry.pattern.test(message))?.result ?? DEFAULT_REFUSAL;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/policy.test.ts`
Expected: PASS, 26 tests (16 of them the classification table).

- [ ] **Step 6: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add src/adapters/solana/rpc.ts src/adapters/solana/fees.ts src/adapters/solana/errors.ts test/adapters/solana/policy.test.ts
git commit -m "feat(solana): transport path, fee policy and broadcast classification

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: The SDK dependency, the web3.js codec and the wire format

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Create: `src/adapters/solana/web3.ts` (codec only; Task 8 appends the driver factory), `src/adapters/solana/wire.ts`
- Create (test support): `test/adapters/solana/support/vectors.ts`
- Test: `test/adapters/solana/codec.test.ts`

**Interfaces:**
- Consumes: Task 1 (`SolanaCodec`, `SolanaInstruction`, program builders, `encodeBase58`), Task 2 (`READ`, `BROADCAST`); `PLACEHOLDER_ORIGIN`, `Transport.createFetch`.
- Produces:
  - `web3.ts`: `createWeb3Codec(transport): SolanaCodec`. `associatedTokenAddress` uses `PublicKey.findProgramAddressSync([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM)`; `compileMessage` uses `TransactionMessage.compileToLegacyMessage()` and returns plain bytes; `createNative()` returns a fresh `Connection` per call on `${PLACEHOLDER_ORIGIN}/` with `fetch: transport.createFetch(classify)` (`sendTransaction` → broadcast tags, everything else read tags), `httpAgent: false`, `disableRetryOnRateLimit: true`, `commitment: 'confirmed'`; its `close` closes the websocket client if one was opened.
  - `wire.ts`: `encodeLength(n)`, `decodeLength(bytes, offset)`, `messageSigners(message)` (legacy only; `null` otherwise), `signedTransaction(signatures, message)`.
  - Test support `vectors.ts`: `KEY`, `KEY_PUBLIC`, `KEY_ADDRESS`, `RECIPIENT_KEY`, `RECIPIENT`, `MINT`, `sign(message, key?)`, `compileLegacy(payer, blockhash, instructions)` (an independent encoder).

**Review points:**
- The SDK is pinned exactly (`1.99.0`) as a devDependency and offered as an optional peer (`^1.99.0`); `dependencies` is unchanged. Task 9's peer-pin test checks all three against `SOLANA_PEER_DEPENDENCIES`.
- `web3.ts` imports the SDK by its bare peer name, `@solana/web3.js` (R80: the core's `DEPENDENCY_MISSING` matches that name).
- The override is the only change to `pnpm-workspace.yaml` (ruling A13); the lockfile shows `rpc-websockets@9.3.9` → `uuid@11.1.1`. The "Ignored build scripts: bufferutil, utf-8-validate" warning is expected (optional native `ws` add-ons); do not approve them.
- The frozen vectors match the independent encoder byte for byte and verify under `@noble/curves` (lesson 11); the SDK re-parses our signed layout unchanged.
- No SDK object leaves `web3.ts` except the native `Connection` (R11).

- [ ] **Step 1: Re-check and install the SDK, with the Jest override**

Run: `npm view @solana/web3.js version`
Expected: `1.99.0`. If a later 1.x shows, still pin `1.99.0`: it is the version this plan was validated against.

Add to `pnpm-workspace.yaml`, after the `onlyBuiltDependencies` list:

```yaml
overrides:
  rpc-websockets>uuid: ^11.1.1
```

Run: `pnpm add -D -E @solana/web3.js@1.99.0`
Expected: `devDependencies` gains `"@solana/web3.js": "1.99.0"`; `pnpm-lock.yaml` gains an `overrides:` block with `rpc-websockets>uuid: ^11.1.1`, `@solana/web3.js@1.99.0`, `rpc-websockets@9.3.9` depending on `uuid: 11.1.1`; pnpm warns "Ignored build scripts: bufferutil, utf-8-validate".

In `package.json`, add as the first entry of `"peerDependencies"` (keys stay alphabetical, before Plan 2's `ethers`):

```json
    "@solana/web3.js": "^1.99.0",
```

and as the first entry of `"peerDependenciesMeta"`:

```json
    "@solana/web3.js": { "optional": true },
```

Run: `pnpm install --frozen-lockfile && node -e "require('@solana/web3.js')"`
Expected: no error. `test/architecture/boundaries.test.ts` still passes (`dependencies` unchanged).

- [ ] **Step 2: Write the failing test**

`test/adapters/solana/support/vectors.ts`:

```ts
/**
 * Test keys (never funded anywhere real) and an independent, SDK-free legacy message
 * encoder (`@noble/*`, `@scure/base`) that the codec vectors are checked against (lesson 11).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import type { SolanaInstruction } from '../../../../src/adapters/solana/types';

/** sha256("crypto-aio solana test key") as an ed25519 seed. */
export const KEY = '97710888410ad41b69cb42c4f84f954f7c842f259ca6af5be39872a9ded1f3d1';
export const KEY_PUBLIC = ed25519.getPublicKey(KEY);
export const KEY_ADDRESS = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
/** sha256("crypto-aio solana recipient"). */
export const RECIPIENT_KEY =
  '8b27be3ee021903655f39e7795662247b046070031091cf3f046f76ec4cd416b';
export const RECIPIENT = '6zYdUwXJR5fhQJazDByGv4PsNrdaNhoruAR5kekA7rGs';
/** sha256("crypto-aio solana mint"): a mint address for the scripted node. */
export const MINT = '3DqxN72sPTL4ahhvF18v1cTwc3ViRHXB8SSZ9P2wt21E';

export const sign = (message: Uint8Array, key = KEY): Uint8Array =>
  ed25519.sign(message, key);

const shortvec = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest) byte |= 0x80;
    out.push(byte);
  } while (rest);
  return out;
};

/**
 * A legacy message by the Solana message rules: the payer first, then signers
 * (writable, then read-only) and non-signers (writable, then read-only), each group in
 * order of first appearance, an instruction's program id before its accounts.
 */
export function compileLegacy(
  payer: string,
  blockhash: string,
  instructions: readonly SolanaInstruction[],
): Uint8Array {
  const meta = new Map<string, { signer: boolean; writable: boolean }>();
  const note = (address: string, signer: boolean, writable: boolean) => {
    const seen = meta.get(address);
    meta.set(address, {
      signer: (seen?.signer ?? false) || signer,
      writable: (seen?.writable ?? false) || writable,
    });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    note(ix.programId, false, false);
    for (const a of ix.accounts) note(a.address, a.signer, a.writable);
  }
  const entries = [...meta.entries()];
  const group = (signer: boolean, writable: boolean) =>
    entries
      .filter(([, m]) => m.signer === signer && m.writable === writable)
      .map(([k]) => k);
  const keys = [
    ...group(true, true),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ];
  const header = [
    group(true, true).length + group(true, false).length,
    group(true, false).length,
    group(false, false).length,
  ];
  const out: number[] = [...header, ...shortvec(keys.length)];
  for (const key of keys) out.push(...base58.decode(key));
  out.push(...base58.decode(blockhash), ...shortvec(instructions.length));
  for (const ix of instructions) {
    out.push(keys.indexOf(ix.programId), ...shortvec(ix.accounts.length));
    for (const a of ix.accounts) out.push(keys.indexOf(a.address));
    out.push(...shortvec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}
```

`test/adapters/solana/codec.test.ts`:

```ts
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotent,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { createWeb3Codec } from '../../../src/adapters/solana/web3';
import {
  decodeLength,
  encodeLength,
  messageSigners,
  signedTransaction,
} from '../../../src/adapters/solana/wire';
import {
  KEY_ADDRESS,
  KEY_PUBLIC,
  MINT,
  RECIPIENT,
  compileLegacy,
  sign,
} from './support/vectors';

const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SOURCE_ATA = 'CCYv891E1JjJ834xKsRFvmdu1Q6W5TQy6UzGg6mCBLcA';
const RECIPIENT_ATA = 'H3yGizipXnUp5JJxpFDikUCHFevydZH6ajimjQQzayUU';

/** Frozen vectors: generated once with @solana/web3.js 1.99.0, cross-checked below. */
const VECTORS = [
  {
    name: 'native transfer with memo',
    instructions: [
      setComputeUnitLimit(16_000n),
      setComputeUnitPrice(1_000n),
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_500_000_000n),
      memo('order-7'),
    ],
    message:
      'AQADBVrI3WBGoGnLbCiVIYOFWFd514dJhL1jlWvYiBgVkg2PWQhNw70tZsh/gPw8EyCOwEcJz96KrMegP3Hw7r6XzpwDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUpTWpkpIQZNJOhxYNo4fHw1td28kruB5B+oQEEFRI3OWdtQgPwsbTvPfKkHEtPC5ebCjyfw37uZU72wiUwDqwQCAAUCgD4AAAIACQPoAwAAAAAAAAMCAAEMAgAAAAAvaFkAAAAABAAHb3JkZXItNw==',
    signature:
      '3gLw2weFTqCxcyAK3Vq3DbtjUJC8dyTo2ikvYBdBexoprNf2Mtmy8ByumTFpfs31LH4szn4pDJ3XgYd5n8fAomEZ',
  },
  {
    name: 'SPL transferChecked creating the recipient account',
    instructions: [
      setComputeUnitLimit(26_000n),
      setComputeUnitPrice(0n),
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, RECIPIENT_ATA, RECIPIENT, MINT),
      transferChecked(SOURCE_ATA, MINT, RECIPIENT_ATA, KEY_ADDRESS, 2_000_000n, 6),
    ],
    message:
      'AQAGCVrI3WBGoGnLbCiVIYOFWFd514dJhL1jlWvYiBgVkg2P7n3HQ++iJT4YiDF8r3is4hXVdfBf5H2bgF0X6xYgffGmZghT39AeTr57eL9MxCsAJpBCpkUYSd8pTAWoX8E0IwMGRm/lIRcy/+ytunLDm+e8jOW7xfcSayxDmzpAAAAAjJclj04kifG7PRApFI4NgwtaE5na/xCEBI572Nvp+FlZCE3DvS1myH+A/DwTII7ARwnP3oqsx6A/cfDuvpfOnCEBsld1ikGCfxegz/jNUMAhHo+nLb+ldQOVRPnq+b2pAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAG3fbh12Whk9nL4UbO63msHLSF7V9bN5E6jPWFfv8Aqc5Z21CA/CxtO898qQcS08Ll5sKPJ/Dfu5lTvbCJTAOrBAMABQKQZQAAAwAJAwAAAAAAAAAABAYAAQUGBwgBAQgEAgYBAAoMgIQeAAAAAAAG',
    signature:
      '2m3dQsMFMSp4xP9KHq2hzE4Xb3hF7Zi26wVrk9wKSTC3Uih2SVNMDrtxnC28o3Eb193PjVyJNkhZMwwVN1At6ZLf',
  },
];

describe('the @solana/web3.js codec (lesson 11)', () => {
  // Codec work needs no transport; only `createNative` uses one.
  const codec = createWeb3Codec(undefined as never);

  it.each(VECTORS)('compiles $name to the frozen, independently derived bytes', (v) => {
    const message = codec.compileMessage(KEY_ADDRESS, BLOCKHASH, v.instructions);
    expect(Buffer.from(message).toString('base64')).toBe(v.message);
    expect(compileLegacy(KEY_ADDRESS, BLOCKHASH, v.instructions)).toEqual(message);
    const signature = sign(message);
    expect(base58.encode(signature)).toBe(v.signature);
    expect(ed25519.verify(signature, message, KEY_PUBLIC, { zip215: false })).toBe(true);
    // Our signed layout is exactly what the SDK parses and writes back.
    const raw = signedTransaction([signature], message);
    const parsed = VersionedTransaction.deserialize(raw);
    expect(base58.encode(parsed.signatures[0] as Uint8Array)).toBe(v.signature);
    expect(Buffer.from(parsed.serialize())).toEqual(Buffer.from(raw));
    expect(messageSigners(message)).toEqual([KEY_ADDRESS]);
  });

  it('builds System and ComputeBudget data exactly as the SDK does', () => {
    const sdk = SystemProgram.transfer({
      fromPubkey: new PublicKey(KEY_ADDRESS),
      toPubkey: new PublicKey(RECIPIENT),
      lamports: 1_500_000_000n,
    });
    const ours = systemTransfer(KEY_ADDRESS, RECIPIENT, 1_500_000_000n);
    expect(Buffer.from(ours.data)).toEqual(Buffer.from(sdk.data));
    expect(ours.accounts.map((a) => [a.address, a.signer, a.writable])).toEqual(
      sdk.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    );
    expect(Buffer.from(setComputeUnitLimit(123_456n).data)).toEqual(
      Buffer.from(ComputeBudgetProgram.setComputeUnitLimit({ units: 123_456 }).data),
    );
    expect(Buffer.from(setComputeUnitPrice(2n ** 63n).data)).toEqual(
      Buffer.from(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2n ** 63n }).data,
      ),
    );
  });

  it('derives associated token addresses as the chain does', () => {
    // Devnet 3CaZnr7H…3QDY created H5ri5h… for AieRQ9…'s CSqx1A… tokens.
    expect(
      codec.associatedTokenAddress(
        'AieRQ9D3hx1fs8Tuj3UbKZgRnLtJq88Zi5a1KUbHnCE6',
        'CSqx1AjNB5q71a1Z2uT32LCNVbtcGCQamkgdQQUKk7CA',
      ),
    ).toBe('H5ri5hFMzV2WUoaR4WBPELgf9ZxRvHCAnxUro4TGn6C4');
    expect(codec.associatedTokenAddress(KEY_ADDRESS, MINT)).toBe(SOURCE_ATA);
  });

  it('reads and writes compact-u16 lengths and refuses versioned or empty messages', () => {
    for (const value of [0, 1, 127, 128, 255, 16_383, 16_384, 65_535]) {
      const bytes = encodeLength(value);
      expect(decodeLength(Uint8Array.from([9, ...bytes]), 1)).toEqual({
        value,
        next: 1 + bytes.length,
      });
    }
    expect(Array.from(encodeLength(128))).toEqual([0x80, 0x01]);
    expect(decodeLength(Uint8Array.of(0x80), 0)).toBeNull();
    const message = Buffer.from(VECTORS[0]!.message, 'base64');
    expect(messageSigners(Uint8Array.from([0x80, ...message]))).toBeNull();
    expect(messageSigners(Uint8Array.from([0, ...message.subarray(1)]))).toBeNull();
    expect(messageSigners(message.subarray(0, 20))).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/codec.test.ts`
Expected: FAIL: "Cannot find module '../../../src/adapters/solana/web3'".

- [ ] **Step 4: Write the wire format and the codec**

`src/adapters/solana/wire.ts`:

```ts
/**
 * The Solana wire format the driver reads and writes itself, SDK-free: compact-u16 lengths,
 * a legacy message's header and signer keys, and a signed transaction (signatures followed
 * by the message). Message compilation stays with the SDK (`web3.ts`).
 */
import { encodeBase58 } from './keys';

/** Solana's compact-u16 ("shortvec") length prefix. */
export function encodeLength(value: number): Uint8Array {
  const out: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return Uint8Array.from(out);
    }
    out.push(byte | 0x80);
  }
}

/** A compact-u16 at `offset`: its value and the offset after it, or `null`. */
export function decodeLength(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | null {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  return null;
}

/** A legacy message's required signer count and signer addresses, in order. */
export function messageSigners(message: Uint8Array): readonly string[] | null {
  const required = message[0];
  // A versioned message starts with 0x80 | version; the driver only builds legacy ones.
  if (required === undefined || required === 0 || (required & 0x80) !== 0) return null;
  const count = decodeLength(message, 3);
  if (!count || count.value < required) return null;
  const signers: string[] = [];
  for (let i = 0; i < required; i++) {
    const start = count.next + 32 * i;
    const key = message.slice(start, start + 32);
    if (key.length !== 32) return null;
    signers.push(encodeBase58(key));
  }
  return signers;
}

/** A signed transaction: the signatures, in signer order, then the message. */
export function signedTransaction(
  signatures: readonly Uint8Array[],
  message: Uint8Array,
): Uint8Array {
  const prefix = encodeLength(signatures.length);
  const out = new Uint8Array(prefix.length + 64 * signatures.length + message.length);
  out.set(prefix, 0);
  signatures.forEach((signature, i) => out.set(signature, prefix.length + 64 * i));
  out.set(message, prefix.length + 64 * signatures.length);
  return out;
}
```

`src/adapters/solana/web3.ts`:

```ts
/**
 * The only module that imports `@solana/web3.js` (spec §15): program-derived addresses,
 * legacy message compilation and the `crypto-aio/native` `Connection`. It is never on a
 * driver request path (lesson 1): the driver sends every request straight to the
 * transport, and the native `Connection` reaches the same transport through
 * `transport.createFetch` (spec §11).
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { PLACEHOLDER_ORIGIN, type Transport } from '../../core/transport/types';
import { ASSOCIATED_TOKEN_PROGRAM, TOKEN_PROGRAM } from './programs';
import { BROADCAST, READ } from './rpc';
import type { SolanaCodec } from './types';

const TOKEN = new PublicKey(TOKEN_PROGRAM);
const ASSOCIATED_TOKEN = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

/** The tags of a native client's requests: plain reads, and broadcasts for sends. */
function classify(_url: URL, init: RequestInit | undefined) {
  const body = typeof init?.body === 'string' ? init.body : '';
  return /"method"\s*:\s*"sendTransaction"/.test(body) ? BROADCAST : READ;
}

export function createWeb3Codec(transport: Transport): SolanaCodec {
  return {
    associatedTokenAddress(owner, mint) {
      const [address] = PublicKey.findProgramAddressSync(
        [
          new PublicKey(owner).toBuffer(),
          TOKEN.toBuffer(),
          new PublicKey(mint).toBuffer(),
        ],
        ASSOCIATED_TOKEN,
      );
      return address.toBase58();
    },
    compileMessage(payer, recentBlockhash, instructions) {
      const message = new TransactionMessage({
        payerKey: new PublicKey(payer),
        recentBlockhash,
        instructions: instructions.map(
          (ix) =>
            new TransactionInstruction({
              programId: new PublicKey(ix.programId),
              keys: ix.accounts.map((a) => ({
                pubkey: new PublicKey(a.address),
                isSigner: a.signer,
                isWritable: a.writable,
              })),
              data: Buffer.from(ix.data),
            }),
        ),
      }).compileToLegacyMessage();
      return new Uint8Array(message.serialize());
    },
    createNative() {
      const connection = new Connection(`${PLACEHOLDER_ORIGIN}/`, {
        commitment: 'confirmed',
        fetch: transport.createFetch(classify),
        httpAgent: false,
        disableRetryOnRateLimit: true,
      });
      return {
        client: connection,
        close: () => {
          // Subscriptions have no transport bridge; close the idle socket client if used.
          const socket = (connection as unknown as { _rpcWebSocket?: { close(): void } })
            ._rpcWebSocket;
          socket?.close();
        },
      };
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/codec.test.ts`
Expected: PASS, 5 tests (the two vectors run as two).

- [ ] **Step 6: Prove determinism (lesson 1)**

Run: `for i in $(seq 1 100); do pnpm jest test/adapters/solana/codec.test.ts --silent >/dev/null 2>&1 || { echo "failed on run $i"; exit 1; }; done; echo '100/100 green'`
Expected: `100/100 green`.

- [ ] **Step 7: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml src/adapters/solana/web3.ts src/adapters/solana/wire.ts test/adapters/solana/support/vectors.ts test/adapters/solana/codec.test.ts
git commit -m "feat(solana): pin @solana/web3.js 1.99.0; codec, wire format and vectors

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: The scripted Solana node

**Files:**
- Create (test support): `test/adapters/solana/support/node.ts`, `test/adapters/solana/support/harness.ts`, `test/adapters/solana/support/tx.ts`
- Test: `test/adapters/solana/node.test.ts`

**Interfaces:**
- Consumes: Task 3 (`createWeb3Codec`, `signedTransaction`, vectors), `FakeFetch`, `FakeClock`, `HttpTransport`, `EventBus`; `@solana/web3.js` (`VersionedTransaction`, `VersionedMessage`, `PublicKey`) to decode, `@noble/curves` to verify.
- Produces (test support, used by Tasks 6–10):
  - `ScriptedSolanaNode({ clock, genesisHash?, finalizedDepth? = 2, blockhashValidity? = 150, prioritizationFees? })`: `endpoint(name, EndpointOptions | BalancedOptions)` with `EndpointOptions { lag?, firstAvailableHeight?, missingHeights?, bigtableFailsBelow? }` and `BalancedOptions { backends: EndpointOptions[] }` (a load-balanced URL: each request is served by the next backend, deterministically), `produce(n)`, `skip(n)`, `reorg(depth, drop?)`, `fund`, `setAccount`, `createMint(mint, decimals, program?)`, `mintTo(mint, owner, amount, { frozen? })`, `balance`, `account`, `tokenBalance`, `rent(bytes)`, `inMempool`, `drop`, `sendCount`, `landed(signature)`, `submit(base64, { skipPreflight? })`, `answer(endpoint, method, params)`, `head`, `finalized`, `block(height)`, `served`, `intercept`; `associatedAddress(owner, mint, program?)`; program-id constants.
  - `harness.ts`: `type Endpoint` (a name, or a name with `EndpointOptions` or `BalancedOptions`), `nodeTransport(options?, endpoints?)` → `{ clock, node, transport, run, seen }`; `recording(transport)` → `{ transport, calls: { method, tags, params }[] }` (tags without `signal`, `quorumKey`, `exactIntegers`).
  - `tx.ts`: `codec`, `signedTx(blockhash, instructions, { payer?, key? })` → base64 wire bytes.

**Review points (lesson 8: the node must follow the real node's rules):**
- Dense heights over skipped slots; `finalized` is `finalizedDepth` heights below the head and never moves back after a fork; forks never cut below it.
- A blockhash's age is checked against the including block's parent (agave, I1): `getLatestBlockhash` states `lastValidBlockHeight = height + 150`, a transaction can land up to `lastValidBlockHeight + 1`, and never later (not even with `skipPreflight`).
- Preflight defaults to `finalized` (so a `confirmed` blockhash is "not found" there, D3); "already been processed" for a landed signature; a bad signature is `-32002` under preflight; with `skipPreflight` the bytes are forwarded unverified and never land (M1).
- A load-balanced URL rotates its backends per request; a missing height answers `-32009`, is left out of `getBlocks`, and hides its transactions (C1's test double); `getBlocks` honours `minContextSlot` (`-32016`); an unknown history cursor is `-32020` (M2); an endpoint whose long-term storage fails (`bigtableFailsBelow`) answers `getBlocks` from below its local ledger with `-32602 "BigTable query failed (maybe timeout due to too large range?)"`, `getBlock` there with `null`, and finds no transaction there (agave 4.3.0, R1); `getBlock` with `transactionDetails: 'signatures'` lists the signatures.
- Fees: 5,000 lamports per signature plus `ceil(price × limit / 1e6)`, charged even when execution fails; compute limits enforced (a starved transaction lands failed).
- Rent: new accounts and the fee payer end at 0 or at least `(128 + bytes) × 5,080` lamports (today's devnet and mainnet value, Appendix A); zero-lamport accounts disappear.
- Token rules: mint and decimals checks (errors 0x12, 0x3), owner check (0x4), frozen (0x11), insufficient (0x1); the associated token account's address is checked; `CreateIdempotent` is a no-op on an existing account.
- Lagging endpoints serve an older head; pruned endpoints answer `-32001` below their first available height; u64 values are written as exact JSON numbers.
- Deterministic: no real timers, `Math.random` or `Date.now`.

- [ ] **Step 1: Write the failing test**

`test/adapters/solana/node.test.ts`:

```ts
import {
  createAssociatedTokenAccountIdempotent,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import type { SolanaInstruction } from '../../../src/adapters/solana/types';
import { FakeClock } from '../../../src/testing/fake-clock';
import { ScriptedSolanaNode, associatedAddress } from './support/node';
import { codec, signedTx } from './support/tx';
import { KEY_ADDRESS, MINT, RECIPIENT, RECIPIENT_KEY } from './support/vectors';

function setup(options: { blockhashValidity?: number } = {}) {
  const node = new ScriptedSolanaNode({ clock: new FakeClock(), ...options });
  const url = node.endpoint('main');
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await node.fetch.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await response.text();
    return JSON.parse(text) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
  };
  const tx = (
    instructions: SolanaInstruction[],
    options: { blockhash?: string; key?: string } = {},
  ) => signedTx(options.blockhash ?? node.head.hash, instructions, options);
  const send = (raw: string, config: Record<string, unknown> = {}) =>
    rpc('sendTransaction', [
      raw,
      { encoding: 'base64', preflightCommitment: 'confirmed', ...config },
    ]);
  return { node, rpc, tx, send };
}

describe('the scripted Solana node', () => {
  it('keeps block heights dense over skipped slots', async () => {
    const { node, rpc } = setup();
    node.produce(2);
    node.skip(3);
    node.produce(2);
    expect([node.head.slot, node.head.height]).toEqual([7n, 4n]);
    expect((await rpc('getBlocks', [0, 10, { commitment: 'confirmed' }])).result).toEqual(
      [0, 1, 2, 6, 7],
    );
    expect(
      (
        await rpc('getBlock', [
          6,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).result,
    ).toMatchObject({
      blockHeight: 3,
      parentSlot: 2,
      previousBlockhash: node.block(2n)?.hash,
    });
    expect(
      (
        await rpc('getBlock', [
          4,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).error,
    ).toEqual({
      code: -32007,
      message: 'Slot 4 was skipped, or missing due to ledger jump to recent snapshot',
    });
    expect(
      (
        await rpc('getBlock', [
          9,
          { commitment: 'confirmed', transactionDetails: 'none' },
        ])
      ).error?.code,
    ).toBe(-32004);
    // `finalized` is two heights below the head: slot 6 (height 3) is not final yet.
    expect(
      (
        await rpc('getBlock', [
          6,
          { commitment: 'finalized', transactionDetails: 'none' },
        ])
      ).error?.code,
    ).toBe(-32004);
    expect((await rpc('getBlockHeight', [{ commitment: 'finalized' }])).result).toBe(2);
    expect((await rpc('getBlock', [6, { commitment: 'processed' }])).error?.code).toBe(
      -32602,
    );
  });

  it('includes a transaction up to lastValidBlockHeight + 1, never later (I1)', async () => {
    const { node, rpc, tx, send } = setup({ blockhashValidity: 3 });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const latest = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]))
      .result as {
      value: { blockhash: string; lastValidBlockHeight: number };
    };
    expect(latest.value).toEqual({ blockhash: node.head.hash, lastValidBlockHeight: 4 });
    const raw = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]);
    expect((await send(raw)).result).toEqual(expect.any(String));
    node.produce(1);
    expect(node.balance(RECIPIENT)).toBe(1_000_000_000n);
    // Signed at height 1 (lastValidBlockHeight 4): agave checks the blockhash's age against
    // the including block's parent, so it can still land at height 5; at height 6 it is dead.
    const edge = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 7n)], {
      blockhash: node.block(1n)?.hash,
    });
    const late = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 8n)], {
      blockhash: node.block(1n)?.hash,
    });
    node.produce(2);
    const edgeId = (await send(edge, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(edgeId)?.block.height).toBe(5n);
    expect((await send(late)).error?.message).toBe(
      'Transaction simulation failed: Blockhash not found',
    );
    const lateId = (await send(late, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(lateId)).toBeUndefined();
    expect(node.inMempool(lateId)).toBe(false);
  });

  it('checks preflight at finalized unless told otherwise, and knows processed transactions', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(3);
    const raw = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]);
    // The head's blockhash is not in the finalized bank yet.
    expect((await send(raw, { preflightCommitment: undefined })).error).toMatchObject({
      code: -32002,
      message: 'Transaction simulation failed: Blockhash not found',
    });
    const id = (await send(raw)).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    expect((await send(raw)).error?.message).toBe(
      'Transaction simulation failed: This transaction has already been processed',
    );
    expect(node.sendCount(id)).toBe(3);
  });

  it('verifies signatures under preflight (-32002); without it, forwards bytes that never land (M1)', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const forged = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)], {
      key: RECIPIENT_KEY,
    });
    expect((await send(forged)).error).toMatchObject({
      code: -32002,
      message:
        'Transaction simulation failed: Transaction did not pass signature verification',
    });
    const id = (await send(forged, { skipPreflight: true })).result as string;
    node.produce(1);
    expect([node.landed(id), node.inMempool(id), node.sendCount(id)]).toEqual([
      undefined,
      false,
      2,
    ]);
  });

  it('charges 5,000 lamports per signature plus the priority fee, even when execution fails', async () => {
    const { node, tx, send, rpc } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const budget = [setComputeUnitLimit(30_000n), setComputeUnitPrice(1_000_001n)];
    const message = codec.compileMessage(KEY_ADDRESS, node.head.hash, [
      ...budget,
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
    ]);
    // ceil(1_000_001 × 30_000 / 1e6) = 30_001.
    expect(
      (
        await rpc('getFeeForMessage', [
          Buffer.from(message).toString('base64'),
          { commitment: 'confirmed' },
        ])
      ).result,
    ).toMatchObject({ value: 35_001 });
    // Too many units for the limit: the transaction lands failed and pays the fee.
    const starved = tx([
      setComputeUnitLimit(200n),
      systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
    ]);
    const id = (await send(starved, { skipPreflight: true })).result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toEqual({
      InstructionError: [1, 'ComputationalBudgetExceeded'],
    });
    expect(node.balance(KEY_ADDRESS)).toBe(10_000_000_000n - 5_000n);
    expect(node.balance(RECIPIENT)).toBe(0n);
  });

  it('enforces rent-exempt minimums on new accounts and on the fee payer', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000n);
    node.produce(1);
    expect(node.rent(0)).toBe(650_240n);
    expect(node.rent(165)).toBe(1_488_440n);
    expect(
      (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000n)]))).error?.message,
    ).toBe(
      'Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent',
    );
    // Leaving the payer between 0 and its minimum is refused too; emptying it is fine.
    expect(
      (
        await send(
          tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 10_000_000n - 5_000n - 100n)]),
        )
      ).error?.message,
    ).toBe(
      'Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent',
    );
    const sweep = tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 10_000_000n - 5_000n)]);
    expect((await send(sweep)).result).toEqual(expect.any(String));
    node.produce(1);
    expect([node.balance(KEY_ADDRESS), node.balance(RECIPIENT)]).toEqual([
      0n,
      9_995_000n,
    ]);
    expect(
      (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1n)]))).error?.message,
    ).toBe(
      'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.',
    );
  });

  it('runs SPL transfers with the token program rules, and creates ATAs idempotently', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.createMint(MINT, 6);
    const source = node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    node.produce(1);
    const destination = associatedAddress(RECIPIENT, MINT);
    const create = createAssociatedTokenAccountIdempotent(
      KEY_ADDRESS,
      destination,
      RECIPIENT,
      MINT,
    );
    const transfer = (amount: bigint, decimals = 6) =>
      transferChecked(source, MINT, destination, KEY_ADDRESS, amount, decimals);
    expect((await send(tx([create, transfer(1n, 9)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x12',
    );
    expect((await send(tx([create, transfer(6_000_000n)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1',
    );
    const id = (await send(tx([create, transfer(2_000_000n), memo('hello')])))
      .result as string;
    node.produce(1);
    expect(node.landed(id)?.err).toBeNull();
    expect(node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
    expect(node.balance(destination)).toBe(1_488_440n);
    // A second create is a no-op; a frozen account refuses.
    node.mintTo(MINT, RECIPIENT, 0n, { frozen: true });
    node.produce(1);
    expect((await send(tx([create, transfer(1n)]))).error?.message).toBe(
      'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x11',
    );
  });

  it('forks below the head only, returning transactions to the mempool', async () => {
    const { node, tx, send } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(3);
    const id = (await send(tx([systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)])))
      .result as string;
    node.produce(1);
    const before = node.head.hash;
    node.reorg(1);
    expect(node.inMempool(id)).toBe(true);
    node.produce(1);
    expect(node.head.hash).not.toBe(before);
    expect(node.landed(id)?.block.height).toBe(4n);
    expect(() => node.reorg(3)).toThrow('cannot reorg below the finalized block');
  });

  it('serves lagging and pruned endpoints their own view, and exact u64 numbers', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const lagging = node.endpoint('lagging', { lag: 2 });
    const pruned = node.endpoint('pruned', { firstAvailableHeight: 3 });
    node.fund(KEY_ADDRESS, 2n ** 60n);
    node.produce(5);
    const call = async (url: string, method: string, params: unknown[]) =>
      (
        await node.fetch.fetch(url, {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
      ).text();
    expect(
      await call(lagging, 'getBlockHeight', [{ commitment: 'confirmed' }]),
    ).toContain('"result":3');
    expect(
      await call(pruned, 'getBlock', [
        2,
        { commitment: 'confirmed', transactionDetails: 'none' },
      ]),
    ).toContain('"code":-32001');
    expect(
      await call(pruned, 'getBalance', [KEY_ADDRESS, { commitment: 'confirmed' }]),
    ).toContain('"value":1152921504606846976');
  });

  it('serves a load-balanced URL from its backends in turn, gaps and all', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const url = node.endpoint('lb', {
      backends: [{}, { lag: 2, missingHeights: [3n] }],
    });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const id = node.submit(
      signedTx(node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]),
    );
    node.produce(1);
    node.produce(4);
    const call = async (method: string, params: unknown[]) =>
      JSON.parse(
        await (
          await node.fetch.fetch(url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).text(),
      ) as { result?: unknown; error?: { code: number } };
    const heights = [
      (await call('getBlockHeight', [{ commitment: 'confirmed' }])).result,
      (await call('getBlockHeight', [{ commitment: 'confirmed' }])).result,
    ];
    expect(heights).toEqual([6, 4]);
    const header = { commitment: 'confirmed', transactionDetails: 'none' };
    expect((await call('getBlock', [2, header])).result).toMatchObject({
      blockHeight: 2,
    });
    // The second backend's ledger lacks height 3.
    expect((await call('getBlock', [3, header])).error?.code).toBe(-32009);
    expect(
      (await call('getBlocks', [0, 10, { commitment: 'confirmed' }])).result,
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      (await call('getBlocks', [0, 10, { commitment: 'confirmed' }])).result,
    ).toEqual([0, 1, 2, 4]);
    const options = {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    };
    expect((await call('getTransaction', [id, options])).result).toMatchObject({
      slot: 2,
    });
    expect((await call('getTransaction', [id, options])).result).toMatchObject({
      slot: 2,
    });
  });

  it('fails long-term-storage reads below the local ledger as agave 4.3.0 does (R1)', async () => {
    const node = new ScriptedSolanaNode({ clock: new FakeClock() });
    const url = node.endpoint('bt', { bigtableFailsBelow: 4n });
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const id = node.submit(
      signedTx(node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n)]),
    );
    node.produce(8);
    const call = async (method: string, params: unknown[]) =>
      JSON.parse(
        await (
          await node.fetch.fetch(url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          })
        ).text(),
      ) as { result?: unknown; error?: { code: number; message: string } };
    const slot = (height: bigint) => Number(node.block(height)?.slot);
    const finalized = { commitment: 'finalized' };
    expect((await call('getBlocks', [slot(1n), slot(6n), finalized])).error).toEqual({
      code: -32602,
      message: 'BigTable query failed (maybe timeout due to too large range?)',
    });
    expect((await call('getBlocks', [slot(4n), slot(6n), finalized])).result).toEqual([
      slot(4n),
      slot(5n),
      slot(6n),
    ]);
    const header = { ...finalized, transactionDetails: 'none' };
    expect((await call('getBlock', [slot(2n), header])).result).toBeNull();
    expect((await call('getBlock', [slot(4n), header])).result).toMatchObject({
      blockHeight: 4,
    });
    const options = { ...finalized, encoding: 'jsonParsed' };
    expect(node.landed(id)?.block.height).toBe(2n);
    expect((await call('getTransaction', [id, options])).result).toBeNull();
  });

  it('answers an unknown history cursor with -32020 (M2)', async () => {
    const { node, rpc } = setup();
    node.fund(KEY_ADDRESS, 10_000_000_000n);
    node.produce(1);
    const before = '1'.repeat(64);
    expect(
      (await rpc('getSignaturesForAddress', [KEY_ADDRESS, { before }])).error,
    ).toEqual({ code: -32020, message: `Transaction ${before} not found` });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/node.test.ts`
Expected: FAIL: "Cannot find module './support/node'".

- [ ] **Step 3: Write the node and its helpers**

`test/adapters/solana/support/node.ts`:

```ts
/**
 * A scripted Solana JSON-RPC node for offline tests (test-only, Plan 5 D5). It models what
 * the driver's safety rests on (lesson 8): dense block heights over skipped slots, the
 * `confirmed` head and a `finalized` block `finalizedDepth` heights below it, blockhash
 * expiry after `blockhashValidity` blocks, the status cache ("already processed"), fees
 * (5,000 lamports per signature plus `ceil(price × limit / 1e6)`), compute-unit limits,
 * rent-exempt minimums and the fee payer's rent rule, System transfers, SPL
 * `transferChecked`, associated token accounts, Memo, forks below the head, lagging
 * endpoints and pruned ledgers. Error texts are agave's. Wire numbers are exact u64 JSON.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { base58 } from '@scure/base';
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import type { FakeClock } from '../../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../../src/testing/fake-fetch';

export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const BUDGET = 'ComputeBudget111111111111111111111111111111';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

/** The node's own compute-unit model (not chain facts; each within real magnitudes). */
const COST = {
  budget: 150n,
  system: 150n,
  token: 105n,
  ataCreate: 20_000n,
  ataExists: 4_000n,
};
const memoCost = (bytes: number) => 12_000n + 25n * BigInt(bytes);

export interface NodeOptions {
  readonly clock: FakeClock;
  readonly genesisHash?: string;
  /** Heights between the head and the finalized block (default 2). */
  readonly finalizedDepth?: number;
  /** Blocks a blockhash stays valid after its own (default 150, agave's MAX_PROCESSING_AGE). */
  readonly blockhashValidity?: number;
  /** `getRecentPrioritizationFees` answers, micro-lamports (default all zero). */
  readonly prioritizationFees?: readonly number[];
}

export interface EndpointOptions {
  /** Blocks this endpoint lags behind the node's head. */
  readonly lag?: number;
  /** Blocks below this height were pruned from this endpoint's ledger. */
  readonly firstAvailableHeight?: number;
  /**
   * Heights this endpoint's ledger lacks (a jump to a snapshot, a long-term-storage gap):
   * `getBlock` answers -32009, `getBlocks` omits them, and their transactions are not found.
   */
  readonly missingHeights?: readonly bigint[];
  /**
   * The local ledger starts at this height and long-term storage fails every read below it
   * (agave 4.3.0): `getBlocks` from a slot below answers -32602 "BigTable query failed",
   * `getBlock` answers `null`, and transactions there are not found.
   */
  readonly bigtableFailsBelow?: bigint;
}

/** A URL behind a load balancer: each request is served by the next backend in turn. */
export interface BalancedOptions {
  readonly backends: readonly EndpointOptions[];
}

interface Account {
  readonly lamports: bigint;
  readonly owner: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

type State = Map<string, Account>;

interface Decoded {
  readonly signature: string;
  readonly raw: Uint8Array;
  readonly message: VersionedMessage;
  readonly keys: readonly string[];
  readonly signatures: readonly string[];
}

interface Inner {
  readonly index: number;
  readonly instructions: readonly Record<string, unknown>[];
}

interface Executed {
  readonly tx: Decoded;
  readonly err: unknown;
  /** The error's display text (agave's), when it failed. */
  readonly display?: string;
  readonly fee: bigint;
  readonly units: bigint;
  readonly pre: State;
  readonly post: State;
  readonly inner: readonly Inner[];
}

interface Block {
  readonly slot: bigint;
  readonly height: bigint;
  readonly hash: string;
  readonly parentSlot: bigint;
  readonly previousBlockhash: string;
  readonly blockTime: number;
  readonly txs: readonly Executed[];
  readonly state: State;
}

export type Intercept = (
  endpoint: string,
  method: string,
  params: readonly unknown[],
) => { result: unknown } | { error: { code: number; message: string } } | undefined;

interface View {
  readonly head: Block;
  readonly finalized: Block;
  readonly firstAvailable: bigint;
  readonly missing: ReadonlySet<bigint>;
  readonly bigtableFailsBelow: bigint | undefined;
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** A transaction error: agave's `TransactionError` value and its display text. */
class TxError extends Error {
  constructor(
    readonly value: unknown,
    readonly display: string,
    /** Load errors (fee payer, blockhash) keep a transaction out of every block. */
    readonly load = false,
  ) {
    super(display);
  }
}

const ixError = (index: number, value: unknown, display: string) =>
  new TxError(
    { InstructionError: [index, value] },
    `Error processing Instruction ${index}: ${display}`,
  );
const custom = (index: number, code: number) =>
  ixError(index, { Custom: code }, `custom program error: 0x${code.toString(16)}`);

const u64le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
const u32le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);

function tokenAccountData(
  mint: string,
  owner: string,
  amount: bigint,
  frozen: boolean,
): Uint8Array {
  const data = new Uint8Array(165);
  data.set(base58.decode(mint), 0);
  data.set(base58.decode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = frozen ? 2 : 1;
  return data;
}

function mintData(decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

interface TokenState {
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly frozen: boolean;
}

function readToken(account: Account | undefined): TokenState | null {
  if (!account || (account.owner !== TOKEN && account.owner !== TOKEN_2022)) return null;
  if (
    account.data.length !== 165 ||
    (account.data[108] !== 1 && account.data[108] !== 2)
  ) {
    return null;
  }
  return {
    mint: base58.encode(account.data.slice(0, 32)),
    owner: base58.encode(account.data.slice(32, 64)),
    amount: u64le(account.data, 64),
    frozen: account.data[108] === 2,
  };
}

/** Exact u64 JSON: bigints are written as bare JSON numbers. */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `__u64:${v.toString()}__` : v,
  ).replace(/"__u64:(\d+)__"/g, '$1');
}

export function associatedAddress(owner: string, mint: string, program = TOKEN): string {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(program).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ATA),
  )[0].toBase58();
}

export class ScriptedSolanaNode {
  readonly fetch = new FakeFetch();
  /** JSON-RPC methods each endpoint served, in order. */
  readonly served: { endpoint: string; method: string; params: readonly unknown[] }[] =
    [];
  intercept: Intercept | undefined;
  readonly genesisHash: string;
  readonly finalizedDepth: number;
  readonly validity: bigint;
  readonly #clock: FakeClock;
  readonly #fees: readonly number[];
  readonly #blocks: Block[] = [];
  readonly #bySlot = new Map<bigint, Block>();
  readonly #mempool = new Map<string, Decoded>();
  readonly #sends = new Map<string, number>();
  readonly #endpoints = new Map<string, readonly EndpointOptions[]>();
  readonly #turns = new Map<string, number>();
  #nextSlot = 1n;
  #fork = 0;
  #finalizedFloor = 0n;

  constructor(options: NodeOptions) {
    this.#clock = options.clock;
    this.genesisHash = options.genesisHash ?? DEVNET_GENESIS;
    this.finalizedDepth = options.finalizedDepth ?? 2;
    this.validity = BigInt(options.blockhashValidity ?? 150);
    this.#fees = options.prioritizationFees ?? [];
    const genesis: Block = {
      slot: 0n,
      height: 0n,
      hash: this.#hash(0n),
      parentSlot: 0n,
      previousBlockhash: this.#hash(0n),
      blockTime: Math.floor(this.#clock.now() / 1000),
      txs: [],
      state: new Map([
        [
          SYSTEM,
          {
            lamports: 1n,
            owner: 'NativeLoader1111111111111111111111111111111',
            data: new Uint8Array(),
            executable: true,
          },
        ],
        [
          TOKEN,
          {
            lamports: 1n,
            owner: 'BPFLoaderUpgradeab1e11111111111111111111111',
            data: new Uint8Array(),
            executable: true,
          },
        ],
      ]),
    };
    this.#push(genesis);
  }

  /**
   * The endpoint URL for `name`: a lagging, pruned or gapped endpoint serves its own view,
   * and a load-balanced one (`{ backends }`) serves each request from the next backend.
   */
  endpoint(name: string, options: EndpointOptions | BalancedOptions = {}): string {
    const url = `https://${name}.solana.test/`;
    this.#endpoints.set(name, 'backends' in options ? options.backends : [options]);
    this.fetch.route(url, (request) => this.#serve(name, request));
    return url;
  }

  // ---- scripting -----------------------------------------------------------------------

  get head(): Block {
    return this.#blocks[this.#blocks.length - 1] as Block;
  }

  get finalized(): Block {
    const height = this.head.height - BigInt(this.finalizedDepth);
    const floor = height > this.#finalizedFloor ? height : this.#finalizedFloor;
    return this.#blocks[Number(floor < 0n ? 0n : floor)] as Block;
  }

  block(height: bigint): Block | undefined {
    return this.#blocks[Number(height)];
  }

  /** Produces `count` blocks, each including every valid pending transaction. */
  produce(count = 1): void {
    for (let i = 0; i < count; i++) this.#produce();
  }

  /** Skips `count` slots: no block is produced in them. */
  skip(count = 1): void {
    this.#nextSlot += BigInt(count);
  }

  /** Replaces the last `depth` blocks with a fork (never below finalized); their
   *  transactions return to the mempool unless listed in `drop`. */
  reorg(depth: number, drop: readonly string[] = []): void {
    if (this.head.height - BigInt(depth) < this.finalized.height) {
      throw new Error('cannot reorg below the finalized block');
    }
    this.#finalizedFloor = this.finalized.height;
    const removed = this.#blocks.splice(this.#blocks.length - depth, depth);
    for (const block of removed) {
      this.#bySlot.delete(block.slot);
      for (const executed of block.txs) {
        if (!drop.includes(executed.tx.signature)) {
          this.#mempool.set(executed.tx.signature, executed.tx);
        }
      }
    }
    this.#fork += 1;
  }

  /** Credits `lamports` to `address` in every block's state (as if since genesis). */
  fund(address: string, lamports: bigint): void {
    for (const { state } of this.#blocks) {
      const account = state.get(address);
      state.set(address, {
        lamports: (account?.lamports ?? 0n) + lamports,
        owner: account?.owner ?? SYSTEM,
        data: account?.data ?? new Uint8Array(),
        executable: account?.executable ?? false,
      });
    }
  }

  /** Sets an account in every block's state (as if since genesis). */
  setAccount(address: string, account: Partial<Account>): void {
    const value: Account = {
      lamports: account.lamports ?? 1_000_000n,
      owner: account.owner ?? SYSTEM,
      data: account.data ?? new Uint8Array(),
      executable: account.executable ?? false,
    };
    for (const { state } of this.#blocks) state.set(address, value);
  }

  createMint(mint: string, decimals: number, program = TOKEN): void {
    this.setAccount(mint, {
      owner: program,
      data: mintData(decimals),
      lamports: this.rent(82),
    });
  }

  /** Mints `amount` into `owner`'s associated token account (created when missing). */
  mintTo(
    mint: string,
    owner: string,
    amount: bigint,
    options: { frozen?: boolean } = {},
  ): string {
    const program = this.head.state.get(mint)?.owner ?? TOKEN;
    const address = associatedAddress(owner, mint, program);
    const current = readToken(this.head.state.get(address));
    this.setAccount(address, {
      owner: program,
      lamports: this.rent(165),
      data: tokenAccountData(
        mint,
        owner,
        (current?.amount ?? 0n) + amount,
        options.frozen ?? false,
      ),
    });
    return address;
  }

  balance(address: string): bigint {
    return this.head.state.get(address)?.lamports ?? 0n;
  }

  account(address: string): Account | undefined {
    return this.head.state.get(address);
  }

  tokenBalance(mint: string, owner: string): bigint {
    return readToken(this.head.state.get(associatedAddress(owner, mint)))?.amount ?? 0n;
  }

  rent(bytes: number): bigint {
    return (128n + BigInt(bytes)) * 5_080n;
  }

  inMempool(signature: string): boolean {
    return this.#mempool.has(signature);
  }

  drop(signature: string): void {
    this.#mempool.delete(signature);
  }

  sendCount(signature: string): number {
    return this.#sends.get(signature) ?? 0;
  }

  /** Where a transaction landed on the node's chain (head view). */
  landed(
    signature: string,
  ): { readonly block: Block; readonly err: unknown } | undefined {
    for (const block of this.#blocks) {
      const executed = block.txs.find((t) => t.tx.signature === signature);
      if (executed) return { block, err: executed.err };
    }
    return undefined;
  }

  /** The node's own answer to `method` at `endpoint`, as plain JSON (for intercept tests). */
  answer(endpoint: string, method: string, params: readonly unknown[]): unknown {
    const view = this.#view(this.#endpoints.get(endpoint)?.[0] ?? {});
    return JSON.parse(toJson(this.#method(view, method, params))) as unknown;
  }

  /** Submits base64 bytes as `sendTransaction` would, with preflight at `confirmed`. */
  submit(base64: string, options: { skipPreflight?: boolean } = {}): string {
    try {
      return this.#send(this.#view({}), [
        base64,
        { encoding: 'base64', preflightCommitment: 'confirmed', ...options },
      ]);
    } catch (error) {
      if (error instanceof RpcFailure) throw new Error(error.message);
      throw error;
    }
  }

  // ---- chain ---------------------------------------------------------------------------

  #hash(slot: bigint): string {
    return base58.encode(sha256(new TextEncoder().encode(`block:${this.#fork}:${slot}`)));
  }

  #push(block: Block): void {
    this.#blocks.push(block);
    this.#bySlot.set(block.slot, block);
  }

  #produce(): void {
    const parent = this.head;
    const slot = this.#nextSlot;
    this.#nextSlot += 1n;
    const height = parent.height + 1n;
    let state: State = new Map(parent.state);
    const txs: Executed[] = [];
    for (const [signature, tx] of this.#mempool) {
      this.#mempool.delete(signature);
      if (this.#processed(signature, parent)) continue;
      try {
        this.#blockhashValid(tx, parent, height);
        const executed = this.#execute(tx, state);
        txs.push(executed);
        state = executed.post;
      } catch (error) {
        if (!(error instanceof TxError)) throw error;
        // A load error (expired blockhash, unpayable fee) keeps it out of the block.
      }
    }
    this.#push({
      slot,
      height,
      hash: this.#hash(slot),
      parentSlot: parent.slot,
      previousBlockhash: parent.hash,
      blockTime: Math.floor(this.#clock.now() / 1000),
      txs,
      state,
    });
  }

  #processed(signature: string, bank: Block): boolean {
    for (let h = Number(bank.height); h >= 0; h--) {
      if (this.#blocks[h]?.txs.some((t) => t.tx.signature === signature)) return true;
    }
    return false;
  }

  /**
   * A blockhash is valid in the block at `height` while its age against that block's
   * PARENT is at most `validity` (agave registers a block's own hash only after its
   * transactions ran): so a transaction can land up to `lastValidBlockHeight + 1` (I1).
   */
  #blockhashValid(tx: Decoded, bank: Block, height: bigint): void {
    const hash = tx.message.recentBlockhash;
    const origin = this.#blocks.find((b) => b.hash === hash && b.height <= bank.height);
    if (!origin || height - 1n - origin.height > this.validity) {
      throw new TxError('BlockhashNotFound', 'Blockhash not found', true);
    }
  }

  #decode(raw: Uint8Array): Decoded {
    const tx = VersionedTransaction.deserialize(raw);
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    return {
      signature: base58.encode(tx.signatures[0] as Uint8Array),
      raw,
      message: tx.message,
      keys,
      signatures: tx.signatures.map((s) => base58.encode(s)),
    };
  }

  #verify(tx: Decoded): boolean {
    const bytes = tx.message.serialize();
    const required = tx.message.header.numRequiredSignatures;
    if (tx.signatures.length !== required) return false;
    return tx.signatures.every((signature, i) => {
      try {
        return ed25519.verify(
          base58.decode(signature),
          bytes,
          base58.decode(tx.keys[i] as string),
          {
            zip215: false,
          },
        );
      } catch {
        return false;
      }
    });
  }

  /** Compute-unit limit and price from the message's ComputeBudget instructions. */
  #budget(message: VersionedMessage): { limit: bigint; price: bigint } {
    let limit: bigint | undefined;
    let price = 0n;
    let others = 0n;
    const keys = message.staticAccountKeys.map((k) => k.toBase58());
    for (const ix of message.compiledInstructions) {
      const data = ix.data;
      if (keys[ix.programIdIndex] !== BUDGET) {
        others += 1n;
        continue;
      }
      if (data[0] === 2 && data.length === 5) limit = BigInt(u32le(data, 1));
      if (data[0] === 3 && data.length === 9) price = u64le(data, 1);
    }
    const fallback = 200_000n * others;
    const chosen = limit ?? (fallback > 1_400_000n ? 1_400_000n : fallback);
    return { limit: chosen > 1_400_000n ? 1_400_000n : chosen, price };
  }

  #fee(message: VersionedMessage): bigint {
    const { limit, price } = this.#budget(message);
    return (
      5_000n * BigInt(message.header.numRequiredSignatures) +
      (price * limit + 999_999n) / 1_000_000n
    );
  }

  /** Runs a transaction on a copy of `state`: fee first, then its instructions atomically. */
  #execute(tx: Decoded, state: State): Executed {
    const message = tx.message;
    const payer = tx.keys[0] as string;
    const fee = this.#fee(message);
    const payerAccount = state.get(payer);
    if (!payerAccount) {
      throw new TxError(
        'AccountNotFound',
        'Attempt to debit an account but found no record of a prior credit.',
        true,
      );
    }
    if (payerAccount.owner !== SYSTEM || payerAccount.data.length > 0) {
      throw new TxError(
        'InvalidAccountForFee',
        'This account may not be used to pay transaction fees',
        true,
      );
    }
    if (payerAccount.lamports < fee) {
      throw new TxError('InsufficientFundsForFee', 'Insufficient funds for fee', true);
    }
    const left = payerAccount.lamports - fee;
    if (left !== 0n && left < this.rent(0)) {
      throw new TxError(
        { InsufficientFundsForRent: { account_index: 0 } },
        'Transaction results in an account (0) with insufficient funds for rent',
        true,
      );
    }
    const pre = new Map(state);
    const charged = new Map(state);
    charged.set(payer, { ...payerAccount, lamports: left });
    const work = new Map(charged);
    const inner: Inner[] = [];
    const { limit } = this.#budget(message);
    let units = 0n;
    try {
      message.compiledInstructions.forEach((ix, index) => {
        units += this.#instruction(tx, ix, index, work, inner);
        if (units > limit) {
          throw ixError(
            index,
            'ComputationalBudgetExceeded',
            'Computational budget exceeded',
          );
        }
      });
      this.#rentCheck(tx, pre, work);
      ScriptedSolanaNode.#collect(work);
      return { tx, err: null, fee, units, pre, post: work, inner };
    } catch (error) {
      if (!(error instanceof TxError)) throw error;
      ScriptedSolanaNode.#collect(charged);
      return {
        tx,
        err: error.value,
        display: error.display,
        fee,
        units: units > limit ? limit : units,
        pre,
        post: charged,
        inner: [],
      };
    }
  }

  /** Accounts left with no lamports no longer exist. */
  static #collect(state: State): void {
    for (const [address, account] of state)
      if (account.lamports === 0n) state.delete(address);
  }

  #rentCheck(tx: Decoded, pre: State, post: State): void {
    tx.keys.forEach((key, index) => {
      if (!tx.message.isAccountWritable(index)) return;
      const after = post.get(key);
      if (!after || after.lamports === 0n) return;
      const minimum = this.rent(after.data.length);
      const before = pre.get(key);
      const wasPaying =
        before !== undefined &&
        before.lamports > 0n &&
        before.lamports < this.rent(before.data.length);
      if (after.lamports < minimum && !wasPaying) {
        throw new TxError(
          { InsufficientFundsForRent: { account_index: index } },
          `Transaction results in an account (${index}) with insufficient funds for rent`,
        );
      }
    });
  }

  #instruction(
    tx: Decoded,
    ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
    index: number,
    state: State,
    inner: Inner[],
  ): bigint {
    const program = tx.keys[ix.programIdIndex] as string;
    const account = (i: number) => tx.keys[ix.accountKeyIndexes[i] as number] as string;
    const signed = (i: number) =>
      tx.message.isAccountSigner(ix.accountKeyIndexes[i] as number);
    const data = ix.data;
    if (program === BUDGET) return COST.budget;
    if (program === SYSTEM) {
      if (data.length !== 12 || u32le(data, 0) !== 2) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const from = account(0);
      const to = account(1);
      const lamports = u64le(data, 4);
      if (!signed(0))
        throw ixError(
          index,
          'MissingRequiredSignature',
          'missing required signature for instruction',
        );
      const source = state.get(from);
      if (!source || source.owner !== SYSTEM || source.data.length > 0) {
        throw ixError(index, 'InvalidArgument', 'invalid program argument');
      }
      if (source.lamports < lamports) throw custom(index, 1);
      state.set(from, { ...source, lamports: source.lamports - lamports });
      const target = state.get(to);
      state.set(to, {
        lamports: (target?.lamports ?? 0n) + lamports,
        owner: target?.owner ?? SYSTEM,
        data: target?.data ?? new Uint8Array(),
        executable: target?.executable ?? false,
      });
      return COST.system;
    }
    if (program === ATA) {
      if (data.length !== 1 || data[0] !== 1) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const [payer, address, wallet, mint] = [
        account(0),
        account(1),
        account(2),
        account(3),
      ];
      if (address !== associatedAddress(wallet, mint)) {
        throw ixError(
          index,
          'InvalidSeeds',
          'Provided seeds do not result in a valid address',
        );
      }
      const existing = readToken(state.get(address));
      if (existing) {
        if (existing.mint !== mint || existing.owner !== wallet) throw custom(index, 0);
        return COST.ataExists;
      }
      const rent = this.rent(165);
      const funder = state.get(payer);
      if (!funder || funder.lamports < rent) throw custom(index, 1);
      state.set(payer, { ...funder, lamports: funder.lamports - rent });
      state.set(address, {
        lamports: rent,
        owner: TOKEN,
        data: tokenAccountData(mint, wallet, 0n, false),
        executable: false,
      });
      inner.push({
        index,
        instructions: [
          {
            parsed: {
              info: {
                lamports: rent,
                newAccount: address,
                owner: TOKEN,
                source: payer,
                space: 165,
              },
              type: 'createAccount',
            },
            program: 'system',
            programId: SYSTEM,
            stackHeight: 2,
          },
          {
            parsed: {
              info: { account: address, mint, owner: wallet },
              type: 'initializeAccount3',
            },
            program: 'spl-token',
            programId: TOKEN,
            stackHeight: 2,
          },
        ],
      });
      return COST.ataCreate;
    }
    if (program === TOKEN) {
      if (data.length !== 10 || data[0] !== 12) {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      const [source, mint, destination, authority] = [
        account(0),
        account(1),
        account(2),
        account(3),
      ];
      const amount = u64le(data, 1);
      const from = readToken(state.get(source));
      const to = readToken(state.get(destination));
      const mintAccount = state.get(mint);
      if (
        !from ||
        !to ||
        state.get(source)?.owner !== TOKEN ||
        state.get(destination)?.owner !== TOKEN
      ) {
        throw ixError(
          index,
          'InvalidAccountData',
          'invalid account data for instruction',
        );
      }
      if (from.mint !== mint || to.mint !== mint) throw custom(index, 3);
      if (!mintAccount || mintAccount.data[44] !== data[9]) throw custom(index, 18);
      if (from.frozen || to.frozen) throw custom(index, 17);
      if (from.owner !== authority) throw custom(index, 4);
      if (!signed(3))
        throw ixError(
          index,
          'MissingRequiredSignature',
          'missing required signature for instruction',
        );
      if (from.amount < amount) throw custom(index, 1);
      const put = (address: string, next: TokenState) =>
        state.set(address, {
          ...(state.get(address) as Account),
          data: tokenAccountData(next.mint, next.owner, next.amount, next.frozen),
        });
      put(source, { ...from, amount: from.amount - amount });
      const current = readToken(state.get(destination)) as TokenState;
      put(destination, { ...current, amount: current.amount + amount });
      return COST.token;
    }
    if (program === MEMO) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw ixError(index, 'InvalidInstructionData', 'invalid instruction data');
      }
      return memoCost(data.length);
    }
    throw ixError(index, 'UnsupportedProgramId', 'Unsupported program id');
  }

  // ---- views ---------------------------------------------------------------------------

  /** The next backend's options for `endpoint` (load-balanced endpoints rotate). */
  #backend(endpoint: string): EndpointOptions {
    const backends = this.#endpoints.get(endpoint) ?? [{}];
    const turn = this.#turns.get(endpoint) ?? 0;
    this.#turns.set(endpoint, turn + 1);
    return backends[turn % backends.length] as EndpointOptions;
  }

  #view(options: EndpointOptions): View {
    const lag = BigInt(options.lag ?? 0);
    const headHeight = this.head.height - lag;
    const head = this.#blocks[Number(headHeight < 0n ? 0n : headHeight)] as Block;
    const target = head.height - BigInt(this.finalizedDepth);
    const floor = this.#finalizedFloor < head.height ? this.#finalizedFloor : head.height;
    const height = target > floor ? target : floor;
    return {
      head,
      finalized: this.#blocks[Number(height < 0n ? 0n : height)] as Block,
      firstAvailable: BigInt(options.firstAvailableHeight ?? 0),
      missing: new Set(options.missingHeights ?? []),
      bigtableFailsBelow: options.bigtableFailsBelow,
    };
  }

  /** Whether the view's ledger holds the block at `height`. */
  #holds(view: View, height: bigint): boolean {
    return (
      height >= view.firstAvailable &&
      !view.missing.has(height) &&
      (view.bigtableFailsBelow === undefined || height >= view.bigtableFailsBelow)
    );
  }

  #bank(view: View, commitment: unknown): Block {
    if (commitment === 'finalized' || commitment === undefined) return view.finalized;
    if (commitment === 'confirmed' || commitment === 'processed') return view.head;
    throw new RpcFailure(-32602, 'Invalid params: invalid commitment');
  }

  // ---- JSON-RPC ------------------------------------------------------------------------

  #serve(endpoint: string, request: FakeRequest): Response {
    const body = request.json<{ id: unknown; method: string; params?: unknown[] }>();
    const params = body.params ?? [];
    this.served.push({ endpoint, method: body.method, params });
    const reply = (payload: Record<string, unknown>) =>
      new Response(toJson({ jsonrpc: '2.0', id: body.id, ...payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const intercepted = this.intercept?.(endpoint, body.method, params);
    if (intercepted) return reply(intercepted);
    try {
      const view = this.#view(this.#backend(endpoint));
      return reply({ result: this.#method(view, body.method, params) });
    } catch (error) {
      if (error instanceof RpcFailure) {
        return reply({
          error: {
            code: error.code,
            message: error.message,
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        });
      }
      throw error;
    }
  }

  #method(view: View, method: string, params: readonly unknown[]): unknown {
    const config = (i: number) => (params[i] ?? {}) as Record<string, unknown>;
    const context = (bank: Block) => ({ apiVersion: '4.3.0', slot: bank.slot });
    switch (method) {
      case 'getGenesisHash':
        return this.genesisHash;
      case 'getSlot':
        return this.#bank(view, config(0).commitment).slot;
      case 'getBlockHeight':
        return this.#bank(view, config(0).commitment).height;
      case 'getLatestBlockhash': {
        const bank = this.#bank(view, config(0).commitment);
        return {
          context: context(bank),
          value: {
            blockhash: bank.hash,
            lastValidBlockHeight: bank.height + this.validity,
          },
        };
      }
      case 'getBalance': {
        const bank = this.#bank(view, config(1).commitment);
        return {
          context: context(bank),
          value: bank.state.get(params[0] as string)?.lamports ?? 0n,
        };
      }
      case 'getAccountInfo': {
        const bank = this.#bank(view, config(1).commitment);
        const account = bank.state.get(params[0] as string);
        return {
          context: context(bank),
          value: account ? this.#renderAccount(account) : null,
        };
      }
      case 'getTokenAccountsByOwner': {
        const bank = this.#bank(view, config(2).commitment);
        const owner = params[0] as string;
        const filter = config(1);
        const value = [...bank.state.entries()].flatMap(([address, account]) => {
          const token = readToken(account);
          if (!token || token.owner !== owner) return [];
          if (typeof filter.mint === 'string' && token.mint !== filter.mint) return [];
          if (typeof filter.programId === 'string' && account.owner !== filter.programId)
            return [];
          return [{ pubkey: address, account: this.#renderAccount(account) }];
        });
        return { context: context(bank), value };
      }
      case 'getMinimumBalanceForRentExemption':
        return this.rent(Number(params[0]));
      case 'getRecentPrioritizationFees':
        return this.#fees.map((fee, i) => ({
          prioritizationFee: fee,
          slot: view.head.slot - BigInt(i),
        }));
      case 'getFeeForMessage': {
        const bank = this.#bank(view, config(1).commitment);
        const message = VersionedMessage.deserialize(
          Buffer.from(params[0] as string, 'base64'),
        );
        const known = this.#blocks.some(
          (b) =>
            b.hash === message.recentBlockhash &&
            b.height <= bank.height &&
            bank.height - b.height <= this.validity,
        );
        return { context: context(bank), value: known ? this.#fee(message) : null };
      }
      case 'simulateTransaction':
        return this.#simulate(view, params);
      case 'sendTransaction':
        return this.#send(view, params);
      case 'getBlocks':
        return this.#getBlocks(view, params);
      case 'getBlock':
        return this.#getBlock(view, params);
      case 'getTransaction':
        return this.#getTransaction(view, params);
      case 'getSignaturesForAddress':
        return this.#getSignatures(view, params);
      default:
        throw new RpcFailure(-32601, 'Method not found');
    }
  }

  #renderAccount(account: Account) {
    return {
      data: [Buffer.from(account.data).toString('base64'), 'base64'],
      executable: account.executable,
      lamports: account.lamports,
      owner: account.owner,
      rentEpoch: 18446744073709551615n,
      space: account.data.length,
    };
  }

  #parseRaw(encoded: unknown): Decoded {
    try {
      return this.#decode(new Uint8Array(Buffer.from(encoded as string, 'base64')));
    } catch {
      throw new RpcFailure(
        -32602,
        'failed to deserialize solana_transaction::versioned::VersionedTransaction: io error: failed to fill whole buffer',
      );
    }
  }

  #simulate(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    const bank = this.#bank(view, options.commitment ?? 'finalized');
    const tx = this.#parseRaw(params[0]);
    const base = {
      accounts: null,
      logs: [],
      returnData: null,
      innerInstructions: null,
      loadedAccountsDataSize: 0,
    };
    try {
      if (options.sigVerify === true && !this.#verify(tx)) {
        throw new TxError(
          'SignatureFailure',
          'Transaction did not pass signature verification',
          true,
        );
      }
      if (options.replaceRecentBlockhash !== true)
        this.#blockhashValid(tx, bank, bank.height + 1n);
      const executed = this.#execute(tx, new Map(bank.state));
      return {
        context: { apiVersion: '4.3.0', slot: bank.slot },
        value: {
          ...base,
          err: executed.err,
          unitsConsumed: executed.units,
          fee: executed.fee,
        },
      };
    } catch (error) {
      if (!(error instanceof TxError)) throw error;
      return {
        context: { apiVersion: '4.3.0', slot: bank.slot },
        value: { ...base, err: error.value, unitsConsumed: 0 },
      };
    }
  }

  #send(view: View, params: readonly unknown[]): string {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.encoding !== 'base64')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    const tx = this.#parseRaw(params[0]);
    this.#sends.set(tx.signature, this.sendCount(tx.signature) + 1);
    if (options.skipPreflight === true) {
      // agave forwards unverified bytes; a leader drops a bad signature, so it never lands.
      if (!this.#verify(tx)) return tx.signature;
    } else {
      const bank = this.#bank(view, options.preflightCommitment ?? 'finalized');
      const fail = (error: TxError) =>
        new RpcFailure(-32002, `Transaction simulation failed: ${error.display}`, {
          accounts: null,
          err: error.value,
          logs: [],
          unitsConsumed: 0,
        });
      if (!this.#verify(tx)) {
        throw fail(
          new TxError(
            'SignatureFailure',
            'Transaction did not pass signature verification',
          ),
        );
      }
      try {
        this.#blockhashValid(tx, bank, bank.height + 1n);
        if (this.#processed(tx.signature, bank)) {
          throw new TxError(
            'AlreadyProcessed',
            'This transaction has already been processed',
          );
        }
        const executed = this.#execute(tx, new Map(bank.state));
        if (executed.err !== null) {
          throw new TxError(executed.err, executed.display ?? 'failed');
        }
      } catch (error) {
        if (error instanceof TxError) throw fail(error);
        throw error;
      }
    }
    if (!this.#processed(tx.signature, this.head)) this.#mempool.set(tx.signature, tx);
    return tx.signature;
  }

  #getBlocks(view: View, params: readonly unknown[]): bigint[] {
    const start = BigInt(params[0] as number);
    const end = BigInt(params[1] as number);
    const bank = this.#bank(
      view,
      ((params[2] ?? {}) as Record<string, unknown>).commitment,
    );
    if (end - start > 500_000n)
      throw new RpcFailure(-32602, 'Slot range too large; max 500000');
    const minContextSlot = ((params[2] ?? {}) as Record<string, unknown>).minContextSlot;
    if (typeof minContextSlot === 'number' && BigInt(minContextSlot) > bank.slot) {
      throw new RpcFailure(-32016, 'Minimum context slot has not been reached');
    }
    const local = view.bigtableFailsBelow;
    if (local !== undefined && start < (this.#blocks[Number(local)]?.slot ?? 0n)) {
      throw new RpcFailure(
        -32602,
        'BigTable query failed (maybe timeout due to too large range?)',
      );
    }
    return this.#blocks
      .filter(
        (b) =>
          b.slot >= start &&
          b.slot <= end &&
          b.slot <= bank.slot &&
          this.#holds(view, b.height),
      )
      .map((b) => b.slot);
  }

  #blockAt(view: View, slot: bigint, bank: Block): Block {
    if (slot > bank.slot)
      throw new RpcFailure(-32004, `Block not available for slot ${slot}`);
    const block = this.#bySlot.get(slot);
    if (!block || block.height > bank.height) {
      throw new RpcFailure(
        -32007,
        `Slot ${slot} was skipped, or missing due to ledger jump to recent snapshot`,
      );
    }
    if (block.height < view.firstAvailable) {
      throw new RpcFailure(
        -32001,
        `Block ${slot} cleaned up, does not exist on node. First available block: ${view.firstAvailable}`,
      );
    }
    if (view.missing.has(block.height)) {
      throw new RpcFailure(
        -32009,
        `Slot ${slot} was skipped, or missing in long-term storage`,
      );
    }
    return block;
  }

  #getBlock(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.commitment === 'processed') {
      throw new RpcFailure(
        -32602,
        'Method does not support commitment below `confirmed`',
      );
    }
    const bank = this.#bank(view, options.commitment);
    const block = this.#blockAt(view, BigInt(params[0] as number), bank);
    // A failed long-term-storage read is not "block not found": agave answers `null`.
    if (view.bigtableFailsBelow !== undefined && block.height < view.bigtableFailsBelow) {
      return null;
    }
    const header = {
      blockHeight: block.height,
      blockTime: block.blockTime,
      blockhash: block.hash,
      parentSlot: block.parentSlot,
      previousBlockhash: block.previousBlockhash,
    };
    if (options.transactionDetails === 'none') return header;
    if (options.transactionDetails === 'signatures') {
      return { ...header, signatures: block.txs.map((t) => t.tx.signature) };
    }
    if (options.encoding !== 'jsonParsed')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    return { ...header, transactions: block.txs.map((t) => this.#renderTx(t)) };
  }

  #find(
    signature: string,
    bank: Block,
  ): { block: Block; executed: Executed } | undefined {
    for (let h = Number(bank.height); h >= 0; h--) {
      const block = this.#blocks[h] as Block;
      const executed = block.txs.find((t) => t.tx.signature === signature);
      if (executed) return { block, executed };
    }
    return undefined;
  }

  #getTransaction(view: View, params: readonly unknown[]) {
    const options = (params[1] ?? {}) as Record<string, unknown>;
    if (options.encoding !== 'jsonParsed')
      throw new RpcFailure(-32602, 'Invalid params: encoding');
    const bank = this.#bank(view, options.commitment);
    const found = this.#find(params[0] as string, bank);
    if (!found || !this.#holds(view, found.block.height)) return null;
    return {
      slot: found.block.slot,
      blockTime: found.block.blockTime,
      ...this.#renderTx(found.executed),
    };
  }

  #getSignatures(view: View, params: readonly unknown[]) {
    const address = params[0] as string;
    const options = (params[1] ?? {}) as Record<string, unknown>;
    const limit = Number(options.limit ?? 1000);
    if (limit < 1 || limit > 1000)
      throw new RpcFailure(-32602, 'Invalid limit; max 1000');
    const bank = this.#bank(view, options.commitment);
    const all: { block: Block; executed: Executed }[] = [];
    for (let h = Number(bank.height); h >= Number(view.firstAvailable); h--) {
      const block = this.#blocks[h] as Block;
      if (!this.#holds(view, block.height)) continue;
      for (const executed of [...block.txs].reverse()) {
        if (executed.tx.keys.includes(address)) all.push({ block, executed });
      }
    }
    let start = 0;
    if (typeof options.before === 'string') {
      const at = all.findIndex((e) => e.executed.tx.signature === options.before);
      if (at < 0) throw new RpcFailure(-32020, `Transaction ${options.before} not found`);
      start = at + 1;
    }
    return all.slice(start, start + limit).map(({ block, executed }) => ({
      blockTime: block.blockTime,
      confirmationStatus:
        block.height <= view.finalized.height ? 'finalized' : 'confirmed',
      err: executed.err,
      memo: null,
      signature: executed.tx.signature,
      slot: block.slot,
    }));
  }

  // ---- jsonParsed rendering ------------------------------------------------------------

  #tokenBalances(tx: Decoded, state: State) {
    return tx.keys.flatMap((key, accountIndex) => {
      const account = state.get(key);
      const token = readToken(account);
      if (!token || !account) return [];
      const decimals = state.get(token.mint)?.data[44] ?? 0;
      const amount = token.amount.toString();
      return [
        {
          accountIndex,
          mint: token.mint,
          owner: token.owner,
          programId: account.owner,
          uiTokenAmount: {
            amount,
            decimals,
            uiAmount: Number(token.amount) / 10 ** decimals,
            uiAmountString: String(Number(token.amount) / 10 ** decimals),
          },
        },
      ];
    });
  }

  #renderInstruction(
    tx: Decoded,
    ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
  ): Record<string, unknown> {
    const programId = tx.keys[ix.programIdIndex] as string;
    const account = (i: number) => tx.keys[ix.accountKeyIndexes[i] as number] as string;
    const data = ix.data;
    if (programId === SYSTEM && data.length === 12 && u32le(data, 0) === 2) {
      return {
        parsed: {
          info: { destination: account(1), lamports: u64le(data, 4), source: account(0) },
          type: 'transfer',
        },
        program: 'system',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === ATA && data[0] === 1) {
      return {
        parsed: {
          info: {
            account: account(1),
            mint: account(3),
            source: account(0),
            systemProgram: account(4),
            tokenProgram: account(5),
            wallet: account(2),
          },
          type: 'createIdempotent',
        },
        program: 'spl-associated-token-account',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === TOKEN && data[0] === 12 && data.length === 10) {
      const amount = u64le(data, 1);
      const decimals = data[9] as number;
      return {
        parsed: {
          info: {
            authority: account(3),
            destination: account(2),
            mint: account(1),
            source: account(0),
            tokenAmount: {
              amount: amount.toString(),
              decimals,
              uiAmount: Number(amount) / 10 ** decimals,
              uiAmountString: String(Number(amount) / 10 ** decimals),
            },
          },
          type: 'transferChecked',
        },
        program: 'spl-token',
        programId,
        stackHeight: 1,
      };
    }
    if (programId === MEMO) {
      return {
        parsed: new TextDecoder().decode(data),
        program: 'spl-memo',
        programId,
        stackHeight: 1,
      };
    }
    return {
      accounts: ix.accountKeyIndexes.map((i) => tx.keys[i]),
      data: base58.encode(data),
      programId,
      stackHeight: 1,
    };
  }

  #renderTx(executed: Executed) {
    const { tx } = executed;
    const message = tx.message;
    return {
      meta: {
        computeUnitsConsumed: executed.units,
        err: executed.err,
        fee: executed.fee,
        innerInstructions: executed.inner,
        logMessages: [],
        postBalances: tx.keys.map((k) => executed.post.get(k)?.lamports ?? 0n),
        postTokenBalances: this.#tokenBalances(tx, executed.post),
        preBalances: tx.keys.map((k) => executed.pre.get(k)?.lamports ?? 0n),
        preTokenBalances: this.#tokenBalances(tx, executed.pre),
        rewards: [],
        status: executed.err === null ? { Ok: null } : { Err: executed.err },
      },
      transaction: {
        message: {
          accountKeys: tx.keys.map((pubkey, i) => ({
            pubkey,
            signer: message.isAccountSigner(i),
            source: 'transaction',
            writable: message.isAccountWritable(i),
          })),
          instructions: message.compiledInstructions.map((ix) =>
            this.#renderInstruction(tx, ix),
          ),
          recentBlockhash: message.recentBlockhash,
        },
        signatures: tx.signatures,
      },
      version: 'legacy',
    };
  }
}
```

`test/adapters/solana/support/tx.ts`:

```ts
import type { SolanaInstruction } from '../../../../src/adapters/solana/types';
import { createWeb3Codec } from '../../../../src/adapters/solana/web3';
import { signedTransaction } from '../../../../src/adapters/solana/wire';
import { KEY, KEY_ADDRESS, sign } from './vectors';

/** The codec without a transport (its native client is never used here). */
export const codec = createWeb3Codec(undefined as never);

/** A transaction signed by the test key (or `key`), as base64 wire bytes. */
export function signedTx(
  blockhash: string,
  instructions: readonly SolanaInstruction[],
  options: { readonly payer?: string; readonly key?: string } = {},
): string {
  const message = codec.compileMessage(
    options.payer ?? KEY_ADDRESS,
    blockhash,
    instructions,
  );
  const raw = signedTransaction([sign(message, options.key ?? KEY)], message);
  return Buffer.from(raw).toString('base64');
}
```

`test/adapters/solana/support/harness.ts` (Task 6 extends it):

```ts
import type { SolanaCallTags } from '../../../../src/adapters/solana/types';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { Transport } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import {
  ScriptedSolanaNode,
  type BalancedOptions,
  type EndpointOptions,
  type NodeOptions,
} from './node';

export type Endpoint =
  string | ({ readonly name: string } & (EndpointOptions | BalancedOptions));

/** A scripted node behind a real HttpTransport, with one or more endpoints. */
export function nodeTransport(
  options: Omit<NodeOptions, 'clock'> = {},
  endpoints: readonly Endpoint[] = ['main'],
) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = new HttpTransport(
    endpoints.map((entry) => {
      const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
      return { name, url: node.endpoint(name, rest) };
    }),
    {
      clock,
      events,
      log: noopLogger,
      options: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    },
  );
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, run, seen };
}

/** Records every JSON-RPC call's method, tags and params (lesson 1), passing it through. */
export function recording(transport: Transport) {
  const calls: { method: string; tags: SolanaCallTags; params: unknown }[] = [];
  const rpc = (
    method: string,
    params: unknown,
    options: Record<string, unknown> = {},
  ) => {
    const { signal: _signal, quorumKey: _key, exactIntegers: _exact, ...tags } = options;
    calls.push({ method, tags: tags as SolanaCallTags, params });
    return transport.rpc(method, params, options);
  };
  // Methods run on the real transport, whose private fields a Proxy receiver cannot reach.
  const wrapped = new Proxy(transport, {
    get(target, prop) {
      if (prop === 'rpc') return rpc;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { transport: wrapped, calls };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/node.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add test/adapters/solana/support/node.ts test/adapters/solana/support/tx.ts test/adapters/solana/support/harness.ts test/adapters/solana/node.test.ts
git commit -m "test(solana): a scripted Solana node with the validator's rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 5: Transaction decoding and the phantom-success guard

**Files:**
- Create: `src/adapters/solana/decode.ts`
- Create (test support): `test/adapters/solana/support/fixtures.ts`
- Test: `test/adapters/solana/decode.test.ts`

**Interfaces:**
- Consumes: Task 1 (program ids), Task 2 (`u64`, `amountString`, `malformed`, `notYet`, `inconsistent`); `DriverTransaction`, `DriverTransfer`, `canonicalJson`.
- Produces:
  - `ParsedTransaction { signature, keys, err, fee, preBalances, postBalances, preTokens, postTokens, tokenBalances: 'present' | 'absent', instructions, version, slot?, blockTime? }` and `parseTransaction(value)`: validates a `jsonParsed` transaction (from `getTransaction` or a block's list); any malformed part is a retryable `PROVIDER_UNAVAILABLE`.
  - `decodeTransaction(parsed, place: BlockPlace { height, hash, blockTime? }): DriverTransaction`: transfers with locators `ix:<outer>` and `ix:<outer>.<inner>`, `decoding: 'partial'` when balances are not explained (spec §15), the chain's own status (lesson 15), `details: { slot, version, err? }`.
  - `isVote(parsed)`; `touches(decoded, parsed, addresses)`, the scan filter, a conservative superset (I4, D13); `tokenTransfersLanded(parsed, from)`, the phantom-success guard in the final wording (I2, D14; verdict paths only; throws a retryable `PROVIDER_UNAVAILABLE` on missing evidence and a retryable `PROVIDER_INCONSISTENT` when token instructions are present but none is the sender's, R3).

**Review points:**
- Reconciliation covers every account: lamports (fee on account 0 plus decoded moves) and token balances; anything unexplained is `partial`, never silently `complete`.
- Token transfers name owners, not token accounts; missing owners fall back to token accounts as `partial`.
- Token-2022 instructions are not decoded (spec §15), and so the transaction is `partial`.
- `tokenTransfersLanded` follows the final wording: a transfer from the sender to the intended recipient of a positive amount, never the exact amount; missing evidence decides nothing (never a proven `failed`); token instructions of which none is the sender's contradict the signed message and decide nothing too (lesson 18, widened; R3); a native transaction keeps the chain's own status; a failed transaction never lands.
- `touches` never drops a transaction that moves value to a watched address, even when decoding cannot attribute it (I4), including an SPL deposit when the node reports no token balances and a token program ran (R4).
- The fixture is public chain data; no private data enters the repository.

- [ ] **Step 1: Write the failing test**

`test/adapters/solana/support/fixtures.ts` (a real devnet transaction, Appendix A):

```ts
/**
 * A real devnet transaction (getTransaction, jsonParsed, 2026-09-25; log messages dropped):
 * two ComputeBudget instructions, an SPL transferChecked of 0.001 USDC (devnet) and a
 * memo, signed by a fee payer and a separate token owner. Public chain data.
 */
export const DEVNET_TRANSFER_CHECKED = {
  blockTime: 1790356677,
  meta: {
    computeUnitsConsumed: 13180,
    costUnits: 15582,
    err: null,
    fee: 10001,
    innerInstructions: [],
    logMessages: [],
    postBalances: [
      132692960, 13750000, 2039280, 2039280, 421923285289, 1, 20369267856, 41509609334,
    ],
    postTokenBalances: [
      {
        accountIndex: 2,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '405000',
          decimals: 6,
          uiAmount: 0.405,
          uiAmountString: '0.405',
        },
      },
      {
        accountIndex: 3,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '372686000',
          decimals: 6,
          uiAmount: 372.686,
          uiAmountString: '372.686',
        },
      },
    ],
    preBalances: [
      132702961, 13750000, 2039280, 2039280, 421923285289, 1, 20369267856, 41509609334,
    ],
    preTokenBalances: [
      {
        accountIndex: 2,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '406000',
          decimals: 6,
          uiAmount: 0.406,
          uiAmountString: '0.406',
        },
      },
      {
        accountIndex: 3,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        owner: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        uiTokenAmount: {
          amount: '372685000',
          decimals: 6,
          uiAmount: 372.685,
          uiAmountString: '372.685',
        },
      },
    ],
    rewards: [],
    status: {
      Ok: null,
    },
  },
  slot: 504092431,
  transaction: {
    message: {
      accountKeys: [
        {
          pubkey: 'GVJJ7rdGiXr5xaYbRwRbjfaJL7fmwRygFi1H6aGqDveb',
          signer: true,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
          signer: true,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
          signer: false,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
          signer: false,
          source: 'transaction',
          writable: true,
        },
        {
          pubkey: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'ComputeBudget111111111111111111111111111111',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          signer: false,
          source: 'transaction',
          writable: false,
        },
        {
          pubkey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
          signer: false,
          source: 'transaction',
          writable: false,
        },
      ],
      addressTableLookups: [],
      instructions: [
        {
          accounts: [],
          data: 'EuxTsD',
          programId: 'ComputeBudget111111111111111111111111111111',
          stackHeight: 1,
        },
        {
          accounts: [],
          data: '3DdGGhkhJbjm',
          programId: 'ComputeBudget111111111111111111111111111111',
          stackHeight: 1,
        },
        {
          parsed: {
            info: {
              authority: '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT',
              destination: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
              mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
              source: '8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3',
              tokenAmount: {
                amount: '1000',
                decimals: 6,
                uiAmount: 0.001,
                uiAmountString: '0.001',
              },
            },
            type: 'transferChecked',
          },
          program: 'spl-token',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          stackHeight: 1,
        },
        {
          parsed: '83c873a1f7d4c4bcfd6c095906248332',
          program: 'spl-memo',
          programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
          stackHeight: 1,
        },
      ],
      recentBlockhash: 'HqSZf935XJS4ZWxHWGf9V55kWj4wuRC7UJGbuL8faYxy',
    },
    signatures: [
      '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
      '2dZqU9pyrx1t3eo22cL7KsqMCDk8YdL4pwerkEX8bAsoVCv5DwuM9y4GonWduuCwmyV58TCo3gwTdH8a7ZuuoQgA',
    ],
  },
  transactionIndex: 2,
  version: 0,
};
```

`test/adapters/solana/decode.test.ts`:

```ts
import {
  decodeTransaction,
  isVote,
  parseTransaction,
  tokenTransfersLanded,
  touches,
} from '../../../src/adapters/solana/decode';
import { DEVNET_TRANSFER_CHECKED } from './support/fixtures';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PLACE = { height: 10n, hash: 'Hash1111111111111111111111111111111111111111' };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type Json = Record<string, unknown>;

/** A payer A sending 1,000 lamports to B, as `jsonParsed` shows it. */
function nativeTx(meta: Json = {}, instructions?: unknown[]): Json {
  return {
    slot: 7,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [100_000, 0, 1],
      postBalances: [94_000, 1_000, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
      ...meta,
    },
    transaction: {
      signatures: ['Sig1'],
      message: {
        accountKeys: [
          { pubkey: 'A', signer: true, writable: true },
          { pubkey: 'B', signer: false, writable: true },
          { pubkey: SYSTEM, signer: false, writable: false },
        ],
        instructions: instructions ?? [
          {
            program: 'system',
            programId: SYSTEM,
            parsed: {
              type: 'transfer',
              info: { source: 'A', destination: 'B', lamports: 1_000 },
            },
          },
        ],
      },
    },
    version: 'legacy',
  };
}

describe('Solana transaction decoding', () => {
  it('decodes a real devnet SPL transfer, with owners and the memo, as complete', () => {
    const parsed = parseTransaction(DEVNET_TRANSFER_CHECKED);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(decoded).toEqual({
      id: '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
      observation: {
        seen: 'block',
        txHash:
          '4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv',
        blockHeight: 10n,
        blockHash: PLACE.hash,
        success: true,
      },
      fee: [{ asset: 'native', amount: 10_001n }],
      transfers: [
        {
          locator: 'ix:2',
          from: ['8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT'],
          to: '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza',
          asset: {
            standard: 'spl',
            contract: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
          },
          amount: 1_000n,
          source: 'token-event',
          memo: '83c873a1f7d4c4bcfd6c095906248332',
        },
      ],
      decoding: 'complete',
      details: { slot: 504_092_431n, version: 0 },
    });
    expect(
      touches(decoded, parsed, new Set(['75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza'])),
    ).toBe(true);
    expect(
      touches(decoded, parsed, new Set(['DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3'])),
    ).toBe(false);
  });

  it('reports a failed transaction as the chain does: fee only, nothing moved (lesson 15)', () => {
    const failed = nativeTx({
      err: { InstructionError: [0, { Custom: 1 }] },
      postBalances: [95_000, 0, 1],
    });
    const decoded = decodeTransaction(parseTransaction(failed), PLACE);
    expect(decoded).toMatchObject({
      observation: { success: false, reason: 'transaction failed' },
      transfers: [],
      decoding: 'complete',
      details: { err: '{"InstructionError":[0,{"Custom":1}]}' },
    });
  });

  it('decodes inner system instructions and keeps them apart from outer ones', () => {
    const tx = nativeTx(
      {
        preBalances: [100_000, 0, 1, 1],
        postBalances: [93_000, 2_000, 1, 1],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                program: 'system',
                programId: SYSTEM,
                parsed: {
                  type: 'createAccount',
                  info: {
                    source: 'A',
                    newAccount: 'B',
                    lamports: 2_000,
                    space: 0,
                    owner: SYSTEM,
                  },
                },
                stackHeight: 2,
              },
            ],
          },
        ],
      },
      [{ programId: 'Prog', accounts: ['A', 'B'], data: '3x' }],
    );
    (tx.transaction as { message: { accountKeys: unknown[] } }).message.accountKeys.push({
      pubkey: 'Prog',
    });
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers).toEqual([
      {
        locator: 'ix:0.0',
        from: ['A'],
        to: 'B',
        asset: 'native',
        amount: 2_000n,
        source: 'internal',
      },
    ]);
    expect(decoded.decoding).toBe('complete');
  });

  it('marks value movement it cannot explain as partial', () => {
    // B gained 500 lamports more than any decoded instruction moved.
    expect(
      decodeTransaction(
        parseTransaction(nativeTx({ postBalances: [94_000, 1_500, 1] })),
        PLACE,
      ).decoding,
    ).toBe('partial');
    // A Token-2022 transfer is not decoded (spec §15), but its balances moved.
    const t22 = nativeTx(
      {
        preTokenBalances: [
          { accountIndex: 1, mint: 'M', owner: 'O', uiTokenAmount: { amount: '5' } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint: 'M', owner: 'O', uiTokenAmount: { amount: '4' } },
        ],
        postBalances: [95_000, 0, 1],
      },
      [
        {
          program: 'spl-token',
          programId: TOKEN_2022,
          parsed: {
            type: 'transferChecked',
            info: {
              source: 'B',
              destination: 'C',
              mint: 'M',
              authority: 'A',
              tokenAmount: { amount: '1' },
            },
          },
        },
      ],
    );
    const decoded = decodeTransaction(parseTransaction(t22), PLACE);
    expect([decoded.transfers, decoded.decoding]).toEqual([[], 'partial']);
  });

  it('falls back to token accounts when a node omits owners, as partial', () => {
    const tx = clone(DEVNET_TRANSFER_CHECKED) as unknown as {
      meta: { preTokenBalances: Json[]; postTokenBalances: Json[] };
    };
    for (const list of [tx.meta.preTokenBalances, tx.meta.postTokenBalances]) {
      for (const balance of list) delete balance.owner;
    }
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers[0]).toMatchObject({
      from: ['8CvwyW7amb4MB547dqWh633vsKPTiQrmDsKxn3p2Jcn3'],
      to: 'DeJGcDqExnXDaMc2TX4bG9A5hRQ5SPxszsb37Zq4kNj3',
    });
    expect(decoded.decoding).toBe('partial');
  });

  it('attaches a memo only when the transaction has exactly one', () => {
    const memo = (text: string) => ({
      program: 'spl-memo',
      programId: MEMO,
      parsed: text,
    });
    const transfer = (nativeTx().transaction as { message: { instructions: unknown[] } })
      .message.instructions[0];
    const one = decodeTransaction(
      parseTransaction(nativeTx({}, [transfer, memo('deposit-1')])),
      PLACE,
    );
    expect(one.transfers[0]?.memo).toBe('deposit-1');
    const two = decodeTransaction(
      parseTransaction(nativeTx({}, [transfer, memo('a'), memo('b')])),
      PLACE,
    );
    expect(two.transfers[0]?.memo).toBeUndefined();
  });

  it('keeps lamports above 2^53 exact, as the transport revives them (P5-A)', () => {
    const big = 2n ** 60n;
    const tx = nativeTx(
      {
        preBalances: [big, 0, 1],
        postBalances: [big - 5_000n - 2n ** 54n - 1n, 2n ** 54n + 1n, 1],
      },
      [
        {
          program: 'system',
          programId: SYSTEM,
          parsed: {
            type: 'transfer',
            info: { source: 'A', destination: 'B', lamports: 2n ** 54n + 1n },
          },
        },
      ],
    );
    const decoded = decodeTransaction(parseTransaction(tx), PLACE);
    expect(decoded.transfers[0]?.amount).toBe(18_014_398_509_481_985n);
    expect(decoded.decoding).toBe('complete');
    // A rounded number means something ignored `exactIntegers`: refused, never guessed.
    expect(() => parseTransaction(nativeTx({ preBalances: [2 ** 60, 0, 1] }))).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE' }),
    );
  });

  it('recognizes vote transactions and refuses malformed answers', () => {
    const vote = nativeTx({}, [
      {
        programId: 'Vote111111111111111111111111111111111111111',
        accounts: [],
        data: '1',
      },
    ]);
    expect(isVote(parseTransaction(vote))).toBe(true);
    expect(isVote(parseTransaction(nativeTx()))).toBe(false);
    for (const bad of [
      null,
      {},
      nativeTx({ preBalances: [1] }),
      nativeTx({ fee: -1 }),
      nativeTx({}, [{ parsed: {} }]),
    ]) {
      expect(() => parseTransaction(bad)).toThrow(
        expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
      );
    }
  });
});

describe('the scan filter is a superset (I4)', () => {
  it('keeps a deposit it cannot attribute, and drops an unrelated transaction', () => {
    // B gained lamports no decoded instruction explains (e.g. a closed token account).
    const unexplained = nativeTx({ postBalances: [94_000, 1_500, 1] });
    const parsed = parseTransaction(unexplained);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(decoded.decoding).toBe('partial');
    expect(touches(decoded, parsed, new Set(['B']))).toBe(true);
    expect(touches(decoded, parsed, new Set(['Z']))).toBe(false);
    // A token balance with no owner reported changed: it cannot be attributed, so it stays.
    const ownerless = clone(DEVNET_TRANSFER_CHECKED) as unknown as {
      meta: { preTokenBalances: Json[]; postTokenBalances: Json[] };
    };
    for (const list of [
      ownerless.meta.preTokenBalances,
      ownerless.meta.postTokenBalances,
    ]) {
      for (const balance of list) delete balance.owner;
    }
    const noOwner = parseTransaction(ownerless);
    expect(touches(decodeTransaction(noOwner, PLACE), noOwner, new Set(['Z']))).toBe(
      true,
    );
  });

  it('keeps an SPL deposit when the node reports no token balances (R4)', () => {
    // The recipient's owner is not an account key: only the balances would name it.
    const recipient = '75AjMdh7Gn1TLigfze541AVJGJ4TyqBEaRZk3pozfBza';
    const bare = clone(DEVNET_TRANSFER_CHECKED) as unknown as { meta: Json };
    delete bare.meta.preTokenBalances;
    delete bare.meta.postTokenBalances;
    const parsed = parseTransaction(bare);
    const decoded = decodeTransaction(parsed, PLACE);
    expect(parsed.keys).not.toContain(recipient);
    expect(decoded.decoding).toBe('partial');
    expect(touches(decoded, parsed, new Set([recipient]))).toBe(true);
    // With the balances reported, an unrelated watcher still sees nothing.
    const full = parseTransaction(DEVNET_TRANSFER_CHECKED);
    expect(touches(decodeTransaction(full, PLACE), full, new Set(['Z']))).toBe(false);
  });
});

describe('tokenTransfersLanded (lessons 7 and 15, the final wording; verdict paths only)', () => {
  const owner = '8sh86hmWL4ka7U44dFn3U72ZagLsAME4iRMwajfgR8QT';
  type Fixture = {
    meta: {
      err: unknown;
      preTokenBalances?: unknown;
      postTokenBalances: { uiTokenAmount: { amount: string } }[];
    };
    transaction: { message: { instructions: Record<string, unknown>[] } };
  };
  const fixture = () => clone(DEVNET_TRANSFER_CHECKED) as unknown as Fixture;
  const landed = (tx: unknown, from = owner) =>
    tokenTransfersLanded(parseTransaction(tx), from);

  it('needs a transfer from the sender to the recipient of a positive amount, not the exact one', () => {
    expect(landed(DEVNET_TRANSFER_CHECKED)).toBe(true);
    // The recipient got less than the instruction said (a fee-on-transfer token): it moved.
    const less = fixture();
    less.meta.postTokenBalances[1]!.uiTokenAmount.amount = '372685001';
    expect(landed(less)).toBe(true);
    // The recipient got nothing: failed.
    const nothing = fixture();
    nothing.meta.postTokenBalances[1]!.uiTokenAmount.amount = '372685000';
    expect(landed(nothing)).toBe(false);
    // A failed transaction moved nothing.
    const failed = fixture();
    failed.meta.err = { InstructionError: [2, { Custom: 1 }] };
    expect(landed(failed)).toBe(false);
    // A native transfer: the chain's status is the verdict.
    expect(landed(nativeTx(), 'A')).toBe(true);
  });

  it('decides nothing on missing or contradictory evidence (lesson 18, widened)', () => {
    // Token instructions, none by the sender: the answer contradicts the signed message.
    expect(() => landed(DEVNET_TRANSFER_CHECKED, 'Someone')).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INCONSISTENT', retryable: true }),
    );
    const noBalances = fixture();
    delete noBalances.meta.preTokenBalances;
    expect(() => landed(noBalances)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
    const unparsed = fixture();
    const instruction = unparsed.transaction.message.instructions[2]!;
    delete instruction.parsed;
    instruction.data = '3ck7szVs';
    instruction.accounts = [];
    expect(() => landed(unparsed)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_UNAVAILABLE', retryable: true }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/decode.test.ts`
Expected: FAIL: "Cannot find module '../../../src/adapters/solana/decode'".

- [ ] **Step 3: Write the decoder**

`src/adapters/solana/decode.ts`:

```ts
/**
 * Transaction decoding (spec §6.6, §15): `jsonParsed` transactions, inner instructions
 * included, into `DriverTransaction`s. Decoded transfers are checked against the pre/post
 * lamport and token balances; any movement they do not explain makes the transaction
 * `decoding: 'partial'`. Locators are `ix:<outer>` and `ix:<outer>.<inner>`.
 *
 * General decoding reports execution as the chain does (lesson 15). The phantom-success
 * guard (`tokenTransfersLanded`, lesson 7) is applied only on verdict paths.
 */
import type { DriverTransaction, DriverTransfer } from '../../core/driver/types';
import { canonicalJson } from '../../core/util/json';
import {
  MEMO_PROGRAM,
  MEMO_V1_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VOTE_PROGRAM,
} from './programs';
import { amountString, inconsistent, malformed, notYet, u64 } from './rpc';

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

interface Instruction {
  readonly locator: string;
  readonly inner: boolean;
  readonly programId: string;
  readonly program?: string;
  readonly type?: string;
  readonly info: Json | null;
  readonly parsedText?: string;
}

interface TokenBalance {
  readonly mint: string;
  readonly owner?: string;
  readonly amount: bigint;
}

/** A parsed transaction's facts, validated once. */
export interface ParsedTransaction {
  readonly signature: string;
  readonly keys: readonly string[];
  readonly err: unknown;
  readonly fee: bigint;
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokens: ReadonlyMap<number, TokenBalance>;
  readonly postTokens: ReadonlyMap<number, TokenBalance>;
  /** Whether the node reported token balances at all (both arrays present). */
  readonly tokenBalances: 'present' | 'absent';
  readonly instructions: readonly Instruction[];
  readonly version: 'legacy' | number;
  readonly slot?: bigint;
  readonly blockTime?: number;
}

/** Lamports are exact u64s: the transport parses them with `exactIntegers` (P5-A). */
const lamports = (value: unknown, what: string): bigint => u64(value, what);

function tokenBalances(value: unknown): Map<number, TokenBalance> {
  const balances = new Map<number, TokenBalance>();
  for (const entry of list(value)) {
    const balance = record(entry);
    const index = balance?.accountIndex;
    if (!balance || typeof index !== 'number' || !Number.isSafeInteger(index)) {
      throw malformed('token balance');
    }
    if (typeof balance.mint !== 'string') throw malformed('token balance');
    balances.set(index, {
      mint: balance.mint,
      ...(typeof balance.owner === 'string' ? { owner: balance.owner } : {}),
      amount: amountString(record(balance.uiTokenAmount)?.amount, 'token amount'),
    });
  }
  return balances;
}

function instruction(value: unknown, locator: string, inner: boolean): Instruction {
  const ix = record(value);
  if (!ix || typeof ix.programId !== 'string') throw malformed('instruction');
  const parsed = ix.parsed;
  const object = record(parsed);
  return {
    locator,
    inner,
    programId: ix.programId,
    ...(typeof ix.program === 'string' ? { program: ix.program } : {}),
    ...(typeof object?.type === 'string' ? { type: object.type } : {}),
    info: record(object?.info),
    ...(typeof parsed === 'string' ? { parsedText: parsed } : {}),
  };
}

/** Validates a `jsonParsed` transaction (from `getTransaction` or a block's list). */
export function parseTransaction(value: unknown): ParsedTransaction {
  const tx = record(value);
  const meta = record(tx?.meta);
  const transaction = record(tx?.transaction);
  const message = record(transaction?.message);
  if (!tx || !meta || !transaction || !message) throw malformed('transaction');
  const signature = list(transaction.signatures)[0];
  if (typeof signature !== 'string') throw malformed('transaction signatures');
  const keys = list(message.accountKeys).map((key) => {
    const pubkey = record(key)?.pubkey ?? key;
    if (typeof pubkey !== 'string') throw malformed('account keys');
    return pubkey;
  });
  const balances = (field: unknown) => {
    const values = list(field);
    if (values.length !== keys.length) throw malformed('balances');
    return values.map((v) => lamports(v, 'balance'));
  };
  const outer = list(message.instructions).map((ix, i) =>
    instruction(ix, `ix:${i}`, false),
  );
  const inner = list(meta.innerInstructions).flatMap((group) => {
    const g = record(group);
    const index = g?.index;
    if (!g || typeof index !== 'number') throw malformed('inner instructions');
    return list(g.instructions).map((ix, j) => instruction(ix, `ix:${index}.${j}`, true));
  });
  const version =
    tx.version === undefined || tx.version === 'legacy' ? 'legacy' : tx.version;
  if (version !== 'legacy' && typeof version !== 'number') throw malformed('version');
  return {
    signature,
    keys,
    err: meta.err ?? null,
    fee: lamports(meta.fee, 'fee'),
    preBalances: balances(meta.preBalances),
    postBalances: balances(meta.postBalances),
    preTokens: tokenBalances(meta.preTokenBalances),
    postTokens: tokenBalances(meta.postTokenBalances),
    tokenBalances:
      Array.isArray(meta.preTokenBalances) && Array.isArray(meta.postTokenBalances)
        ? 'present'
        : 'absent',
    instructions: [...outer, ...inner],
    version,
    ...(tx.slot !== undefined ? { slot: u64(tx.slot, 'slot') } : {}),
    ...(typeof tx.blockTime === 'number' && Number.isSafeInteger(tx.blockTime)
      ? { blockTime: tx.blockTime }
      : {}),
  };
}

/** A vote transaction: consensus traffic that moves no user value (skipped by scans). */
export const isVote = (tx: ParsedTransaction): boolean =>
  tx.instructions.length > 0 &&
  tx.instructions.every((ix) => ix.programId === VOTE_PROGRAM);

interface NativeMove {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

interface TokenMove {
  readonly source: string;
  readonly destination: string;
  readonly authority?: string;
  readonly mint?: string;
  readonly amount: bigint;
}

function nativeMove(ix: Instruction): NativeMove | null {
  if (ix.programId !== SYSTEM_PROGRAM || !ix.info) return null;
  const { info } = ix;
  const to =
    ix.type === 'transfer' || ix.type === 'transferWithSeed'
      ? info.destination
      : ix.type === 'createAccount' || ix.type === 'createAccountWithSeed'
        ? info.newAccount
        : undefined;
  if (to === undefined) return null;
  if (typeof info.source !== 'string' || typeof to !== 'string') {
    throw malformed('system instruction');
  }
  return { from: info.source, to, amount: lamports(info.lamports, 'lamports') };
}

function tokenMove(ix: Instruction): TokenMove | null {
  if (ix.programId !== TOKEN_PROGRAM || !ix.info) return null;
  if (ix.type !== 'transfer' && ix.type !== 'transferChecked') return null;
  const { info } = ix;
  const authority = info.authority ?? info.multisigAuthority;
  if (typeof info.source !== 'string' || typeof info.destination !== 'string') {
    throw malformed('token instruction');
  }
  const raw = ix.type === 'transfer' ? info.amount : record(info.tokenAmount)?.amount;
  return {
    source: info.source,
    destination: info.destination,
    ...(typeof authority === 'string' ? { authority } : {}),
    ...(typeof info.mint === 'string' ? { mint: info.mint } : {}),
    amount: amountString(raw, 'token amount'),
  };
}

const memoText = (ix: Instruction): string | undefined =>
  (ix.programId === MEMO_PROGRAM || ix.programId === MEMO_V1_PROGRAM) &&
  ix.parsedText !== undefined
    ? ix.parsedText
    : undefined;

/** Token balance deltas the decoded moves predict, per account index. */
function tokenDeltas(
  tx: ParsedTransaction,
  moves: readonly TokenMove[],
): Map<number, bigint> | null {
  const expected = new Map<number, bigint>();
  const add = (address: string, amount: bigint): boolean => {
    const index = tx.keys.indexOf(address);
    if (index < 0) return false;
    expected.set(index, (expected.get(index) ?? 0n) + amount);
    return true;
  };
  for (const move of moves) {
    if (!add(move.source, -move.amount) || !add(move.destination, move.amount))
      return null;
  }
  return expected;
}

function tokensReconcile(tx: ParsedTransaction, moves: readonly TokenMove[]): boolean {
  const expected = tokenDeltas(tx, moves);
  if (!expected) return false;
  const indices = new Set([
    ...tx.preTokens.keys(),
    ...tx.postTokens.keys(),
    ...expected.keys(),
  ]);
  for (const index of indices) {
    const actual =
      (tx.postTokens.get(index)?.amount ?? 0n) - (tx.preTokens.get(index)?.amount ?? 0n);
    if (actual !== (expected.get(index) ?? 0n)) return false;
  }
  return true;
}

function lamportsReconcile(tx: ParsedTransaction, moves: readonly NativeMove[]): boolean {
  const expected = new Map<number, bigint>([[0, -tx.fee]]);
  for (const move of moves) {
    const from = tx.keys.indexOf(move.from);
    const to = tx.keys.indexOf(move.to);
    if (from < 0 || to < 0) return false;
    expected.set(from, (expected.get(from) ?? 0n) - move.amount);
    expected.set(to, (expected.get(to) ?? 0n) + move.amount);
  }
  for (let i = 0; i < tx.keys.length; i++) {
    const pre = tx.preBalances[i] as bigint;
    const post = tx.postBalances[i] as bigint;
    if (post - pre !== (expected.get(i) ?? 0n)) return false;
  }
  return true;
}

const ownerOf = (tx: ParsedTransaction, address: string): string | undefined => {
  const index = tx.keys.indexOf(address);
  return tx.postTokens.get(index)?.owner ?? tx.preTokens.get(index)?.owner;
};

const mintOf = (tx: ParsedTransaction, move: TokenMove): string | undefined => {
  if (move.mint !== undefined) return move.mint;
  for (const address of [move.source, move.destination]) {
    const index = tx.keys.indexOf(address);
    const mint = tx.postTokens.get(index)?.mint ?? tx.preTokens.get(index)?.mint;
    if (mint !== undefined) return mint;
  }
  return undefined;
};

/** Where a transaction sits: the block's dense height and hash (never the slot). */
export interface BlockPlace {
  readonly height: bigint;
  readonly hash: string;
  readonly blockTime?: number;
}

/** Decodes a parsed transaction as the chain reports it (lesson 15). */
export function decodeTransaction(
  tx: ParsedTransaction,
  place: BlockPlace,
): DriverTransaction {
  const success = tx.err === null;
  let complete = true;
  const natives: { ix: Instruction; move: NativeMove }[] = [];
  const tokens: { ix: Instruction; move: TokenMove }[] = [];
  const memos: string[] = [];
  for (const ix of tx.instructions) {
    const text = memoText(ix);
    if (text !== undefined) memos.push(text);
    if (!success) continue;
    const native = nativeMove(ix);
    if (native) natives.push({ ix, move: native });
    const token = tokenMove(ix);
    if (token) tokens.push({ ix, move: token });
  }
  const memo = memos.length === 1 ? memos[0] : undefined;
  const transfers: DriverTransfer[] = [];
  for (const { ix, move } of natives) {
    transfers.push({
      locator: ix.locator,
      from: [move.from],
      to: move.to,
      asset: 'native',
      amount: move.amount,
      source: ix.inner ? 'internal' : 'native',
      ...(memo !== undefined ? { memo } : {}),
    });
  }
  for (const { ix, move } of tokens) {
    const mint = mintOf(tx, move);
    const from = ownerOf(tx, move.source);
    const to = ownerOf(tx, move.destination);
    if (mint === undefined) {
      complete = false;
      continue;
    }
    // Without the owners the node did not report, the token accounts stand in for them.
    if (from === undefined || to === undefined) complete = false;
    transfers.push({
      locator: ix.locator,
      from: [from ?? move.source],
      to: to ?? move.destination,
      asset: { standard: 'spl', contract: mint },
      amount: move.amount,
      source: 'token-event',
      ...(memo !== undefined ? { memo } : {}),
    });
  }
  if (
    !lamportsReconcile(
      tx,
      natives.map((n) => n.move),
    ) ||
    !tokensReconcile(
      tx,
      tokens.map((t) => t.move),
    )
  ) {
    complete = false;
  }
  return {
    id: tx.signature,
    observation: {
      seen: 'block',
      txHash: tx.signature,
      blockHeight: place.height,
      blockHash: place.hash,
      success,
      ...(success ? {} : { reason: 'transaction failed' }),
    },
    fee: [{ asset: 'native', amount: tx.fee }],
    transfers,
    decoding: complete ? 'complete' : 'partial',
    ...(place.blockTime !== undefined ? { timestamp: place.blockTime } : {}),
    details: {
      ...(tx.slot !== undefined ? { slot: tx.slot } : {}),
      version: tx.version,
      ...(success ? {} : { err: canonicalJson(tx.err) }),
    },
  };
}

/**
 * The scan filter (handoff §3: "at least every transaction with a transfer from or to"
 * the addresses), a conservative superset (I4): a decoded transfer names a watched
 * address; a watched account's lamports changed; a token balance owned by a watched
 * address changed, or one with no owner reported changed (it cannot be attributed); the
 * node reported no token balances and a token program ran (a deposit into an existing
 * token account names no owner then, R4); or the decoding is partial and a watched address
 * is among the account keys.
 */
export function touches(
  decoded: DriverTransaction,
  tx: ParsedTransaction,
  addresses: ReadonlySet<string>,
): boolean {
  const named = decoded.transfers.some(
    (transfer) =>
      addresses.has(transfer.to) || transfer.from.some((f) => addresses.has(f)),
  );
  if (named) return true;
  const keyed = tx.keys.some((key) => addresses.has(key));
  const lamportsMoved = tx.keys.some(
    (key, i) => addresses.has(key) && tx.preBalances[i] !== tx.postBalances[i],
  );
  if (lamportsMoved || (decoded.decoding === 'partial' && keyed)) return true;
  if (
    tx.tokenBalances === 'absent' &&
    tx.instructions.some(
      (ix) => ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM,
    )
  ) {
    return true;
  }
  const indices = new Set([...tx.preTokens.keys(), ...tx.postTokens.keys()]);
  for (const index of indices) {
    const pre = tx.preTokens.get(index);
    const post = tx.postTokens.get(index);
    if ((pre?.amount ?? 0n) === (post?.amount ?? 0n)) continue;
    const owner = post?.owner ?? pre?.owner;
    if (owner === undefined || addresses.has(owner)) return true;
  }
  return false;
}

/**
 * The phantom-success guard (lessons 7 and 15; the board's final wording), for verdict
 * paths only: a token transfer counts as executed only when the balances show a transfer
 * from the sender's account to the intended recipient's account of a positive amount. The
 * exact amount is not required (fee-on-transfer tokens exist). The intended recipient is
 * the destination of the sender's own signed instruction. Missing evidence (no token
 * balances, an unparsed instruction, accounts not in the keys) decides nothing (a
 * retryable `PROVIDER_UNAVAILABLE`), and so does an answer that contradicts the signed
 * message: token instructions, none of them by the sender, where the sender signed its own
 * `transferChecked` (lesson 18, widened; a retryable `PROVIDER_INCONSISTENT`). Seeing no
 * transfer never passes.
 */
export function tokenTransfersLanded(tx: ParsedTransaction, from: string): boolean {
  if (tx.err !== null) return false;
  const tokenInstructions = tx.instructions.filter(
    (ix) =>
      !ix.inner &&
      (ix.programId === TOKEN_PROGRAM || ix.programId === TOKEN_2022_PROGRAM),
  );
  // A native transfer: the chain's own status is the verdict.
  if (tokenInstructions.length === 0) return true;
  if (tokenInstructions.some((ix) => !ix.info)) {
    throw notYet('the parsed token instructions');
  }
  const ours = tokenInstructions.flatMap((ix) => {
    const move = tokenMove(ix);
    return move && move.authority === from ? [move] : [];
  });
  if (ours.length === 0) {
    throw inconsistent('the token instructions do not match the signed transaction');
  }
  if (tx.tokenBalances === 'absent') throw notYet('the token balances');
  const delta = (address: string): bigint => {
    const index = tx.keys.indexOf(address);
    if (index < 0) throw notYet('the accounts of the token transfer');
    return (
      (tx.postTokens.get(index)?.amount ?? 0n) - (tx.preTokens.get(index)?.amount ?? 0n)
    );
  };
  return ours.every((move) => {
    // A zero-amount record moved nothing; a transfer to itself cannot show in balances.
    if (move.amount === 0n) return false;
    if (move.source === move.destination) return true;
    return delta(move.source) < 0n && delta(move.destination) > 0n;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/decode.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add src/adapters/solana/decode.ts test/adapters/solana/support/fixtures.ts test/adapters/solana/decode.test.ts
git commit -m "feat(solana): jsonParsed decoding with balance reconciliation and the landing guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: Dense heights and the Solana reader

**Files:**
- Create: `src/adapters/solana/heights.ts`, `src/adapters/solana/reader.ts`
- Modify (test support): `test/adapters/solana/support/harness.ts` (replace it: adds `solanaHarness`)
- Test: `test/adapters/solana/heights.test.ts`, `test/adapters/solana/reader.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5; `AddressCodec`, `ChainReader`, `DriverBlock`, `DriverTxObservation`, `Logger`, `Transport`.
- Produces:
  - `heights.ts`: `HeightIndex(transport)` with `head(commitment, tags)` → `{ slot, header }`; `header(slot, commitment, tags)` → `BlockHeader | null` (`null` when the endpoint cannot show it); `slotAt(height, commitment, tags)` → `bigint | null` (`null` while no block at that height is visible; a height at or below the endpoint's finalized height resolves on the finalized chain and caches the pairs from it upward); `forget(height)`.
  - `reader.ts`: `SolanaContext { transport, codec, chain, network, config, heights, log, nextVariant }`; `AccountInfo`; `accountInfo(ctx, address, tags)`; `tokenAccount(ctx, address, tags)` (throws `INVALID_INTENT` for a non-token account); `mintOf(asset)`; `mintDecimals(ctx, mint, tags)` (lesson 13); `createSolanaAddressCodec()`; `blockAtHeight(ctx, height, tags)`; `readTransaction(ctx, signature, tags)`; `createSolanaReader(ctx)`; `tokenAccountsOf(ctx, owner, mint?, tags)`; `createSolanaExt(ctx)`.
  - `harness.ts` gains `solanaHarness({ endpoints?, node? })` → `{ …nodeTransport, ctx, calls, keys, from }` (devnet, a fixed variant of 0).

**Review points:**
- Heights: `getBlockHeight` at `confirmed` (head) and `finalized`; both are `monitor` reads; blocks by height via the index, checked against the height they claim (a contradiction is `PROVIDER_INCONSISTENT` and drops the cache).
- I3: no pair is cached before a read of its page's first block confirms the counted height; the downward search is bounded; a pruned endpoint answers a retryable error, never `null`; `forget()` clears the whole cache.
- Lesson 18, widened (R1): proofs reach this index, so any other RPC error from `header` or `getBlocks` (agave's `-32602 "BigTable query failed"` below its local ledger, `-32603`) goes through `undecided`: retryable, deciding nothing.
- `getTokenMetadata` (lesson 13): a missing mint, another program's account or unparsable data is `ASSET_RESOLUTION`; Token-2022 is `UNSUPPORTED_CAPABILITY`; a definitive node error becomes retryable; `PROVIDER_MISCONFIGURED` and retryable errors propagate unchanged.
- `observe` applies the landing guard only with an ordering (lesson 15; Plan 2's Task 8 note); a malformed id is `{ seen: 'none' }` with no request.
- `getBalance(owner, spl)` sums every classic token account of the owner for the mint (D12); lamports above 2^53 are exact (D19).
- Reads use `read` tags; heights and observations use `monitor` tags.

- [ ] **Step 1: Extend the harness**

Replace `test/adapters/solana/support/harness.ts` with:

```ts
import { SOLANA_CHAIN } from '../../../../src/adapters/solana/chains';
import { HeightIndex } from '../../../../src/adapters/solana/heights';
import { solanaNetworkConfig } from '../../../../src/adapters/solana/network';
import type { SolanaContext } from '../../../../src/adapters/solana/reader';
import type { SolanaCallTags } from '../../../../src/adapters/solana/types';
import { createWeb3Codec } from '../../../../src/adapters/solana/web3';
import { EventBus } from '../../../../src/core/events/bus';
import { noopLogger } from '../../../../src/core/events/logger';
import type { AioEvent } from '../../../../src/core/events/types';
import type { NetworkInfo } from '../../../../src/core/model/chain';
import { HttpTransport } from '../../../../src/core/transport/http-transport';
import type { Transport } from '../../../../src/core/transport/types';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import {
  ScriptedSolanaNode,
  type BalancedOptions,
  type EndpointOptions,
  type NodeOptions,
} from './node';
import { KEY_ADDRESS, KEY_PUBLIC } from './vectors';

export type Endpoint =
  string | ({ readonly name: string } & (EndpointOptions | BalancedOptions));

/** A scripted node behind a real HttpTransport, with one or more endpoints. */
export function nodeTransport(
  options: Omit<NodeOptions, 'clock'> = {},
  endpoints: readonly Endpoint[] = ['main'],
) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ ...options, clock });
  const events = new EventBus(clock, noopLogger);
  const seen: AioEvent[] = [];
  events.onAny((event) => seen.push(event));
  const transport = new HttpTransport(
    endpoints.map((entry) => {
      const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
      return { name, url: node.endpoint(name, rest) };
    }),
    {
      clock,
      events,
      log: noopLogger,
      options: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    },
  );
  const run = <T>(promise: Promise<T>): Promise<T> => drive(clock, promise);
  return { clock, node, transport, run, seen };
}

/** Records every JSON-RPC call's method, tags and params (lesson 1), passing it through. */
export function recording(transport: Transport) {
  const calls: { method: string; tags: SolanaCallTags; params: unknown }[] = [];
  const rpc = (
    method: string,
    params: unknown,
    options: Record<string, unknown> = {},
  ) => {
    const { signal: _signal, quorumKey: _key, exactIntegers: _exact, ...tags } = options;
    calls.push({ method, tags: tags as SolanaCallTags, params });
    return transport.rpc(method, params, options);
  };
  // Methods run on the real transport, whose private fields a Proxy receiver cannot reach.
  const wrapped = new Proxy(transport, {
    get(target, prop) {
      if (prop === 'rpc') return rpc;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { transport: wrapped, calls };
}

/** A Solana driver context for devnet over a scripted node. */
export function solanaHarness(
  options: {
    readonly endpoints?: readonly Endpoint[];
    readonly node?: Omit<NodeOptions, 'clock'>;
  } = {},
) {
  const t = nodeTransport(options.node, options.endpoints);
  const network = SOLANA_CHAIN.networks.devnet as NetworkInfo;
  const { transport, calls } = recording(t.transport);
  const ctx: SolanaContext = {
    transport,
    codec: createWeb3Codec(t.transport),
    chain: SOLANA_CHAIN,
    network,
    config: solanaNetworkConfig(SOLANA_CHAIN, network),
    heights: new HeightIndex(transport),
    log: noopLogger,
    nextVariant: () => 0,
  };
  const keys = [{ scheme: 'ed25519', publicKey: KEY_PUBLIC }];
  return { ...t, ctx, calls, keys, from: KEY_ADDRESS };
}
```

- [ ] **Step 2: Write the failing tests**

`test/adapters/solana/heights.test.ts`:

```ts
import { HeightIndex } from '../../../src/adapters/solana/heights';
import { MONITOR } from '../../../src/adapters/solana/rpc';
import { nodeTransport, recording } from './support/harness';

function setup() {
  const t = nodeTransport();
  const { transport, calls } = recording(t.transport);
  return { ...t, calls, index: new HeightIndex(transport) };
}

describe('dense heights over slots (Review Focus 5)', () => {
  it('maps every height to its block, skipping empty slots', async () => {
    const { node, run, index } = setup();
    for (let i = 0; i < 12; i++) {
      if (i % 3 === 1) node.skip(i % 2 === 0 ? 1 : 2);
      node.produce();
    }
    for (let h = 0n; h <= node.head.height; h++) {
      expect(await run(index.slotAt(h, 'confirmed', MONITOR))).toBe(node.block(h)?.slot);
    }
    expect(
      await run(index.slotAt(node.head.height + 1n, 'confirmed', MONITOR)),
    ).toBeNull();
    expect(await run(index.slotAt(-1n, 'confirmed', MONITOR))).toBeNull();
  });

  it('answers finalized heights only up to the finalized block, and caches them for a forward scan', async () => {
    const { node, run, index, calls } = setup();
    node.skip(4);
    node.produce(10);
    const finalized = node.finalized.height;
    expect(await run(index.slotAt(finalized + 1n, 'finalized', MONITOR))).toBeNull();
    expect(await run(index.slotAt(3n, 'finalized', MONITOR))).toBe(node.block(3n)?.slot);
    calls.length = 0;
    // A forward scan from 3 finds every later height in the pairs that answer cached.
    for (let h = 3n; h <= finalized; h++) {
      expect(await run(index.slotAt(h, 'finalized', MONITOR))).toBe(node.block(h)?.slot);
    }
    expect(calls).toEqual([]);
    expect(
      calls.every((c) => c.tags.purpose === 'monitor' && c.tags.quorum === undefined),
    ).toBe(true);
  });

  it('widens its window for heights far below the head', async () => {
    const { node, run, index, calls } = setup();
    for (let i = 0; i < 600; i++) {
      node.produce();
      if (i % 5 === 0) node.skip(3);
    }
    expect(await run(index.slotAt(1n, 'confirmed', MONITOR))).toBe(node.block(1n)?.slot);
    expect(calls.filter((c) => c.method === 'getBlocks').length).toBeLessThanOrEqual(3);
  });

  it('refuses a block list that does not end at its anchor', async () => {
    const { node, run, index } = setup();
    node.produce(6);
    node.intercept = (_endpoint, method) =>
      method === 'getBlocks' ? { result: [1, 2, 3] } : undefined;
    await expect(run(index.slotAt(2n, 'confirmed', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('refuses a list that leaves out a block, and caches nothing from it (I3)', async () => {
    const { node, run, index, calls } = setup();
    node.produce(6);
    // A ledger gap: slot 2 missing from the list shifts every counted height.
    node.intercept = (_endpoint, method) =>
      method === 'getBlocks' ? { result: [0, 1, 3, 4] } : undefined;
    await expect(run(index.slotAt(2n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    node.intercept = undefined;
    calls.length = 0;
    expect(await run(index.slotAt(2n, 'finalized', MONITOR))).toBe(node.block(2n)?.slot);
    // Nothing was cached from the gapped list: the good answer needed a fresh list.
    expect(calls.map((c) => c.method)).toContain('getBlocks');
  });

  it('answers a height a pruned endpoint no longer holds with a retryable error, in bounded calls', async () => {
    const t = nodeTransport({}, [{ name: 'pruned', firstAvailableHeight: 40 }]);
    const { transport, calls } = recording(t.transport);
    const index = new HeightIndex(transport);
    for (let i = 0; i < 60; i++) {
      t.node.produce();
      if (i % 4 === 0) t.node.skip(1);
    }
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    expect(calls.length).toBeLessThanOrEqual(8);
    // A held height still resolves; a height not produced yet is null.
    expect(await t.run(index.slotAt(45n, 'finalized', MONITOR))).toBe(
      t.node.block(45n)?.slot,
    );
    expect(await t.run(index.slotAt(1_000n, 'confirmed', MONITOR))).toBeNull();
  });

  it('turns any other RPC error into a retryable one that decides nothing (lesson 18, widened)', async () => {
    const t = nodeTransport({}, [{ name: 'bt', bigtableFailsBelow: 40n }]);
    const index = new HeightIndex(t.transport);
    t.node.produce(200);
    // agave 4.3.0: getBlocks from below the local ledger, with long-term storage failing.
    await expect(t.run(index.slotAt(10n, 'finalized', MONITOR))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: expect.stringContaining('BigTable query failed') as unknown,
    });
    // An internal error on a header read.
    t.node.intercept = (_endpoint, method) =>
      method === 'getBlock'
        ? { error: { code: -32603, message: 'Internal error' } }
        : undefined;
    await expect(
      t.run(index.header(t.node.block(150n)?.slot as bigint, 'finalized', MONITOR)),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    t.node.intercept = undefined;
    // Heights well inside the local ledger still resolve.
    expect(await t.run(index.slotAt(150n, 'finalized', MONITOR))).toBe(
      t.node.block(150n)?.slot,
    );
  });
});
```

`test/adapters/solana/reader.test.ts`:

```ts
import { ed25519 } from '@noble/curves/ed25519';
import {
  createSolanaAddressCodec,
  createSolanaExt,
  createSolanaReader,
  type SolanaContext,
} from '../../../src/adapters/solana/reader';
import {
  createAssociatedTokenAccountIdempotent,
  systemTransfer,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { ProviderError } from '../../../src/core/errors/error';
import { TOKEN_2022, associatedAddress } from './support/node';
import { solanaHarness } from './support/harness';
import { signedTx } from './support/tx';
import { KEY_ADDRESS, KEY_PUBLIC, MINT, RECIPIENT } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'signature' as const, canonical: true });
const ORDERING = { kind: 'expiry' as const, lastValidHeight: 1_000n };
const OTHER_MINT = 'So11111111111111111111111111111111111111112';

function setup() {
  const h = solanaHarness();
  h.node.fund(KEY_ADDRESS, 10_000_000_000n);
  h.node.createMint(MINT, 6);
  h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
  h.node.produce(2);
  return { ...h, reader: createSolanaReader(h.ctx) };
}

/** Sends 2 tokens to RECIPIENT (creating its account) and mines the block. */
function tokenTransfer(h: ReturnType<typeof setup>): string {
  const destination = associatedAddress(RECIPIENT, MINT);
  const id = h.node.submit(
    signedTx(h.node.head.hash, [
      createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
      transferChecked(
        associatedAddress(KEY_ADDRESS, MINT),
        MINT,
        destination,
        KEY_ADDRESS,
        2_000_000n,
        6,
      ),
    ]),
  );
  h.node.produce(1);
  return id;
}

describe('Solana addresses', () => {
  const codec = createSolanaAddressCodec();
  it('validates, normalizes and derives strictly', () => {
    expect(codec.validate(KEY_ADDRESS)).toBe(true);
    expect(codec.normalize(KEY_ADDRESS)).toEqual({
      canonical: KEY_ADDRESS,
      display: KEY_ADDRESS,
    });
    expect(() => codec.normalize(`${KEY_ADDRESS}x`)).toThrow(
      expect.objectContaining({ code: 'INVALID_ADDRESS' }),
    );
    expect(codec.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    expect(() =>
      codec.fromPublicKey(ed25519.utils.randomPrivateKey().slice(0, 31)),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
  });
});

describe('the Solana reader', () => {
  it('reads balances: lamports, and every classic token account of an owner', async () => {
    const h = setup();
    // A second account of the same mint, owned by the same wallet (not its ATA).
    const extra = associatedAddress(RECIPIENT, OTHER_MINT);
    h.node.setAccount(extra, {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      lamports: h.node.rent(165),
      data: h.node.account(associatedAddress(KEY_ADDRESS, MINT))!.data,
    });
    h.calls.length = 0;
    expect(await h.run(h.reader.getBalance(KEY_ADDRESS, 'native'))).toBe(10_000_000_000n);
    expect(
      await h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'spl', contract: MINT })),
    ).toBe(10_000_000n);
    expect(
      await h.run(h.reader.getBalance(RECIPIENT, { standard: 'spl', contract: MINT })),
    ).toBe(0n);
    expect(
      h.calls.every((c) => c.tags.purpose === 'read' && c.tags.retry === 'safe'),
    ).toBe(true);
    await expect(
      h.run(h.reader.getBalance(KEY_ADDRESS, { standard: 'erc20', contract: MINT })),
    ).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
  });

  it('reads balances above 2^53 lamports exactly (P5-A)', async () => {
    const h = setup();
    h.node.fund(RECIPIENT, 2n ** 60n + 1n);
    expect(await h.run(h.reader.getBalance(RECIPIENT, 'native'))).toBe(2n ** 60n + 1n);
  });

  it('reads heights at confirmed and finalized as monitor reads, and blocks by height', async () => {
    const h = setup();
    h.node.skip(2);
    h.node.produce(3);
    h.calls.length = 0;
    expect(await h.run(h.reader.getBlockHeight())).toBe(5n);
    expect(await h.run(h.reader.getFinalizedHeight())).toBe(3n);
    expect(h.calls.map((c) => [c.method, c.tags.purpose, c.params])).toEqual([
      ['getBlockHeight', 'monitor', [{ commitment: 'confirmed' }]],
      ['getBlockHeight', 'monitor', [{ commitment: 'finalized' }]],
    ]);
    expect(await h.run(h.reader.getBlock(4n))).toEqual({
      height: 4n,
      hash: h.node.block(4n)?.hash,
      parentHash: h.node.block(3n)?.hash,
      timestamp: expect.any(Number),
    });
    expect(await h.run(h.reader.getBlock(6n))).toBeNull();
    await expect(h.run(h.reader.getBlock(h.node.head.hash))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
  });

  it('reads and decodes transactions; a malformed id is simply not found', async () => {
    const h = setup();
    const id = h.node.submit(
      signedTx(h.node.head.hash, [
        systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
      ]),
    );
    h.node.produce(1);
    const tx = await h.run(h.reader.getTransaction(id));
    expect(tx).toMatchObject({
      id,
      observation: {
        seen: 'block',
        blockHeight: 3n,
        blockHash: h.node.block(3n)?.hash,
        success: true,
      },
      transfers: [
        { locator: 'ix:0', to: RECIPIENT, asset: 'native', amount: 1_000_000_000n },
      ],
      decoding: 'complete',
    });
    h.calls.length = 0;
    expect(await h.run(h.reader.getTransaction('not-a-signature'))).toBeNull();
    expect(await h.run(h.reader.observe(ref('0x12'), undefined, undefined))).toEqual({
      seen: 'none',
    });
    expect(h.calls).toEqual([]);
  });

  it('observes our own token transfers with the phantom-success guard, others as the chain says', async () => {
    const h = setup();
    const id = tokenTransfer(h);
    expect(await h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS))).toEqual({
      seen: 'block',
      txHash: id,
      blockHeight: 3n,
      blockHash: h.node.block(3n)?.hash,
      success: true,
    });
    // An answer whose balances do not show our transfer (lesson 7).
    const tampered = JSON.parse(JSON.stringify(await rawTransaction(h, id)));
    tampered.meta.postTokenBalances = tampered.meta.preTokenBalances;
    h.node.intercept = (_endpoint, method) =>
      method === 'getTransaction' ? { result: tampered } : undefined;
    expect(await h.run(h.reader.observe(ref(id), ORDERING, KEY_ADDRESS))).toMatchObject({
      success: false,
      reason: 'token transfer failed',
    });
    // Lesson 15: an unmanaged lookup reports the chain's own view.
    expect(await h.run(h.reader.observe(ref(id), undefined, undefined))).toMatchObject({
      success: true,
    });
  });

  it('classifies token metadata failures (lesson 13)', async () => {
    const h = setup();
    const meta = (mint: string) =>
      h.run(h.reader.getTokenMetadata!({ standard: 'spl', contract: mint }));
    expect(await meta(MINT)).toEqual({ symbol: MINT.slice(0, 8), decimals: 6 });
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      retryable: false,
    });
    h.node.fund(OTHER_MINT, 1_000_000n);
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    h.node.createMint(RECIPIENT, 6, TOKEN_2022);
    await expect(meta(RECIPIENT)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    h.node.setAccount(OTHER_MINT, {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: new Uint8Array(82),
    });
    await expect(meta(OTHER_MINT)).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
      message: 'the mint does not parse',
    });
    await expect(meta('bad')).rejects.toMatchObject({ code: 'ASSET_RESOLUTION' });
    expect(h.reader.normalizeTokenRef!({ standard: 'spl', contract: MINT })).toEqual({
      standard: 'spl',
      contract: MINT,
    });
  });

  it('makes a node error retryable and keeps PROVIDER_MISCONFIGURED final', async () => {
    const failing = (error: unknown): SolanaContext =>
      ({
        ...solanaHarness().ctx,
        transport: { rpc: () => Promise.reject(error) },
      }) as unknown as SolanaContext;
    const definitive = new ProviderError('RPC_ERROR', 'getAccountInfo failed: x', {
      details: { rpcCode: -32603, rpcMessage: 'x' },
    });
    await expect(
      createSolanaReader(failing(definitive)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', retryable: true });
    const misconfigured = new ProviderError(
      'PROVIDER_MISCONFIGURED',
      'identity mismatch',
    );
    await expect(
      createSolanaReader(failing(misconfigured)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toBe(misconfigured);
    const transient = new ProviderError('PROVIDER_UNAVAILABLE', 'down');
    await expect(
      createSolanaReader(failing(transient)).getTokenMetadata!({
        standard: 'spl',
        contract: MINT,
      }),
    ).rejects.toBe(transient);
  });

  it('lists token accounts through ext.solana', async () => {
    const h = setup();
    const ext = createSolanaExt(h.ctx);
    expect(await h.run(ext.solana.getTokenAccounts(KEY_ADDRESS))).toEqual([
      {
        address: associatedAddress(KEY_ADDRESS, MINT),
        mint: MINT,
        amount: 5_000_000n,
        frozen: false,
      },
    ]);
    expect(await h.run(ext.solana.getTokenAccounts(KEY_ADDRESS, OTHER_MINT))).toEqual([]);
    await expect(h.run(ext.solana.getTokenAccounts('nope'))).rejects.toMatchObject({
      code: 'INVALID_ADDRESS',
    });
  });
});

async function rawTransaction(h: ReturnType<typeof setup>, id: string): Promise<unknown> {
  const response = await h.node.fetch.fetch('https://main.solana.test/', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        id,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        },
      ],
    }),
  });
  return ((await response.json()) as { result: unknown }).result;
}
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm jest test/adapters/solana/heights.test.ts test/adapters/solana/reader.test.ts`
Expected: FAIL: "Cannot find module '../../../src/adapters/solana/heights'" (and `reader`).

- [ ] **Step 4: Write the height index**

`src/adapters/solana/heights.ts`:

```ts
/**
 * Dense block heights over Solana's slots (handoff §3: "use block height, not slot, on
 * Solana"). Slots can be skipped; block heights count only produced blocks, so every height
 * up to the head has exactly one block. The index maps a height to its slot with
 * `getBlocks`, which lists the produced slots of a range: anchored on a known block at
 * the head, the block `k` places before it in that list is `k` heights lower.
 *
 * A list can have gaps (a ledger jump to a snapshot, a long-term-storage gap, pruning), so
 * no pair is believed until a read of the list's first block confirms its height (I3). Only
 * finalized, verified pairs are cached (immutable chain data, spec §7), which makes a
 * forward scan cost one `getBlock` per height. A height the endpoint no longer holds is a
 * retryable error that decides nothing, never `null` (`null` means "not visible yet").
 * Every read is a single endpoint's view (lesson 17): verdicts quorum-read the block at the
 * resolved slot. Any other RPC error decides nothing either (lesson 18, widened): proofs
 * reach this index, and agave answers `getBlocks` below its local ledger with `-32602
 * "BigTable query failed"` when long-term storage fails.
 */
import type { Transport } from '../../core/transport/types';
import {
  blockHeader,
  call,
  gone,
  headerOptions,
  inconsistent,
  isGone,
  isNotYet,
  isSkipped,
  malformed,
  notYet,
  u64,
  undecided,
  type BlockHeader,
} from './rpc';
import type { Commitment, SolanaCallTags } from './types';

/** `getBlocks` accepts at most this many slots per call (agave). */
const MAX_RANGE = 500_000n;
/** At most this many `getBlocks` pages below the head (about 8 M slots). */
const MAX_PAGES = 16;
/** Verified finalized height → slot pairs kept per driver. */
const CACHE_SIZE = 8_192;

export interface HeadBlock {
  readonly slot: bigint;
  readonly header: BlockHeader;
}

export class HeightIndex {
  readonly #transport: Transport;
  readonly #final = new Map<bigint, bigint>();

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** The block at the endpoint's `commitment` head (one `getSlot`, one `getBlock`). */
  async head(commitment: Commitment, tags: SolanaCallTags): Promise<HeadBlock> {
    const slot = u64(
      await call(this.#transport, 'getSlot', [{ commitment }], tags),
      'getSlot',
    );
    const header = await this.header(slot, commitment, tags);
    if (!header) throw notYet(`the ${commitment} head block`);
    return { slot, header };
  }

  /**
   * The block at `slot`, or `null` while the endpoint has not reached it at `commitment`.
   * A pruned or missing block is a retryable error (decides nothing); a slot the endpoint
   * calls skipped means a list named a slot with no block, so the cache is dropped.
   */
  async header(
    slot: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<BlockHeader | null> {
    let result: unknown;
    try {
      result = await call(
        this.#transport,
        'getBlock',
        [Number(slot), headerOptions(commitment)],
        tags,
      );
    } catch (error) {
      if (isNotYet(error)) return null;
      if (isGone(error)) throw gone(`the block at slot ${slot}`);
      if (isSkipped(error)) {
        this.forget();
        throw inconsistent(`slot ${slot} holds no block`);
      }
      throw undecided(error, `the block at slot ${slot}`);
    }
    return result === null ? null : blockHeader(result);
  }

  /**
   * The slot of the block at `height` on the endpoint's chain at `commitment`, or `null`
   * while that chain has no block at `height` yet. A `confirmed` lookup at or below the
   * endpoint's finalized height resolves on the finalized chain, which fills the cache.
   */
  async slotAt(
    height: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint | null> {
    if (height < 0n) return null;
    const cached = this.#final.get(height);
    if (cached !== undefined) return cached;
    const final = await this.head('finalized', tags);
    if (height <= final.header.blockHeight) {
      return this.#resolve(height, final, 'finalized', tags);
    }
    if (commitment === 'finalized') return null;
    const top = await this.head('confirmed', tags);
    if (height > top.header.blockHeight) return null;
    return this.#resolve(height, top, 'confirmed', tags);
  }

  /** Counts back from `top` through verified `getBlocks` pages to the block at `height`. */
  async #resolve(
    height: bigint,
    top: HeadBlock,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint> {
    let anchorSlot = top.slot;
    let anchorHeight = top.header.blockHeight;
    if (height === anchorHeight) return anchorSlot;
    let span = anchorHeight - height + (anchorHeight - height) / 4n + 64n;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (span > MAX_RANGE) span = MAX_RANGE;
      const from = anchorSlot > span ? anchorSlot - span : 0n;
      const slots = await this.#blocks(from, anchorSlot, commitment, tags);
      const last = slots.length - 1;
      if (slots[last] !== anchorSlot) {
        throw inconsistent(`getBlocks does not end at slot ${anchorSlot}`);
      }
      // A list that adds nothing below its anchor: the endpoint holds nothing older.
      if (last === 0) throw gone(`the block at height ${height}`);
      // I3: the list's first block must sit exactly `last` heights below the anchor, or
      // the list has a gap; nothing from it is believed or cached.
      const firstHeight = anchorHeight - BigInt(last);
      const first = await this.header(slots[0] as bigint, commitment, tags);
      if (!first) throw notYet(`the block at slot ${slots[0]}`);
      if (first.blockHeight !== firstHeight) {
        throw inconsistent(`the blocks listed below slot ${anchorSlot} have a gap`);
      }
      slots.forEach((slot, i) => {
        const at = firstHeight + BigInt(i);
        // Keep the pairs a forward scan from `height` needs next.
        if (at >= height && at < height + BigInt(CACHE_SIZE)) {
          this.#remember(commitment, at, slot);
        }
      });
      if (height >= firstHeight) return slots[Number(height - firstHeight)] as bigint;
      if (from === 0n) throw gone(`the block at height ${height}`);
      anchorHeight = firstHeight;
      anchorSlot = slots[0] as bigint;
      span *= 2n;
    }
    throw gone(`the block at height ${height} (too far below the head)`);
  }

  async #blocks(
    from: bigint,
    to: bigint,
    commitment: Commitment,
    tags: SolanaCallTags,
  ): Promise<bigint[]> {
    let result: unknown;
    try {
      result = await call(
        this.#transport,
        'getBlocks',
        [Number(from), Number(to), { commitment }],
        tags,
      );
    } catch (error) {
      throw undecided(error, `the blocks from slot ${from}`);
    }
    if (!Array.isArray(result) || result.length === 0) throw malformed('getBlocks');
    const slots = result.map((slot) => u64(slot, 'getBlocks slot'));
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] as bigint;
      if (slot < from || slot > to || (i > 0 && slot <= (slots[i - 1] as bigint))) {
        throw malformed('getBlocks');
      }
    }
    return slots;
  }

  /** Drops every cached pair: a later read contradicted one (cheap to rebuild). */
  forget(): void {
    this.#final.clear();
  }

  #remember(commitment: Commitment, height: bigint, slot: bigint): void {
    if (commitment !== 'finalized' || this.#final.has(height)) return;
    this.#final.set(height, slot);
    if (this.#final.size > CACHE_SIZE) {
      const oldest = this.#final.keys().next().value as bigint;
      this.#final.delete(oldest);
    }
  }
}
```

- [ ] **Step 5: Write the reader**

`src/adapters/solana/reader.ts`:

```ts
/**
 * Solana addresses, reads and the `ext.solana` API. Every call carries the tags of the
 * `ChainDriver` contract table: `read` for point queries, `monitor` for heights and
 * observations. Heads are read at `confirmed`, finality at `finalized` (spec §15).
 */
import type {
  AddressCodec,
  ChainReader,
  DriverBlock,
  DriverTxObservation,
} from '../../core/driver/types';
import {
  UnsupportedCapabilityError,
  ValidationError,
  isCryptoAioError,
  withContext,
} from '../../core/errors/error';
import type { Logger } from '../../core/events/logger';
import type { AssetMetadata, AssetRef, TokenRef } from '../../core/model/asset';
import type { ChainInfo, NetworkInfo } from '../../core/model/chain';
import type { Transport } from '../../core/transport/types';
import {
  decodeTransaction,
  parseTransaction,
  tokenTransfersLanded,
  type ParsedTransaction,
} from './decode';
import type { HeightIndex } from './heights';
import {
  addressFromPublicKey,
  decodeBase58,
  encodeBase58,
  isAddress,
  isSignature,
} from './keys';
import type { SolanaNetworkConfig } from './network';
import {
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  decodeMint,
  decodeTokenAccount,
} from './programs';
import {
  MONITOR,
  READ,
  call,
  contextValue,
  inconsistent,
  malformed,
  notYet,
  parsedOptions,
  u64,
  type BlockHeader,
} from './rpc';
import type { SolanaCallTags, SolanaCodec, SolanaExt, SolanaTokenAccount } from './types';

/** What every Solana port is built from. */
export interface SolanaContext {
  readonly transport: Transport;
  readonly codec: SolanaCodec;
  readonly chain: ChainInfo;
  readonly network: NetworkInfo;
  readonly config: SolanaNetworkConfig;
  readonly heights: HeightIndex;
  readonly log: Logger;
  /** The next build variant (`fees.ts`, `variantCounter`). */
  readonly nextVariant: () => number;
}

export interface AccountInfo {
  readonly owner: string;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function base64Data(value: unknown, what: string): Uint8Array {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[1] !== 'base64' ||
    typeof value[0] !== 'string'
  ) {
    throw malformed(what);
  }
  return new Uint8Array(Buffer.from(value[0], 'base64'));
}

/** `getAccountInfo` (base64) at `confirmed`; `null` when the account does not exist. */
export async function accountInfo(
  ctx: SolanaContext,
  address: string,
  tags: SolanaCallTags,
): Promise<AccountInfo | null> {
  const value = contextValue(
    await call(
      ctx.transport,
      'getAccountInfo',
      [address, { encoding: 'base64', commitment: 'confirmed' }],
      tags,
    ),
    'getAccountInfo',
  );
  if (value === null) return null;
  const account = record(value);
  if (
    !account ||
    typeof account.owner !== 'string' ||
    typeof account.executable !== 'boolean'
  ) {
    throw malformed('getAccountInfo');
  }
  return {
    owner: account.owner,
    executable: account.executable,
    data: base64Data(account.data, 'getAccountInfo'),
  };
}

/** A classic SPL token account's balance and state; `null` when it does not exist. */
export async function tokenAccount(
  ctx: SolanaContext,
  address: string,
  tags: SolanaCallTags,
): Promise<{
  readonly amount: bigint;
  readonly frozen: boolean;
  readonly mint: string;
  readonly owner: string;
} | null> {
  const info = await accountInfo(ctx, address, tags);
  if (!info) return null;
  const decoded = info.owner === TOKEN_PROGRAM ? decodeTokenAccount(info.data) : null;
  if (!decoded) {
    throw new ValidationError(
      'INVALID_INTENT',
      'the account is not a classic SPL token account',
    );
  }
  return {
    amount: decoded.amount,
    frozen: decoded.frozen,
    mint: encodeBase58(decoded.mint),
    owner: encodeBase58(decoded.owner),
  };
}

const assetError = (reason: string) => new ValidationError('ASSET_RESOLUTION', reason);

/** The mint of an `spl` asset ref; any other standard is not a Solana token. */
export function mintOf(asset: AssetRef): string {
  if (asset === 'native' || asset.standard !== 'spl') {
    throw assetError(`Solana tokens use the 'spl' standard`);
  }
  if (!isAddress(asset.contract)) throw assetError('not a Solana mint address');
  return asset.contract;
}

/**
 * A classic Token mint's decimals (lesson 13): a missing mint, an account of another
 * program or data that does not parse is the token's own `ASSET_RESOLUTION`; a Token-2022
 * mint is `UNSUPPORTED_CAPABILITY` (spec §15). A definitive node error is made retryable;
 * `PROVIDER_MISCONFIGURED` and retryable errors propagate unchanged.
 */
export async function mintDecimals(
  ctx: SolanaContext,
  mint: string,
  tags: SolanaCallTags,
): Promise<number> {
  let info: AccountInfo | null;
  try {
    info = await accountInfo(ctx, mint, tags);
  } catch (error) {
    if (isCryptoAioError(error, 'RPC_ERROR') && !error.retryable) {
      throw withContext(error, {}, { retryable: true });
    }
    throw error;
  }
  if (!info) throw assetError('no mint at this address');
  if (info.owner === TOKEN_2022_PROGRAM) {
    throw new UnsupportedCapabilityError(
      'UNSUPPORTED_CAPABILITY',
      'Token-2022 mints are not supported',
    );
  }
  if (info.owner !== TOKEN_PROGRAM) throw assetError('not an SPL token mint');
  const decoded = decodeMint(info.data);
  if (!decoded) throw assetError('the mint does not parse');
  return decoded.decimals;
}

export function createSolanaAddressCodec(): AddressCodec {
  return {
    validate: (value) => isAddress(value),
    normalize: (value) => {
      if (!isAddress(value)) {
        throw new ValidationError('INVALID_ADDRESS', 'not a Solana address');
      }
      return { canonical: value, display: value };
    },
    fromPublicKey: (publicKey) => {
      const canonical = addressFromPublicKey(publicKey);
      return { canonical, display: canonical };
    },
  };
}

function driverBlock(height: bigint, header: BlockHeader): DriverBlock {
  return {
    height,
    hash: header.blockhash,
    parentHash: header.previousBlockhash,
    ...(header.blockTime !== undefined ? { timestamp: header.blockTime } : {}),
  };
}

/**
 * The block at dense `height` (`confirmed`), checked against the height it claims; `null`
 * while the endpoint has no block there. A contradicting answer is a retryable
 * `PROVIDER_INCONSISTENT`, and the cached slot it came from is dropped.
 */
export async function blockAtHeight(
  ctx: SolanaContext,
  height: bigint,
  tags: SolanaCallTags,
): Promise<{ readonly slot: bigint; readonly block: DriverBlock } | null> {
  const slot = await ctx.heights.slotAt(height, 'confirmed', tags);
  if (slot === null) return null;
  const header = await ctx.heights.header(slot, 'confirmed', tags);
  if (!header) return null;
  if (header.blockHeight !== height) {
    ctx.heights.forget();
    throw inconsistent(`the block at slot ${slot} is not at height ${height}`);
  }
  return { slot, block: driverBlock(height, header) };
}

/** Reads and decodes a transaction at `confirmed`, with its block's height and hash. */
export async function readTransaction(
  ctx: SolanaContext,
  signature: string,
  tags: SolanaCallTags,
): Promise<{ readonly parsed: ParsedTransaction; readonly header: BlockHeader } | null> {
  const result = await call(
    ctx.transport,
    'getTransaction',
    [signature, parsedOptions('confirmed')],
    tags,
  );
  if (result === null) return null;
  const parsed = parseTransaction(result);
  if (parsed.signature !== signature || parsed.slot === undefined) {
    throw malformed('getTransaction');
  }
  const header = await ctx.heights.header(parsed.slot, 'confirmed', tags);
  if (!header) throw notYet('the block of the transaction');
  return { parsed, header };
}

export function createSolanaReader(ctx: SolanaContext): ChainReader {
  const height = async (commitment: 'confirmed' | 'finalized') =>
    u64(
      await call(ctx.transport, 'getBlockHeight', [{ commitment }], MONITOR),
      'getBlockHeight',
    );
  return {
    getBalance: async (address, asset) => {
      if (asset === 'native') {
        return u64(
          contextValue(
            await call(
              ctx.transport,
              'getBalance',
              [address, { commitment: 'confirmed' }],
              READ,
            ),
            'getBalance',
          ),
          'balance',
        );
      }
      const mint = mintOf(asset);
      const accounts = await tokenAccountsOf(ctx, address, mint, READ);
      return accounts.reduce((sum, account) => sum + account.amount, 0n);
    },
    getBlockHeight: () => height('confirmed'),
    getFinalizedHeight: () => height('finalized'),
    getBlock: async (ref) => {
      if (typeof ref !== 'bigint') {
        throw new UnsupportedCapabilityError(
          'UNSUPPORTED_CAPABILITY',
          'Solana has no block lookup by hash; pass a block height',
        );
      }
      return (await blockAtHeight(ctx, ref, READ))?.block ?? null;
    },
    getTransaction: async (id) => {
      if (!isSignature(id)) return null;
      const found = await readTransaction(ctx, id, READ);
      if (!found) return null;
      return decodeTransaction(found.parsed, {
        height: found.header.blockHeight,
        hash: found.header.blockhash,
        ...(found.parsed.blockTime !== undefined
          ? { blockTime: found.parsed.blockTime }
          : {}),
      });
    },
    observe: async (ref, ordering, from): Promise<DriverTxObservation> => {
      if (!isSignature(ref.id)) return { seen: 'none' };
      const found = await readTransaction(ctx, ref.id, MONITOR);
      if (!found) return { seen: 'none' };
      const { parsed, header } = found;
      let success = parsed.err === null;
      let reason = success ? undefined : 'transaction failed';
      // Lesson 7/15: the phantom-success guard applies to our own Attempts only.
      if (success && ordering !== undefined && from !== undefined) {
        if (!tokenTransfersLanded(parsed, from)) {
          success = false;
          reason = 'token transfer failed';
        }
      }
      return {
        seen: 'block',
        txHash: parsed.signature,
        blockHeight: header.blockHeight,
        blockHash: header.blockhash,
        success,
        ...(reason !== undefined ? { reason } : {}),
      };
    },
    getTokenMetadata: async (ref: TokenRef): Promise<AssetMetadata> => {
      const mint = mintOf(ref);
      const decimals = await mintDecimals(ctx, mint, READ);
      // SPL mints carry no symbol on chain: a registered token has its own; any other
      // shows the first characters of its mint (display only, spec §6.2).
      return { symbol: mint.slice(0, 8), decimals };
    },
    normalizeTokenRef: (ref) => ({ standard: 'spl', contract: mintOf(ref) }),
  };
}

/** The classic token accounts of `owner`, optionally for one mint. */
export async function tokenAccountsOf(
  ctx: SolanaContext,
  owner: string,
  mint: string | undefined,
  tags: SolanaCallTags,
): Promise<SolanaTokenAccount[]> {
  const value = contextValue(
    await call(
      ctx.transport,
      'getTokenAccountsByOwner',
      [
        owner,
        mint !== undefined ? { mint } : { programId: TOKEN_PROGRAM },
        { encoding: 'base64', commitment: 'confirmed' },
      ],
      tags,
    ),
    'getTokenAccountsByOwner',
  );
  if (!Array.isArray(value)) throw malformed('getTokenAccountsByOwner');
  const accounts: SolanaTokenAccount[] = [];
  for (const entry of value) {
    const item = record(entry);
    const account = record(item?.account);
    if (!item || !account || !isAddress(item.pubkey)) {
      throw malformed('getTokenAccountsByOwner');
    }
    if (account.owner !== TOKEN_PROGRAM) continue; // Token-2022 is unsupported.
    const decoded = decodeTokenAccount(
      base64Data(account.data, 'getTokenAccountsByOwner'),
    );
    if (!decoded || encodeBase58(decoded.owner) !== owner) {
      throw malformed('getTokenAccountsByOwner');
    }
    const accountMint = encodeBase58(decoded.mint);
    if (mint !== undefined && accountMint !== mint)
      throw malformed('getTokenAccountsByOwner');
    accounts.push({
      address: item.pubkey,
      mint: accountMint,
      amount: decoded.amount,
      frozen: decoded.frozen,
    });
  }
  return accounts;
}

export function createSolanaExt(ctx: SolanaContext): SolanaExt {
  return {
    solana: {
      getTokenAccounts: async (owner, mint) => {
        if (!isAddress(owner)) {
          throw new ValidationError('INVALID_ADDRESS', 'not a Solana address');
        }
        if (mint !== undefined && decodeBase58(mint, 32) === null) {
          throw new ValidationError('INVALID_ADDRESS', 'not a Solana mint address');
        }
        return tokenAccountsOf(ctx, owner, mint, READ);
      },
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm jest test/adapters/solana/heights.test.ts test/adapters/solana/reader.test.ts`
Expected: PASS, 16 tests (7 + 9). "maps every height to its block, skipping empty slots", "refuses a list that leaves out a block, and caches nothing from it" and "answers a height a pruned endpoint no longer holds with a retryable error, in bounded calls" pin Review Focus 5.

- [ ] **Step 7: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add src/adapters/solana/heights.ts src/adapters/solana/reader.ts test/adapters/solana/support/harness.ts test/adapters/solana/heights.test.ts test/adapters/solana/reader.test.ts
git commit -m "feat(solana): dense block heights over slots, and the reader

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 7: The builder and the broadcaster

**Files:**
- Create: `src/adapters/solana/builder.ts`
- Test: `test/adapters/solana/builder.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6; `TxBuilder`, `Broadcaster`, `WalletKey`, `DriverIntent`, `UnsignedTx`, `SignedTx`, `isFeeSpeed`, `assetId`, `equalBytes`.
- Produces: `createSolanaBuilder(ctx): TxBuilder` and `createSolanaBroadcaster(ctx): Broadcaster`.
  - `estimateFee(intent)`: needs no key (a watch-only wallet can estimate); checks the recipient (D11, including M4's program ids for SPL) and the memo (D16); prices (D9) with a build variant on every limit, an explicit one included (D10, M3); returns `feeDraft(...)`.
  - `checkFunds(intent, fee)`: the token balance of the sender's associated token account (frozen → `INVALID_INTENT`) and the lamports for fees, amount and the rent reserve; `{ ok: false, asset, required, available }` otherwise.
  - `build(intent, fee, ctx)`: the ed25519 key for `from` (`SIGNER_UNAVAILABLE` otherwise), the budget, the transfer and memo instructions, a fresh `confirmed` blockhash; `UnsignedTx { payload: { encoding: 'base64', data: message }, signingRequests: [{ id: 's0', scheme: 'ed25519', payload: message, payloadKind: 'message', publicKey, keyRef? }], ordering: { kind: 'expiry', lastValidHeight }, fee, summary }`; refuses a transaction over 1,232 bytes.
  - `assemble(unsigned, signatures)`: `SignedTx { raw: { encoding: 'base64' }, ref: { id: base58(signature 0), idKind: 'signature', canonical: true } }`; `SIGNING_FAILED` for a missing or malformed signature or a message whose signers differ from the requests.
  - `broadcast(signed, { fanout?, signal? })`: `sendTransaction(raw, { encoding: 'base64', preflightCommitment: 'confirmed' })` under broadcast tags (fanout and signal passed through); a `hex` raw is converted; a `json` raw is `INVALID_INTENT`; definitive errors classified (D15), everything else rethrown unchanged.

**Review points:**
- The unsigned payload, the signing request's payload and the stored ordering come from one compiled message; `assemble` reads no fee field and parses no SDK object (Plan 2 Task 8 note: the core adds `fee.details.requestedFee` on replacements, which never happen on Solana).
- Review Focus 3 and 4 are pinned here; the funds check never lets a sender end between 0 and its rent-exempt minimum.
- A refusal of recipients happens before anything is signed, with validation codes and fixed texts.
- The broadcaster rethrows ambiguous `RPC_ERROR`s, non-RPC `ProviderError`s and foreign errors as the same objects (Plan 2 Task 8 note).

- [ ] **Step 1: Write the failing test**

`test/adapters/solana/builder.test.ts`:

```ts
import { base58 } from '@scure/base';
import { VersionedMessage } from '@solana/web3.js';
import {
  createSolanaBroadcaster,
  createSolanaBuilder,
} from '../../../src/adapters/solana/builder';
import { variantCounter } from '../../../src/adapters/solana/fees';
import type { SolanaContext } from '../../../src/adapters/solana/reader';
import type { BuildContext } from '../../../src/core/driver/types';
import { ProviderError } from '../../../src/core/errors/error';
import type { DriverIntent } from '../../../src/core/model/intent';
import { TOKEN, TOKEN_2022, associatedAddress } from './support/node';
import { solanaHarness } from './support/harness';
import { KEY_ADDRESS, MINT, RECIPIENT, RECIPIENT_KEY, sign } from './support/vectors';
import { ed25519 } from '@noble/curves/ed25519';

const SPL = { standard: 'spl', contract: MINT };
const SOL = 1_000_000_000n;
const intent = (overrides: Partial<DriverIntent> = {}): DriverIntent => ({
  asset: 'native',
  outputs: [{ to: RECIPIENT, amount: 1_000_000_000n }],
  from: KEY_ADDRESS,
  fee: 'normal',
  ...overrides,
});

function setup(options: { fees?: number[]; fund?: bigint } = {}) {
  const h = solanaHarness({
    node: { prioritizationFees: options.fees ?? [0, 10, 20, 30] },
  });
  h.node.fund(KEY_ADDRESS, options.fund ?? 10_000_000_000n);
  h.node.createMint(MINT, 6);
  h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
  h.node.produce(2);
  const build: BuildContext = { from: KEY_ADDRESS, keys: h.keys, wallet: {} };
  return {
    ...h,
    build,
    builder: createSolanaBuilder(h.ctx),
    broadcaster: createSolanaBroadcaster(h.ctx),
  };
}

type Setup = ReturnType<typeof setup>;

async function signedFor(h: Setup, request: DriverIntent) {
  const fee = await h.run(h.builder.estimateFee(request, h.build));
  const unsigned = await h.run(h.builder.build(request, fee, h.build));
  const signature = sign(unsigned.signingRequests[0]!.payload);
  return {
    fee,
    unsigned,
    signed: await h.run(
      h.builder.assemble(unsigned, [{ requestId: 's0', bytes: signature }]),
    ),
  };
}

describe('Solana fee estimates', () => {
  it('prices a native transfer from the node: signature fee, simulated limit, percentile price', async () => {
    const h = setup();
    h.calls.length = 0;
    const fee = await h.run(h.builder.estimateFee(intent(), h.build));
    // Simulated: 150 + 150 + 150 units; limit = 450 + 90 + 1,000; normal = the 50th percentile (10).
    expect(fee).toEqual({
      kind: 'solana',
      speed: 'normal',
      bound: 'exact',
      charges: [
        { asset: 'native', amount: 5_000n, label: 'network' },
        { asset: 'native', amount: 1n, label: 'priority' },
      ],
      details: {
        signatures: 1,
        baseFee: 5_000n,
        computeUnitLimit: 1_540n,
        computeUnitPrice: 10n,
        priorityFee: 1n,
        rent: 0n,
        createsRecipientAccount: false,
      },
    });
    expect(
      h.calls.every((c) => c.tags.purpose === 'read' && c.tags.retry === 'safe'),
    ).toBe(true);
    expect(h.calls.map((c) => c.method)).toEqual([
      'getAccountInfo',
      'getMinimumBalanceForRentExemption',
      'getRecentPrioritizationFees',
      'getLatestBlockhash',
      'simulateTransaction',
      'getFeeForMessage',
    ]);
  });

  it('charges the rent of a missing recipient token account as an upper bound', async () => {
    const h = setup();
    const missing = await h.run(
      h.builder.estimateFee(
        intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
        h.build,
      ),
    );
    expect(missing).toMatchObject({
      bound: 'upper',
      details: { createsRecipientAccount: true, rent: 1_488_440n },
    });
    expect(missing.charges.map((c) => c.label)).toEqual(['network', 'priority', 'rent']);
    h.node.mintTo(MINT, RECIPIENT, 0n);
    const existing = await h.run(
      h.builder.estimateFee(
        intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
        h.build,
      ),
    );
    expect(existing).toMatchObject({
      bound: 'exact',
      details: { createsRecipientAccount: false, rent: 0n },
    });
  });

  it("honours an explicit price exactly, and varies every build's limit (D10, M3)", async () => {
    const h = setup();
    const custom = await h.run(
      h.builder.estimateFee(
        intent({ fee: { computeUnitPrice: 2_000_000n, computeUnitLimit: 20_000n } }),
        h.build,
      ),
    );
    expect(custom).toMatchObject({
      speed: 'custom',
      details: {
        computeUnitPrice: 2_000_000n,
        computeUnitLimit: 20_000n,
        priorityFee: 40_000n,
      },
    });
    const varied: SolanaContext = {
      ...h.ctx,
      nextVariant: variantCounter(1_024 * 7 + 3),
    };
    const fee = await h.run(createSolanaBuilder(varied).estimateFee(intent(), h.build));
    expect(fee.details).toMatchObject({
      computeUnitLimit: 1_543n,
      computeUnitPrice: 17n,
    });
    // An explicit limit gets the variant too, so identical overrides differ; its price not.
    const explicit = await h.run(
      createSolanaBuilder(varied).estimateFee(
        intent({ fee: { computeUnitPrice: 2_000_000n, computeUnitLimit: 20_000n } }),
        h.build,
      ),
    );
    expect(explicit.details).toMatchObject({
      computeUnitPrice: 2_000_000n,
      computeUnitLimit: 20_004n,
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ fee: { gasPrice: 1n } }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });
});

describe('refusals before signing (Review Focus 4)', () => {
  it('refuses recipients that would lose the funds', async () => {
    const h = setup();
    h.node.setAccount(RECIPIENT, {
      owner: 'Stake11111111111111111111111111111111111111',
      data: new Uint8Array(200),
    });
    await expect(h.run(h.builder.estimateFee(intent(), h.build))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a program-owned account',
    });
    // M4: SPL to a program id, whose token account nobody could ever sign for.
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({
            asset: SPL,
            outputs: [{ to: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', amount: 1n }],
          }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a program; send to a wallet or a PDA owner',
    });
    const tokenAccount = associatedAddress(KEY_ADDRESS, MINT);
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: tokenAccount, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: SPL, outputs: [{ to: tokenAccount, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient is a token account; send to its owner',
    });
    const fresh = base58.encode(ed25519.getPublicKey(RECIPIENT_KEY.replace('8b', '8c')));
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: fresh, amount: 650_239n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ outputs: [{ to: fresh, amount: 650_240n }] }),
          h.build,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'solana',
    });
  });

  it('refuses frozen accounts, Token-2022 mints, bad memos, several outputs and a foreign key', async () => {
    const h = setup();
    h.node.mintTo(MINT, RECIPIENT, 0n, { frozen: true });
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: SPL, outputs: [{ to: RECIPIENT, amount: 1n }] }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the recipient token account is frozen',
    });
    const t22 = 'So11111111111111111111111111111111111111112';
    h.node.createMint(t22, 9, TOKEN_2022);
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({ asset: { standard: 'spl', contract: t22 } }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'x'.repeat(257) }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'a\uD800b' }), h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
    await expect(
      h.run(h.builder.estimateFee(intent({ memo: 'é'.repeat(128) }), h.build)),
    ).resolves.toBeDefined();
    await expect(
      h.run(
        h.builder.estimateFee(
          intent({
            outputs: [
              { to: RECIPIENT, amount: 1n },
              { to: RECIPIENT, amount: 2n },
            ],
          }),
          h.build,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // A fee needs no key; building for an address the wallet has no key for does.
    h.node.fund(RECIPIENT, 10_000_000_000n);
    const theirs = intent({
      from: RECIPIENT,
      outputs: [{ to: KEY_ADDRESS, amount: SOL }],
    });
    const fee = await h.run(h.builder.estimateFee(theirs, { ...h.build, keys: [] }));
    await expect(
      h.run(h.builder.build(theirs, fee, { ...h.build, from: RECIPIENT })),
    ).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
  });
});

describe('funds checks (Review Focus 4)', () => {
  it('keeps the sender at zero or above the rent-exempt minimum', async () => {
    const h = setup({ fund: 2_000_000n });
    const fee = await h.run(
      h.builder.estimateFee(
        intent({ outputs: [{ to: RECIPIENT, amount: 1_500_000n }] }),
        h.build,
      ),
    );
    // 2,000,000 − 1,500,000 − fees would leave about 495,000: below the 650,240 minimum.
    const spent = 1_500_000n + fee.charges.reduce((s, c) => s + c.amount, 0n);
    const available = 2_000_000n;
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: 1_500_000n }] }),
          fee,
          h.build,
        ),
      ),
    ).toEqual({ ok: false, asset: 'native', required: spent + 650_240n, available });
    const sweep = available - fee.charges.reduce((s, c) => s + c.amount, 0n);
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: sweep }] }),
          fee,
          h.build,
        ),
      ),
    ).toEqual({
      ok: true,
    });
    expect(
      await h.run(
        h.builder.checkFunds(
          intent({ outputs: [{ to: RECIPIENT, amount: 3_000_000n }] }),
          fee,
          h.build,
        ),
      ),
    ).toMatchObject({ ok: false, asset: 'native', available });
  });

  it('checks the token balance of the source account and the lamports for fees', async () => {
    const h = setup();
    const request = intent({
      asset: SPL,
      outputs: [{ to: RECIPIENT, amount: 6_000_000n }],
    });
    const fee = await h.run(h.builder.estimateFee(request, h.build));
    expect(await h.run(h.builder.checkFunds(request, fee, h.build))).toEqual({
      ok: false,
      asset: SPL,
      required: 6_000_000n,
      available: 5_000_000n,
    });
    h.node.mintTo(MINT, KEY_ADDRESS, 0n, { frozen: true });
    await expect(
      h.run(h.builder.checkFunds(request, fee, h.build)),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      message: 'the source token account is frozen',
    });
  });
});

describe('building and assembling', () => {
  it('builds a legacy message with the estimate, an expiry ordering and one ed25519 request', async () => {
    const h = setup();
    const request = intent({
      asset: SPL,
      outputs: [{ to: RECIPIENT, amount: 2_000_000n }],
      memo: 'order-7',
    });
    const { fee, unsigned, signed } = await signedFor(h, request);
    expect(unsigned.ordering).toEqual({
      kind: 'expiry',
      lastValidHeight: h.node.head.height + 150n,
    });
    expect(unsigned.signingRequests).toEqual([
      {
        id: 's0',
        scheme: 'ed25519',
        payload: expect.any(Uint8Array),
        payloadKind: 'message',
        publicKey: h.keys[0]!.publicKey,
      },
    ]);
    expect(unsigned.summary).toEqual({
      asset: `solana:devnet/spl:${MINT}`,
      outputs: [{ to: RECIPIENT, amount: '2000000' }],
      memo: 'order-7',
    });
    expect(unsigned.fee).toBe(fee);
    const message = VersionedMessage.deserialize(
      Buffer.from(unsigned.payload.data, 'base64'),
    );
    const programs = message.compiledInstructions.map((ix) =>
      message.staticAccountKeys[ix.programIdIndex]!.toBase58(),
    );
    expect(programs).toEqual([
      'ComputeBudget111111111111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      TOKEN,
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ]);
    expect(message.recentBlockhash).toBe(h.node.head.hash);
    expect(signed.ref).toEqual({
      id: base58.encode(sign(unsigned.signingRequests[0]!.payload)),
      idKind: 'signature',
      canonical: true,
    });
    expect(signed.raw.encoding).toBe('base64');
  });

  it('gives two identical Operations different bytes (identical-transfer hazard)', async () => {
    const h = setup();
    const ctx: SolanaContext = { ...h.ctx, nextVariant: variantCounter(0) };
    const builder = createSolanaBuilder(ctx);
    const payloads = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const fee = await h.run(builder.estimateFee(intent(), h.build));
      payloads.add((await h.run(builder.build(intent(), fee, h.build))).payload.data);
    }
    expect(payloads.size).toBe(3);
  });

  it('refuses to assemble with a missing or foreign signature request', async () => {
    const h = setup();
    const fee = await h.run(h.builder.estimateFee(intent(), h.build));
    const unsigned = await h.run(h.builder.build(intent(), fee, h.build));
    await expect(h.run(h.builder.assemble(unsigned, []))).rejects.toMatchObject({
      code: 'SIGNING_FAILED',
    });
    await expect(
      h.run(
        h.builder.assemble(unsigned, [{ requestId: 's0', bytes: new Uint8Array(63) }]),
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
    const foreign = {
      ...unsigned,
      signingRequests: [
        {
          ...unsigned.signingRequests[0]!,
          publicKey: ed25519.getPublicKey(RECIPIENT_KEY),
        },
      ],
    };
    await expect(
      h.run(
        h.builder.assemble(foreign, [{ requestId: 's0', bytes: new Uint8Array(64) }]),
      ),
    ).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
  });
});

describe('the Solana broadcaster', () => {
  it('sends with preflight at confirmed and classifies the answers', async () => {
    const h = setup();
    const { signed } = await signedFor(h, intent());
    h.calls.length = 0;
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({ kind: 'accepted' });
    expect(h.calls).toEqual([
      {
        method: 'sendTransaction',
        tags: { purpose: 'broadcast', retry: 'ambiguous-on-failure' },
        params: [
          signed.raw.data,
          { encoding: 'base64', preflightCommitment: 'confirmed' },
        ],
      },
    ]);
    h.node.produce(1);
    expect(await h.run(h.broadcaster.broadcast(signed))).toEqual({
      kind: 'already-known',
    });
    const hex = {
      ...signed,
      raw: {
        encoding: 'hex' as const,
        data: Buffer.from(signed.raw.data, 'base64').toString('hex'),
      },
    };
    expect(await h.run(h.broadcaster.broadcast(hex))).toEqual({ kind: 'already-known' });
    const forged = Buffer.from(signed.raw.data, 'base64');
    forged[5] = (forged[5] as number) ^ 1;
    expect(
      await h.run(
        h.broadcaster.broadcast({
          ...signed,
          raw: { encoding: 'base64', data: forged.toString('base64') },
        }),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid signature' });
    await expect(
      h.run(
        h.broadcaster.broadcast({ ...signed, raw: { encoding: 'json', data: '{}' } }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });

  it('passes fanout and signal through, and rethrows every unclassified failure unchanged', async () => {
    const seen: unknown[] = [];
    const stub = (error: unknown): SolanaContext =>
      ({
        ...solanaHarness().ctx,
        transport: {
          rpc: (_m: string, _p: unknown, options: unknown) => {
            seen.push(options);
            return Promise.reject(error);
          },
        },
      }) as unknown as SolanaContext;
    const signed = {
      raw: { encoding: 'base64' as const, data: 'AA==' },
      ref: { id: '', idKind: 'signature' as const, canonical: true },
    };
    const failures = [
      new ProviderError('RPC_ERROR', 'x', {
        details: { rpcCode: -32002, rpcMessage: 'x' },
        ambiguous: true,
      }),
      new ProviderError('PROVIDER_UNAVAILABLE', 'timeout', { ambiguous: true }),
      new Error('foreign'),
    ];
    const signal = new AbortController().signal;
    for (const error of failures) {
      await expect(
        createSolanaBroadcaster(stub(error)).broadcast(signed, { fanout: 2, signal }),
      ).rejects.toBe(error);
    }
    expect(seen[0]).toMatchObject({
      purpose: 'broadcast',
      retry: 'ambiguous-on-failure',
      fanout: 2,
      signal,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/builder.test.ts`
Expected: FAIL: "Cannot find module '../../../src/adapters/solana/builder'".

- [ ] **Step 3: Write the builder and the broadcaster**

`src/adapters/solana/builder.ts`:

```ts
/**
 * Solana transfers (spec §15): SystemProgram and SPL `transferChecked`, with
 * `createAssociatedTokenAccountIdempotent` when the recipient's token account is missing,
 * an optional Memo, and compute-budget instructions. Expiry ordering: the recent blockhash's
 * `lastValidBlockHeight` is the Attempt's ordering. One `ed25519` signing request per
 * required signer, over the message; the Attempt ref is the first signature (canonical).
 */
import type { Broadcaster, TxBuilder, WalletKey } from '../../core/driver/types';
import {
  SigningError,
  ValidationError,
  type CryptoAioError,
} from '../../core/errors/error';
import { assetId } from '../../core/model/asset';
import { isFeeSpeed } from '../../core/model/fee';
import type { DriverIntent } from '../../core/model/intent';
import type { SignedTx, UnsignedTx } from '../../core/model/transaction';
import { equalBytes } from '../../core/util/bytes';
import { classifyBroadcastError } from './errors';
import {
  computeUnitLimitFor,
  detailsOf,
  fallbackComputeUnitLimit,
  feeDraft,
  lamportsCharged,
  parseOverride,
  priceForSpeed,
  priorityFee,
  variantOffsets,
} from './fees';
import { addressFromPublicKey, decodeBase58, encodeBase58 } from './keys';
import {
  MAX_COMPUTE_UNIT_LIMIT,
  MAX_MEMO_BYTES,
  MAX_TRANSACTION_SIZE,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SIZE,
  TOKEN_PROGRAM,
  createAssociatedTokenAccountIdempotent,
  memo,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  transferChecked,
} from './programs';
import {
  accountInfo,
  mintDecimals,
  mintOf,
  tokenAccount,
  type SolanaContext,
} from './reader';
import {
  BROADCAST,
  READ,
  call,
  contextValue,
  malformed,
  notYet,
  rpcCode,
  rpcMessage,
  u64,
  withSignal,
} from './rpc';
import type { SolanaCallTags, SolanaFeeDetails, SolanaInstruction } from './types';
import { messageSigners, signedTransaction } from './wire';

const invalid = (reason: string) => new ValidationError('INVALID_INTENT', reason);
/** A UTF-16 surrogate without its pair: text that has no UTF-8 encoding. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** What a transfer needs on chain, resolved once per estimate. */
interface TransferPlan {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly memo?: string;
  readonly token?: {
    readonly mint: string;
    readonly decimals: number;
    readonly source: string;
    readonly destination: string;
  };
  readonly createsRecipientAccount: boolean;
}

function keyOf(from: string, keys: readonly WalletKey[]): WalletKey {
  const key = keys.find((k) => k.scheme === 'ed25519');
  if (!key || addressFromPublicKey(key.publicKey) !== from) {
    throw new SigningError(
      'SIGNER_UNAVAILABLE',
      'no ed25519 key for the sending address',
    );
  }
  return key;
}

function memoOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (LONE_SURROGATE.test(text))
    throw invalid('the memo is not well-formed Unicode text');
  if (new TextEncoder().encode(text).length > MAX_MEMO_BYTES) {
    throw invalid(`the memo exceeds ${MAX_MEMO_BYTES} UTF-8 bytes`);
  }
  return text;
}

async function rentExemptMinimum(ctx: SolanaContext, bytes: number): Promise<bigint> {
  return u64(
    await call(
      ctx.transport,
      'getMinimumBalanceForRentExemption',
      [bytes, { commitment: 'confirmed' }],
      READ,
    ),
    'getMinimumBalanceForRentExemption',
  );
}

/** The one output and the recipient's on-chain checks (no key: a fee needs none). */
async function planTransfer(
  ctx: SolanaContext,
  intent: DriverIntent,
): Promise<TransferPlan> {
  const output = intent.outputs[0];
  if (!output || intent.outputs.length !== 1) {
    throw invalid('Solana transfers have exactly one output');
  }
  const { from } = intent;
  const text = memoOf(intent.memo);
  const base = {
    from,
    to: output.to,
    amount: output.amount,
    ...(text !== undefined ? { memo: text } : {}),
  };
  const recipient = output.to === from ? null : await accountInfo(ctx, output.to, READ);
  if (intent.asset === 'native') {
    if (recipient && (recipient.executable || recipient.owner !== SYSTEM_PROGRAM)) {
      throw invalid('the recipient is a program-owned account');
    }
    if (
      !recipient &&
      output.to !== from &&
      output.amount < (await rentExemptMinimum(ctx, 0))
    ) {
      throw new ValidationError(
        'INVALID_AMOUNT',
        'a new account needs at least the rent-exempt minimum',
      );
    }
    return { ...base, createsRecipientAccount: false };
  }
  const mint = mintOf(intent.asset);
  const decimals = await mintDecimals(ctx, mint, READ);
  // M4: nobody can sign for a program's associated token account.
  if (recipient?.executable) {
    throw invalid('the recipient is a program; send to a wallet or a PDA owner');
  }
  if (
    recipient &&
    (recipient.owner === TOKEN_PROGRAM || recipient.owner === TOKEN_2022_PROGRAM)
  ) {
    throw invalid('the recipient is a token account; send to its owner');
  }
  const source = ctx.codec.associatedTokenAddress(from, mint);
  const destination = ctx.codec.associatedTokenAddress(output.to, mint);
  const existing = await tokenAccount(ctx, destination, READ);
  if (existing && (existing.mint !== mint || existing.owner !== output.to)) {
    throw invalid('the recipient token account does not match');
  }
  if (existing?.frozen) throw invalid('the recipient token account is frozen');
  return {
    ...base,
    token: { mint, decimals, source, destination },
    createsRecipientAccount: existing === null,
  };
}

/** The transfer's own instructions (no compute budget). */
function transferInstructions(plan: TransferPlan): SolanaInstruction[] {
  const list: SolanaInstruction[] = [];
  const { token } = plan;
  if (token) {
    if (plan.createsRecipientAccount) {
      list.push(
        createAssociatedTokenAccountIdempotent(
          plan.from,
          token.destination,
          plan.to,
          token.mint,
        ),
      );
    }
    list.push(
      transferChecked(
        token.source,
        token.mint,
        token.destination,
        plan.from,
        plan.amount,
        token.decimals,
      ),
    );
  } else {
    list.push(systemTransfer(plan.from, plan.to, plan.amount));
  }
  if (plan.memo !== undefined) list.push(memo(plan.memo));
  return list;
}

const withBudget = (limit: bigint, price: bigint, list: readonly SolanaInstruction[]) => [
  setComputeUnitLimit(limit),
  setComputeUnitPrice(price),
  ...list,
];

async function latestBlockhash(
  ctx: SolanaContext,
  tags: SolanaCallTags,
): Promise<{ readonly blockhash: string; readonly lastValidBlockHeight: bigint }> {
  const value = contextValue(
    await call(ctx.transport, 'getLatestBlockhash', [{ commitment: 'confirmed' }], tags),
    'getLatestBlockhash',
  ) as { blockhash?: unknown; lastValidBlockHeight?: unknown } | null;
  if (!value || decodeBase58(value.blockhash, 32) === null) {
    throw malformed('getLatestBlockhash');
  }
  return {
    blockhash: value.blockhash as string,
    lastValidBlockHeight: u64(value.lastValidBlockHeight, 'lastValidBlockHeight'),
  };
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** The simulated compute units of the transfer, or `null` when it cannot be measured. */
async function simulatedUnits(
  ctx: SolanaContext,
  plan: TransferPlan,
  price: bigint,
  list: readonly SolanaInstruction[],
  blockhash: string,
): Promise<bigint | null> {
  const message = ctx.codec.compileMessage(
    plan.from,
    blockhash,
    withBudget(MAX_COMPUTE_UNIT_LIMIT, price, list),
  );
  const unsignedTx = signedTransaction([new Uint8Array(64)], message);
  const value = contextValue(
    await call(
      ctx.transport,
      'simulateTransaction',
      [
        base64(unsignedTx),
        {
          encoding: 'base64',
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'confirmed',
        },
      ],
      READ,
    ),
    'simulateTransaction',
  ) as { err?: unknown; unitsConsumed?: unknown } | null;
  if (!value) throw malformed('simulateTransaction');
  // A failing simulation (e.g. insufficient funds) still lets `checkFunds` explain itself.
  if (value.err !== null || value.unitsConsumed === undefined) return null;
  return u64(value.unitsConsumed, 'unitsConsumed');
}

export function createSolanaBuilder(ctx: SolanaContext): TxBuilder {
  return {
    async estimateFee(intent) {
      const plan = await planTransfer(ctx, intent);
      const list = transferInstructions(plan);
      const override = isFeeSpeed(intent.fee) ? undefined : parseOverride(intent.fee);
      const variant = variantOffsets(ctx.nextVariant());
      let price: bigint;
      if (override) {
        price = override.computeUnitPrice;
      } else {
        const writable = plan.token
          ? [plan.from, plan.token.source, plan.token.destination]
          : [plan.from, plan.to];
        const recent = await call(
          ctx.transport,
          'getRecentPrioritizationFees',
          [writable],
          READ,
        );
        price =
          priceForSpeed(recent, intent.fee as 'slow' | 'normal' | 'fast') + variant.price;
      }
      const { blockhash } = await latestBlockhash(ctx, READ);
      let base = override?.computeUnitLimit;
      if (base === undefined) {
        const units = await simulatedUnits(ctx, plan, price, list, blockhash);
        base =
          units === null
            ? fallbackComputeUnitLimit(list.length)
            : computeUnitLimitFor(units);
      }
      // D10, M3: every build varies the limit, an explicit one included (the price of an
      // explicit fee is kept exactly); at the protocol maximum no variant fits.
      const limit =
        base + variant.limit > MAX_COMPUTE_UNIT_LIMIT
          ? MAX_COMPUTE_UNIT_LIMIT
          : base + variant.limit;
      const message = ctx.codec.compileMessage(
        plan.from,
        blockhash,
        withBudget(limit, price, list),
      );
      const quoted = contextValue(
        await call(
          ctx.transport,
          'getFeeForMessage',
          [base64(message), { commitment: 'confirmed' }],
          READ,
        ),
        'getFeeForMessage',
      );
      // `null`: the endpoint does not know the blockhash yet.
      if (quoted === null) throw notYet('the fee of the message');
      const total = u64(quoted, 'getFeeForMessage');
      const priority = priorityFee(price, limit);
      if (total < priority) throw malformed('getFeeForMessage');
      const details: SolanaFeeDetails = {
        signatures: 1,
        baseFee: total - priority,
        computeUnitLimit: limit,
        computeUnitPrice: price,
        priorityFee: priority,
        rent: plan.createsRecipientAccount
          ? await rentExemptMinimum(ctx, TOKEN_ACCOUNT_SIZE)
          : 0n,
        createsRecipientAccount: plan.createsRecipientAccount,
      };
      return feeDraft(
        override ? 'custom' : (intent.fee as 'slow' | 'normal' | 'fast'),
        details,
      );
    },

    async checkFunds(intent, fee) {
      const output = intent.outputs[0];
      if (!output) throw invalid('Solana transfers have exactly one output');
      const balance = u64(
        contextValue(
          await call(
            ctx.transport,
            'getBalance',
            [intent.from, { commitment: 'confirmed' }],
            READ,
          ),
          'getBalance',
        ),
        'balance',
      );
      if (intent.asset !== 'native') {
        const mint = mintOf(intent.asset);
        const source = await tokenAccount(
          ctx,
          ctx.codec.associatedTokenAddress(intent.from, mint),
          READ,
        );
        if (source?.frozen) throw invalid('the source token account is frozen');
        const available = source?.amount ?? 0n;
        if (available < output.amount) {
          return { ok: false, asset: intent.asset, required: output.amount, available };
        }
      }
      // A system account may end at 0 or at the rent-exempt minimum, nothing in between.
      const spent =
        lamportsCharged(fee) + (intent.asset === 'native' ? output.amount : 0n);
      const minimum = await rentExemptMinimum(ctx, 0);
      if (balance < spent) {
        return { ok: false, asset: 'native', required: spent, available: balance };
      }
      const left = balance - spent;
      if (left !== 0n && left < minimum) {
        return {
          ok: false,
          asset: 'native',
          required: spent + minimum,
          available: balance,
        };
      }
      return { ok: true };
    },

    async build(intent, fee, build) {
      const output = intent.outputs[0];
      if (!output || intent.outputs.length !== 1) {
        throw invalid('Solana transfers have exactly one output');
      }
      const details = detailsOf(fee);
      const key = keyOf(intent.from, build.keys);
      const text = memoOf(intent.memo);
      const plan: TransferPlan = {
        from: intent.from,
        to: output.to,
        amount: output.amount,
        ...(text !== undefined ? { memo: text } : {}),
        createsRecipientAccount: details.createsRecipientAccount,
        ...(intent.asset === 'native'
          ? {}
          : await (async () => {
              const mint = mintOf(intent.asset);
              return {
                token: {
                  mint,
                  decimals: await mintDecimals(ctx, mint, READ),
                  source: ctx.codec.associatedTokenAddress(intent.from, mint),
                  destination: ctx.codec.associatedTokenAddress(output.to, mint),
                },
              };
            })()),
      };
      const list = withBudget(
        details.computeUnitLimit,
        details.computeUnitPrice,
        transferInstructions(plan),
      );
      const { blockhash, lastValidBlockHeight } = await latestBlockhash(
        ctx,
        withSignal(READ, build.signal),
      );
      const message = ctx.codec.compileMessage(plan.from, blockhash, list);
      const signers = messageSigners(message);
      if (!signers || signers.length !== 1 || signers[0] !== plan.from) {
        throw invalid('the compiled message has unexpected signers');
      }
      if (
        signedTransaction([new Uint8Array(64)], message).length > MAX_TRANSACTION_SIZE
      ) {
        throw invalid(`the transaction exceeds ${MAX_TRANSACTION_SIZE} bytes`);
      }
      const unsigned: UnsignedTx = {
        payload: { encoding: 'base64', data: base64(message) },
        signingRequests: [
          {
            id: 's0',
            scheme: 'ed25519',
            payload: message,
            payloadKind: 'message',
            publicKey: key.publicKey,
            ...(key.keyRef ? { keyRef: key.keyRef } : {}),
          },
        ],
        ordering: { kind: 'expiry', lastValidHeight: lastValidBlockHeight },
        fee,
        summary: {
          asset: assetId(ctx.chain.id, ctx.network.id, intent.asset),
          outputs: [{ to: output.to, amount: output.amount.toString() }],
          ...(text !== undefined ? { memo: text } : {}),
        },
      };
      return unsigned;
    },

    async assemble(unsigned, signatures): Promise<SignedTx> {
      const failed = (reason: string) => new SigningError('SIGNING_FAILED', reason);
      if (unsigned.payload.encoding !== 'base64') throw failed('not a Solana message');
      const message = new Uint8Array(Buffer.from(unsigned.payload.data, 'base64'));
      const signers = messageSigners(message);
      if (!signers || signers.length !== unsigned.signingRequests.length) {
        throw failed('the message and its signing requests do not match');
      }
      const bytes = unsigned.signingRequests.map((request, i) => {
        if (
          request.scheme !== 'ed25519' ||
          encodeBase58(request.publicKey) !== signers[i] ||
          !equalBytes(request.payload, message)
        ) {
          throw failed('the message and its signing requests do not match');
        }
        const signature = signatures.find((s) => s.requestId === request.id);
        if (!signature || signature.bytes.length !== 64) {
          throw failed(`missing signature for request ${request.id}`);
        }
        return signature.bytes;
      });
      const raw = signedTransaction(bytes, message);
      if (raw.length > MAX_TRANSACTION_SIZE) {
        throw failed(`the transaction exceeds ${MAX_TRANSACTION_SIZE} bytes`);
      }
      return {
        raw: { encoding: 'base64', data: base64(raw) },
        ref: {
          id: encodeBase58(bytes[0] as Uint8Array),
          idKind: 'signature',
          canonical: true,
        },
      };
    },
  };
}

export function createSolanaBroadcaster(ctx: SolanaContext): Broadcaster {
  return {
    async broadcast(signed, options = {}) {
      const { encoding, data } = signed.raw;
      if (encoding === 'json') {
        throw invalid('a Solana transaction is bytes (base64 or hex)');
      }
      const payload =
        encoding === 'hex' ? Buffer.from(data, 'hex').toString('base64') : data;
      try {
        await call(
          ctx.transport,
          'sendTransaction',
          [payload, { encoding: 'base64', preflightCommitment: 'confirmed' }],
          {
            ...withSignal(BROADCAST, options.signal),
            ...(options.fanout !== undefined ? { fanout: options.fanout } : {}),
          },
        );
        return { kind: 'accepted' };
      } catch (error) {
        // Handoff §3, R16/R17: only a definitive, non-ambiguous node answer is classified.
        const code = rpcCode(error);
        if (code === undefined) throw error;
        return classifyBroadcastError(code, rpcMessage(error as CryptoAioError));
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/builder.test.ts`
Expected: PASS, 12 tests. "refuses recipients that would lose the funds" and "keeps the sender at zero or above the rent-exempt minimum" pin Review Focus 4; "gives two identical Operations different bytes" and "honours an explicit price exactly, and varies every build's limit" pin Review Focus 3.

- [ ] **Step 5: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add src/adapters/solana/builder.ts test/adapters/solana/builder.test.ts
git commit -m "feat(solana): transfers, fees, funds checks, assembly and broadcasting

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: Proofs, the block source, history and the driver factory

**Files:**
- Create: `src/adapters/solana/proofs.ts`, `src/adapters/solana/history.ts`, `src/adapters/solana/driver.ts`
- Modify: `src/adapters/solana/web3.ts` (append `web3DriverFactory`)
- Test: `test/adapters/solana/driver.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7; `ProofSource`, `BlockSource`, `AddressHistorySource`, `ChainDriver`, `DriverFactory`, `HealthProbes`, `EndpointCall`, `randomBytes`.
- Produces:
  - `proofs.ts`: `BLOCKHASH_VALIDITY = 150n`, `PEER_SKEW = 2n`, `windowOf(lastValidHeight)` → `{ first, end }` (`lastValidHeight − 149` … `lastValidHeight + 1`, I1); `createSolanaProofs(ctx)` (D6, D7): `finalizedHead`, `includedFinal` (a positive answer from the finalized `getTransaction`; a negative one only from the window scan, C1, remembered per driver), `slotConsumed` (always `false`), `expired`, `blockHash`; every proof read under `PROOF` tags; every method wrapped by `guarded` (lesson 18, widened: no RPC error leaves a proof method as anything but a retryable error, R1); `createSolanaBlocks(ctx)`: `header(height)` (dense, `monitor`) and `transactions(block, filter?)` (the full `jsonParsed` block at `confirmed`, votes skipped, the superset address filter of Task 5, a changed block → retryable `PROVIDER_INCONSISTENT`, a pruned one → retryable `PROVIDER_UNAVAILABLE`).
  - `history.ts`: `MAX_HISTORY_PAGE = 1_000`; `createSolanaHistory(ctx)` (D17; `-32020` → retryable, M2).
  - `driver.ts`: `solanaDriverFactory(makeCodec: (transport) => SolanaCodec): DriverFactory`: validates the network, calls `setProbes` exactly once on the transport and on the indexer before any traffic (identity `getGenesisHash`, height `getBlockHeight` at `confirmed`, R19, M12), builds the context (a random variant start), and assembles `{ ordering: 'expiry', capabilities, address, reader, builder, broadcaster, proofs, blocks, history, ext: { solana: { getTokenAccounts } }, limits: () => ({ maxOutputs: 1 }), createNativeClient }` (no `sequence`, no `replacement`).
  - `web3.ts`: `web3DriverFactory = solanaDriverFactory(createWeb3Codec)`, which Task 9's manifest `load()` returns (Plan 2 Task 9's shape: the factory lives in `driver.ts`; the client module exports `<library>DriverFactory`; `driver.ts` imports no client).

**Review points:**
- Lesson 17 final form: no endpoint proposes a height for a verdict. `expired` is one predicate read; a lagging peer throws a retryable `PROVIDER_INCONSISTENT`; an endpoint that has not finalized a block answers nothing and decides nothing.
- Lesson 16 sharpened / C1: "not included" comes only from reading every block of the window (151 blocks, through `lastValidBlockHeight + 1`) under finality, each certifying its height and its parent; a lagging, pruned or gapped backend behind one load-balanced URL decides nothing; the tests use **one** endpoint (quorum 1). A block that holds the transaction while the index did not is `PROVIDER_INCONSISTENT`.
- I1: a transaction included at `lastValidBlockHeight + 1` is proven included.
- Lesson 18, widened (R1): only a definitive negative proof answers "no". Every other RPC error on a proof path (the index, the window list, a window block, a header, the finalized height, the block of a landed transfer; agave's `-32602 "BigTable query failed"` for an old window) is a retryable `PROVIDER_UNAVAILABLE`; `PROVIDER_MISCONFIGURED` and already-retryable errors pass unchanged.
- R2: each one-endpoint C1 test fails against the old composition (index empty twice, finalized past `L`, the window's first block held): the lagging backends sit below the transaction's block, the gap is mid-window, and an index that hides a transaction every block serves is `PROVIDER_INCONSISTENT`.
- Proven inclusion reads the transaction and its block at `finalized` under the quorum (lesson 2 keys), and applies the landing guard (lesson 7).
- `setProbes` once per transport, before traffic (M12), pinned with a counting Proxy; the driver never reads `maxLagBlocks` (R36).
- No request path waits on a real timer (lesson 1): a `setTimeout` spy and the 100-run step.
- History uses the indexer transport when configured (handoff §3).

- [ ] **Step 1: Write the failing test**

`test/adapters/solana/driver.test.ts`:

```ts
import { Connection } from '@solana/web3.js';
import { SOLANA_CHAIN } from '../../../src/adapters/solana/chains';
import {
  systemTransfer,
  transferChecked,
  createAssociatedTokenAccountIdempotent,
} from '../../../src/adapters/solana/programs';
import { web3DriverFactory } from '../../../src/adapters/solana/web3';
import type { ChainDriver } from '../../../src/core/driver/types';
import { noopLogger } from '../../../src/core/events/logger';
import type { NetworkInfo } from '../../../src/core/model/chain';
import type { OrderingData } from '../../../src/core/model/ordering';
import type { Transport } from '../../../src/core/transport/types';
import { nodeTransport, recording, type Endpoint } from './support/harness';
import { associatedAddress } from './support/node';
import { signedTx } from './support/tx';
import { KEY_ADDRESS, KEY_PUBLIC, MINT, RECIPIENT } from './support/vectors';

const ref = (id: string) => ({ id, idKind: 'signature' as const, canonical: true });

/** The parts of a `jsonParsed` transaction the reformatting tests change. */
interface TokenBalanceJson {
  owner?: string;
  uiTokenAmount: { amount: string; uiAmount: number | null };
}
interface TransactionJson {
  blockTime?: number | null;
  meta: Record<string, unknown> & {
    preTokenBalances: TokenBalanceJson[];
    postTokenBalances: TokenBalanceJson[];
  };
  transaction: { message: { instructions: Record<string, unknown>[] } };
}

async function driverFor(
  endpoints: readonly Endpoint[] = ['a', 'b'],
  indexer?: Transport,
) {
  const t = nodeTransport({}, endpoints);
  const { transport, calls } = recording(t.transport);
  const driver: ChainDriver = await web3DriverFactory.create({
    chain: SOLANA_CHAIN,
    network: SOLANA_CHAIN.networks.devnet as NetworkInfo,
    library: '@solana/web3.js',
    transport,
    ...(indexer ? { indexer } : {}),
    clock: t.clock,
    log: noopLogger,
    options: {},
  });
  t.node.fund(KEY_ADDRESS, 10_000_000_000n);
  return { ...t, driver, calls };
}

type Harness = Awaited<ReturnType<typeof driverFor>>;

const SOL = 1_000_000_000n;

/** A System transfer signed at the head but not sent: its bytes and expiry ordering. */
function heldBack(h: Harness, lamports = SOL) {
  const raw = signedTx(h.node.head.hash, [
    systemTransfer(KEY_ADDRESS, RECIPIENT, lamports),
  ]);
  const last = h.node.head.height + 150n;
  const ordering: OrderingData = { kind: 'expiry', lastValidHeight: last };
  return { raw, last, ordering };
}

/** Produces blocks until the node's head is at `height`. */
function produceTo(h: Harness, height: bigint): void {
  while (h.node.head.height < height) h.node.produce();
}

/** Runs `includedFinal` `times` times; every answer or retryable error it gave. */
async function verdicts(h: Harness, id: string, ordering: OrderingData, times = 6) {
  const out: unknown[] = [];
  for (let i = 0; i < times; i++) {
    try {
      out.push(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      );
    } catch (error) {
      expect(error).toMatchObject({ retryable: true });
      out.push('decides nothing');
    }
  }
  return out;
}

/** A System transfer signed at the head; returns its signature and expiry ordering. */
function transfer(
  h: Harness,
  lamports = 1_000_000_000n,
): { id: string; ordering: OrderingData } {
  const id = h.node.submit(
    signedTx(h.node.head.hash, [systemTransfer(KEY_ADDRESS, RECIPIENT, lamports)]),
  );
  return { id, ordering: { kind: 'expiry', lastValidHeight: h.node.head.height + 150n } };
}

describe('the Solana driver factory', () => {
  it('sets identity (getGenesisHash) and height probes before any traffic', async () => {
    const h = await driverFor();
    expect(h.node.served).toEqual([]);
    h.node.intercept = (endpoint, method) =>
      endpoint === 'a' && method === 'getGenesisHash'
        ? { result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }
        : undefined;
    h.node.produce(3);
    await h.run(h.transport.refreshHealth());
    expect(h.transport.status().map((s) => [s.id, s.state])).toEqual([
      ['a', 'disabled'],
      ['b', 'healthy'],
    ]);
    expect(h.transport.highestHeight()).toBe(3n);
    expect(h.seen).toContainEqual(
      expect.objectContaining({
        type: 'provider.misconfigured',
        expected: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
        actual: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      }),
    );
  });

  it('calls setProbes exactly once on the transport and the indexer, before any traffic', async () => {
    const counted = (target: Transport, counts: string[]) =>
      new Proxy(target, {
        get(t, prop) {
          const value = Reflect.get(t, prop) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            counts.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const main = nodeTransport({}, ['main']);
    const idx = nodeTransport({}, ['idx']);
    const counts: string[] = [];
    const indexerCounts: string[] = [];
    await web3DriverFactory.create({
      chain: SOLANA_CHAIN,
      network: SOLANA_CHAIN.networks.devnet as NetworkInfo,
      library: '@solana/web3.js',
      transport: counted(main.transport, counts),
      indexer: counted(idx.transport, indexerCounts),
      clock: main.clock,
      log: noopLogger,
      options: {},
    });
    expect(counts).toEqual(['setProbes']);
    expect(indexerCounts).toEqual(['setProbes']);
    expect([main.node.served, idx.node.served]).toEqual([[], []]);
  });

  it('offers expiry ordering, one output, ext.solana and a fresh native client per call', async () => {
    const h = await driverFor(['main']);
    expect(h.driver.ordering).toBe('expiry');
    expect([...h.driver.capabilities].sort()).toEqual([
      'address-history',
      'block-scan',
      'expiry',
      'memo',
      'tokens',
    ]);
    expect([h.driver.replacement, h.driver.sequence]).toEqual([undefined, undefined]);
    expect(h.driver.limits?.({})).toEqual({ maxOutputs: 1 });
    expect(h.driver.address.fromPublicKey(KEY_PUBLIC).canonical).toBe(KEY_ADDRESS);
    h.node.createMint(MINT, 6);
    h.node.mintTo(MINT, KEY_ADDRESS, 7n);
    const accounts = await h.run(
      (h.driver.ext!.solana!.getTokenAccounts! as (o: string) => Promise<unknown>)(
        KEY_ADDRESS,
      ),
    );
    expect(accounts).toEqual([expect.objectContaining({ mint: MINT, amount: 7n })]);
    const first = h.driver.createNativeClient!();
    const second = h.driver.createNativeClient!();
    expect(first.client).toBeInstanceOf(Connection);
    expect(first.client).not.toBe(second.client);
    // The native Connection reaches the same transport through its bridged fetch.
    h.node.served.length = 0;
    expect(await h.run((first.client as Connection).getBlockHeight('confirmed'))).toBe(
      Number(h.node.head.height),
    );
    expect(h.node.served.map((s) => s.method)).toEqual(['getBlockHeight']);
    await first.close?.();
    await second.close?.();
  });

  it('puts probes on the indexer too, and reads history from it', async () => {
    const indexer = nodeTransport({}, ['idx']);
    const h = await driverFor(['main'], indexer.transport);
    expect(indexer.transport.hasProbes()).toBe(true);
    indexer.node.fund(KEY_ADDRESS, 10_000_000_000n);
    indexer.node.produce(1);
    indexer.node.submit(
      signedTx(indexer.node.head.hash, [
        systemTransfer(KEY_ADDRESS, RECIPIENT, 1_000_000_000n),
      ]),
    );
    indexer.node.produce(1);
    const page = await indexer.run(h.driver.history!.list(KEY_ADDRESS, { limit: 5 }));
    expect(page.items).toHaveLength(1);
    expect(h.node.served.filter((s) => s.method === 'getSignaturesForAddress')).toEqual(
      [],
    );
  });

  it('never waits on a real timer on its request paths (lesson 1)', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    try {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.produce(3);
      await h.run(h.driver.reader.observe(ref(id), ordering, KEY_ADDRESS));
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS));
      await h.run(h.driver.reader.getTransaction(id));
      await h.run(
        h.driver.blocks!.transactions((await h.run(h.driver.blocks!.header(3n)))!),
      );
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Solana proofs', () => {
  it('proves inclusion only once final, from both endpoints, on proof tags', async () => {
    const h = await driverFor();
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.produce(1);
    await expect(
      h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    h.node.produce(2);
    h.calls.length = 0;
    h.node.served.length = 0;
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toEqual({
      included: true,
      success: true,
      blockHeight: 3n,
      blockHash: h.node.block(3n)?.hash,
      txHash: id,
    });
    expect(
      h.calls.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
    ).toBe(true);
    expect(new Set(h.node.served.map((s) => s.endpoint))).toEqual(new Set(['a', 'b']));
    expect(
      await h.run(h.driver.proofs.slotConsumed(ordering, KEY_ADDRESS, 'finalized')),
    ).toBe(false);
  });

  it('agrees across formatting differences and decides nothing on a different fact (Review Focus 2)', async () => {
    const h = await driverFor();
    h.node.createMint(MINT, 6);
    h.node.mintTo(MINT, KEY_ADDRESS, 5_000_000n);
    h.node.produce(2);
    const destination = associatedAddress(RECIPIENT, MINT);
    const id = h.node.submit(
      signedTx(h.node.head.hash, [
        createAssociatedTokenAccountIdempotent(KEY_ADDRESS, destination, RECIPIENT, MINT),
        transferChecked(
          associatedAddress(KEY_ADDRESS, MINT),
          MINT,
          destination,
          KEY_ADDRESS,
          2_000_000n,
          6,
        ),
      ]),
    );
    const ordering: OrderingData = {
      kind: 'expiry',
      lastValidHeight: h.node.head.height + 150n,
    };
    h.node.produce(3);
    /** Endpoint b formats (or alters) its finalized transaction answer. */
    const reformat = (mutate: (tx: TransactionJson) => void) => {
      h.node.intercept = (endpoint, method, params) => {
        if (endpoint !== 'b' || method !== 'getTransaction') return undefined;
        const tx = h.node.answer('b', method, params) as TransactionJson | null;
        if (tx) mutate(tx);
        return { result: tx };
      };
    };
    reformat((tx) => {
      tx.meta.costUnits = 1;
      tx.meta.logMessages = ['Program log: other node'];
      delete tx.meta.computeUnitsConsumed;
      for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
        delete b.owner;
        b.uiTokenAmount.uiAmount = null;
      }
      for (const ix of tx.transaction.message.instructions) ix.stackHeight = null;
      tx.blockTime = null;
    });
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({
      included: true,
      success: true,
    });
    reformat((tx) => {
      tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = '1';
    });
    await expect(
      h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('answers "not included" only past the window with the window on record (Review Focus 1)', async () => {
    const pruned = await driverFor(['a', { name: 'b', firstAvailableHeight: 5 }]);
    const honest = await driverFor(['a', 'b']);
    for (const h of [pruned, honest]) {
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.drop(id);
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
      });
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(false);
      h.node.produce(153);
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
      const verdict = h.run(
        h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS),
      );
      if (h === pruned) {
        // Endpoint b pruned heights below 5: it cannot vouch for the window's start (height 3).
        await expect(verdict).rejects.toMatchObject({
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        });
      } else {
        expect(await verdict).toEqual({ included: false });
      }
    }
  });

  it('proves a transfer included at lastValidBlockHeight + 1 as included, never absent (I1)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const { raw, last, ordering } = heldBack(h);
    produceTo(h, last);
    const id = h.node.submit(raw, { skipPreflight: true });
    h.node.produce(3);
    expect(h.node.landed(id)?.block.height).toBe(last + 1n);
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    expect(
      await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
    ).toMatchObject({ included: true, success: true, blockHeight: last + 1n });
  });

  it('attests expiry with a predicate at its own height: a lagging peer decides nothing (lesson 17)', async () => {
    const h = await driverFor(['a', { name: 'b', lag: 3 }]);
    h.node.produce(2);
    const { id, ordering } = transfer(h);
    h.node.drop(id);
    // a has finalized past lastValidHeight; b, three blocks behind, has not.
    h.node.produce(150 + 2 + 1);
    await expect(h.run(h.driver.proofs.expired(ordering))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
    h.node.produce(3);
    h.calls.length = 0;
    expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    // No endpoint proposed a height: one quorum read of the finalized height, nothing else.
    expect(h.calls.map((c) => [c.method, c.tags.purpose, c.tags.quorum])).toEqual([
      ['getBlockHeight', 'proof', 'proof'],
    ]);
  });

  describe('"not included" behind one URL (C1: one endpoint, quorum 1)', () => {
    it('never answers "not included" for a landed transfer when a backend lags', async () => {
      // Two of three backends lag (the rotation then reaches a lagging one for both index
      // reads of one proof, as the old composition needed to be fooled).
      const h = await driverFor([
        { name: 'lb', backends: [{}, { lag: 20 }, { lag: 20 }] },
      ]);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      produceTo(h, last - 3n);
      const id = h.node.submit(raw);
      h.node.produce(1);
      expect(h.node.landed(id)?.block.height).toBe(last - 2n);
      // The caught-up backend has finalized lastValid + 1; the lagging one only reaches
      // lastValid − 19, below the transaction's block, so its index shows nothing.
      produceTo(h, last + 3n);
      const answers = await verdicts(h, id, ordering);
      expect(answers).not.toContainEqual({ included: false });
      expect(answers).toContain('decides nothing');
      // Once the lagging backend has finalized the block too, the transfer is proven.
      produceTo(h, last + 30n);
      expect(await verdicts(h, id, ordering)).toContainEqual(
        expect.objectContaining({ included: true }),
      );
    });

    it('never answers "not included" when a backend\'s ledger lacks the transaction\'s block', async () => {
      // The gap covers the block that holds the transaction (filled in once it lands).
      const single: bigint[] = [];
      const balanced: bigint[] = [];
      for (const endpoint of [
        { name: 'gapped', missingHeights: single },
        // Behind a balancer the block lists can come from the whole backend, so only the
        // window scan sees the gap; one gapped URL is also caught by the height index (I3).
        {
          name: 'lb',
          backends: [{}, { missingHeights: balanced }, { missingHeights: balanced }],
        },
      ]) {
        const h = await driverFor([endpoint]);
        h.node.produce(2);
        const { raw, last, ordering } = heldBack(h);
        // Mid-window, away from the window's first and last blocks.
        produceTo(h, last - 50n);
        const id = h.node.submit(raw);
        h.node.produce(1);
        const height = h.node.landed(id)?.block.height as bigint;
        expect(height).toBe(last - 49n);
        single.push(height);
        balanced.push(height);
        produceTo(h, last + 5n);
        const answers = await verdicts(h, id, ordering);
        expect(answers).not.toContainEqual({ included: false });
        expect(answers).toContain('decides nothing');
      }
    });

    it('never answers "not included" when the index hides a transaction the window holds', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      produceTo(h, last - 50n);
      const id = h.node.submit(raw);
      h.node.produce(1);
      produceTo(h, last + 3n);
      // Every block is served; only the index answers "no such transaction".
      h.node.intercept = (_endpoint, method) =>
        method === 'getTransaction' ? { result: null } : undefined;
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT', retryable: true });
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
    });

    it('still proves an honest window without the transaction, once, and remembers it', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { raw, last, ordering } = heldBack(h);
      const id = h.node.submit(raw);
      h.node.drop(id);
      produceTo(h, last + 1n);
      // The window's last block (lastValid + 1) is not final yet: nothing is decided.
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      produceTo(h, last + 3n);
      h.calls.length = 0;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toEqual({ included: false });
      // One block read per height of the window (151), each with its signatures.
      const scanned = h.calls.filter(
        (c) =>
          c.method === 'getBlock' &&
          (c.params as [number, { transactionDetails?: string }])[1]
            .transactionDetails === 'signatures',
      );
      expect(scanned).toHaveLength(151);
      expect(
        scanned.every((c) => c.tags.purpose === 'proof' && c.tags.quorum === 'proof'),
      ).toBe(true);
      h.calls.length = 0;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toEqual({ included: false });
      expect(h.calls.map((c) => c.method)).toEqual(['getTransaction']);
    });
  });

  describe('no RPC error is a verdict (lesson 18, widened)', () => {
    it('decides nothing when long-term storage fails below the local ledger', async () => {
      // agave 4.3.0: getBlocks from below the local ledger answers -32602 "BigTable query
      // failed", getBlock answers null, and the transaction is not found.
      const h = await driverFor([{ name: 'bt', bigtableFailsBelow: 200n }]);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.drop(id);
      produceTo(h, 260n);
      expect(await h.run(h.driver.proofs.expired(ordering))).toBe(true);
      const answers = await verdicts(h, id, ordering);
      expect(answers).toEqual(Array(6).fill('decides nothing'));
      expect(h.node.served.map((s) => s.method)).toContain('getBlocks');
    });

    it('decides nothing when the block of a landed transfer fails to load', async () => {
      const h = await driverFor(['main']);
      h.node.produce(2);
      const { id, ordering } = transfer(h);
      h.node.produce(5);
      h.node.intercept = (_endpoint, method) =>
        method === 'getBlock'
          ? { error: { code: -32603, message: 'Internal error' } }
          : undefined;
      await expect(
        h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      h.node.intercept = undefined;
      expect(
        await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
      ).toMatchObject({ included: true, success: true });
    });

    const failing: readonly [
      string,
      (method: string, params: readonly unknown[]) => boolean,
    ][] = [
      ['the index (getTransaction)', (method) => method === 'getTransaction'],
      [
        'the window list (getBlocks)',
        (method, params) =>
          method === 'getBlocks' &&
          (params[2] as { minContextSlot?: number }).minContextSlot !== undefined,
      ],
      [
        'a block of the window (getBlock)',
        (method, params) =>
          method === 'getBlock' &&
          (params[1] as { transactionDetails?: string }).transactionDetails ===
            'signatures',
      ],
      [
        'the height index (getBlocks)',
        (method, params) =>
          method === 'getBlocks' &&
          (params[2] as { minContextSlot?: number }).minContextSlot === undefined,
      ],
      ['a block header (getBlock)', (method) => method === 'getBlock'],
      [
        'the finalized height (getBlockHeight)',
        // Not the health probe, which reads the confirmed height.
        (method, params) =>
          method === 'getBlockHeight' &&
          (params[0] as { commitment?: string }).commitment === 'finalized',
      ],
    ];
    it.each(failing)(
      'turns a definitive error from %s into a retryable PROVIDER_UNAVAILABLE',
      async (_what, fails) => {
        const h = await driverFor(['main']);
        h.node.produce(2);
        const { id, ordering } = transfer(h);
        h.node.drop(id);
        produceTo(h, 160n);
        h.node.intercept = (_endpoint, method, params) =>
          fails(method, params)
            ? { error: { code: -32603, message: 'Internal error' } }
            : undefined;
        await expect(
          h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
        ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
        h.node.intercept = undefined;
        expect(
          await h.run(h.driver.proofs.includedFinal(ref(id), ordering, KEY_ADDRESS)),
        ).toEqual({ included: false });
      },
    );
  });

  it('serves block hashes by level, null above the head or the finalized block (R33)', async () => {
    const h = await driverFor();
    h.node.skip(2);
    h.node.produce(5);
    expect(await h.run(h.driver.proofs.blockHash(3n, 'finalized'))).toBe(
      h.node.block(3n)?.hash,
    );
    expect(await h.run(h.driver.proofs.blockHash(4n, 'finalized'))).toBeNull();
    expect(await h.run(h.driver.proofs.blockHash(5n, 'latest'))).toBe(
      h.node.block(5n)?.hash,
    );
    expect(await h.run(h.driver.proofs.blockHash(6n, 'latest'))).toBeNull();
    // The unanchored head: one endpoint's finalized height (3) trailed by the peer skew (2).
    expect(await h.run(h.driver.proofs.finalizedHead())).toEqual({
      height: 1n,
      hash: h.node.block(1n)?.hash,
      timestamp: expect.any(Number),
    });
    h.node.intercept = (endpoint, method) =>
      endpoint === 'b' && method === 'getBlock'
        ? {
            result: {
              blockhash: 'Other111111111111111111111111111111111111111',
              previousBlockhash: 'p',
              parentSlot: 1,
              blockHeight: 5,
            },
          }
        : undefined;
    await expect(h.run(h.driver.proofs.blockHash(5n, 'latest'))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });
});

describe('the Solana block source', () => {
  it('scans dense heights over skipped slots, filtered by address, without votes', async () => {
    const h = await driverFor(['main']);
    h.node.produce(1);
    h.node.skip(3);
    const { id } = transfer(h);
    h.node.produce(1);
    const header = await h.run(h.driver.blocks!.header(2n));
    expect(header).toEqual({
      height: 2n,
      hash: h.node.block(2n)?.hash,
      parentHash: h.node.block(1n)?.hash,
      timestamp: expect.any(Number),
    });
    expect(h.node.block(2n)?.slot).toBe(5n);
    expect(await h.run(h.driver.blocks!.header(3n))).toBeNull();
    const vote = {
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000],
        postBalances: [5_000],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        signatures: ['Vote'],
        message: {
          accountKeys: [{ pubkey: 'V' }],
          instructions: [
            {
              programId: 'Vote111111111111111111111111111111111111111',
              accounts: [],
              data: '1',
            },
          ],
        },
      },
    };
    h.node.intercept = (endpoint, method, params) => {
      if (
        method !== 'getBlock' ||
        (params[1] as { transactionDetails?: string }).transactionDetails !== 'full'
      )
        return undefined;
      const block = h.node.answer(endpoint, method, params) as {
        transactions: unknown[];
      };
      block.transactions.push(vote);
      return { result: block };
    };
    expect(
      (await h.run(h.driver.blocks!.transactions(header!))).map((tx) => tx.id),
    ).toEqual([id]);
    expect(
      (
        await h.run(h.driver.blocks!.transactions(header!, { addresses: [RECIPIENT] }))
      ).map((tx) => tx.id),
    ).toEqual([id]);
    expect(
      await h.run(h.driver.blocks!.transactions(header!, { addresses: [MINT] })),
    ).toEqual([]);
    h.node.intercept = undefined;
    h.node.reorg(1);
    h.node.produce(1);
    await expect(h.run(h.driver.blocks!.transactions(header!))).rejects.toMatchObject({
      code: 'PROVIDER_INCONSISTENT',
      retryable: true,
    });
  });

  it('returns a transaction whose deposit it cannot attribute (I4: a superset filter)', async () => {
    const h = await driverFor(['main']);
    h.node.produce(2);
    const header = await h.run(h.driver.blocks!.header(2n));
    const credit = (to: string) => ({
      meta: {
        err: null,
        fee: 5000,
        preBalances: [10_000, 0, 1],
        postBalances: [4_000, 1_000, 1],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
      transaction: {
        signatures: [`Sig${to}`],
        message: {
          accountKeys: [{ pubkey: 'Payer' }, { pubkey: to }, { pubkey: 'SomeProgram' }],
          instructions: [
            { programId: 'SomeProgram', accounts: ['Payer', to], data: '1' },
          ],
        },
      },
    });
    h.node.intercept = (endpoint, method, params) => {
      if (method !== 'getBlock') return undefined;
      if ((params[1] as { transactionDetails?: string }).transactionDetails !== 'full') {
        return undefined;
      }
      const block = h.node.answer(endpoint, method, params) as {
        transactions: unknown[];
      };
      block.transactions.push(credit(RECIPIENT), credit('Unrelated'));
      return { result: block };
    };
    const found = await h.run(
      h.driver.blocks!.transactions(header!, { addresses: [RECIPIENT] }),
    );
    expect(found.map((tx) => [tx.id, tx.decoding])).toEqual([
      [`Sig${RECIPIENT}`, 'partial'],
    ]);
  });

  it('decides nothing when a backend does not know the history cursor (M2)', async () => {
    const h = await driverFor(['main']);
    h.node.intercept = (_endpoint, method) =>
      method === 'getSignaturesForAddress'
        ? { error: { code: -32020, message: 'Transaction x not found' } }
        : undefined;
    await expect(
      h.run(h.driver.history!.list(RECIPIENT, { limit: 2, cursor: '1'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('pages address history newest first, with the chain’s own status', async () => {
    const h = await driverFor(['main']);
    h.node.produce(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(transfer(h, 1_000_000_000n + BigInt(i)).id);
      h.node.produce(1);
    }
    const first = await h.run(h.driver.history!.list(RECIPIENT, { limit: 2 }));
    expect(first.items.map((t) => t.id)).toEqual([ids[2], ids[1]]);
    expect(first.next).toBe(ids[1]);
    const second = await h.run(
      h.driver.history!.list(RECIPIENT, { limit: 2, cursor: first.next! }),
    );
    expect([second.items.map((t) => t.id), second.next]).toEqual([[ids[0]], undefined]);
    await expect(
      h.run(h.driver.history!.list(RECIPIENT, { limit: 2, cursor: 'x' })),
    ).rejects.toMatchObject({
      code: 'INVALID_INTENT',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm jest test/adapters/solana/driver.test.ts`
Expected: FAIL: TypeScript reports that `'../../../src/adapters/solana/web3'` has no exported member `web3DriverFactory`.

- [ ] **Step 3: Write the proofs and the block source**

`src/adapters/solana/proofs.ts`:

```ts
/**
 * Proofs and block scanning (spec §6.7, §10), in lesson 17's final form: each fact is
 * attested at its own height with a monotone predicate, never at a height one endpoint
 * proposes. "My finalized height is past H" is a quorum read of
 * `getBlockHeight({ commitment: 'finalized' })` keyed on `height > H`; the block at a height
 * is a quorum read of `getBlock(slot, { commitment: 'finalized' })` keyed on its consensus
 * fields, so an endpoint that has not finalized it answers nothing and decides nothing.
 *
 * A transaction is proven absent (lesson 16) only by reading every block of its window
 * under finality: each block certifies its own height and its parent's hash, so a lagging,
 * pruned, snapshot-jumped or long-term-storage-gapped backend behind a load-balanced URL
 * can only answer "not available" (decides nothing), never a short window (C1).
 *
 * Lesson 18, widened: only a definitive negative proof answers "no". Every other RPC error
 * on these paths decides nothing (`undecided`: a retryable `PROVIDER_UNAVAILABLE`).
 */
import type { BlockSource, DriverBlock, ProofSource } from '../../core/driver/types';
import {
  decodeTransaction,
  isVote,
  parseTransaction,
  tokenTransfersLanded,
  touches,
} from './decode';
import { isSignature } from './keys';
import { blockAtHeight, type SolanaContext } from './reader';
import {
  BLOCK_FIELDS,
  MONITOR,
  PROOF,
  blockHeader,
  call,
  headerOptions,
  gone,
  inconsistent,
  isGone,
  isNotAvailable,
  isSkipped,
  malformed,
  notYet,
  parsedOptions,
  pick,
  u64,
  undecided,
  type BlockHeader,
} from './rpc';
import type { Commitment } from './types';

/** A blockhash is valid for this many blocks after its own (agave `MAX_PROCESSING_AGE`). */
export const BLOCKHASH_VALIDITY = 150n;

/**
 * The heights that can hold a transaction whose blockhash gives `lastValidBlockHeight`:
 * from the block after the blockhash's own, through `lastValidBlockHeight + 1`. agave checks
 * a blockhash's age against the including block's PARENT, so the block after
 * `lastValidBlockHeight` still accepts it (I1).
 */
export function windowOf(lastValidHeight: bigint): {
  readonly first: bigint;
  readonly end: bigint;
} {
  const first =
    lastValidHeight > BLOCKHASH_VALIDITY ? lastValidHeight - BLOCKHASH_VALIDITY + 1n : 0n;
  return { first, end: lastValidHeight + 1n };
}

/** Signatures proven absent from their finalized windows, kept per driver (spec §7). */
const ABSENT_MEMO = 1_024;

/** Library policy: an unanchored head trails one endpoint's view by this peer skew. */
export const PEER_SKEW = 2n;

async function finalizedHeight(ctx: SolanaContext): Promise<bigint> {
  return u64(
    await call(ctx.transport, 'getBlockHeight', [{ commitment: 'finalized' }], MONITOR),
    'getBlockHeight',
  );
}

/**
 * Whether every quorum endpoint has finalized a block above `height`: the monotone
 * predicate "my finalized height > height" (lesson 17). Endpoints that disagree throw a
 * retryable `PROVIDER_INCONSISTENT` (decides nothing); all saying no is `false`.
 */
async function finalizedPast(ctx: SolanaContext, height: bigint): Promise<boolean> {
  const past = (result: unknown): boolean => {
    if (typeof result === 'bigint') return result > height;
    if (typeof result === 'number' && Number.isSafeInteger(result))
      return BigInt(result) > height;
    throw malformed('getBlockHeight');
  };
  const result = await call(
    ctx.transport,
    'getBlockHeight',
    [{ commitment: 'finalized' }],
    { ...PROOF, quorumKey: past },
  );
  return past(result);
}

/**
 * The block at `height` as the quorum serves it at `commitment`, or `null` when an endpoint
 * cannot show it there yet. The slot of a height comes from one endpoint's block list; the
 * quorum then attests the block itself and its height, so a wrong slot only ever decides
 * nothing. Callers use it only for heights the quorum already holds as final (deep window
 * starts, heights at or below an attested finalized height) or for `'latest'` checks where
 * `null` decides nothing.
 */
async function attestedBlock(
  ctx: SolanaContext,
  height: bigint,
  commitment: Commitment,
): Promise<{ readonly slot: bigint; readonly header: BlockHeader } | null> {
  const slot = await ctx.heights.slotAt(height, commitment, MONITOR);
  if (slot === null) return null;
  let result: unknown;
  try {
    result = await call(
      ctx.transport,
      'getBlock',
      [Number(slot), headerOptions(commitment)],
      PROOF,
    );
  } catch (error) {
    if (isSkipped(error)) {
      // The slot came from a list that named a slot with no block.
      ctx.heights.forget();
      throw inconsistent(`slot ${slot} holds no block`);
    }
    if (isNotAvailable(error)) return null;
    throw undecided(error, `the block at height ${height}`);
  }
  if (result === null) return null;
  const header = blockHeader(result);
  if (header.blockHeight !== height) {
    ctx.heights.forget();
    throw inconsistent(`the block at slot ${slot} is not at height ${height}`);
  }
  return { slot, header };
}

/**
 * Whether `signature` is in none of the finalized blocks of its window (C1, lesson 16).
 * The window's first and last blocks are attested by height; `getBlocks` must list exactly
 * one slot per height between them; every block is read whole (its signatures) under the
 * proof quorum and must sit at the next height with the previous block as its parent. A
 * gap, a pruned block or a lagging backend answers "not available" and decides nothing.
 * `false` means a block holds the transaction.
 */
async function absentFromWindow(
  ctx: SolanaContext,
  signature: string,
  lastValidHeight: bigint,
): Promise<boolean> {
  const { first, end } = windowOf(lastValidHeight);
  const top = await attestedBlock(ctx, end, 'finalized');
  const bottom = await attestedBlock(ctx, first, 'finalized');
  if (!top || !bottom) throw notYet('the transaction window');
  const listKey = (result: unknown): unknown => {
    if (!Array.isArray(result)) throw malformed('getBlocks');
    return result.map(String);
  };
  let listed: unknown;
  try {
    listed = await call(
      ctx.transport,
      'getBlocks',
      [
        Number(bottom.slot),
        Number(top.slot),
        { commitment: 'finalized', minContextSlot: Number(top.slot) },
      ],
      { ...PROOF, quorumKey: listKey },
    );
  } catch (error) {
    if (isNotAvailable(error)) throw notYet('every block of the window');
    throw undecided(error, 'every block of the window');
  }
  if (!Array.isArray(listed) || BigInt(listed.length) !== end - first + 1n) {
    throw notYet('every block of the window');
  }
  const holds = (result: unknown): boolean | null => {
    const list = (result as { signatures?: unknown } | null)?.signatures;
    return Array.isArray(list) ? list.includes(signature) : null;
  };
  const blockKey = (result: unknown): unknown => ({
    ...(pick(result, BLOCK_FIELDS) as object),
    holds: holds(result),
  });
  let parent: string | undefined;
  for (const [i, value] of listed.entries()) {
    let block: unknown;
    try {
      block = await call(
        ctx.transport,
        'getBlock',
        [
          Number(u64(value, 'getBlocks slot')),
          { ...headerOptions('finalized'), transactionDetails: 'signatures' },
        ],
        { ...PROOF, quorumKey: blockKey },
      );
    } catch (error) {
      if (isNotAvailable(error)) throw notYet('a block of the window');
      throw undecided(error, 'a block of the window');
    }
    const found = holds(block);
    if (found === null) throw notYet('a block of the window');
    const header = blockHeader(block);
    if (
      header.blockHeight !== first + BigInt(i) ||
      (parent !== undefined && header.previousBlockhash !== parent)
    ) {
      throw inconsistent('the window is not one chain of blocks');
    }
    if (found) return false;
    parent = header.blockhash;
  }
  if (parent !== top.header.blockhash) {
    throw inconsistent('the window does not end at its attested block');
  }
  return true;
}

/** The quorum's finalized transaction (`null`: every endpoint agrees it has none). */
async function finalTransaction(ctx: SolanaContext, signature: string): Promise<unknown> {
  try {
    return await call(
      ctx.transport,
      'getTransaction',
      [signature, parsedOptions('finalized')],
      PROOF,
    );
  } catch (error) {
    if (isNotAvailable(error)) throw notYet('the transaction history');
    throw undecided(error, 'the transaction history');
  }
}

/** Lesson 18, widened: whatever a proof method meets, no RPC error is ever a verdict. */
function guarded<A extends unknown[], R>(
  method: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await method(...args);
    } catch (error) {
      throw undecided(error, 'the proof');
    }
  };
}

export function createSolanaProofs(ctx: SolanaContext): ProofSource {
  const absent = new Set<string>();
  const included = async (result: unknown, signature: string, from: string) => {
    const parsed = parseTransaction(result);
    if (parsed.signature !== signature || parsed.slot === undefined) {
      throw malformed('getTransaction');
    }
    let header: BlockHeader | null;
    try {
      const block = await call(
        ctx.transport,
        'getBlock',
        [Number(parsed.slot), headerOptions('finalized')],
        PROOF,
      );
      header = block === null ? null : blockHeader(block);
    } catch (error) {
      if (!isNotAvailable(error)) throw undecided(error, 'the block of the transaction');
      header = null;
    }
    if (!header) throw notYet('the block of the transaction');
    return {
      included: true as const,
      // Lesson 7: our own token transfers count only when the balances show them.
      success: parsed.err === null && tokenTransfersLanded(parsed, from),
      blockHeight: header.blockHeight,
      blockHash: header.blockhash,
      txHash: signature,
    };
  };

  const proofs: ProofSource = {
    async finalizedHead() {
      // The one unanchored head (lesson 17): one endpoint's view, trailed by a peer skew.
      const seen = await finalizedHeight(ctx);
      const height = seen > PEER_SKEW ? seen - PEER_SKEW : 0n;
      const block = await attestedBlock(ctx, height, 'finalized');
      if (!block) throw notYet('the finalized head');
      return {
        height,
        hash: block.header.blockhash,
        ...(block.header.blockTime !== undefined
          ? { timestamp: block.header.blockTime }
          : {}),
      };
    },

    async includedFinal(ref, ordering, from) {
      // A malformed signature can never be on chain.
      if (!isSignature(ref.id)) return { included: false };
      const found = await finalTransaction(ctx, ref.id);
      if (found !== null) return included(found, ref.id, from);
      // Lesson 16: an index that shows nothing proves nothing; only the window can.
      if (ordering.kind !== 'expiry' || ordering.lastValidHeight === undefined) {
        throw notYet('proof that the transaction is absent');
      }
      const last = ordering.lastValidHeight;
      const key = `${ref.id}:${last}`;
      if (absent.has(key)) return { included: false };
      // The window's last block (lastValidBlockHeight + 1, I1) is final everywhere.
      if (!(await finalizedPast(ctx, last))) {
        throw notYet('finality past the transaction window');
      }
      if (!(await absentFromWindow(ctx, ref.id, last))) {
        throw inconsistent(
          'a block of the window holds a transaction its index does not show',
        );
      }
      absent.add(key);
      if (absent.size > ABSENT_MEMO)
        absent.delete(absent.values().next().value as string);
      return { included: false };
    },

    // Expiry ordering has no slot that another transaction could consume.
    slotConsumed: async () => false,

    async expired(ordering) {
      if (ordering.kind !== 'expiry' || ordering.lastValidHeight === undefined)
        return false;
      return finalizedPast(ctx, ordering.lastValidHeight);
    },

    async blockHash(height, level) {
      // R33: null above the finalized height decides nothing; so does any endpoint that has
      // not finalized `height` yet (the attested read answers nothing there).
      if (level === 'finalized' && !(await finalizedPast(ctx, height - 1n))) return null;
      const block = await attestedBlock(
        ctx,
        height,
        level === 'finalized' ? 'finalized' : 'confirmed',
      );
      return block?.header.blockhash ?? null;
    },
  };
  return {
    finalizedHead: guarded(proofs.finalizedHead),
    includedFinal: guarded(proofs.includedFinal),
    slotConsumed: guarded(proofs.slotConsumed),
    expired: guarded(proofs.expired),
    blockHash: guarded(proofs.blockHash),
  };
}

const changed = (height: bigint) =>
  inconsistent(`block ${height} changed while scanning`);

export function createSolanaBlocks(ctx: SolanaContext): BlockSource {
  return {
    header: async (height) => (await blockAtHeight(ctx, height, MONITOR))?.block ?? null,

    async transactions(block: DriverBlock, filter) {
      const slot = await ctx.heights.slotAt(block.height, 'confirmed', MONITOR);
      if (slot === null) throw changed(block.height);
      let result: unknown;
      try {
        result = await call(
          ctx.transport,
          'getBlock',
          [
            Number(slot),
            { ...parsedOptions('confirmed'), transactionDetails: 'full', rewards: false },
          ],
          MONITOR,
        );
      } catch (error) {
        if (isGone(error)) throw gone(`the block at height ${block.height}`);
        if (isNotAvailable(error)) throw changed(block.height);
        throw error;
      }
      const full = result as { blockhash?: unknown; transactions?: unknown } | null;
      if (!full || full.blockhash !== block.hash) throw changed(block.height);
      if (!Array.isArray(full.transactions)) throw malformed('getBlock');
      const wanted = filter?.addresses?.length ? new Set(filter.addresses) : undefined;
      const place = {
        height: block.height,
        hash: block.hash,
        ...(block.timestamp !== undefined ? { blockTime: block.timestamp } : {}),
      };
      return full.transactions.flatMap((entry) => {
        const parsed = parseTransaction(entry);
        if (isVote(parsed)) return [];
        const decoded = decodeTransaction(parsed, place);
        return !wanted || touches(decoded, parsed, wanted) ? [decoded] : [];
      });
    },
  };
}
```

- [ ] **Step 4: Write the history source and the driver factory**

`src/adapters/solana/history.ts`:

```ts
/**
 * Address history (spec §15: `getSignaturesForAddress`), newest first. The cursor is the
 * last signature of a page. A token account's history holds the SPL transfers into it; an
 * owner's history holds only the transactions that name the owner itself.
 */
import type { AddressHistorySource, DriverTransaction } from '../../core/driver/types';
import { ProviderError, ValidationError } from '../../core/errors/error';
import { decodeTransaction } from './decode';
import { isSignature } from './keys';
import { readTransaction, type SolanaContext } from './reader';
import { READ, RPC_CODES, call, inconsistent, malformed, rpcCode } from './rpc';

/** `getSignaturesForAddress` returns at most this many signatures per call (agave). */
export const MAX_HISTORY_PAGE = 1_000;

export function createSolanaHistory(ctx: SolanaContext): AddressHistorySource {
  return {
    async list(address, { cursor, limit }) {
      if (cursor !== undefined && !isSignature(cursor)) {
        throw new ValidationError('INVALID_INTENT', 'not a Solana history cursor');
      }
      const size = Math.min(limit, MAX_HISTORY_PAGE);
      let result: unknown;
      try {
        result = await call(
          ctx.transport,
          'getSignaturesForAddress',
          [
            address,
            {
              limit: size,
              commitment: 'confirmed',
              ...(cursor !== undefined ? { before: cursor } : {}),
            },
          ],
          READ,
        );
      } catch (error) {
        // M2: a backend that does not hold the cursor's transaction (another backend
        // behind a load balancer, or a pruned one) decides nothing.
        if (rpcCode(error) === RPC_CODES.FILTER_TRANSACTION_NOT_FOUND) {
          throw new ProviderError(
            'PROVIDER_UNAVAILABLE',
            'the endpoint does not know the history cursor',
          );
        }
        throw error;
      }
      if (!Array.isArray(result)) throw malformed('getSignaturesForAddress');
      const signatures = result.map((entry: unknown) => {
        const signature = (entry as { signature?: unknown } | null)?.signature;
        if (!isSignature(signature)) throw malformed('getSignaturesForAddress');
        return signature;
      });
      const items: DriverTransaction[] = [];
      for (const signature of signatures) {
        const found = await readTransaction(ctx, signature, READ);
        if (!found) throw inconsistent('a listed transaction is missing');
        items.push(
          decodeTransaction(found.parsed, {
            height: found.header.blockHeight,
            hash: found.header.blockhash,
            ...(found.parsed.blockTime !== undefined
              ? { blockTime: found.parsed.blockTime }
              : {}),
          }),
        );
      }
      const last = signatures[signatures.length - 1];
      return {
        items,
        ...(signatures.length === size && last !== undefined ? { next: last } : {}),
      };
    },
  };
}
```

`src/adapters/solana/driver.ts`:

```ts
/**
 * The Solana driver (spec §15), over the `SolanaCodec` of `@solana/web3.js`. One factory
 * serves every Solana cluster; each network's registry data configures it.
 */
import type { ChainDriver, DriverFactory } from '../../core/driver/types';
import type { EndpointCall, HealthProbes, Transport } from '../../core/transport/types';
import { randomBytes } from '../../core/util/bytes';
import { createSolanaBroadcaster, createSolanaBuilder } from './builder';
import { variantCounter } from './fees';
import { HeightIndex } from './heights';
import { createSolanaHistory } from './history';
import { decodeBase58 } from './keys';
import { solanaNetworkConfig } from './network';
import { createSolanaBlocks, createSolanaProofs } from './proofs';
import {
  createSolanaAddressCodec,
  createSolanaExt,
  createSolanaReader,
  type SolanaContext,
} from './reader';
import { malformed, u64 } from './rpc';
import type { SolanaCodec } from './types';

/** R19: identity is the genesis hash; the height is the `confirmed` block height. */
function probes(genesisHash: string): HealthProbes {
  return {
    identity: async (call: EndpointCall) => {
      const hash = await call.rpc<unknown>('getGenesisHash', []);
      if (decodeBase58(hash, 32) === null) throw malformed('getGenesisHash');
      return hash as string;
    },
    expectedIdentity: genesisHash,
    height: async (call: EndpointCall) =>
      u64(
        await call.rpc<unknown>('getBlockHeight', [{ commitment: 'confirmed' }]),
        'height',
      ),
  };
}

export function solanaDriverFactory(
  makeCodec: (transport: Transport) => SolanaCodec,
): DriverFactory {
  return {
    async create(ctx): Promise<ChainDriver> {
      const config = solanaNetworkConfig(ctx.chain, ctx.network);
      // M12: probes go on every transport this driver receives, before any traffic.
      ctx.transport.setProbes(probes(config.genesisHash));
      ctx.indexer?.setProbes(probes(config.genesisHash));
      const codec = makeCodec(ctx.transport);
      const solana: SolanaContext = {
        transport: ctx.transport,
        codec,
        chain: ctx.chain,
        network: ctx.network,
        config,
        heights: new HeightIndex(ctx.transport),
        log: ctx.log,
        nextVariant: variantCounter(new DataView(randomBytes(4).buffer).getUint32(0)),
      };
      // Handoff §3: history reads the indexer transport when one is configured.
      const history = ctx.indexer
        ? { ...solana, transport: ctx.indexer, heights: new HeightIndex(ctx.indexer) }
        : solana;
      const ext = createSolanaExt(solana);
      return {
        ordering: 'expiry',
        capabilities: config.capabilities,
        address: createSolanaAddressCodec(),
        reader: createSolanaReader(solana),
        builder: createSolanaBuilder(solana),
        broadcaster: createSolanaBroadcaster(solana),
        proofs: createSolanaProofs(solana),
        blocks: createSolanaBlocks(solana),
        history: createSolanaHistory(history),
        ext: { solana: { getTokenAccounts: ext.solana.getTokenAccounts } },
        limits: () => ({ maxOutputs: 1 }),
        createNativeClient: () => codec.createNative(),
      };
    },
  };
}
```

- [ ] **Step 5: Export the factory from the SDK module**

In `src/adapters/solana/web3.ts`, add `import { solanaDriverFactory } from './driver';` after `import { PLACEHOLDER_ORIGIN, type Transport } from '../../core/transport/types';`, and append at the end of the file:

```ts

/** The `@solana/web3.js` adapter's driver factory; the manifest's `load()` returns it. */
export const web3DriverFactory = solanaDriverFactory(createWeb3Codec);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm jest test/adapters/solana/driver.test.ts`
Expected: PASS, 27 tests. The four "not included behind one URL" tests, "proves a transfer included at lastValidBlockHeight + 1 as included, never absent", "answers "not included" only past the window…" and "attests expiry with a predicate at its own height" pin Review Focus 1; "agrees across formatting differences and decides nothing on a different fact" pins Review Focus 2; "scans dense heights over skipped slots, filtered by address, without votes" pins Review Focus 5; "returns a transaction whose deposit it cannot attribute" pins I4; the "no RPC error is a verdict" tests (eight) pin R1.

- [ ] **Step 7: Prove determinism (lesson 1)**

Run: `for i in $(seq 1 100); do pnpm jest test/adapters/solana/driver.test.ts --silent >/dev/null 2>&1 || { echo "failed on run $i"; exit 1; }; done; echo '100/100 green'`
Expected: `100/100 green`. A failure means something outside `FakeClock` is on a request path: find it, never retry.

- [ ] **Step 8: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add src/adapters/solana/proofs.ts src/adapters/solana/history.ts src/adapters/solana/driver.ts src/adapters/solana/web3.ts test/adapters/solana/driver.test.ts
git commit -m "feat(solana): quorum proofs, block scanning, history and the driver factory

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 9: The Solana plugin, `crypto-aio/solana` and packaging

**Files:**
- Create: `src/adapters/solana/plugin.ts`, `src/adapters/solana/index.ts`
- Modify: `src/index.ts`, `package.json` (`exports`, `typesVersions`), `typedoc.json` (`entryPoints`), `test/architecture/registry-augmentation.test.ts`
- Test: `test/adapters/solana/plugin.test.ts`, `test/adapters/solana/dependency.test.ts`, `test/adapters/solana/lazy.test.ts`

**Interfaces:**
- Consumes: `SOLANA_CHAIN`, `SOLANA_PRESETS`, `SOLANA_TOKENS`, `SOLANA_CAPABILITIES` (Task 1); `web3DriverFactory` (Task 8); `Plugin`, `AdapterManifest`, `PeerDependency`, `setBuiltinPlugins`; Plan 2 Task 10's entry shape.
- Produces:
  - `plugin.ts`: `SOLANA_PEER_DEPENDENCIES: Readonly<Record<'@solana/web3.js', PeerDependency>>`, keyed by library (Plan 2 Task 10's shape); `solanaManifest` (family `solana`, library `@solana/web3.js`, chains `['solana']`, `peerDependencies: [SOLANA_PEER_DEPENDENCIES['@solana/web3.js']]`, `load()` `require()`s `./web3`), `solanaPlugin(): Plugin` (name `solana`).
  - `crypto-aio/solana` (`src/adapters/solana/index.ts`): `SOLANA_PEER_DEPENDENCIES`, `SOLANA_CAPABILITIES`, the types `SolanaExt`, `SolanaFeeDetails`, `SolanaFeeOverride`, `SolanaTokenAccount`, and the `NativeClientMap` augmentation (`'@solana/web3.js': Connection`).
  - `crypto-aio` registers `solanaPlugin()` as a built-in (after `evmPlugin()`).

No `solanaChainPlugin` (a Solana network of your own, like Plan 2's `evmChainPlugin`) is offered: spec §2 lists the three clusters. A local test validator has its own genesis hash, so the identity check refuses it on the built-in chain; see Unresolved assumptions.

**Review points (Plan 2 Task 10's final shape, R79–R82):**
- The plugin module is SDK-free; only `load()` requires `./web3`, which imports the SDK by its bare peer name (R80); the built entry loads no SDK (`node -e` check below).
- `lazy.test.ts`: importing `crypto-aio` and `crypto-aio/solana` loads no SDK; each manifest's `load()`, in a module registry of its own, loads exactly its `peerDependencies` names.
- `plugin.test.ts` pins `SOLANA_PEER_DEPENDENCIES` to `package.json` per entry: peer range, `peerDependenciesMeta[name].optional`, and `^devDependencies[name]` (R82).
- A missing SDK fails `ready()` with `DEPENDENCY_MISSING` and `npm i @solana/web3.js@^1.99.0` (the core's message).
- Augmentations go through the entry module (R37), tested with `USE_ACME` in both file orders; `dist/index.d.ts` never names the SDK, and the main-entry guard type-checks `crypto-aio` with `@solana/web3.js` hidden, with a control proving it is hidden.
- `typesVersions` keys stay alphabetical; `pnpm doc` stays green with the new entry point (R55).
- R79 (`<family>ChainPlugin` naming) does not apply: there is no Solana chain plugin.

- [ ] **Step 1: Write the failing tests**

`test/adapters/solana/plugin.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CryptoAio, noopLogger } from '../../../src';
import { SOLANA_PEER_DEPENDENCIES } from '../../../src/adapters/solana/index';
import { solanaPlugin } from '../../../src/adapters/solana/plugin';
import { FakeClock, drive } from '../../../src/testing/fake-clock';
import { ScriptedSolanaNode } from './support/node';
import { KEY_ADDRESS } from './support/vectors';

function container() {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ clock });
  const aio = new CryptoAio({
    env: false,
    logger: noopLogger,
    clock,
    transport: { fetch: node.fetch.fetch, baseDelayMs: 1, maxDelayMs: 2 },
    providers: { local: { endpoints: [{ url: node.endpoint('main') }] } },
  });
  return { aio, node, run: <T>(p: Promise<T>) => drive(clock, p) };
}

describe('the built-in Solana plugin', () => {
  it('registers solana with @solana/web3.js as its library', async () => {
    const { aio, node, run } = container();
    const sol = aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'local' });
    expect([sol.chain, sol.network, sol.library]).toEqual([
      'solana',
      'devnet',
      '@solana/web3.js',
    ]);
    expect([...sol.capabilities].sort()).toEqual([
      'address-history',
      'block-scan',
      'expiry',
      'memo',
      'tokens',
    ]);
    node.fund(KEY_ADDRESS, 12n);
    node.produce(1);
    await run(sol.ready());
    expect((await run(sol.getBalance(KEY_ADDRESS))).amount.toDecimalString()).toBe(
      '0.000000012',
    );
    expect(aio.blockchain({ chain: 'solana', provider: 'public' }).network).toBe(
      'mainnet',
    );
    expect(() =>
      aio.blockchain({ chain: 'solana', network: 'testnet', provider: 'alchemy' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      aio.blockchain({
        chain: 'solana',
        library: 'ethers' as '@solana/web3.js',
        provider: 'local',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INCOMPATIBLE_SELECTION',
        message: expect.stringContaining('supported: @solana/web3.js'),
      }),
    );
    await aio.close();
  });

  it('resolves the well-known tokens by alias, only on their own cluster', async () => {
    const { aio, run } = container();
    const devnet = aio.blockchain({
      chain: 'solana',
      network: 'devnet',
      provider: 'local',
    });
    expect((await run(devnet.resolveAsset('USDC'))).id).toBe(
      'solana:devnet/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    );
    await expect(run(devnet.resolveAsset('USDT'))).rejects.toMatchObject({
      code: 'ASSET_RESOLUTION',
    });
    const mainnet = aio.blockchain({ chain: 'solana', provider: 'local' });
    expect((await run(mainnet.resolveAsset('USDT'))).metadata).toEqual({
      symbol: 'USDT',
      decimals: 6,
    });
    await aio.close();
  });

  it('is data only: registering it loads no SDK', () => {
    const plugin = solanaPlugin();
    expect(
      plugin.adapters?.map((m) => [m.family, m.library, m.chains, m.peerDependencies]),
    ).toEqual([
      [
        'solana',
        '@solana/web3.js',
        ['solana'],
        [{ name: '@solana/web3.js', range: '^1.99.0' }],
      ],
    ]);
    expect(plugin.chains?.map((c) => c.id)).toEqual(['solana']);
  });

  it('pins the SDK range package.json declares as an optional peer and pins for tests (R82)', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    ) as Record<'peerDependencies' | 'devDependencies', Record<string, string>> & {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    const peers = Object.values(SOLANA_PEER_DEPENDENCIES);
    expect(peers.length).toBeGreaterThan(0);
    for (const { name, range } of peers) {
      expect([name, pkg.peerDependencies[name]]).toEqual([name, range]);
      expect([name, pkg.peerDependenciesMeta[name]?.optional]).toEqual([name, true]);
      expect([name, `^${pkg.devDependencies[name]}`]).toEqual([name, range]);
    }
  });
});
```

`test/adapters/solana/dependency.test.ts` (its own file: `jest.mock` applies to the whole file):

```ts
// A missing SDK: the manifest's lazy require fails like Node does without the package.
jest.mock('@solana/web3.js', () => {
  throw Object.assign(
    new Error("Cannot find module '@solana/web3.js' from 'src/adapters/solana/web3.ts'"),
    { code: 'MODULE_NOT_FOUND' },
  );
});

import { CryptoAio } from '../../../src';

describe('a missing Solana SDK', () => {
  it('fails with DEPENDENCY_MISSING and the exact install command', async () => {
    const aio = new CryptoAio({
      env: false,
      providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
    });
    const bc = aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'local' });
    await expect(bc.ready()).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'DEPENDENCY_MISSING',
      message: expect.stringContaining('npm i @solana/web3.js@^1.99.0'),
      details: { packages: ['@solana/web3.js'] },
    });
    await aio.close();
  });
});
```

`test/adapters/solana/lazy.test.ts` (ported from `test/adapters/evm/lazy.test.ts`):

```ts
// Lazy loading (spec §4): only a manifest's `load()` may require an SDK. Each check runs in
// a fresh module registry where requiring `@solana/web3.js` is recorded, then served as usual.
import { solanaPlugin } from '../../../src/adapters/solana/plugin';

type Entry = typeof import('../../../src');
type SolanaEntry = typeof import('../../../src/adapters/solana');
type SolanaPlugin = typeof import('../../../src/adapters/solana/plugin');

const SDKS = ['@solana/web3.js'] as const;

/** The SDKs `run` requires, in order, in a module registry of its own. */
function requiredSdks(run: () => void): string[] {
  const loaded: string[] = [];
  jest.isolateModules(() => {
    for (const sdk of SDKS) {
      jest.doMock(sdk, () => {
        loaded.push(sdk);
        return jest.requireActual(sdk);
      });
    }
    run();
  });
  return loaded;
}

describe('lazy loading of the Solana SDK', () => {
  it('imports crypto-aio and crypto-aio/solana without loading @solana/web3.js', () => {
    const loaded = requiredSdks(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const entry = require('../../../src') as Entry;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const solana = require('../../../src/adapters/solana') as SolanaEntry;
      // Both entries are usable: the family is registered and its constants are there.
      new entry.CryptoAio({
        env: false,
        providers: { local: { endpoints: [{ url: 'https://node.invalid/rpc' }] } },
      }).blockchain({ chain: 'solana', provider: 'local' });
      expect(solana.SOLANA_CAPABILITIES).toContain('expiry');
    });
    expect(loaded).toEqual([]);
  });

  // Each manifest loads in a registry of its own, so no SDK can hide behind an earlier load.
  const manifests = (solanaPlugin().adapters ?? []).map((m) => ({
    library: m.library,
    names: m.peerDependencies.map((d) => d.name),
  }));

  it('has a manifest to check', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests)(
    "the $library manifest's load() loads exactly its peer dependencies",
    async ({ library, names }) => {
      let pending: Promise<unknown> | undefined;
      const loaded = requiredSdks(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fresh = require('../../../src/adapters/solana/plugin') as SolanaPlugin;
        pending = fresh
          .solanaPlugin()
          .adapters?.find((m) => m.library === library)
          ?.load();
      });
      expect(pending).toBeDefined();
      await pending;
      expect(loaded).toEqual(names);
    },
  );
});
```

In `test/architecture/registry-augmentation.test.ts` (Plan 2 Task 10's final shape; R82), make these edits:

1. In `OPTIONS.paths`, after the `'crypto-aio/native'` entry, add:
   ```ts
    'crypto-aio/solana': [join(ROOT, 'src', 'adapters', 'solana', 'index.ts')],
   ```
2. Insert before `/** A consumer of the main entry only; a user with no SDK installed at all. */` (it compiles `USE_SOLANA` with `AUGMENT` and `USE_ACME` in both file orders, so a `NativeClientMap` augmentation aimed at `ids` would be caught):

```ts
/** The Solana family is typed from the entry; its SDK client from `crypto-aio/solana`. */
const USE_SOLANA = `
import { CryptoAio, type SolanaFeeOverride } from 'crypto-aio';
import { native } from 'crypto-aio/native';
import 'crypto-aio/solana';
const aio = new CryptoAio({ env: false });
export const sol = aio.blockchain({ chain: 'solana', network: 'devnet', library: '@solana/web3.js' });
export const fee: SolanaFeeOverride = { computeUnitPrice: 5n, computeUnitLimit: 20_000n };
export async function height(): Promise<number> {
  const connection = await native(aio.blockchain({ chain: 'solana' }), '@solana/web3.js');
  return connection.getBlockHeight('confirmed');
}
export async function accounts(): Promise<readonly { readonly amount: bigint }[]> {
  return aio.blockchain({ chain: 'solana', network: 'testnet' }).ext.solana.getTokenAccounts('x');
}
`;

describe('Solana registry augmentation (R37)', () => {
  it('types the Solana chain, networks, library, ext and native client, in both file orders', () => {
    const first = compile({
      'augment.ts': AUGMENT,
      'solana.ts': USE_SOLANA,
      'acme.ts': USE_ACME,
    });
    expect(first.errors).toEqual([]);
    const second = compile(
      { 'acme.ts': USE_ACME, 'solana.ts': USE_SOLANA, 'augment.ts': AUGMENT },
      first.program,
    );
    expect(second.errors).toEqual([]);
  }, 120_000);

  it('rejects a network or library the Solana family does not have', () => {
    const wrong = USE_SOLANA.replace("network: 'devnet'", "network: 'localnet'").replace(
      "library: '@solana/web3.js'",
      "library: 'ethers'",
    );
    const { errors } = compile({ 'solana.ts': wrong });
    expect(errors).toEqual([
      expect.stringContaining(`'"localnet"' is not assignable`),
      expect.stringContaining(`'"ethers"' is not assignable`),
    ]);
  }, 120_000);
});
```

3. Replace the `USE_MAIN` constant (with its doc comment) with:

```ts
/** A consumer of the main entry only; a user with no SDK installed at all. */
const USE_MAIN = `
import {
  CryptoAio,
  type EvmExt,
  type EvmFeeDetails,
  type EvmFeeOverride,
  type SolanaExt,
  type SolanaFeeDetails,
  type SolanaFeeOverride,
  type SolanaTokenAccount,
} from 'crypto-aio';
const aio = new CryptoAio({ env: false });
export const eth = aio.blockchain({ chain: 'ethereum', network: 'sepolia' });
export const ext: EvmExt = eth.ext;
export const fee: EvmFeeOverride = { gasPrice: 1n };
export type Details = EvmFeeDetails;
export const sol = aio.blockchain({ chain: 'solana', network: 'devnet' });
export const solanaExt: SolanaExt = sol.ext;
export const solanaFee: SolanaFeeOverride = { computeUnitPrice: 1n };
export type SolanaDetails = SolanaFeeDetails;
export type Account = SolanaTokenAccount;
`;
```

4. In `declarations()`, add `join(ROOT, 'src', 'adapters', 'solana', 'index.ts'),` to `entries`, after the EVM entry.
5. In `withoutSdks`, add `'crypto-aio/solana': [join(DTS, 'adapters', 'solana', 'index.d.ts')],` to `paths` after `'crypto-aio/evm'`, and widen `hidden` to:
   ```ts
  hidden: /[\\/]node_modules[\\/](ethers|web3|@solana[\\/]web3\.js)[\\/]/,
   ```
6. In the last `describe` (`'the main entry names no SDK (spec §5.6)'`), append after the EVM control test:

```ts
  it('control: `crypto-aio/solana` does need the SDK types, so @solana/web3.js really is unresolvable', () => {
    const { everywhere } = compile(
      { 'main.ts': `${USE_MAIN}import 'crypto-aio/solana';\n` },
      undefined,
      withoutSdks(dts),
    );
    expect(everywhere()).toEqual([
      expect.stringMatching(
        /__dts__\/adapters\/solana\/index\.d\.ts: Cannot find module '@solana\/web3\.js'/,
      ),
    ]);
  }, 120_000);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm jest test/adapters/solana/plugin.test.ts test/adapters/solana/dependency.test.ts test/architecture/registry-augmentation.test.ts`
Expected: FAIL: `plugin.test.ts` and `lazy.test.ts` cannot find `../../../src/adapters/solana/plugin`; `dependency.test.ts` fails with `unknown chain 'solana'`; the new augmentation tests fail on `'crypto-aio/solana'`.

- [ ] **Step 3: Write the plugin and the entry**

`src/adapters/solana/plugin.ts`:

```ts
/**
 * The Solana family plugin (spec §4): the chain, tokens and provider presets as data, plus
 * one adapter manifest. SDK-free: only the manifest's `load()` requires the `@solana/web3.js`
 * module, and with it the SDK.
 */
import type {
  AdapterManifest,
  DriverFactory,
  PeerDependency,
} from '../../core/driver/types';
import type { Plugin } from '../../core/registry/plugin';
import { SOLANA_CHAIN } from './chains';
import { SOLANA_CAPABILITIES } from './network';
import { SOLANA_PRESETS } from './presets';
import { SOLANA_TOKENS } from './tokens';

/** The SDK versions this adapter is validated against (spec §16), keyed by library. */
export const SOLANA_PEER_DEPENDENCIES: Readonly<
  Record<'@solana/web3.js', PeerDependency>
> = Object.freeze({
  '@solana/web3.js': Object.freeze({ name: '@solana/web3.js', range: '^1.99.0' }),
});

export const solanaManifest: AdapterManifest = Object.freeze({
  family: 'solana',
  library: '@solana/web3.js',
  chains: Object.freeze(['solana']),
  capabilities: SOLANA_CAPABILITIES,
  peerDependencies: Object.freeze([SOLANA_PEER_DEPENDENCIES['@solana/web3.js']]),
  load: async (): Promise<DriverFactory> => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./web3') as typeof import('./web3');
    return mod.web3DriverFactory;
  },
});

/** The built-in Solana family: mainnet, devnet and testnet (spec §2). */
export function solanaPlugin(): Plugin {
  return {
    name: 'solana',
    chains: [SOLANA_CHAIN],
    adapters: [solanaManifest],
    presets: SOLANA_PRESETS,
    assets: SOLANA_TOKENS,
  };
}
```

`src/adapters/solana/index.ts`:

```ts
/**
 * `crypto-aio/solana`: the SDK-free Solana types, and the `crypto-aio/native` client type:
 * importing this entry types `native(bc, '@solana/web3.js')` as a `Connection` wired to the
 * handle's transport (HTTP JSON-RPC only; subscriptions have no transport bridge).
 *
 * @module crypto-aio/solana
 */
import type { Connection } from '@solana/web3.js';

// R37: through the package entry. SDK types appear only here (spec §5.6).
declare module '../../index' {
  interface NativeClientMap {
    '@solana/web3.js': Connection;
  }
}

export { SOLANA_PEER_DEPENDENCIES } from './plugin';
export { SOLANA_CAPABILITIES } from './network';
export type {
  SolanaExt,
  SolanaFeeDetails,
  SolanaFeeOverride,
  SolanaTokenAccount,
} from './types';
```

- [ ] **Step 4: Register the family in the composition root**

In `src/index.ts`, add `import { solanaPlugin } from './adapters/solana/plugin';` after `import { evmPlugin } from './adapters/evm/plugin';`, and replace

```ts
const BUILTIN_PLUGINS: readonly Plugin[] = [evmPlugin()];
```

with

```ts
const BUILTIN_PLUGINS: readonly Plugin[] = [evmPlugin(), solanaPlugin()];
```

and replace the comment line `// Chain families: SDK-free types (spec §5.6). SDK client types are in \`crypto-aio/evm\`.` with

```ts
// Chain families: SDK-free types (spec §5.6). SDK client types are in `crypto-aio/evm`
// and `crypto-aio/solana`.
```

- [ ] **Step 5: Publish the entry**

In `package.json`, add to `"exports"` after the `"./evm"` entry:

```json
    "./solana": { "types": "./dist/adapters/solana/index.d.ts", "default": "./dist/adapters/solana/index.js" },
```

and to `"typesVersions"."*"`, keeping its keys alphabetical (`evm`, `native`, `solana`, `testing`), between `"native"` and `"testing"`:

```json
      "solana": ["dist/adapters/solana/index.d.ts"],
```

In `typedoc.json`, append `"src/adapters/solana/index.ts"` to `"entryPoints"`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm jest test/adapters/solana/plugin.test.ts test/adapters/solana/dependency.test.ts test/adapters/solana/lazy.test.ts test/architecture/registry-augmentation.test.ts`
Expected: PASS: 4 plugin, 1 dependency and 3 lazy tests, and the augmentation suite with 3 new tests.

- [ ] **Step 7: Check, build and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm doc`
Expected: all green; `pnpm doc` 0 errors and 0 warnings; `dist/adapters/solana/index.d.ts` exists; `grep -c "solana/web3" dist/index.d.ts` prints `0`; `node -e "require('./dist/index.js'); console.log(Object.keys(require.cache).some((k) => k.includes('@solana/web3.js')))"` prints `false`.

```bash
git add src/adapters/solana/plugin.ts src/adapters/solana/index.ts src/index.ts package.json typedoc.json test/adapters/solana/plugin.test.ts test/adapters/solana/dependency.test.ts test/adapters/solana/lazy.test.ts test/architecture/registry-augmentation.test.ts
git commit -m "feat(solana): register the Solana family and publish crypto-aio/solana

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 10: End-to-end suite on the scripted node

**Files:**
- Create (test support): `test/adapters/solana/support/env.ts`
- Test: `test/adapters/solana/e2e.test.ts`

**Interfaces:**
- Consumes: everything above through the public API: `CryptoAio`, `Blockchain`, `native`, `FaultyOperationStore`, `CrashError`, `MemoryOperationStore`, `ScriptedSolanaNode`; `fenceGeneration` from `src/testing/generation.ts` (Plan 2 Task 11, rulings A5 and R71: `fenceGeneration({ clock, fetch, stores, signers }, generation)` returns the fenced `{ clock, fetch, stores, signers }`).
- Produces (test support): `countingSigner(): { signer, calls() }` (the test key, counting `sign` calls); `createSolanaEnv({ node?, endpoints?, fund?, stores?, signer?, lifecycle? })` → `{ aio, bc, node, clock, stores, address, run, produceWhile, restart }` (`aio` and `bc` are the current generation's); `restart({ killPrevious })` builds a new container over the same raw stores, node and clock, and with `killPrevious` fences the old generation (handoff R20); a killed container is never closed (its fenced calls never settle).

No production code changes in this task: the suite proves Tasks 0–9 work together through the engine, the monitor, recovery and the scanner. A failure here is a defect in Tasks 0–9: fix it in the owning module (and extend that task's unit test), never by loosening this suite.

**Review points:**
- Crash tests use `restart({ killPrevious: true })` (R20, A5); nothing is signed twice (`calls()`); recovery rebroadcasts the stored bytes ("already processed" when they landed).
- Expiry is proven only once block `lastValidBlockHeight + 1` is final and every block of the window has been read without the transaction (D7), and only then allows `rebuild` (spec §8.6); a lagging endpoint keeps it unproven (Review Focus 1).
- Two identical intents give two payments (Review Focus 3); five concurrent transfers need no lease (expiry ordering).
- A refused transfer (funds spent elsewhere) stalls, keeps its bytes, and lands after a top-up and `rebroadcast` (spec §8.2).
- A fork (M11, Plan 2 Task 11's pattern): while one endpoint still serves the orphaned block at the fixed height, the quorum disagrees (`provider.inconsistent` naming both endpoints) and nothing is decided (no `tx.reorged`, no resend); once both serve the new block, the reorg is decided and the transfer finalizes once.
- The first crash test pins that a call on the dead handle never settles (M11).
- A transfer that lands at `lastValidBlockHeight + 1`, with the monitor polling throughout, ends `final`, never `expired` (I1).
- The deposit scan resolves SOL and SPL transfers and reports an unusable mint as an `UnresolvedTransfer` (R35).

- [ ] **Step 1: Write the test support**

`test/adapters/solana/support/env.ts`:

```ts
/**
 * A container on the scripted Solana node, for end-to-end tests. `restart({ killPrevious })`
 * builds a new container over the same stores, node and clock; with `killPrevious` the old
 * generation's clock, fetch, stores and signer are fenced (`fenceGeneration`, handoff R20),
 * so nothing it started can still act.
 */
import {
  CryptoAio,
  noopLogger,
  type Blockchain,
  type LifecycleOptions,
  type Signer,
  type Stores,
} from '../../../../src';
import { secret } from '../../../../src/core/secret/secret';
import { localSigner } from '../../../../src/core/signing/local';
import { createMemoryStores } from '../../../../src/core/store/memory';
import { FakeClock, drive } from '../../../../src/testing/fake-clock';
import { fenceGeneration } from '../../../../src/testing/generation';
import { ScriptedSolanaNode, type NodeOptions } from './node';
import type { Endpoint } from './harness';
import { KEY, KEY_ADDRESS } from './vectors';

export interface SolanaEnvOptions {
  readonly node?: Omit<NodeOptions, 'clock'>;
  readonly endpoints?: readonly Endpoint[];
  /** Lamports for the test key's account (default 10 SOL). */
  readonly fund?: bigint;
  readonly stores?: Partial<Stores>;
  readonly signer?: Signer;
  readonly lifecycle?: LifecycleOptions;
}

/** A local signer holding the test key that counts its `sign` calls. */
export function countingSigner(): { readonly signer: Signer; calls(): number } {
  const inner = localSigner({ id: 'hot', ed25519: secret(KEY) });
  let calls = 0;
  const signer: Signer = {
    id: inner.id,
    schemes: inner.schemes,
    getPublicKey: (scheme, keyRef) => inner.getPublicKey(scheme, keyRef),
    sign: (requests, ctx) => {
      calls += 1;
      return inner.sign(requests, ctx);
    },
  };
  return { signer, calls: () => calls };
}

export async function createSolanaEnv(options: SolanaEnvOptions = {}) {
  const clock = new FakeClock();
  const node = new ScriptedSolanaNode({ ...options.node, clock });
  const endpoints = (options.endpoints ?? ['main']).map((entry) => {
    const { name, ...rest } = typeof entry === 'string' ? { name: entry } : entry;
    return { name, url: node.endpoint(name, rest) };
  });
  const signer = options.signer ?? countingSigner().signer;
  const stores: Stores = { ...createMemoryStores(clock), ...options.stores };
  node.fund(KEY_ADDRESS, options.fund ?? 10_000_000_000n);
  node.produce(2);

  const assemble = (generation: { alive: boolean }) => {
    const fenced = fenceGeneration(
      { clock, fetch: node.fetch.fetch, stores, signers: { hot: signer } },
      generation,
    );
    const aio = new CryptoAio({
      env: false,
      logger: noopLogger,
      clock: fenced.clock,
      stores: fenced.stores,
      transport: { fetch: fenced.fetch, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 5_000 },
      providers: { node: { endpoints } },
      signers: fenced.signers,
      wallets: { main: { signer: 'hot' } },
      chains: { solana: { network: 'devnet', provider: 'node', wallet: 'main' } },
      lifecycle: {
        pollIntervalMs: 1_000,
        droppedGracePeriodMs: 10_000,
        rebroadcastIntervalMs: 5_000,
        waitTimeoutMs: 600_000,
        leaseMs: 30_000,
        claimLeaseMs: 30_000,
        ...options.lifecycle,
      },
    });
    const bc: Blockchain<'solana'> = aio.blockchain({ chain: 'solana' });
    return { aio, bc };
  };

  let generation = { alive: true };
  let current = assemble(generation);
  const run = <T>(promise: Promise<T>, stepMs = 100): Promise<T> =>
    drive(clock, promise, stepMs);
  /** Produces one block per fake 400 ms until `promise` settles. */
  const produceWhile = async <T>(promise: Promise<T>, maxSteps = 2_000): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let i = 0; i < maxSteps && !done; i++) {
      node.produce();
      await clock.advance(400);
    }
    return tracked;
  };
  const restart = (restartOptions: { readonly killPrevious?: boolean } = {}) => {
    if (restartOptions.killPrevious) generation.alive = false;
    generation = { alive: true };
    current = assemble(generation);
    return current;
  };
  return {
    get aio() {
      return current.aio;
    },
    get bc() {
      return current.bc;
    },
    node,
    clock,
    stores,
    address: KEY_ADDRESS,
    run,
    produceWhile,
    restart,
  };
}
```

- [ ] **Step 2: Write the suite**

`test/adapters/solana/e2e.test.ts`:

```ts
import type { AioEvent, OperationPatch, ScanEvent } from '../../../src';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { native } from '../../../src/native';
import { CrashError, FaultyOperationStore } from '../../../src/testing/faulty-store';
import {
  createAssociatedTokenAccountIdempotent,
  transferChecked,
} from '../../../src/adapters/solana/programs';
import { TOKEN, associatedAddress } from './support/node';
import { signedTx } from './support/tx';
import { countingSigner, createSolanaEnv } from './support/env';
import { MINT, RECIPIENT } from './support/vectors';

const SOL = 1_000_000_000n;
const JUNK = 'So11111111111111111111111111111111111111112';

describe('Solana end to end', () => {
  it('runs a native transfer with a memo to proven finality', async () => {
    const env = await createSolanaEnv();
    const sub = await env.run(
      env.bc.transfer(
        { to: RECIPIENT, amount: '1.5', memo: 'order-7' },
        { idempotencyKey: 'n1' },
      ),
    );
    expect(sub).toMatchObject({
      state: 'submitted',
      attempt: { idKind: 'signature', canonical: true },
    });
    const final = await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(final.status).toMatchObject({
      state: 'final',
      evidence: 'proven',
      finality: 'final',
    });
    expect(env.node.balance(RECIPIENT)).toBe(1_500_000_000n);
    const tx = await env.run(env.bc.getTransaction(sub.attempt?.id ?? ''));
    expect(tx?.transfers).toEqual([
      expect.objectContaining({
        id: `${sub.attempt?.id}:ix:2`,
        memo: 'order-7',
        amount: expect.objectContaining({ base: 1_500_000_000n }),
      }),
    ]);
    expect(tx?.decoding).toBe('complete');
  });

  it('sends SPL tokens by mint, creating the recipient account and charging its rent', async () => {
    const env = await createSolanaEnv();
    env.node.createMint(MINT, 6);
    env.node.mintTo(MINT, env.address, 10_000_000n);
    const asset = { standard: 'spl', contract: MINT };
    const fee = await env.run(env.bc.estimateFee({ to: RECIPIENT, amount: '2', asset }));
    expect(fee.bound).toBe('upper');
    expect(fee.charges.map((c) => c.label)).toEqual(['network', 'priority', 'rent']);
    expect(fee.charges[0]?.amount.base).toBe(5_000n);
    // The build variant adds at most ~1 lamport per 1,000 compute units.
    expect(fee.charges[1]?.amount.base).toBeLessThanOrEqual(50n);
    expect(fee.charges[2]?.amount.toDecimalString()).toBe('0.00148844');
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: '2', asset }));
    await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(env.node.tokenBalance(MINT, RECIPIENT)).toBe(2_000_000n);
    expect(env.node.balance(associatedAddress(RECIPIENT, MINT))).toBe(1_488_440n);
    await expect(
      env.run(env.bc.transfer({ to: RECIPIENT, amount: '9', asset })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('lands five concurrent transfers from one address (expiry ordering needs no lease)', async () => {
    const env = await createSolanaEnv();
    const subs = await env.run(
      Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          env.bc.transfer(
            { to: RECIPIENT, amount: SOL + BigInt(i) },
            { idempotencyKey: `c${i}` },
          ),
        ),
      ),
      10,
    );
    expect(new Set(subs.map((s) => s.attempt?.id)).size).toBe(5);
    const finals = await env.produceWhile(
      Promise.all(subs.map((s) => s.wait({ finality: 'final' }))),
    );
    expect(finals.every((f) => f.status.state === 'final')).toBe(true);
    expect(env.node.balance(RECIPIENT)).toBe(5n * SOL + 10n);
  });

  it('keeps two identical Operations apart: two payments, two signatures', async () => {
    const env = await createSolanaEnv();
    const [a, b] = await env.run(
      Promise.all([
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'same-1' }),
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'same-2' }),
      ]),
      10,
    );
    expect(a?.attempt?.id).not.toBe(b?.attempt?.id);
    await env.produceWhile(
      Promise.all([a!.wait({ finality: 'final' }), b!.wait({ finality: 'final' })]),
    );
    expect(env.node.balance(RECIPIENT)).toBe(2n * SOL);
  });

  it('rebroadcasts identical bytes while the blockhash is valid, as "already processed" after', async () => {
    const env = await createSolanaEnv({
      lifecycle: { droppedGracePeriodMs: 2_000, rebroadcastIntervalMs: 1_000 },
    });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }));
    const id = sub.attempt?.id ?? '';
    env.node.drop(id); // the leader never got it: no mempool on Solana
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    await env.clock.advance(3_000);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    expect(env.node.sendCount(id)).toBeGreaterThanOrEqual(2);
    const final = await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(final.status.state).toBe('final');
    // The same bytes again: the node knows them ("already processed"), nothing is paid twice.
    const attempt = (await env.stores.operations.get('default', sub.operationId))
      ?.attempts[0];
    expect(() => env.node.submit(attempt?.raw.data ?? '')).toThrow(
      'Transaction simulation failed: This transaction has already been processed',
    );
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('proves expiry only past lastValidBlockHeight on finalized state, then rebuilds', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 2n * SOL }, { idempotencyKey: 'e1' }),
    );
    const id = sub.attempt?.id ?? '';
    // Every node loses it and never accepts it again.
    env.node.drop(id);
    env.node.intercept = (_e, method) =>
      method === 'sendTransaction' ? { result: id } : undefined;
    await expect(env.run(env.bc.rebuild(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    const outcome = await env.produceWhile(
      sub.wait({ finality: 'final' }).catch((e: unknown) => e),
    );
    expect(outcome).toMatchObject({ code: 'TX_EXPIRED' });
    const op = await env.run(env.bc.getOperation(sub.operationId));
    expect(op?.state).toBe('expired');
    env.node.intercept = undefined;
    const rebuilt = await env.run(env.bc.rebuild(sub.operationId));
    expect(rebuilt.attempts.map((a) => a.purpose)).toEqual(['original', 'rebuild']);
    const done = await env.produceWhile(rebuilt.wait({ finality: 'final' }));
    expect(done.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(2n * SOL);
  });

  it('never calls an expired-looking transfer dead while it can still land (Review Focus 1)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', { name: 'b', lag: 4 }] });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'late' }),
    );
    const id = sub.attempt?.id ?? '';
    env.node.drop(id);
    // Past lastValidBlockHeight on endpoint a only: b still trails by four blocks.
    env.node.produce(150 + 3);
    await env.run(env.aio.monitor.runOnce({ workerId: 'w' }), 10);
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).not.toBe(
      'expired',
    );
  });

  it('stalls on insufficient funds, then lands after a top-up and a rebroadcast', async () => {
    const env = await createSolanaEnv({ fund: 3n * SOL });
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: 2n * SOL }));
    // Spend the balance behind the library's back before its transaction lands.
    env.node.drop(sub.attempt?.id ?? '');
    env.node.fund(env.address, -2n * SOL);
    await expect(env.run(env.bc.rebroadcast(sub.operationId))).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    expect((await env.run(env.bc.getOperation(sub.operationId)))?.state).toBe('stalled');
    env.node.fund(env.address, 2n * SOL);
    expect((await env.run(env.bc.rebroadcast(sub.operationId))).state).toBe('submitted');
    await env.produceWhile(sub.wait({ finality: 'final' }));
    expect(env.node.balance(RECIPIENT)).toBe(2n * SOL);
  });

  it('decides a fork only when both endpoints serve the new block at the height (M11)', async () => {
    const env = await createSolanaEnv({ endpoints: ['a', 'b'] });
    const reorgs: AioEvent[] = [];
    env.aio.on('tx.reorged', (e) => reorgs.push(e));
    const disagreements: AioEvent[] = [];
    env.aio.on('provider.inconsistent', (e) => disagreements.push(e));
    const sub = await env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }));
    const ref = sub.attempt?.id ?? '';
    env.node.produce(1);
    await env.run(env.bc.waitForConfirmation(sub.operationId, { confirmations: 1 }));
    const orphan = env.node.landed(ref)?.block;
    if (!orphan) throw new Error('not landed');
    env.node.reorg(1, [ref]);
    env.node.produce(1);
    const replacement = env.node.block(orphan.height);
    expect(replacement?.hash).not.toBe(orphan.hash);
    // The orphan check reads the block at the recorded height (lesson 17) from both
    // endpoints. While b still serves the orphaned block there, the quorum disagrees, which
    // decides nothing: no reorg, no resend.
    let bLags = true;
    env.node.intercept = (endpoint, method, params) =>
      bLags &&
      endpoint === 'b' &&
      method === 'getBlock' &&
      Number(params[0]) === Number(replacement?.slot)
        ? {
            result: {
              blockHeight: Number(orphan.height),
              blockTime: orphan.blockTime,
              blockhash: orphan.hash,
              parentSlot: Number(orphan.parentSlot),
              previousBlockhash: orphan.previousBlockhash,
            },
          }
        : undefined;
    const waiting = env.bc.waitForConfirmation(sub.operationId, { finality: 'final' });
    waiting.catch(() => undefined);
    for (let i = 0; i < 10; i++) {
      env.node.produce();
      await env.clock.advance(1_000);
    }
    expect([reorgs.length, env.node.sendCount(ref)]).toEqual([0, 1]);
    expect(disagreements.length).toBeGreaterThan(0);
    for (const event of disagreements) {
      expect(event).toMatchObject({
        method: 'getBlock',
        endpointIds: ['node/a', 'node/b'],
      });
    }
    bLags = false;
    const final = await env.produceWhile(waiting);
    expect(final.operation?.state).toBe('final');
    expect(reorgs[0]).toMatchObject({
      operationId: sub.operationId,
      previousBlockHash: orphan.hash,
    });
    expect(env.node.sendCount(ref)).toBeGreaterThanOrEqual(2);
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  it('ends final, never expired, when the transfer lands at lastValidBlockHeight + 1 (I1)', async () => {
    const env = await createSolanaEnv();
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'edge' }),
    );
    const ref = sub.attempt?.id ?? '';
    const op = await env.stores.operations.getByKey('default', 'edge');
    const attempt = op?.attempts[0];
    const last =
      attempt?.ordering.kind === 'expiry'
        ? (attempt.ordering.lastValidHeight as bigint)
        : 0n;
    // Held back from every leader until its last block, then sent once; the monitor polls
    // (and resends) all along, and must never prove it expired.
    env.node.drop(ref);
    env.node.intercept = (_e, method) =>
      method === 'sendTransaction' ? { result: ref } : undefined;
    const waiting = sub.wait({ finality: 'final' });
    waiting.catch(() => undefined);
    while (env.node.head.height < last) {
      env.node.produce();
      await env.clock.advance(400);
    }
    env.node.intercept = undefined;
    env.node.submit(attempt?.raw.data ?? '', { skipPreflight: true });
    env.node.produce(1);
    expect(env.node.landed(ref)?.block.height).toBe(last + 1n);
    const final = await env.produceWhile(waiting);
    expect(final.status).toMatchObject({ state: 'final', blockHeight: last + 1n });
    expect(env.node.balance(RECIPIENT)).toBe(SOL);
  });

  describe('crash and recovery (handoff R20: killPrevious)', () => {
    async function crashEnv() {
      const { signer, calls } = countingSigner();
      const faulty = new FaultyOperationStore(new MemoryOperationStore());
      const env = await createSolanaEnv({ signer, stores: { operations: faulty } });
      return { env, faulty, calls };
    }
    const patchState = (state: string) => (args: readonly unknown[]) =>
      (args[2] as OperationPatch | undefined)?.state === state;

    it('rebroadcasts a signed-but-never-sent transfer without signing again', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'appendAttempt', timing: 'after' });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.sendCount(ref)]).toEqual(['signed', 0]);
      const dead = env.bc;
      const restarted = env.restart({ killPrevious: true });
      // M11: the crashed process is dead: nothing on its handle settles any more.
      let deadSettled = false;
      void dead.getBlockHeight().then(
        () => (deadSettled = true),
        () => (deadSettled = true),
      );
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, sub.attempt?.id, calls()]).toEqual(['submitted', ref, 1]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
      expect(deadSettled).toBe(false);
    });

    it('recovers a broadcast that was never recorded: the node answers "already processed"', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({
        method: 'update',
        timing: 'before',
        when: patchState('submitted'),
      });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toMatchObject({ code: 'STATE_UNRECORDED', ambiguous: true });
      const stored = await env.stores.operations.getByKey('default', 'k');
      const ref = stored?.attempts[0]?.ref.id ?? '';
      expect([stored?.state, env.node.inMempool(ref)]).toEqual(['signed', true]);
      env.node.produce(1);
      const restarted = env.restart({ killPrevious: true });
      const report = await env.run(restarted.aio.operations.recover());
      expect(report).toMatchObject({ rebroadcast: 1, failed: 0 });
      expect(env.node.sendCount(ref)).toBe(2);
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['included', 1]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
    });

    it('resumes a prepared transfer by signing its stored message once', async () => {
      const { env, faulty, calls } = await crashEnv();
      faulty.crashOn({ method: 'update', timing: 'after', when: patchState('prepared') });
      await expect(
        env.run(env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' })),
      ).rejects.toBeInstanceOf(CrashError);
      expect((await env.stores.operations.getByKey('default', 'k'))?.state).toBe(
        'prepared',
      );
      const restarted = env.restart({ killPrevious: true });
      const sub = await env.run(
        restarted.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'k' }),
      );
      expect([sub.state, calls()]).toEqual(['submitted', 1]);
      await env.produceWhile(sub.wait({ finality: 'final' }));
      expect(env.node.balance(RECIPIENT)).toBe(SOL);
      expect(env.clock.pending).toBe(0);
    });
  });

  it('scans final blocks for deposits: native, SPL, and an unresolved token (R35)', async () => {
    const env = await createSolanaEnv();
    env.node.createMint(MINT, 6);
    env.node.mintTo(MINT, env.address, 10_000_000n);
    const subs = [];
    subs.push(
      await env.run(
        env.bc.transfer({ to: RECIPIENT, amount: SOL }, { idempotencyKey: 'd1' }),
      ),
    );
    subs.push(
      await env.run(
        env.bc.transfer(
          { to: RECIPIENT, amount: 2n, asset: { standard: 'spl', contract: MINT } },
          { idempotencyKey: 'd2' },
        ),
      ),
    );
    await env.produceWhile(Promise.all(subs.map((s) => s.wait({ finality: 'final' }))));
    // Another wallet's token whose mint no longer parses: its deposit is unresolved (R35).
    env.node.createMint(JUNK, 6);
    const source = env.node.mintTo(JUNK, env.address, 10n);
    const destination = associatedAddress(RECIPIENT, JUNK);
    env.node.submit(
      signedTx(env.node.head.hash, [
        createAssociatedTokenAccountIdempotent(env.address, destination, RECIPIENT, JUNK),
        transferChecked(source, JUNK, destination, env.address, 5n, 6),
      ]),
    );
    env.node.produce(1);
    env.node.setAccount(JUNK, { owner: TOKEN, data: new Uint8Array(82) });
    const scanner = env.bc
      .scanner({
        cursorKey: 'deposits',
        from: 1n,
        mode: 'final',
        filter: { addresses: [RECIPIENT] },
      })
      [Symbol.asyncIterator]();
    const seen: ScanEvent[] = [];
    for (
      let i = 0;
      i < 200 &&
      seen.flatMap((e) => (e.type === 'block' ? e.transactions : [])).length < 3;
      i++
    ) {
      const next = await env.produceWhile(scanner.next());
      if (next.done) break;
      await env.run(next.value.ack());
      seen.push(next.value);
    }
    const txs = seen.flatMap((e) => (e.type === 'block' ? e.transactions : []));
    expect(
      txs.map((t) =>
        t.transfers.map((tr) =>
          tr.unresolved ? tr.unresolved.code : tr.amount.format(),
        ),
      ),
    ).toEqual([
      ['1 SOL'],
      ['0.00148844 SOL', `0.000002 ${MINT.slice(0, 8)}`],
      ['0.00148844 SOL', 'ASSET_RESOLUTION'],
    ]);
    expect(txs[2]).toMatchObject({
      decoding: 'partial',
      transfers: [
        expect.anything(),
        { unresolved: { asset: { standard: 'spl', contract: JUNK }, amount: 5n } },
      ],
    });
  });

  it('hands the handle its own native Connection', async () => {
    const env = await createSolanaEnv();
    const client = await env.run(native(env.bc, '@solana/web3.js'));
    expect(await env.run(native(env.bc, '@solana/web3.js'))).toBe(client);
    expect(await env.run(client.getBlockHeight('confirmed'))).toBe(
      Number(env.node.head.height),
    );
    await env.aio.close();
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm jest test/adapters/solana/e2e.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 4: Prove determinism (lesson 1)**

Run: `for i in $(seq 1 100); do pnpm jest test/adapters/solana/e2e.test.ts test/adapters/solana/driver.test.ts --silent >/dev/null 2>&1 || { echo "failed on run $i"; exit 1; }; done; echo '100/100 green'`
Expected: `100/100 green`. A failure means something outside `FakeClock` is on a request path: find it, never retry.

- [ ] **Step 5: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add test/adapters/solana/support/env.ts test/adapters/solana/e2e.test.ts
git commit -m "test(solana): end-to-end transfers, expiry and rebuild, forks, crashes and scanning

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 11: Opt-in read-only integration test

**Files:**
- Test: `test/integration/solana.test.ts`

**Interfaces:**
- Consumes: the public API; `test/setup.ts` keeps the real `fetch` only when `CRYPTO_AIO_INTEGRATION=1`.
- Produces: a suite skipped by default that, when enabled, checks a live cluster: `ready()` (the `getGenesisHash` identity check), heights, the block at a finalized height and its child's parent link (dense heights on a real ledger with skipped slots), a native balance, and a fee estimate for an unfunded sender (the simulation fallback and `getFeeForMessage`). Routing: `CRYPTO_AIO_IT_SOLANA_NETWORK` and `CRYPTO_AIO_IT_SOLANA_RPC_URL` (D23); no variable carries a key, and a URL is wrapped in `secret()`.

**Review points:**
- No key or funded account is needed; the test never broadcasts.
- It does not assume that a finalized height read after a head height is lower: behind a load balancer, or with sub-second finality, two reads are not ordered (observed during authoring on mainnet and testnet).
- It pauses 2 s between steps: the public endpoints are rate-limited and, until A17 lands, health probes do not wait for the limit (M12).

- [ ] **Step 1: Write the test**

`test/integration/solana.test.ts`:

```ts
/**
 * Opt-in, read-only checks against a live Solana cluster (spec §17), skipped unless
 * CRYPTO_AIO_INTEGRATION=1. Environment variables carry flags and routing only, never keys:
 * - CRYPTO_AIO_IT_SOLANA_NETWORK: `mainnet`, `devnet` (default) or `testnet`;
 * - CRYPTO_AIO_IT_SOLANA_RPC_URL: an endpoint URL (default: the `public` preset). If the URL
 *   embeds a key it stays redacted (a `Secret`), but prefer a keyless endpoint.
 */
import { CryptoAio, secret, type ProviderRef } from '../../src';

const enabled = process.env.CRYPTO_AIO_INTEGRATION === '1';
const network = (process.env.CRYPTO_AIO_IT_SOLANA_NETWORK ?? 'devnet') as
  'mainnet' | 'devnet' | 'testnet';
const url = process.env.CRYPTO_AIO_IT_SOLANA_RPC_URL;
const provider: ProviderRef = url ? { endpoints: [{ url: secret(url) }] } : 'public';
/** The System Program's address: always present, never a signer. */
const SYSTEM = '11111111111111111111111111111111';
/** Two addresses derived from public test seeds (Plan 5 vectors); nobody funds them. */
const SENDER = '77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa';
const RECIPIENT = '6zYdUwXJR5fhQJazDByGv4PsNrdaNhoruAR5kekA7rGs';
const suite = enabled ? describe : describe.skip;
/**
 * The public endpoints allow about 40 requests per 10 s per method, and until ruling A17
 * lands the health probes do not wait for the rate limit: pause between steps.
 */
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000));

suite(`Solana integration on ${network}`, () => {
  it('checks the genesis hash, then reads heights, a final block and balances', async () => {
    const aio = new CryptoAio({ env: false });
    try {
      const bc = aio.blockchain({ chain: 'solana', network, provider });
      await bc.ready();
      await pause();
      const status = await bc.getNetworkStatus();
      expect(status.height).toBeGreaterThan(0n);
      expect(status.finalizedHeight).toBeGreaterThan(0n);
      // Two reads are not ordered: behind a load balancer, or with sub-second finality, the
      // finalized height can read above a confirmed height read a moment earlier.
      const gap = status.height - status.finalizedHeight;
      expect(gap < 1_000n && gap > -1_000n).toBe(true);
      await pause();
      const block = await bc.getBlock(status.finalizedHeight - 10n);
      expect(block?.height).toBe(status.finalizedHeight - 10n);
      expect(block?.hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      const next = await bc.getBlock(status.finalizedHeight - 9n);
      expect(next?.parentHash).toBe(block?.hash);
      await pause();
      expect((await bc.getBalance(SYSTEM)).amount.asset.id).toBe(
        `solana:${network}/native`,
      );
      // A fee needs no signer and no funds (the simulation fails; the limit falls back).
      await pause();
      const fee = await bc.estimateFee({
        to: RECIPIENT,
        amount: 1_000_000n,
        from: SENDER,
      });
      expect(fee.charges[0]).toMatchObject({ label: 'network' });
      expect(fee.charges[0]?.amount.base).toBeGreaterThan(0n);
    } finally {
      await aio.close();
    }
  }, 180_000);
});
```

- [ ] **Step 2: Run it offline**

Run: `pnpm jest test/integration/solana.test.ts`
Expected: `Tests: 1 skipped, 1 total`.

- [ ] **Step 3: Run it live (optional, needs network)**

Run: `CRYPTO_AIO_INTEGRATION=1 pnpm jest test/integration/solana.test.ts` (and with `CRYPTO_AIO_IT_SOLANA_NETWORK=testnet`)
Expected: PASS, 1 test each. During authoring it passed on mainnet, devnet and testnet against the public endpoints (Agave 4.3.0). If an endpoint blocks your network, set `CRYPTO_AIO_IT_SOLANA_RPC_URL` (and, behind a proxy, `NODE_USE_ENV_PROXY=1`). This step never runs in CI.

- [ ] **Step 4: Check and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`
Expected: all green, with the integration test skipped.

```bash
git add test/integration/solana.test.ts
git commit -m "test(solana): opt-in read-only integration checks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 12: Guides, README and CHANGELOG

**Files:**
- Modify: `docs/guides/index.md`, `docs/guides/quick-start.md`, `docs/guides/networks.md`, `docs/guides/transactions.md`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the shipped behaviour of Tasks 0–11, and the guide layout after Plan 2 Task 13 (whose replacement texts are the anchors below).
- Produces: guides whose status tables say the Solana family works today; a "Solana networks" section in `networks.md`; the Solana fee override, rebuild and history notes in `transactions.md`; README and CHANGELOG `[Unreleased]` entries.

Edit the guides by hand and do not run Prettier on them (D22). If another family plan changed one of these sentences first, add Solana to the current sentence in the same style instead of replacing it.

**Review points:**
- Every statement matches the shipped behaviour and Appendix A (genesis hashes, presets per cluster, limits).
- The Node ≥ 22.12 note for `@solana/web3.js` 1.99 is present (ruling A13).
- The pre-flight corrections are present (M9): landing up to `lastValidBlockHeight + 1` (I1), expiry proven only over the whole window and the two-provider advice (C1), the explicit-limit variant (M3), the `blockhash not found` stall (M5), SPL to a program refused (M4), the scan's `partial` superset (I4), provider retention, and the lossy `Connection`.
- `pnpm doc` resolves the new `networks.md#solana-networks` anchor.

- [ ] **Step 1: Apply the edits**

Make each replacement below exactly once.

1. In `docs/guides/index.md`, replace:

```markdown
| Solana (@solana/web3.js) | Planned, Plan 5 |
```

with:

```markdown
| Solana (@solana/web3.js) | Works today: SOL, classic SPL tokens, memos, scanning and history |
```

2. In `docs/guides/index.md`, replace:

```markdown
`crypto-aio/testing` is a deterministic, in-memory chain for learning and testing. The other
real chain families are planned.
```

with:

```markdown
`crypto-aio/testing` is a deterministic, in-memory chain for learning and testing. Plan 5
adds the **Solana family** (mainnet, devnet and testnet, through `@solana/web3.js`). The other
real chain families are planned.
```

3. In `docs/guides/index.md`, replace:

```markdown
`crypto-aio`, `crypto-aio/evm`, `crypto-aio/testing` and `crypto-aio/native`. It also
includes these guides.
```

with:

```markdown
`crypto-aio`, `crypto-aio/evm`, `crypto-aio/solana`, `crypto-aio/testing` and
`crypto-aio/native`. It also includes these guides.
```

4. In `docs/guides/quick-start.md`, replace:

```markdown
next to it, for example `npm install ethers` for EVM chains. A missing SDK fails with
`DEPENDENCY_MISSING` and the exact install command. The package has four entry points:
```

with:

```markdown
next to it, for example `npm install ethers` for EVM chains or `npm install @solana/web3.js`
for Solana (which needs Node ≥ 22.12). A missing SDK fails with `DEPENDENCY_MISSING` and the
exact install command. The package has five entry points:
```

and replace:

```markdown
import { evmChainPlugin } from 'crypto-aio/evm'; // EVM extras and SDK client types
```

with:

```markdown
import { evmChainPlugin } from 'crypto-aio/evm'; // EVM extras and SDK client types
import { SOLANA_CAPABILITIES } from 'crypto-aio/solana'; // Solana extras and SDK client types
```

5. In `docs/guides/networks.md`, replace:

```markdown
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | Planned, Plan 5 |
```

with:

```markdown
| Solana (@solana/web3.js) | mainnet, devnet, testnet | expiry | **Works today**, built in ([details](#solana-networks)) |
```

6. In `docs/guides/networks.md`, replace:

```markdown
families register themselves in the package's composition root; today that is the EVM
family.
```

with:

```markdown
families register themselves in the package's composition root; today those are the EVM and
Solana families.
```

7. In `docs/guides/networks.md`, replace:

```markdown
`Web3` instance, both wired to the same transport. Import `crypto-aio/evm` once to type them.
```

with:

````markdown
`Web3` instance, both wired to the same transport. Import `crypto-aio/evm` once to type them.

### Solana networks

The Solana driver serves three clusters through `@solana/web3.js` (v1), installed next to
crypto-aio: `npm install @solana/web3.js`. Version 1.99 needs Node ≥ 22.12.

| Network | Identity (genesis hash) | Presets |
| --- | --- | --- |
| `mainnet` | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `public`, `alchemy`, `infura`, `ankr` |
| `devnet` | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | `public`, `alchemy`, `infura`, `ankr` |
| `testnet` | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY` | `public` |

- **Transfers.** SOL (System Program) and classic SPL tokens (`transferChecked`), one output
  per transfer. When the recipient has no associated token account, the transfer creates it
  and the estimate adds its rent-exempt deposit as a `rent` charge. That charge is an `upper`
  bound: if someone creates the account first, no rent is paid. Token-2022 mints throw
  `UNSUPPORTED_CAPABILITY`. Tokens move between associated token accounts; `getBalance` sums
  every token account the owner holds for the mint, and `bc.ext.solana.getTokenAccounts(owner,
  mint?)` lists them.
- **Checks before signing.** SOL to a program-owned account, SPL to a program (send to a
  wallet or a PDA owner instead) or to a token account instead of its owner, a new account
  below the rent-exempt minimum, a frozen token account, and a transfer that would leave the
  sender between 0 and its rent-exempt minimum are refused before anything is signed. To fund
  a program account on purpose, use `native()`.
- **Fees.** `solana` fees have a `network` charge (the signature fee the node quotes), a
  `priority` charge (compute-unit price × limit) and, when an account is created, `rent`.
  Speeds take the 25th, 50th and 75th percentile of recent prioritization fees; the limit is a
  simulation plus 20%. Override with `{ computeUnitPrice, computeUnitLimit? }`
  (`SolanaFeeOverride`, micro-lamports per compute unit). Each build adds up to 1,023 units
  to the limit, an explicit limit included (an explicit price is kept exactly), so two
  identical transfers do not share a signature. At the 1,400,000-unit maximum no variant
  fits, and the library refuses a second Operation that would share a signature.
- **Memos.** Up to 256 UTF-8 bytes, through the Memo program. A received memo is attached to
  a transaction's transfers when the transaction has exactly one.
- **Expiry instead of replacement.** A transaction can land up to the block after its
  `lastValidBlockHeight` (150 blocks after its blockhash). The monitor resends the same bytes
  while it can still land. It becomes `expired` (`TX_EXPIRED`) only once every proof endpoint
  has finalized that last block and serves every block of the window without the
  transaction; then `bc.rebuild(id)` signs a new one. There is no replace or cancel.
- **Configure two providers for proven expiry.** Each proof is a quorum over your endpoints,
  and an endpoint is a URL: a single URL, load-balanced or not, is trusted for everything it
  answers. A backend that lags or lacks blocks never decides anything, but only a second,
  independent provider guards against one that answers wrongly.
- **A `blockhash not found` refusal.** An endpoint that lags behind the one that served the
  blockhash refuses the first broadcast, and the Operation is `stalled`. While the blockhash
  is valid, `bc.rebroadcast(id)` retries it; otherwise it expires and `bc.rebuild(id)` signs a
  new one.
- **Finality and scanning.** `final` is the `finalized` commitment. Heights are block
  heights, not slots, so skipped slots never leave a gap in scans or confirmations. A scan
  reports every transaction that may move funds for a watched address; one it cannot fully
  attribute is reported as `partial` rather than dropped.
- **Retention.** Endpoints need transaction history (`getTransaction`,
  `getSignaturesForAddress`), and providers keep different amounts: Ankr documents about 16
  hours of ledger, and Infura's Solana access is limited to select customers. History ends at
  a provider's retention, and a proof about blocks older than it decides nothing (the call
  waits and retries) rather than guessing.
- **History** comes from the RPC (`getSignaturesForAddress`), newest first, without an
  indexer. An SPL deposit into an existing token account appears in that account's history,
  not the owner's.
- **Tokens.** USDC (mainnet, devnet) and USDT (mainnet) are registered by alias. Any other
  classic mint resolves by address, with its decimals read from the chain and the first eight
  characters of its address as its symbol.
- **Keys.** Solana keys are ed25519: `localSigner({ ed25519: secret(hex) })`. Mnemonic signers
  need `keyRef.path`; wallets commonly use `m/44'/501'/0'/0'`.
- **Not in this release:** durable nonces, Token-2022, building versioned transactions with
  address lookup tables (received ones are decoded), a Solana network of your own (a local
  test validator has its own genesis hash), and `@solana/kit`.

`native(bc, '@solana/web3.js')` returns a `Connection` wired to the same transport (HTTP
JSON-RPC only: subscriptions have no bridge). Import `crypto-aio/solana` once to type it.
The `Connection` parses JSON itself, so numbers above 2^53 are rounded there; the driver's
own reads keep u64 amounts exact.
````

8. In `docs/guides/transactions.md`, replace:

```markdown
(`evm-legacy`), in wei (`EvmFeeOverride`). Each planned family defines its own override fields
with its adapter. Override amounts
```

with:

```markdown
(`evm-legacy`), in wei (`EvmFeeOverride`). Solana takes `{ computeUnitPrice, computeUnitLimit? }`
(micro-lamports per compute unit, and compute units; `SolanaFeeOverride`). Each planned family
defines its own override fields with its adapter. Override amounts
```

9. In `docs/guides/transactions.md`, replace:

```markdown
On expiry- and seqno-based chains (planned Tron, Solana and TON; `fakeexpiry` and
`fakeseqno` today), `bc.rebuild(id)` re-issues an Operation after its expiry is **proven**
```

with:

```markdown
On expiry- and seqno-based chains (Solana today; planned Tron and TON; `fakeexpiry` and
`fakeseqno` in the testing kit), `bc.rebuild(id)` re-issues an Operation after its expiry is **proven**
```

10. In `docs/guides/transactions.md`, replace:

```markdown
support one yet, so both throw `UNSUPPORTED_CAPABILITY`.
```

with:

```markdown
support one yet, so both throw `UNSUPPORTED_CAPABILITY`. Solana is the exception: its RPC
serves history (`getSignaturesForAddress`) without an indexer, newest first. An SPL deposit
into an existing token account appears in that token account's history, not the owner's;
`bc.ext.solana.getTokenAccounts(owner)` lists an owner's token accounts.
```

11. In `README.md`, replace:

```markdown
Base, through ethers or web3). Bitcoin, Tron, Solana and TON arrive in Plans 3–6.
```

with:

```markdown
Base, through ethers or web3). The Solana family works too (Plan 5, through
`@solana/web3.js`). Bitcoin, Tron and TON arrive in Plans 3, 4 and 6.
```

12. In `CHANGELOG.md`, under `## [Unreleased]`, insert after the line `- \`CallOptions.quorumKey\`: a quorum compares only the facts it names.`:

```markdown
- The Solana family, built in: mainnet, devnet and testnet, with `@solana/web3.js` 1.99 as
  an optional peer dependency (it needs Node ≥ 22.12).
- SOL and classic SPL token transfers (`transferChecked`), creating the recipient's
  associated token account when it is missing, with its rent as a separate `rent` charge;
  memos; `solana` fees (signature fee plus priority fee); `expiry` ordering on
  `lastValidBlockHeight`, and `rebuild` after a proven expiry.
- `finalized`-commitment finality with quorum proofs, block scanning over dense block
  heights, address history from `getSignaturesForAddress`, the `public`, `alchemy`,
  `infura` and `ankr` presets, USDC and USDT by alias, and the `crypto-aio/solana` entry.
```

(`CallOptions.exactIntegers` is Plan 2.5's changelog entry.)

- [ ] **Step 2: Check the snippets and the docs build**

Run: `pnpm exec prettier --check README.md CHANGELOG.md && pnpm doc`
Expected: both files use Prettier code style; TypeDoc reports 0 errors and 0 warnings, and the new `networks.md#solana-networks` anchor resolves.

- [ ] **Step 3: Run the whole branch's checks**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm doc`
Expected: all green: the earlier suites plus the new ones (152 new tests, 148 if Plan 2.5 already delivered Task 0's four), 1 Solana integration test skipped, `dist/adapters/solana/` built, TypeDoc clean. During authoring, on Plan 2's `7bec7eb`: 1,164 passed and 1 skipped.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/index.md docs/guides/quick-start.md docs/guides/networks.md docs/guides/transactions.md README.md CHANGELOG.md
git commit -m "docs(guides): the Solana family works today

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Chain-specific risks

Each risk names the protocol pitfall and where the plan handles it.

| Risk | What goes wrong | How the plan handles it |
|---|---|---|
| **Blockhash expiry versus "may still land"** | A transaction looks gone (no mempool on Solana; `getTransaction` is `null`) while it can still be included, up to block `lastValidBlockHeight + 1` (agave compares the blockhash's age against the including block's parent, I1); calling it dead lets the user rebuild and pay twice. | The window is `L − 149 … L + 1` (D6). Expiry is proven only once block `L + 1` is final (a quorum predicate) and every block of the window has been read under the proof quorum, self-certified by height and parent link, without the signature (D7). Anything else is retryable and decides nothing. Pinned: Task 4 (the node lands at `L + 1`), Task 8 (included at `L + 1`; the one-endpoint gap tests), Task 10 ("never calls an expired-looking transfer dead", "ends final, never expired, when the transfer lands at lastValidBlockHeight + 1"). |
| **Moving finalized head** | Finality advances every ~200 ms (Alpenglow-era clusters); two honest endpoints rarely agree on "the finalized block", and one endpoint ahead of its peer could push finality to its own head. | Lesson 17 final form: predicates and finality-scoped reads at the fact's own height; no endpoint proposes a height; `finalizedHead` trails a peer skew (D6). Observed live: a finalized height read later can exceed a confirmed height read earlier (Task 11 tolerates it). |
| **Durable nonces** | A durable-nonce transaction never expires by block height, which breaks expiry proofs. | Out of scope (spec §20): the builder only uses recent blockhashes; received durable-nonce transactions are decoded like any other. |
| **Rebroadcasting identical bytes** | Resending a landed transaction must not look like a failure; resending an expired one must not look permanent. | "This transaction has already been processed" is `already-known`; "Blockhash not found" is `refused` (a lagging node may not know it yet), never `rejected` (D15). The monitor resends while `dropped` (spec §8.8). A first broadcast refused that way leaves the Operation `stalled` until the user calls `bc.rebroadcast(id)` or expiry is proven (M5; the guide says so). Pinned: Task 7 (broadcaster), Task 10 (rebroadcast and recovery tests). |
| **Identical transfers share a signature** | Deterministic ed25519 over the same message and blockhash: a second Operation silently tracks the first one's payment. | Build variants on the compute-unit limit, an explicit limit included (D10, M3), plus the core guard of ruling A15 (Plan 2.5), which is the only guard at the 1,400,000-unit maximum. Pinned: Task 7, Task 10 (Review Focus 3). |
| **Recipient ATA races** | Between the estimate and landing, someone may create the recipient's token account (the rent is then not charged) or close it (the transfer fails). | `CreateIdempotent` succeeds either way, and the `rent` charge is an `upper` bound. A closed account makes the transfer fail at preflight: `refused` → `stalled`, then expiry and `rebuild`, which re-reads the account (D11). |
| **Accounts below the rent-exempt minimum** | A new account funded below the minimum, or a sender left between 0 and its minimum, fails with "insufficient funds for rent" after signing. | Checked before signing (D11): `INVALID_AMOUNT` for a new recipient, `INSUFFICIENT_FUNDS` with `{ required, available }` for the sender. The minimum is read from the node (it changed in 2026: 650,240 lamports for an empty account). Pinned: Task 7 (Review Focus 4); the node models it (Task 4). |
| **A transfer to a program or a program-owned account** | SOL sent to a token account, a stake account or a program's data account may be stranded; tokens sent to a program id land in an associated token account nobody can sign for. | Refused before signing unless the recipient is a system-owned account (D11); SPL to a token account instead of its owner, or to an executable account (M4), is refused too. Pinned: Task 7 (Review Focus 4). |
| **`jsonParsed` differences across providers** | Honest providers differ in `uiAmount` (float or `null`), `owner`/`programId` on token balances, `stackHeight`, `costUnits`, logs, `blockTime`; a whole-object quorum would never agree. | Quorum keys compare only the facts a verdict reads (lesson 2): slot, error, signatures, keys, token amounts, token-transfer instructions. Pinned: Task 2, Task 8 (Review Focus 2). |
| **Skipped slots and dense heights** | Slots are not heights; a scanner or confirmation count over slots would see gaps or skip blocks. | Block heights everywhere; the height index maps them to slots (D4). Pinned: Task 6, Task 8 (Review Focus 5). |
| **u64 lamports as JSON numbers** | Balances above 2^53 − 1 lamports are rounded by `JSON.parse`. | Every call sets `exactIntegers` (Task 0, D19); a rounded number is refused. Pinned: Tasks 0, 2, 5, 6. |
| **Pruned ledgers, snapshot jumps and history gaps** | An endpoint without transaction history, with a pruned ledger (Ankr keeps about 16 hours), started from a snapshot, or with a long-term-storage gap answers `null` for a transaction that did land, and its `getBlocks` lists can skip heights. | "Gone" codes decide nothing (D4); a `getBlocks` page is believed only after its first block's height is read (I3); "not included" reads every block of the window (D7), so a gapped backend yields "not available", never `{ included: false }`. Any other RPC error on a proof path, such as agave's `-32602 "BigTable query failed"` for a window below a backend's local ledger, decides nothing too (lesson 18 widened, R1). History ends at the provider's retention (guide). Pinned: Task 4 (the BigTable model), Task 6 (the gap, pruned-endpoint and lesson 18 tests), Task 8 (one gapped endpoint, single and load-balanced; "no RPC error is a verdict"). |
| **Phantom success** | A node answer that says a token transfer succeeded while the balances do not show it. | The landing guard on verdict paths (D14): a token transfer from the sender's account to the recipient's, of any positive amount; seeing no such transfer never passes; missing token balances or keys, and token instructions of which none is the sender's (a contradiction of the signed message, R3), decide nothing (retryable), never a proven `failed`. General decoding reports the chain's own status. Pinned: Task 5 ("needs a transfer from the sender to the recipient of a positive amount, not the exact one", "decides nothing on missing or contradictory evidence"). |
| **Load-balanced endpoints** | `api.mainnet.solana.com` and every provider URL are load-balanced: consecutive reads may reach different backends, one lagging, pruned or gapped, so an endpoint is not monotone and one "held" block says nothing about the next read. | A positive verdict is one quorum read of a fixed fact; "not included" is a chain of self-certifying block reads, each of which can only fail to decide (D7); single reads only feed observed (non-terminal) states and the stale-view guard. With one URL, everything that URL answers is trusted, so the guide advises two independent providers. Pinned: Task 4 (the balanced node model), Task 8 (one load-balanced endpoint with a gapped backend never yields `{ included: false }` or a proven `expired`). |
| **Scan filters that drop deposits** | A block scan that keeps only transactions it can attribute to a watched address would miss a deposit whose token owner is not in the balances or whose instruction is not parsed. | The filter is a superset (I4): a named transfer, a lamport change on a watched key, a token balance change whose owner is watched or missing, a token program that ran when the node reported no token balances (R4), or any partly decoded transaction with a watched key; what cannot be attributed is reported as `partial`, never dropped. Pinned: Task 5 ("keeps a deposit it cannot attribute…", "keeps an SPL deposit when the node reports no token balances"), Task 8. |

## Unresolved assumptions

Each item gives the default chosen and what it costs if wrong.

- **One provider is trusted for everything it answers (D7, A14).** The window scan makes every lagging, pruned or gapped backend fail to decide, but a provider that serves a well-formed, self-consistent block without a transaction it did include cannot be caught by reading it alone. Default: the proof quorum (A14 keeps a height liar from shrinking it), and the guide advises two independent providers for proven expiry. Cost if wrong: with one dishonest provider, a proven `expired` for a transaction that landed.
- **Provider retention.** Ankr documents a ledger of about 100 M slots (about 16 hours); Infura's Solana access is limited to select customers; others vary. Default: a read below a provider's retention is "gone" and decides nothing (D4, D7), and history ends there (guide). Cost: an `expired` proof, or a scan, older than the retention waits until the user adds an archival provider.
- **`getTransaction` ignores `minContextSlot` on agave 4.3.0** (verified live; `getBlocks` honours it). Default: nothing relies on it; `getBlocks` sets it as a cheap first filter, and the block reads self-certify. Cost: none.
- **Long-term storage failing near a backend's local ledger (R1).** agave 4.3.0 serves `getBlocks` from below its local ledger through long-term storage; when that fails (`-32602`), a height-index page that starts below the ledger fails too, even for a height just above it (a page reaches about 64 slots plus a quarter of the distance below the target). Default: it decides nothing (retryable), and a second provider or a later retry answers. Cost: liveness only, for heights near one backend's retention.
- **Health probes and rate limits (A17).** Until Plan 2.5's A17 lands, probes do not wait for a public endpoint's rate limit. Default: Task 11 pauses 2 s between steps. Cost: a flaky live run, never CI.
- **Priority-fee percentiles and the compute margin** (D9) are library policy, not chain facts; a congested account may need `fast` or an explicit price. Cost: an Attempt expires unlanded and needs `rebuild`.
- **A simulation failure uses the runtime default limit** (200,000 per instruction). Cost: a higher priority fee for such a transfer (the price is usually 0 in that case).
- **The rent-exempt minimum is read per estimate**; the scripted node models today's value (5,080 lamports per byte including the 128-byte overhead). Cost: none for the driver; the node's constant would need an update if rent changes again.
- **Unregistered mints' symbols** are the first eight characters of the mint (D12). Cost: display only.
- **Node ≥ 22.12 for `@solana/web3.js` 1.99** (A13). Cost: users on 22.0–22.11 cannot load the SDK (`DEPENDENCY_MISSING` is not what they see; the require fails with Node's ESM error). Documented.
- **No Solana network of your own** (no `solanaChainPlugin`). Cost: a local test validator cannot be used through the built-in chain; a later plan can add a chain plugin as Plan 2 did.
- **`-32005` (node unhealthy) is `RATE_LIMITED`.** The core transport maps JSON-RPC `-32005` to `RATE_LIMITED` (an EVM convention); on Solana it means "node unhealthy / behind". Default: accepted, since both are retryable with backoff and fail over. Cost: an event names a rate limit that is really a lagging node.
- **Live endpoints.** Task 11 passed on mainnet, devnet and testnet during authoring (after the pre-flight review; earlier, the authoring machine's Node could not reach mainnet). Cost: none expected; the integration test takes an explicit URL.

## Merge notes

Plan 2 is merged and Plan 2.5 has landed before this plan executes (ruling A11). Branch from `main`. Shared files, and how the changes combine:

- **`src/core/util/json.ts`, `src/core/transport/{types,http-transport}.ts`** (Task 0): lifted into Plan 2.5 and merged there with Plan 4's Task 0 into one implementation: one `parseJson(text, exactIntegers)` helper, one `CallOptions.exactIntegers` field, and one `test/core/transport/exact-integers.test.ts` holding both plans' assertions (M12). If Plan 2.5 delivered it, skip Task 0 and keep the rest unchanged; if its final API differs (a different option name), rename the one `exactIntegers: true` in `rpc.ts`'s `call()` and the harness's `recording` filter.
- **`includedFinal`'s reason (M10, A9).** Once Plan 2.5 lets `includedFinal` carry `reason`, the included branch passes `'transaction failed'` or `'token transfer failed'` through, and the core puts it on the proven `failed` (P6-2). One line in `proofs.ts`; no test changes beyond asserting the reason.
- **`package.json` and `pnpm-lock.yaml`** (Tasks 3, 9): add `@solana/web3.js` next to Plan 2's `ethers` and `web3` in `devDependencies`, `peerDependencies` and `peerDependenciesMeta` (keys alphabetical); add `./solana` after `./evm` in `exports`. `typesVersions` keys are alphabetical (R81), so `solana` sits between `native` and `testing`: a merge hotspot when several families land, resolved by keeping the keys sorted. Regenerate the lockfile only with pnpm 10.5.2 (`pnpm add`), one plan at a time; if another family merged first, rebase and rerun `pnpm install` rather than hand-merging the lockfile.
- **`pnpm-workspace.yaml`** (Task 3): Plan 5 is the only plan that touches it (A13).
- **`src/index.ts`** (Tasks 1, 9): type exports after Plan 2's EVM exports; `solanaPlugin()` after `evmPlugin()` in `BUILTIN_PLUGINS`. Other families append theirs; order is registration order only (no cross-family dependency).
- **`typedoc.json`** (Task 9): append the Solana entry after Plan 2's EVM entry.
- **`test/architecture/registry-augmentation.test.ts`** (Task 9): the six edits are anchored on Plan 2's final file (`7bec7eb`): a path entry after `'crypto-aio/evm'`, `USE_SOLANA` checked with `USE_ACME` in both file orders, the `USE_MAIN` and `declarations` extensions, the `withoutSdks` path, the widened `hidden` regex, and one appended control test. Another family adds its own lines beside them; where two families extend the same regex or list, keep both.
- **`test/adapters/solana/lazy.test.ts` and the peer-pin test** (Task 9): Solana's own files, in Plan 2's final family shape (R79–R82); nothing shared.
- **Guides, `README.md`, `CHANGELOG.md`** (Task 12): anchored on Plan 2 Task 13's text; where another family already rewrote a sentence, add Solana to it (Task 12's note).
- **`src/testing/generation.ts`**: consumed, not changed (Plan 2 Task 11, A5, R71; validated against Plan 2's own file at `7bec7eb`).
- No other `src/core/**` or `src/testing/**` file changes.

## Appendix A: Verified data (lesson 12)

Every item below was checked against the named source while this plan was written (25 September 2026); the rows the pre-flight review added or corrected were checked again on 26 September 2026. `chains.ts`, `presets.ts`, `tokens.ts` and `programs.ts` contain nothing else, apart from the library policies of D8, D9, D10 and D16.

| Item | Value in the plan | Source |
| --- | --- | --- |
| Mainnet genesis hash | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | live `getGenesisHash` on `https://api.mainnet.solana.com` and `https://api.mainnet-beta.solana.com` |
| Devnet genesis hash | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` | live `getGenesisHash` on `https://api.devnet.solana.com` |
| Testnet genesis hash | `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY` | live `getGenesisHash` on `https://api.testnet.solana.com` |
| Public RPC (`public` preset, not for production) | `https://api.mainnet.solana.com`, `https://api.devnet.solana.com`, `https://api.testnet.solana.com` | https://solana.com/docs/references/clusters ("The public RPC endpoints are not intended for production applications") |
| Alchemy | `https://solana-mainnet.g.alchemy.com/v2/<key>`, `https://solana-devnet.g.alchemy.com/v2/<key>`; no testnet | https://www.alchemy.com/docs/reference/node-supported-chains |
| Infura | `https://solana-mainnet.infura.io/v3/<key>`, `https://solana-devnet.infura.io/v3/<key>` ("Testnet (Devnet)"); no testnet | https://docs.infura.io/get-started/endpoints/ |
| Ankr | `https://rpc.ankr.com/solana/<key>`, `https://rpc.ankr.com/solana_devnet/<key>`; no testnet path | https://www.ankr.com/docs/llms-full.txt |
| Ankr retention | about 16 hours of transaction history ("RPC nodes are configured with a ledger size of ~100M, which retains approximately the last 16 hours of transaction history") | https://www.ankr.com/docs/rpc-service/chains/chains-api/solana/ |
| Infura access | "Solana access is currently limited to select customers." | https://docs.infura.io/get-started/endpoints/ |
| Explorer templates | `https://explorer.solana.com/tx/{id}`, `/address/{address}`; `?cluster=devnet`, `?cluster=testnet` | Tether's USDT link (`explorer.solana.com/address/<mint>`, below); Solana Explorer transaction URLs with `?cluster=devnet` (solana.com search results); `explorer.solana.com/epoch/357?cluster=testnet` (github.com/solana-foundation/explorer issue #213) |
| USDC mints | mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | https://developers.circle.com/stablecoins/usdc-contract-addresses ("Solana", "Solana Devnet") |
| USDT mint | mainnet `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`; none listed for devnet or testnet | https://tether.to/en/supported-protocols/ ("Solana Token via Solana Blockchain") |
| Token decimals and program | 6 for all three; owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; mint size 82 | live `getAccountInfo` (`jsonParsed`) on mainnet and devnet |
| Program ids | System `11111111111111111111111111111111`, Token `Tokenkeg…Q5DA`, Token-2022 `TokenzQd…uEb`, Associated Token `ATokenGP…8knL`, Memo `MemoSq4g…mfcHr` (v1 `Memo1Uhk…FMNo`), ComputeBudget `ComputeBudget111…111`, Vote `Vote111…111` | live `getAccountInfo` on devnet: every one is `executable` |
| Instruction encodings | SetComputeUnitLimit `02 + u32`, SetComputeUnitPrice `03 + u64`, TransferChecked `0c + u64 amount + u8 decimals` with accounts `[source, mint, destination, authority]`, Memo = UTF-8 bytes | devnet transaction `4DETGWWsC9zQ83YrU5EyYJmAgaug1dDas7cLWBVRBnvxxfo8Knfm4osJbmN4fXnrHZLFJmrPn8XbpcnTWWQsixv` (`encoding: 'json'`) |
| CreateIdempotent | data `01`; accounts `[payer, ata, wallet, mint, system, token]`; the ATA is `findProgramAddress([wallet, token program, mint], ATA program)` | devnet transaction `3CaZnr7HSUpegrThdwDtravRezQxdJVAf2eMoDnHGKnYktD9G6hhh8oXVHtJ1DXspwCVbuwwC4HacEVSe7LV3QDY` (account `H5ri5hFMzV2WUoaR4WBPELgf9ZxRvHCAnxUro4TGn6C4`) |
| System transfer and ComputeBudget data | as `@solana/web3.js` 1.99.0 builds them | `codec.test.ts` compares both |
| Token account layout | 165 bytes: mint 0–31, owner 32–63, amount u64 at 64, state at 108 (1 initialized, 2 frozen); mint: decimals at 44, initialized at 45 | a live devnet token account and the devnet USDC mint (`programs.test.ts` fixtures) |
| SPL Token errors | `InsufficientFunds` 1, `MintMismatch` 3, `OwnerMismatch` 4, `AccountFrozen` 17 (0x11), `MintDecimalsMismatch` 18 (0x12) | https://github.com/solana-program/token/blob/main/interface/src/error.rs |
| Fees | 5,000 lamports per signature; priority fee `ceil(compute_unit_price × compute_unit_limit / 1,000,000)`, charged on the requested limit; max 1,400,000 CU per transaction; default 200,000 per instruction | https://solana.com/docs/core/fees; devnet transaction above: fee 10,001 = 2 × 5,000 + ceil(1 × 20,000 / 10^6) |
| Blockhash validity | `lastValidBlockHeight` = the blockhash's block height + 150; a transaction can still land in block `lastValidBlockHeight + 1` (I1), so the window is `L − 149 … L + 1` (151 blocks) | agave `v4.3.0` `accounts-db/src/blockhash_queue.rs` (`is_hash_index_valid`: `last_hash_index - hash_index <= max_age`), `runtime/src/bank.rs` (`register_tick` registers the bank's own blockhash only at the block boundary, after its transactions ran, so a block checks age against its parent; `get_blockhash_last_valid_block_height` = `block_height + max_processing_age − age`); https://solana.com/developers/guides/advanced/confirmation ("151 blockhashes … considered 'recent enough'"); live: `getLatestBlockhash` slot 504092289 had `lastValidBlockHeight` 491344822 and that block's `blockHeight` was 491344672 |
| Commitments for blockhash and preflight | `confirmed`, with `preflightCommitment` equal to it | https://solana.com/developers/guides/advanced/confirmation; devnet refused a `confirmed` blockhash under the default preflight ("Blockhash not found") |
| Transaction size limit | 1,232 bytes | https://solana.com/docs/core/transactions |
| Rent-exempt minimums (today) | 650,240 lamports for 0 bytes, 1,488,440 for 165, 1,066,800 for 82 (= (128 + bytes) × 5,080) | live `getMinimumBalanceForRentExemption` on devnet (0, 82, 165) and mainnet (0) |
| Error texts | `TransactionError` and `InstructionError` displays; sendTransaction's "Transaction simulation failed: {err}" | https://github.com/anza-xyz/solana-sdk (`transaction-error/src/lib.rs`, `instruction-error/src/lib.rs`), https://github.com/anza-xyz/agave (`rpc/src/rpc.rs`); live devnet answers for blockhash-not-found, signature failure and undeserializable bytes |
| JSON-RPC server codes | `-32001` cleaned up, `-32002` preflight failure, `-32003` signature verification (older agave; 4.3.0 reports it under `-32002`), `-32004` block not available, `-32005` node unhealthy, `-32007` slot skipped or missing after a ledger jump to a snapshot, `-32009` slot skipped or missing in long-term storage, `-32011` history not available, `-32014` status not yet available, `-32016` min context slot, `-32019` long-term storage unreachable, `-32020` transaction not found (an unknown `before` cursor) | https://github.com/anza-xyz/agave/blob/master/rpc-client-api/src/custom_error.rs; live devnet: `getSignaturesForAddress` with an unknown `before` → `-32020 "Transaction … not found"` |
| Long-term storage failures | `getBlocks` from a slot below the local ledger, when the BigTable read fails: `-32602 "BigTable query failed (maybe timeout due to too large range?)"`; a blockstore iterator error: `-32603`; `getBlock` on a BigTable error other than "block not found": `null` | agave `v4.3.0` `rpc/src/rpc.rs` (`get_blocks`: `start_slot < lowest_blockstore_slot` → `bigtable_ledger_storage.get_confirmed_blocks(…).map_err(… invalid_params("BigTable query failed …"))`, `rooted_slot_iterator(…).map_err(… internal_error())`; `check_bigtable_result` maps only `BlockNotFound` to `-32009`) |
| `minContextSlot` | `getBlocks` honours it (`-32016 "Minimum context slot has not been reached"`); `getTransaction` on agave 4.3.0 ignores it and returns the transaction | live devnet, 26 September 2026 (agave 4.3.0) |
| `skipPreflight` with a bad signature | returns the signature; the leader drops the bytes (M1) | agave `v4.3.0` `rpc/src/rpc.rs` `send_transaction` (signatures verified only without `skip_preflight`); pre-flight review, live devnet |
| RPC limits | `getBlocks` range 500,000 slots; `getSignaturesForAddress` limit 1,000 | https://github.com/anza-xyz/agave/blob/master/rpc-client-types/src/request.rs |
| History search needs transaction history | `searchTransactionHistory` / `getTransaction` → `-32011` without it | agave `rpc/src/rpc.rs` (`check_if_transaction_history_enabled`) |
| SDK version | `@solana/web3.js` 1.99.0 (latest 1.x, 2026-09-08); `rpc-websockets` 9.3.9 → `uuid@^14` (ESM-only); 9.3.10 deprecated | `npm view @solana/web3.js`, `npm view rpc-websockets` |
| Node versions on public clusters | Agave 4.3.0 on mainnet, devnet and testnet | live `getVersion` / `apiVersion` |

## Appendix B: Left out, because it could not be verified or is out of scope

- **Alchemy, Infura and Ankr for testnet.** None of the three documents a Solana testnet endpoint; the presets refuse it with `CONFIG_INVALID`. `public` serves testnet.
- **USDT on devnet and testnet, USDC on testnet.** Their issuers list none; such tokens still resolve by mint.
- **Per-cluster block times** (for `maxLagBlocks`): the cluster pages describe 200 ms slots only informally; the plan uses the blockhash lifetime (150 blocks) as a library policy instead (D8).
- **On-chain token symbols** (Metaplex metadata): not part of the SPL Token program; left to token registration (D12).
- **Durable nonces, Token-2022, `@solana/kit`:** out of scope (spec §20).

## Appendix C: How this plan was validated

- Every code block was written and run in a scratch copy of Plan 2's final tree (`git archive` of `feat/plan-2-evm` at `7bec7eb`, whose own suite is 1,012 tests), with `@solana/web3.js` 1.99.0 and the uuid override installed (`.superpowers/scratch/repo2`, git-ignored). The final state: `tsc --noEmit` clean, ESLint clean, `pnpm doc` 0 warnings, the whole suite 1,165 tests (1,164 passed, 1 integration skipped), `dist/index.d.ts` names no SDK and `dist/index.js` loads none.
- The tasks were replayed in order on a fresh copy of that baseline (`replay2.sh`): after each task the tree typechecked, linted and every test so far passed (new tests: Task 0: 4, 1: 12, 2: 26, 3: 5, 4: 12, 5: 12, 6: 16, 7: 12, 8: 27, 9: 11 plus the extended augmentation suite, 10: 15; Task 11: 1 skipped).
- Task 0's textual edit steps, applied to Plan 2's files and formatted with Prettier, reproduce the validated `json.ts`, `types.ts` and `http-transport.ts` byte for byte.
- The dependency step was replayed with pnpm 10.5.2 in a copy of `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml`: the lockfile records the override, `rpc-websockets@9.3.9` resolves `uuid@11.1.1`, and `pnpm install --frozen-lockfile` succeeds.
- The driver, codec and end-to-end suites passed 100 consecutive runs.
- Mutation checks (re-review R2, R1, R3, R4): restoring the old composition (index empty twice, finalized past `L`, the window's first block held) fails every one of Task 8's one-endpoint C1 tests (the lag, gap and hidden-index tests answer `{ included: false }`; the honest-window test sees no block reads); making `undecided` a no-op fails all nine lesson 18 tests in Tasks 6 and 8; restoring `false` for a sender-less token answer and dropping the no-balances rule fails the two Task 5 tests that pin them.
- The integration test passed live against mainnet, devnet and testnet (agave 4.3.0).
- `src/testing/generation.ts` is Plan 2's own file (Task 11, at `7bec7eb`); the crash tests never close a killed container and pin that a call on the dead handle never settles.
