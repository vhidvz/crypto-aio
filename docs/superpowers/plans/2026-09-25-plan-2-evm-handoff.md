# Plan 2 (EVM) handoff

What Plans 2.5–7 need from Plan 2's scratch workspaces: `.superpowers/sdd/2026-09-25-plan-2-evm/` (the controller ledger and reviews) and `.superpowers/plan-authoring/` (the cross-plan ledger and board). Both are git-ignored and are deleted after this commit. Read this with the spec, the Plan 1 handoff (`2026-09-23-plan-1-core-handoff.md`), the Plan 2 file (`2026-09-25-plan-2-evm.md`, author decisions D1–D18) and the code. "Rn" is a Plan 2 controller ruling, "An" a cross-plan ruling, "Xn" an execution note, "Nn" a residual.

## 1. Status

- **Delivered:** the EVM family (`src/adapters/evm/**`, entry `crypto-aio/evm`): ethereum, bsc, polygon, avalanche, arbitrum, optimism and base with their testnets; ethers 6.17.0 (default) and web3 4.16.0 as optional peers; native and ERC-20 transfers; `evm-1559`/`evm-legacy` fees and the OP Stack `l1-data` charge; nonce ordering; replace and cancel (not on Arbitrum); finality by the `finalized` tag or by confirmations (Avalanche); proofs; block scans; the `public`, `alchemy`, `infura` and `ankr` presets; USDT/USDC by alias; `evmChainPlugin`; `ext.evm.getNonce`.
- **Core changes** (all listed in `CHANGELOG.md` `[Unreleased]`):
  - `CallOptions.quorumKey` (`src/core/transport/types.ts`, D3): endpoints must agree only on the key's projection; the call resolves with the first endpoint's whole answer; a throwing key is a disagreement (retryable `PROVIDER_INCONSISTENT`).
  - The N6 metadata cache (`src/core/assets/service.ts`): only a non-retryable `ASSET_RESOLUTION` is cached per container (R53). Every other failure is looked up again.
  - The native close timeout: `close()` waits at most `NATIVE_CLOSE_TIMEOUT_MS` (5 s, container clock) per native client, then logs a warning (`src/core/container/container.ts`).
  - `DEPENDENCY_MISSING` (`src/core/registry/adapters.ts`, R80): only a quoted bare peer name matches; the error always carries `cause`; any other missing module is rethrown unchanged.
  - The proof contract with lesson 18 (`src/core/driver/types.ts`, the `ProofSource` JSDoc and the contract table, R86): only a definitive negative proof answers "no"; every other RPC error on a proof path is a retryable `PROVIDER_UNAVAILABLE`. `src/testing/fake-driver.ts` follows it (R91). `getNetworkStatus()` clamps `finalizedHeight` to `height` (R85).
  - `src/testing/generation.ts` (R71, A5): the restart generation fence, `fenceGeneration(parts, generation)`. Not exported publicly; `env.ts` imports it.
- **Branch** `feat/plan-2-evm`, HEAD `3099589`: 47 commits ahead of `main` (`1fc49b9`) before this handoff. 13 tasks, each reviewed on opus. The final whole-branch review found 1 Critical, 2 Important and 7 Minor issues; all were fixed (R88–R94), and the re-review said "ready to merge".
- **Checks at `3099589`:** frozen install, format, lint, typecheck, build and `pnpm doc` (0 warnings) are clean; 1073 tests pass and 4 are skipped (the opt-in EVM integration suite), in 63 suites. The EVM driver and e2e suites passed 30 consecutive runs after each fix; the Task 4, 5 and 11 suites passed 100 (R46).
- **Guides:** `docs/guides/` (index, quick-start, concepts, tutorial, transactions, networks, security). The EVM material is mostly in `networks.md` and `transactions.md`; their lengths over budget were accepted (R87).

## 2. Rulings R39–R94

Each line gives the decision, then the cost if it is wrong. "Binds" names later plans that must follow it.

- **R39.** Branch `feat/plan-2-evm`; TDD for pure logic; stage explicit paths; never stage `.claude/`, `.superpowers/` or `.env`; opus trailer; pnpm 10.5.2. Cost: none. **(binds 2.5–7)**
- **R40.** Scope is the whole spec §2 EVM family. Deferred: EVM address history (`history()` gives `UNSUPPORTED_CAPABILITY`), contract calls beyond ERC-20 `transfer`, funded write tests. Cost: EVM history waits for an indexer provider.
- **R41.** `EvmDriver` holds the logic over a narrow `EvmClient`; every I/O call carries the contract table's tags; SDKs do codec work and native clients only; probes `eth_chainId` and `eth_blockNumber`; plain data only. Cost: none. **(pattern for 3–6)**
- **R42.** Offline tests; one suite over both libraries; cross-checked vectors; a test-only scripted JSON-RPC node; opt-in read-only integration (`CRYPTO_AIO_INTEGRATION=1`). Cost: none. **(pattern for 3–6)**
- **R43.** Chain data verified against authoritative sources and cited (plan Appendix A); unverifiable data left out. Cost: fewer defaults. **(binds 3–6)**
- **R44.** web3.js is sunset (4.16.0 is its last release); implemented anyway, ethers is the default. Cost: a dead dependency to maintain.
- **R45.** All subagents on opus; work autonomously, ask only before push or merge. Cost: spend. **(binds 2.5–7)**
- **R46.** No driver request path waits on a real timer; the flake budget is zero; SDK-bridge suites pass 100 runs in a row. Cost: none. **(binds 3–6)**
- **R47.** `EthersClient.send` is a direct `transportCall`; ethers' provider serves only `createNative()`; a `setTimeout`-spy test pins it. Cost: ethers' request queue goes unused.
- **R48.** A bump raises each price strictly and to at least (100 + bump)%, a zero tip included (geth's rule); the scripted node enforces it. Cost: none.
- **R49.** Crash tests without the fence (D15). **Superseded by R71.**
- **R50.** A token `transfer` counts as executed only if the token logged `Transfer` from the sender; tightened by R89. Cost: a token that moves value silently is reported failed. **(binds 3–6)**
- **R51.** Pre-flight minors M4–M15 adopted; the Polygon 25 gwei minimum tip re-verified. Cost: none.
- **R52.** Plan-author scratch copies live outside the repo, because their `.js` probes broke `pnpm lint`. Cost: none. **(binds 2.5–7)**
- **R53.** The N6 cache keeps only a non-retryable `ASSET_RESOLUTION`; a provider fault never pins a token. Cost: a token's own failure under another code is re-queried. **(binds 3–6)**
- **R54.** A throwing `quorumKey` is a retryable `PROVIDER_INCONSISTENT`; a lagging endpoint's "no contract" may be cached. Cost: an unresolved marker until restart.
- **R55.** Export a public type in the task that first references it, so `pnpm doc` is green at every commit. Cost: none. **(binds 2.5–6)**
- **R56.** Every token address tested with EIP-55; an empty API key is `CONFIG_INVALID`; chain data deep-frozen. Cost: none. **(binds 3–6)**
- **R57.** Scripted-node fidelity: no nonce gaps, geth's exact bump threshold, reorg guards, out-of-gas. Cost: none. **(binds 3–6)**
- **R58.** One strict SDK-free public-key decode (33-byte compressed or 65-byte `0x04`, on curve) for both clients, else `INVALID_ADDRESS`. Cost: none. **(binds 3–6)**
- **R59.** The receipt quorum key covers the normalized logs a token verdict reads. Cost: a provider that formats logs differently fails proofs, retryably. **(binds 3–6)**
- **R60.** A recording-transport test pins the `quorumKey`, purpose and retry pass-through; small fixes. Cost: none.
- **R61.** A `tx.chainId` other than the client's is refused before any codec call (`INVALID_INTENT`); a malformed web3 answer is a retryable `PROVIDER_UNAVAILABLE`. Cost: none. **(binds 3–6)**
- **R62.** No action on web3 unwrapping an envelope-shaped success answer. Cost: the libraries report one hostile answer shape differently.
- **R63.** Node-policy and state-dependent texts (type not supported, intrinsic gas too low, replay-protected, oversized) are `refused`. Cost: a misconfigured network holds its nonce as refused. **(binds 3–6)**
- **R64.** `rejected` only on exact anchored permanent texts; everything else defaults to refused. Cost: an unlisted permanent text reads refused (safe). **(binds 3–6)**
- **R65.** Frozen results; empty fee history is a retryable `PROVIDER_UNAVAILABLE`; a bad `minBumpPercent` is `CONFIG_INVALID`. Cost: none.
- **R66.** Token metadata: a revert or VM failure is `ASSET_RESOLUTION`; any other `RPC_ERROR` is retryable; `PROVIDER_MISCONFIGURED` passes unchanged. Cost: a VM failure that later succeeds stays cached until restart. **(binds 3–6)**
- **R67.** Confirmation counts must be safe integers ≥ 1; confirmation finality needs a quorum-confirmed head. Cost: one extra quorum read per proof. **(binds 3–6)**
- **R68.** The phantom-success guard runs on verdict paths only; `getTransaction` and scans show the chain's view. Cost: our own false-returning transfer shows chain success there. **(binds 3–6)**
- **R69.** bor's `LogFeeTransfer` system log is exempt from D14's "no logs" test on Polygon (verified in bor's source). Cost: none.
- **R70.** bor's `LogTransfer` is also exempt for plain POL transfers (empty calldata, 21,000 gas), which decode `complete`. Cost: one ignored system log; no value missed.
- **R71.** The fence moves to `src/testing/generation.ts`, and crash tests use `restart({ killPrevious: true })`. Supersedes R49. Cost: one pure move. **(binds 3–6)**
- **R72.** Estimate-path VM failures are `INVALID_INTENT`; `isRevert` runs before "insufficient funds"; `assemble` checks bytes and digest. Cost: none.
- **R73.** The core `cancelBase` ranks earlier cancels by total charges, not by comparable price; left unchanged. Cost: a repeat cancel may need an explicit `fee`. **(open: Plan 7)**
- **R74.** Finality attested by a predicate quorum key, with one endpoint proposing F. **Superseded by R75.**
- **R75.** Anchored attestation: a fact is attested at its own height with a monotone predicate key, and no endpoint proposes a height; `finalizedHead` trails by `PEER_SKEW` = 2. Cost: `finalizedHead` trails 2 blocks. **(binds 3–6)**
- **R76.** `whenAbsent` composes two proof calls, and an endpoint-set change between them could prove `replaced`. Narrowed by R77 and R88. Cost: a narrow window. **(open: Plan 7)**
- **R77.** A receipt found but not yet final is a retryable `PROVIDER_UNAVAILABLE`, never `included: false`. Cost: none. **(binds 3–6)**
- **R78.** The scan superset includes contract creation (`to === null`); one hex helper; the `getLogs` gap recorded (fixed by R90). Cost: none.
- **R79.** `evmChainPlugin` is named `evm:<name>`, with `name` matching `/^[a-z][a-z0-9-]*$/`. Cost: none. **(binds 3–6: `<family>:<name>`)**
- **R80.** `DEPENDENCY_MISSING` rethrows an unmatched missing module and always carries `cause`. Cost: none. **(binds 3–6: require the bare peer name)**
- **R81.** `crypto-aio/evm` typings name both SDKs; the docs say `skipLibCheck: true`. Cost: one-SDK users with `skipLibCheck: false` fail typecheck; Plan 7 may split subpaths.
- **R82.** Per-manifest lazy tests, an SDK-free main-entry typing guard, and peers equal to `package.json`. Cost: none. **(binds 3–6)**
- **R83.** Task 11 e2e minors (finality thresholds, cancel self-transfer, crash identity, `mineWhile` throws). Cost: none.
- **R84.** The implementer's correction stands: R75 governs `includedFinal` (head ≥ h + N − 1, or the finalized tag at or after h). Cost: none.
- **R85.** State-unavailable proof answers are retryable; the finalized nonce is read at an attested numeric height, not the tag; public-preset limits documented. Cost: one extra attested read per `slotConsumed`. **(binds 3–6)**
- **R86.** One `undecided()` boundary in `proofs.ts` makes every `RPC_ERROR` on a proof path a retryable `PROVIDER_UNAVAILABLE`. Cost: liveness only. **(binds 3–6)**
- **R87.** Docs close the silent-token double-payment trap (a `TX_REVERTED` exception); the README does not name the release with EVM. Cost: none.
- **R88.** "Not included" only when the nonce's final consumer is another transaction: attest F, gallop and bisect to C with `count > n`, quorum-read block C; ours is included via block receipts; none decides nothing; 64 reads at most. Cost: old consumptions need historical state, else undecided. **(binds 3–6)**
- **R89.** A token verdict needs a `Transfer` from the sender to the recipient decoded from the signed calldata, of a positive amount; fee-on-transfer counts. Cost: none. **(binds 3–6)**
- **R90.** Scans read `eth_getBlockReceipts(blockHash)`; where the method is missing, a bloom-guarded `getLogs`; a missing receipt fails the scan retryably. Cost: none. **(binds 3–6: read by block)**
- **R91.** Final minors: fake-driver `undecided()`, hash-checked lookups, native broadcasts tagged `broadcast`/`ambiguous-on-failure`, metadata under the proof quorum, a lease-takeover e2e, `params.systemLogs: 'bor'`. Cost: none. **(binds 3–6: native broadcast tags)**
- **R92.** Recorded without code: R73 to Plan 7; a distinct "token did not log" reason or code to Plan 2.5 A9 and Plan 7; N5 to Plan 2.5 A14. Cost: none.
- **R93.** Lie tests pin block C's key fields; the receipts fallback also accepts `-32004` and "method not found/supported" texts; docs on state horizons and EIP-7702. Cost: none.
- **R94.** Block C's key and the by-hash key compare calldata as `input ?? data`. Cost: none.

## 3. Cross-plan rulings A1–A27 and lessons 1–18 (binding for Plans 2.5–6)

The board (`coordination.md`) and the authoring ledger (`ledger.md`) had the detail; this section replaces them. Each plan file already applies these; the executor checks them.

**Rulings**

- **A1.** Authors worked in worktrees under `/home/vahid/WorkSpace/crypto-aio-worktrees/`, on `plan/*` branches off Plan 2 `83b6468` (2.5 off `d6b0afd`), committing only the plan file.
- **A2.** The authoring briefs baked in Plan 2's review lessons. **A3.** Every plan gets an opus pre-flight review before execution (done for 2.5–6).
- **A4.** Shared files and any `src/core/**` or `src/testing/**` change need a proposal and a controller ruling. Isolation stays until Plan 2 merges.
- **A5.** Plan 2 moved the fence into `src/testing/generation.ts` (R71); Plans 3–6 consume it.
- **A6.** `submitSignatures(id, SignatureBundle[] | RawTx)` with an optional `TxBuilder.signaturesFrom?`; the orchestrator verifies each extracted signature; a mismatch is `INVALID_INTENT`. Plan 2.5 Task 4.
- **A7.** The UTXO scripted Esplora node is test-only, like D5.
- **A8.** `DriverIntent.outputs[i].variant?` (TON bounce), hashed only when present; Tron's variant is derived from `canonical`. Plan 2.5 Task 5.
- **A9.** A driver's failure `reason` is recorded on observations and proven failures; fixed literals, sensitive. Plan 2.5 Task 6.
- **A10.** When two changes touch one core file, the second to merge rebases; both are additive.
- **A11.** All accepted core changes form Plan 2.5, run after Plan 2 and before any family. Each family skips its "(lifted into Plan 2.5)" task after checking the API exists.
- **A12.** `CallOptions.exactIntegers` on `rpc`, `rpcRaw` and `http`: unsafe integers become `bigint`. Tron and Solana set it on amount-bearing reads. Plan 2.5 Task 1.
- **A13.** Plan 5 alone adds the `pnpm-workspace.yaml` override `rpc-websockets>uuid: ^11.1.1`, with a Node ≥ 22.12 note.
- **A14.** Height exclusion never shrinks a proof quorum below `min(proofQuorum, identity-verified endpoints)`; otherwise it decides nothing. Plan 2.5 Task 3.
- **A15.** The engine refuses an Attempt whose ref another Operation in the namespace holds (`NONCE_CONFLICT`). Tron's and Solana's random build variants stay as defence in depth. Plan 2.5 Task 7.
- **A16.** TON's native coin is "Gram (GRAM)", with the alias `TON`; Plan 7 says "Gram (formerly Toncoin)".
- **A17.** Health probes take tokens from their endpoint's rate-limit bucket. Plan 2.5 Task 2.
- **A18.** A different plugin under a registered name is `CONFIG_INVALID`; the same plugin again is a no-op. Plan 2.5 Task 8.
- **A19.** `wallet.utxo.changeAddress` must be derivable from the wallet, else `CONFIG_INVALID` naming no address; opt-out `allowExternalChangeAddress: true`.
- **A20.** `deriveXpubChild` refuses an extended key whose network class differs from `network.testnet`, on UTXO chains. Plan 2.5 Task 9.
- **A21.** `BuildContext.schemes` is deferred to Plan 7; a scheme mismatch fails at signing, before any broadcast.
- **A22.** Drivers get `WalletOptions.hd: { xpub, xpubPath?, xpubVersions? }`. Plan 2.5 Task 10.
- **A23.** TON: a W5 `internal_signed` request counts only with a successful compute phase and a signature that verifies against the wallet key; the seqno floor applies only to an indexed transaction newer than the live read.
- **A24.** A14 sizes the quorum on identity-verified endpoints, counting unknown heights, until 3 health refreshes in a row fail.
- **A25.** "Same plugin" compares data structurally and functions by identity; every family hoists its manifest `load` functions (X6).
- **A26.** `wallet.hd.xpub` must be a public key; a private version is `CONFIG_INVALID` and is never echoed.
- **A27.** The A15 guard assumes `findByRef` is read-your-writes consistent across processes; documented, not a contract change.

**The family shape (from Plan 2 Task 10)**

- Entry `src/adapters/<family>/index.ts` (`@module crypto-aio/<family>`): SDK types by `import type` only; the `NativeClientMap` augmentation targets `'../../index'`; exports `<FAMILY>_PEER_DEPENDENCIES` (keyed by library), `<family>ChainPlugin` if any, `<FAMILY>_CAPABILITIES` and the SDK-free types. `ChainRegistry`/`FamilyRegistry` augmentations live in the SDK-free `types.ts`.
- `src/index.ts`: append `<family>Plugin()` to `BUILTIN_PLUGINS`; type-only exports go under "Chain families: SDK-free types"; `dist/index.d.ts` names no SDK.
- The core builds `DEPENDENCY_MISSING`; clients `require()` the bare peer name, never a subpath.
- `<family>DriverFactory(makeClient)` lives in `driver.ts`, and each client module exports `<library>DriverFactory`. A one-library family may keep its factory in `driver.ts` if `plugin.ts` never imports it statically. `setProbes` runs once on `transport` and `indexer` (a counting-Proxy test). `createNativeClient` returns a fresh client. Drivers never read `network.maxLagBlocks`.
- Tests: `lazy.test.ts` per manifest in its own module registry; peers equal `package.json`; the SDK-free main-entry typing guard extended; registry augmentation in both file orders via `native(bc, '<library>')`.
- The fence: `fenceGeneration({ clock, fetch, stores, signers }, { alive: true })` per generation; a kill sets `alive = false` and builds a new container over the same raw parts; never `close()` the killed one; assert on the raw stores; pin the kill (an old-handle call never settles).
- Phantom success, final wording: for a positive token amount, the verdict needs a recorded transfer from the sender to the intended recipient (decoded from the signed payload) of a positive amount, never the exact amount.

**Lessons 1–18**

1. Deterministic I/O: no real timer on request paths; direct transport calls with the table's tags; SDKs for codec and native clients; SDK-bridge tests run 100 times.
2. A proof's quorum key covers every field the verdict reads and ignores formatting-only fields; a throwing key is a disagreement.
3. `rejected` only on exact anchored permanent texts; state, fork, policy and unknown texts are `refused`; reasons are fixed literals; ambiguous errors are rethrown unclassified.
4. Strict decoding of keys, addresses and transactions; both code paths reject the same inputs.
5. Refuse a mismatched embedded network or chain identity before any codec or signing call.
6. Only a token's own permanent problem is `ASSET_RESOLUTION`; provider faults stay retryable or pass unchanged; a malformed answer is a retryable `PROVIDER_UNAVAILABLE`.
7. No phantom success: a token transfer is executed only with on-chain evidence that value moved (final wording above).
8. Test doubles model the real node's rules exactly and deterministically, and stay test-only; a lagging endpoint keeps transactions above its view in its mempool.
9. Crash tests use `restart({ killPrevious: true })`.
10. Deep-freeze data; keyed URLs are `Secret`s; an empty key or a bad numeric config is `CONFIG_INVALID`; `pnpm doc` green at every commit; augment the entry module.
11. Frozen vectors are cross-checked against an independent implementation.
12. Verified data is cited; unverifiable data is left out; SDKs pinned exactly, peers with `^`.
13. A revert, VM failure or missing contract is `ASSET_RESOLUTION`; other RPC errors are retryable; `PROVIDER_MISCONFIGURED` passes unchanged.
14. Confirmation finality never trusts one endpoint's head under `PROOF`; counts are validated ≥ 1.
15. The phantom guard runs on verdict paths only; `observe` without an ordering returns the chain's view.
16. A lookup never answers `included: false` while it cannot know; found-but-not-final decides nothing. Sharpened by R88: a `null` after pruning is not absence, so prove "not included" by finding the slot's final consumer.
17. Attest a fact at its own height with a monotone predicate key; no endpoint proposes a height; only an unanchored head trails by a peer skew, then is attested; never compare data read at a moving tag; client tags carry a caller `quorumKey`.
18. On a proof path only a definitive negative answers "no"; every other RPC error, and any decoding contradiction, is a retryable `PROVIDER_UNAVAILABLE`; prefer attested numeric heights over finality tags.

**Other cross-plan notes**

- Broadcaster stub tests: an ambiguous `RPC_ERROR`, a non-RPC `ProviderError` and a foreign `Error` are each rethrown as the same object.
- `assemble` reads only named fee fields, because the core adds `fee.details.requestedFee` after `build`.
- A pre-signing shortfall is `ChainError('INSUFFICIENT_FUNDS')` with `details: { required, available }` as decimal strings.
- Scans read by block, never through a separate log index; a missing per-transaction result fails retryably.
- Never assume an order between two separate reads. Node's `fetch` needs `NODE_USE_ENV_PROXY=1` behind a proxy.

## 4. Execution order and branch map

1. Plan 2 merges into `main` (the owner decides; agents never push).
2. Plan 2.5 runs on a branch from post-Plan-2 `main`, and merges. Run the full suite before Task 1, and the EVM driver and e2e suites after Task 3.
3. Plans 3–6 each rebase their plan branch onto post-2.5 `main`, then execute, two or three at a time. Shared files (`package.json`, `pnpm-lock.yaml`, `src/index.ts`, `typedoc.json`, `docs/guides/*`, `README.md`, `CHANGELOG.md`, `test/architecture/*`) merge one plan at a time. Regenerate the lockfile with pnpm 10.5.2 only.

| Branch          | Final commit | Forked from | Plan file (`docs/superpowers/plans/`) | Tasks     |
| --------------- | ------------ | ----------- | ------------------------------------- | --------- |
| `plan/2.5-core` | `c8bb281`    | `d6b0afd`   | `2026-09-26-plan-2.5-core.md`         | 10        |
| `plan/3-utxo`   | `c49bed0`    | `83b6468`   | `2026-09-25-plan-3-utxo.md`           | 13        |
| `plan/4-tron`   | `3c7bfaa`    | `83b6468`   | `2026-09-25-plan-4-tron.md`           | 13 (0–12) |
| `plan/5-solana` | `823e782`    | `83b6468`   | `2026-09-25-plan-5-solana.md`         | 13 (0–12) |
| `plan/6-ton`    | `fba889e`    | `83b6468`   | `2026-09-25-plan-6-ton.md`            | 15        |

- Each branch holds Plan 2 commits up to its fork point, plus commits that touch only its plan file. `git rebase --onto main <fork> <branch>` brings only the plan-file commits onto `main` (Plan 2.5 included), even if Plan 2 is squash-merged.
- The worktrees are `plan-2.5-core`, `plan-3-utxo`, `plan-4-tron`, `plan-5-solana` and `plan-6-ton`. `plan-2-fix-r86` (`fix/r86-proofs`, `ef6e92b`) is obsolete: its commits are on `feat/plan-2-evm` as `7736cb6` and `a4a9399`.
- The lifted tasks are skipped: Plan 3 Task 1, Plan 4 Task 0, Plan 5 Task 0 and Plan 6 Task 1.
- Every plan was validated on an older Plan 2 (2.5 on `1270832`); Plan 2 later changed `src/adapters/evm/**`, its tests and `transactions.md`. Anchor edits on the same text.
- A14/A24 change proof tests: a lagging proof endpoint must stay within `maxLagBlocks`, or the test adds a second endpoint at the head. A proof with a failing height probe decides nothing until 3 refreshes fail.

**Execution notes X2–X6**

- **X2 (Plan 6).** toncenter's keyless v2 and v3 endpoints share one per-IP limit of 1 request per second; budget them together (`rateLimit: { rps: 0.5 }` each), or keep the integration pauses as required.
- **X3 (Plan 3).** Task 13's signed-PSBT paragraph duplicates Plan 2.5's; keep only the Bitcoin sentence and example, after Plan 2.5's paragraph.
- **X4 (Plan 3).** Task 8 Step 4b passes `{ testnet }` to `deriveXpubChild` (`deriveXpubChild(hd.xpub, path, hd.xpubVersions, { testnet })`), so A20 applies; the three-argument call compiles and skips it.
- **X5 (Plans 6 and 7).** Plan 2.5 writes its own changelog lines; Plan 6 Task 15 Step 5's A8/A9 lines and Plan 7 must not add them again.
- **X6 (every family).** Hoist each manifest `load` function to module level, and test re-registering the family's own plugin.

**Small items to fold in at execution**

- **Plan 2.5, N1.** A caller-aborted identity check counts toward the 3-miss limit; it should not.
- **Plan 3.** Pass `{ testnet }` to `deriveXpubChild` (X4); the field is `wallet.hd`.
- **Plan 5.** Clamp the height search start to the endpoint's first available block (liveness).

## 5. Residuals, and Plan 7 items

**Open residuals** (liveness or precision unless noted)

- **R73.** `cancelBase` ranks by total charges. Fix: a `ReplacementPolicy` price comparator. Plan 3 needs none (equal-size cancels).
- **R76 (narrowed).** After R88, only an endpoint-set change between `slotConsumed` and `includedFinal` remains, and it can only decide nothing on EVM. Plans 3, 4 and 6 close it for their families.
- **N4.** An undecided Attempt repeats the R88 nonce search on every monitor pass; cache the consumption height and consumer per `(from, nonce)`.
- **N5.** Under a quorum the transport throws the first endpoint's definitive error before comparing, so one endpoint's revert marks a token unresolvable until restart (denial of service on one token; never a mis-scaled amount).
- **EIP-7702.** An authorization that consumes our nonce leaves R88 undecided forever (safe direction). Recognise type-4 authorization lists; `@noble/curves` can recover the authority.
- **A distinct code for "token did not log".** EVM `observe` sets `reason: 'token transfer failed'`. Once A9 lands, `includedFinal` can return it too; Plan 2.5's text does not do this. Plan 7 decides whether it deserves its own code instead of `TX_REVERTED`, for every family. Until then the R87 docs close the trap.
- **A21** `BuildContext.schemes`.
- **Plan 1 handoff N1–N4, N7 and N8**, unchanged. N6 is done. N5's safety half is Plan 2.5 A14; its two liveness halves (a liar among the first endpoints stalls verdicts; one absurd height stales every monitor view) stay for Plan 7.
- Also noted: split `crypto-aio/evm` typings per library (R81); the OP Stack operator fee is unverified and not in the fee report. **Safety, dormant:** if Tron USDT is deprecated to its `upgradedAddress`, its `Transfer` logs come from the new contract, and every emitter check (EVM's included) reports `failed` for transfers that moved (Plan 4, Unresolved assumptions).

**CHANGELOG**

- `[Unreleased]` holds the EVM "Added" lines and the core "Changed" lines, above `[0.1.0] - Unreleased`, whose body still says "Only the fake chain family ships in this release." Plan 7 decides which release contains EVM and reconciles the two; the README and quick start say "on main; next release" (R87).
- `[Unreleased]` compares `v0.0.2...HEAD`, like `[0.1.0]`. Move it to `v0.1.0...HEAD` once `v0.1.0` exists.
- Plans 2.5–6 append their own lines under `[Unreleased]`; nobody duplicates them (X5). The Plan 1 handoff §5 list (API breaks, the version reconciliation, migration notes) still applies.

**Stale files:** the 0.0.x GitHub Pages site in `docs/` (`index.html`, `modules.html`, `hierarchy.html`, `.nojekyll`, `assets/`, `classes/`, `functions/`, `interfaces/`, `types/`) and the stale coverage output, as in Plan 1 handoff §5.

**Owner actions (never done by agents):** rotate the compromised `.env` credentials and move any funds they hold; decide whether to rewrite git history (agents never force-push); approve the Plan 2 merge.

## 6. Process notes

- Run every subagent on opus (R21, R45). Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Run at most about 4 agents at once. Session and weekly limits stopped every running agent several times (first on 2026-09-25 about 21:40); resume them staggered.
- Use targeted edits, never whole-file rewrites (the 64k output cap); build large files in pieces.
- `cp`, `mv` and `rm` are aliased to interactive forms and hang an agent (a stuck `cp -i` in Task 5). Restore files, including after mutation checks, with `git checkout -- <path>`; use `\cp -f` when a copy is needed.
- Validate every plan block in scratch before execution, in an ignored directory outside lint's reach (R52).
- Pre-flight review every plan on opus, and apply the findings before execution (A3).
- When a fix must land while another agent edits the same branch, make it in a separate worktree off that branch, then cherry-pick it after the other agent commits (the R86 pattern).
- Before each commit: `pnpm format && pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm doc` when docs or exports change. Run SDK-bridge suites 100 times and driver/e2e suites 30 times after a proof change.
- Markdown: `pnpm exec prettier --check <file>`; the guides are edited by hand (D16).
- Implementers end each report with "Cross-plan notes"; the controller relays them.
- Stage explicit paths only; never commit `.claude/`, `.superpowers/`, `.env` or `dist/`; never push; never touch `main` without the owner.
