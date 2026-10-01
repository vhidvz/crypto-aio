# The 0.1.0 Release (Plan 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `main` releasable as `crypto-aio@0.1.0`: close the release blockers (secret fragments echoed by providers, caller-typed names echoed in errors, the deposit-crediting promise no family keeps, release texts that are false today), rule on and fix the fund-critical items (EVM lesson 21, an EVM fee ceiling, whole orderings in the store contract), take the cheap core hygiene that closes a secret, fund or single-endpoint denial-of-service gap, and finish the release mechanics of spec §16–§19. Tagging, pushing, publishing and every §19 owner action stay with the owner.

**Architecture:** Thirteen tasks in the order the scope ruling A29 sets: the release-blocking and fund-critical code first (Tasks 1–5: the transport's secret scrub, one bounded-name helper, the EVM broadcaster and fee policy, the store contract), then the core hygiene (Tasks 6–8: the transport's byte cap, rate-limited probes and a decaying height watermark, workers that stop on `close()`), then docs and release mechanics (Tasks 9–13), so that the docs describe the final code. Each code task rewrites the guide sentences its change makes false in its own commit, and lists the `CHANGELOG.md` lines it needs in a "Changelog block"; Task 12 collects those blocks into the owner-approved `[0.1.0]` section. No new runtime dependency; one dev dependency (`make-coverage-badge`) goes.

**Tech Stack:** TypeScript 5.9.3 (CommonJS, `module`/`moduleResolution: node16`); Node.js ≥ 22 (Solana ≥ 22.12); Jest 30 + ts-jest 29.4.12; pnpm 10.5.2; `@noble/curves` 1.9, `@noble/hashes` 1.8, `@scure/*` (already dependencies); ethers 6.17.0 in tests only, as an independent encoder. GitHub Actions for CI.

**Spec:** `docs/superpowers/specs/2026-09-23-blockchain-adapter-layer-design.md`

**Also read:** the six handoffs in `docs/superpowers/plans/` (Plan 1 §4–§5, Plans 2, 2.5, 3, 4 and 5 §5, Plan 6 §3 and §5, and every §6), the cross-plan rulings A1–A29 and lessons 1–21 (the Plan 2 handoff §3 restates A1–A27 and lessons 1–18; the Plan 3–6 handoffs restate A28 and lessons 19–21), the `ChainDriver` contract table in `src/core/driver/types.ts`, and the store contract suites in `src/testing/contracts/`.

**Plan series:** Plans 1, 2, 2.5, 3, 4, 5 and 6 are merged into local `main`. **Plan 7 (this document) is the last plan: the 0.1.0 release.** It runs on `plan/7-release` in `/home/vahid/WorkSpace/crypto-aio-worktrees/plan-7-release`, one subagent at a time and every subagent on opus (R21, the user's 2026-09-29 instruction), and merges into `main` locally after a clean final review. It is one branch off `main`, so it has no merge notes.

**Where this runs:** on `plan/7-release`, forked from `main` at `db73e90` (the Plan 6 handoff), where `pnpm test` gives 2,735 passed and 15 skipped in 134 suites (129 run, 5 skipped). Every code block in this plan was applied, in task order, to a detached copy of that tree and validated there (on Node 22.22.2 and pnpm 10.5.2): after each task the full suite, `prettier --check`, ESLint, `tsc --noEmit` and TypeDoc were green; each new test failed on the unchanged code first (red) where the task fixes a defect, and each mutation named in a task's review points was killed; the transport suites passed 30 runs in a row after Task 7, the EVM e2e and builder suites 30 after Task 3; the packed-tarball check of Task 11 passed against the npm registry; the coverage gate of Task 11 passed; after Task 13 the whole suite passed under `--detectOpenHandles` with no open handle; and gitleaks 8.30.1, CI's secret scan, found no leak in the final tree with this plan in it. The validated totals per task are in each task's last step and in Appendix A. If `main` moved after `db73e90`, anchor each edit on the same text; the replaced text is quoted in full.

## Global Constraints

- Runtime: "Node.js ≥ 22, backend only" (`engines.node >= 22`, unchanged). Toolchain pinned: "TypeScript 5.9", "Jest 30 + ts-jest", "ESLint 9 flat config". pnpm 10.5.2 only (`packageManager`); regenerate the lockfile with it and never hand-merge it.
- "The core (`src/core/**`) imports no blockchain SDK; SDKs are optional peer dependencies loaded lazily." `src/core/**` never imports `src/adapters/**` or `src/testing/**`.
- "Hard `dependencies`: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `debug`" (plus `@scure/bip39`). No new runtime dependency and no new dev dependency. The one dev dependency removed is `make-coverage-badge` (Task 11).
- "`bigint` always means base units." Amounts are never rounded.
- "`Secret<T>` … Provider URLs and headers containing secrets are redacted in errors, config snapshots and events" (spec §14); "Events carry only `operational`-class data" (spec §14). Over-scrubbing is the safe direction.
- Store records hold plain data only (R11). Refusal and failure reasons are short fixed texts with no addresses, amounts or node text (R24).
- No new error code and no new capability name. Every refusal reuses an existing code.
- Lesson 21: a node's `rejected` is a claim; it stands only when its reason holds for our own bytes, checked locally; otherwise the answer is `refused`.
- Deterministic I/O (lesson 1): tests run on `FakeClock` and `FakeFetch`; no real timer, `Math.random` or `Date.now` on a path a test drives. The one networked check is Task 11's packed-tarball script, which runs outside Jest.
- The store contract suites are the compatibility boundary for durable stores: Task 5 adds one assertion on purpose, and nothing else in `src/testing/contracts/` changes.
- `pnpm doc` stays green at **every** commit; a public export lands in the task that first references it (R55).
- The owner's text is theirs: `CHANGELOG.md`'s `[0.1.0]` section changes only with the owner's approval (Task 12), and the README keeps the owner's title and tagline (`# Crypto-AIO`, "All-In-One Crypto-Currency", commit `eeb992a`). Never revert or restage an owner edit.
- Agents never tag, push, create a GitHub release or run `npm publish`, and never force-push. The owner's release checklist is in Task 13.
- Process: TDD (red, green, commit); stage explicit paths only; never stage `.claude/`, `.superpowers/`, `.env` or `dist/`; never push. **Before every commit run `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`**, plus the Markdown check below for each Markdown file touched. Prettier may reflow code copied from this plan; that is expected.
- **The Markdown check (D16).** The guides are edited by hand and are not Prettier-formatted: on `main`, `prettier --check` already warns on six of the seven guides, because their tables are compact and Prettier pads them. So never run `prettier --write` on a guide. Instead, count the lines Prettier (prose only) would change, and expect the number the task's step names: a prose edit adds nothing, a new compact table row adds one.

  ```sh
  mdcheck() { for f in "$@"; do echo "$f $(pnpm exec prettier --embedded-language-formatting=off "$f" | diff "$f" - | grep -c '^<')"; done; }
  ```

  On `db73e90`: `concepts.md` 23, `index.md` 18, `networks.md` 60, `quick-start.md` 0, `security.md` 15, `transactions.md` 35, `tutorial.md` 12, `README.md` 0, `CHANGELOG.md` 0. `README.md` and `CHANGELOG.md` stay at 0.
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `cp`, `mv` and `rm` are aliased to interactive forms here and hang an agent: use `git rm`, `git mv`, or `\cp -f`, `\mv -f` and `\rm -f`. A mutation check never restores a file with `git checkout` on a dirty tree (Plan 4 handoff §6): commit first and mutate on top, or restore from a byte copy checked with `cmp`.

## Review Focus

These five inputs are the most likely to bite a real user of 0.1.0, and no spec example exercises them. Each has a pinned test in the task named.

1. **A provider that echoes the bare API key back**, from a path segment (`/v2/<key>`), a query value (`?api_key=`), a header value or the token after `Bearer `, in a JSON-RPC error message or its `data`, a REST error body or a network failure's cause, in any letter case or percent-encoded: no error message, `details` field, `cause`, event or `status()` may carry it, for every family's keyed presets and a custom URL. Pinned in Task 1 (`test/architecture/secret-echo.test.ts`, "a key echoed by the provider never reaches an error, a cause or an event", one case per keyed preset).
2. **A lone EVM endpoint that answers "invalid sender" to our valid bytes and relays them later**: the transfer must stay alive (`TX_REFUSED`, `stalled`), end `final`, and pay the recipient once, never `TX_REJECTED` with its nonce freed for a second payment. Pinned in Task 3 ("never ends a transfer that a lone endpoint calls invalid, then relays (lesson 21)").
3. **An EVM endpoint suggesting a 100,000 gwei tip, or a caller's fee above the ceiling**: nothing is ever signed above `maxFeePerGas`; a suggestion is clamped, an explicit fee is refused before any fee request or signing, and a replacement or cancel above the ceiling is refused while the original lands. Pinned in Task 4 ("never signs above the ceiling however an endpoint prices the fee").
4. **A durable store that drops or retypes one ordering property** (Tron's `refBlockHash`, a Solana `blockhashSlot` read back as a number, a TON `validFrom` moved later): the store contract suite must fail it, since each can prove a transaction absent while a block holds it. Pinned in Task 5 ("fails a store that keeps %s").
5. **A keyless endpoint answering a health probe with HTTP 429**, and **one probe that saw a forged far-future head**: the endpoint keeps its last good height and serves reads, a rate-limited endpoint never leaves the proof count, and three refreshes without the forged height end the stale views. Pinned in Task 7 ("keeps the last good height through a height-probe 429, so reads go on", "keeps a rate-limited endpoint in the proof count, so the other never proves alone" and "drops a forged far-future head after three refreshes without it").

---

## Decisions recorded by the plan author

Scope ruling A29, rulings A1–A28 and lessons 1–21 bind this plan. Where they and the spec were silent, these decisions were made; each names what it costs if wrong.

- **D1. The secret scrub (F3-R20, release blocker).** The transport derives, once per endpoint, every secret fragment of its configuration (`src/core/secret/fragments.ts`): the URL as given and as parsed (shown as the placeholder `<endpoint id>`), its path with its query, each userinfo part, each path segment, each query value and the URL fragment, raw and percent-decoded; each header value whole; the token after an auth scheme (`Bearer <token>`), and for `Basic` the decoded `user:password` and the password. One case-insensitive regular expression, longest fragment first, replaces them all in every text the transport copies from a provider or a failure: the JSON-RPC error message (`message`, `details.rpcMessage`), its `data` (`details.rpcData`), a REST error body (`details.body`), a network failure's message and `cause`, and the answer an identity probe reports in `provider.misconfigured`. Every one of them reads only a bounded prefix (lesson 20): the text's limit plus the longest fragment, so a secret cut by the limit is still removed whole.
  - **The minimum fragment length is 8 characters** (`MIN_FRAGMENT_LENGTH`). Every built-in keyed preset's key has at least 32 characters (Alchemy, Infura, Ankr, TronGrid, toncenter), while the ordinary words of endpoint URLs are shorter than 8 (`v2`, `v3`, `api`, `rpc`, `eth`, `bsc`, `solana`, `jsonRPC`, `mainnet`) and also occur in node texts the drivers classify: `eth` is inside "method not found", which EVM's receipts fallback reads (R93), and `jsonrpc` is in every JSON-RPC body. Scrubbing them would change a verdict's input. A shorter secret is still removed wherever the whole URL, the whole header value (4 characters or more, as before) or the whole `Scheme token` appears. Cost: a non-secret word of 8 or more characters in an endpoint URL (such as Ankr's `avalanche` path, or `testnet4`) is also `[REDACTED]` in that endpoint's error texts; a secret of fewer than 8 characters that a provider echoes alone survives (none of the documented presets has one).
  - **Out of scope, documented:** an SDK's own errors from a `native()` client, which may quote a provider's answer (the SDK received it; the security guide says so), and a secret put somewhere other than the URL or headers.
- **D2. REST error texts name the route template, never the concrete path (the F3-R20 privacy question).** Recommendation taken: `${method} ${route}` when the driver gives a `route` (every family's REST client does, R14), else the bare method, exactly as events already do. Cost: an operator no longer sees which address or txid a failed REST call named in the message itself; the error keeps `context.endpointId`, and the Operation keeps its `operationId`. Addresses and txids are `sensitive` data (spec §12), and error texts end up in logs and alerting systems, so the concrete path should not. One guide sentence (security.md, the Errors row) changes with it.
- **D3. One bounded-name helper (F3-R16, F6-R24).** `src/core/util/names.ts` gives `unknownName(what, accepted)`: `unknown <what>; the accepted names are 'a', 'b' and 'c'` (sorted, at most 12 listed, the rest counted; `the only accepted name is 'a'`; `none is configured`), and `knownName(value, known, unshown)`, which quotes a value only when it is one of a fixed list (a core capability name). Every error that echoed a caller-typed name now uses it: the chain, network, library, provider, provider preset, wallet, signer, signature scheme and asset alias in the core; the option keys of every family (UTXO and its `wallet.utxo`, Tron, Solana, TON, and the new EVM option); the capability names of Tron and TON. Three more echoes lose their echo without a list, since their accepted set is unbounded or is the handle's: a malformed asset id, an invalid namespace, and the library name passed to `native()` (the author found this one beyond the brief's list). The accepted names are the library's own or the caller's own configuration keys. `ChainCatalog.network`, `deriveAddress` and `signerFor` switch to own-key lookups (`Object.hasOwn`, the F3-R2 item) in the same edit. Ids the library itself issued (an operation id passed back to `get`) are echoed as before. Cost: about 20 test assertions change their expected text (listed in Task 2), and a caller can no longer see which name they mistyped, only which names exist.
- **D4. Lesson 21 for EVM (Tier 2a).** The broadcaster classifies a node's rejection against the bytes it sent, read SDK-free by `src/adapters/evm/rawtx.ts` (strict RLP over legacy, EIP-2930 and EIP-1559 envelopes). The reader is never stricter than geth: it calls bytes `malformed` only for what geth's decoder also refuses (a broken or non-canonical encoding, trailing bytes, an integer with a leading zero byte or over its width, the wrong number of fields, a `to` that is not 0 or 20 bytes), reads no access list, and returns `undefined` for EIP-4844 and EIP-7702 envelopes and anything over 256 KiB (lesson 20), for which no claim holds. The four rejections and their checks: "wrong chain id" holds when the bytes carry a chain id other than the network's; "invalid signature" when geth's `ValidateSignatureValues` fails (r or s out of range, s above n/2, a recovery id not 0 or 1); "malformed transaction" when the reader says so; "priority fee above the fee cap" when an EIP-1559 transaction's tip exceeds its cap. Anything else is `refused` with the fixed reason "the node claimed the transaction is invalid". Our builder never produces such bytes and the core verifies every signature, so for our own Operations a node's rejection now always stays a refusal. Cost: a genuine rejection of a bare `broadcast` of foreign bytes whose fault the reader cannot see (an unrecoverable in-range signature) reads `refused`, the safe direction.
- **D5. The second-endpoint core option and the fanout's first HTTP 200 answer go to the backlog (moved out of Tier 2 against the brief's default).** F3-R11 (c) proposed that the engine require a second endpoint before a first-broadcast `rejected`, and (b) a must-conflict set. With this plan every family re-verifies a rejection against its own bytes (UTXO F3-R11, Tron F4-R20, Solana F5-R15, TON F6-R9, EVM D4), so a lying endpoint can no longer end an Operation, and a second endpoint would add only a second send per genuine rejection plus a `Broadcaster` port change (the port hides which endpoint answered). F4-R8 (3), the broadcast fanout returning the first HTTP 200 answer, matters only to Tron (java-tron answers refusals with HTTP 200): after lesson 21 a liar's 200 refusal can only show a transient `TX_REFUSED` for a transfer an honest endpoint accepted, which the monitor then observes on chain. Both are liveness or defence in depth; both are Appendix B Tier 5 rows. Cost if wrong: a bug in one family's local check could end an Operation on one endpoint's word.
- **D6. The EVM fee ceiling and the cross-family operator bound (Tier 2b).** EVM gets the option `maxFeePerGas` (a bigint of wei per gas, 1 to 2^256 − 1; the handle's `options`, else the network's `params.maxFeePerGas`, else `DEFAULT_MAX_FEE_PER_GAS` = 1,000 gwei; the F4-R28 shape). Node suggestions are clamped to it (the fee cap or legacy gas price at most the ceiling, the tip at most the fee cap), an explicit fee above it is refused with `INVALID_INTENT` before any fee request (`details.required`, `details.maxFeePerGas`), and `build` and `buildCancel` check it again, whatever produced the fee object; a replacement's price always comes through the same clamp or refusal. 1,000 gwei bounds a plain transfer at 0.021 and a 65,000-gas ERC-20 transfer at 0.065 of the native coin, however an endpoint prices the fee; a network whose base fee rises above the ceiling (a Polygon spike) stalls its transfers as `FEE_TOO_LOW` until it falls or the option is raised, which the guide says. The EVM driver now reads and validates its options, so an unknown option key is `CONFIG_INVALID` (F6-R25), where it was silently ignored. The gas limit is not bounded: an inflated `eth_estimateGas` only raises the reserved maximum (the funds check then refuses before signing if the wallet cannot cover it), and burns more only when the transfer's execution fails outright (Appendix B). **The cross-family policy**, written into `transactions.md`: every family bounds what a node suggests by an operator setting no endpoint can raise (UTXO `maxFeeRate`, `maxFee`, `maxEstimatedFeeRate`; Tron `maxFeeLimit`; Solana `maxComputeUnitPrice`; TON `maxNetworkFee`; EVM `maxFeePerGas`); a suggestion is clamped or refused, an explicit fee above the bound is refused before any request, and the build checks it again. Cost: an EVM user whose handle passed stray `options` gets `CONFIG_INVALID` at driver creation (a CHANGELOG "Changed" line).
- **D7. Orderings round-trip whole (Tier 2c), without a typed core home.** The operation-store contract suite gains one assertion: an Attempt's `ordering`, its `unsigned.ordering` and the Operation's `reservation` come back with every property's value and type, for the orderings the families record (EVM nonce, UTXO inputs, Tron `refBlockHash`, Solana `blockhash`/`blockhashSlot`/bigint `lastValidHeight`, TON `validFrom`), with bigints above 2^53, after the append and after a later `update`. The samples are exported from `crypto-aio/testing` as `SAMPLE_ORDERINGS`. A second test shows the assertion is not vacuous: stores that drop, retype, reorder or move one property fail it. The core's `OrderingData` type does not grow the families' fields in 0.1.0: the families export their typed orderings (`TronExpiryOrdering`, `SolanaExpiryOrdering`, `TonSeqnoOrdering`) from the root entry, and a typed core home would be a public type change with no safety gain over the contract pin. Cost: a store author reads three family types instead of one core type (Appendix B keeps the typed home in the backlog).
- **D8. The deposit guide line (F6-R36, release blocker).** The proven deposit read stays in the backlog: no family has one, TON's authenticated walk is the cheapest start but needs a new read path per family and scanner trust elsewhere, which is not small (Appendix B). So every guide sentence that promised "credit deposits only on `final` with `proven` evidence" now says what is true: withdrawals (your own Operations) complete on `final` with `proven` evidence; deposits are `observed` in every family, since `getTransaction`, `history` and scans read one endpoint (`statusFromObservation` in `src/core/blockchain/mapping.ts` never returns `proven`); so credit a deposit on `finality: 'final'`, and before crediting automatically (or above your risk threshold) read it again through an independent provider (and indexer, where the family needs one) and credit it only when both reads are final and agree on the transaction hash, recipient, asset, amount and memo. `transactions.md` gains a "Crediting deposits" section with a per-family table of what each read rests on, the family rules (Bitcoin change, Solana owners, TON jetton arrivals), and the N8 note that a `final`-mode scan trusts the block contents one endpoint serves. TON's "exception" sentences become the general rule. Cost: none in code; an operator who relied on the old sentence now does a second read.
- **D9. The guide layout (Plan 1 handoff D1).** The tracked `docs/guides/` and its seven files stay, rendered by TypeDoc's `projectDocuments`; spec §18's `docs/guide/` with seven other file names is not adopted. Renaming would break every link, the TypeDoc configuration, the tutorial-sync test and the CHANGELOG's references, for no content gain: the spec's files map onto sections of the existing ones, and `index.md` gains that map. Recorded as a deviation from spec §18. Cost: a reader looking for `exchange-operations.md` finds a table row instead.
- **D10. Tier 4, each with its cost.** Included: the response byte cap (Task 6: `transport.maxResponseBytes`, 64 MiB by default, about 40 lines; one endpoint could exhaust memory with an endless answer, a single-endpoint denial of service); the own-key lookups (Task 2: three lines beside edits already made there); rate-limited probes that keep the last good height and identity (Task 7: an endpoint whose `Retry-After` is pending is not probed, a rate-limited probe is neither a miss nor a success, and a rate-limited first identity check retries after the endpoint's own delay instead of 15 s; about 20 lines; a 429 on a probe made a live endpoint unusable, which is why the keyless TronGrid and toncenter mainnet presets fail under load); the decaying height watermark (Task 7: a peak no verified endpoint comes within `maxLagBlocks` of for three refreshes in a row falls back to the verified best; about 20 lines; one forged far-future head made every view stale until restart, a single-endpoint denial of service); `close()` stopping the worker loops (Task 8: the root's `close()` aborts a `closing` controller that every loop, pass and recovery runs under; about 30 lines; a closed container kept claiming Operations from a shared store, holding each for a lease, and kept the process alive); and explicit budgets for the three `probe-rate-limit.test.ts` tests (Task 7) and two TON tests (Task 13) that time out under `--detectOpenHandles`, so the final gate runs it with no flag. Deferred to Appendix B: the cross-family `require.cache` boundary test (a guard for future changes, not a present gap; Task 11's packed-tarball check proves today that every entry loads with no SDK), N7 (the memory store's lenient `clear`; the engine always passes an array), and one shared `deepFreeze` and one `MAX_COINS` (duplication, no gap).
- **D11. The CHANGELOG is the owner's (F4-R26).** Task 12 holds the complete proposed `CHANGELOG.md`, marked **OWNER APPROVAL**. With approval, it replaces the file. Without it, the proposal is written to `docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md` for the owner, and `CHANGELOG.md` is left untouched. The `[Unreleased]` family and core bullets move into `[0.1.0]` once each (X5), the §19 advisory is kept (with the registry check's result), and the owner's "planned" line goes.
- **D12. Release mechanics.** `package.json` goes to `0.1.0`, and `files` gains `CHANGELOG.md`, so the security advisory and the migration notes ship with the package (npm 10 does not add a CHANGELOG by itself; the published tarballs of 0.0.1, 0.0.2 and 0.0.3 held only `dist`, `package.json`, `README.md` and `LICENSE`). Coverage moves from the tracked `docs/coverage/` to a git-ignored `coverage/`, the badge script and `make-coverage-badge` go, and Jest enforces thresholds 2 points under 0.1.0's (measured on this plan's code: lines and statements 98.45%, functions 96.83%, branches 93.14%; thresholds 96, 96, 94 and 91). A new `scripts/pack-check.mjs` (`pnpm test:pack`) checks the packed tarball as a user installs it. CI (`ci.yml`) adds a format check (`pnpm format:check`, which also covers `scripts/`), the coverage gate with an artifact, and a `package` job running the pack check, with read-only token permissions; its `secrets` job, red on `main` because gitleaks flags the test vectors, passes again with a `.gitleaks.toml` that allows those 20 values exactly (no path, no rule), and its gitleaks image is pinned to v8.30.1; the publish workflow (`npm-ci.yml`) checks that the release tag matches `package.json`, runs the same checks plus `pnpm doc` and the pack check before `npm publish --provenance`, and triggers on a **published** release instead of a created one (a draft no longer publishes). Cost: CI runs about 5 minutes longer, and each new key-shaped test vector needs its own allowlist line.
- **D13. The backlog becomes a tracked file.** Task 12 writes `docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md`, holding Appendix B's Tier 5 rows as they stand in this plan, so the owner has one living list after the plan file becomes history. Cost: one more file to keep current.
- **D14. The quick start installs from npm.** It says `npm install crypto-aio` and names 0.1.0 as the first release of this API; the 0.0.x note stays. The window between the merge and the owner's publish, in which `main` documents a version npm does not serve yet, is covered by the owner's checklist (Task 13).
- **D15. A link check for the docs.** Tasks 9–12 rewrite the README, delete the stale site the README badges pointed at, and add anchors the guides link to, so Task 9 adds `test/docs/links.test.ts`: every relative link in `README.md`, `CHANGELOG.md` and the seven guides resolves to a file, and every `#anchor` to a heading (GitHub's ids). TypeDoc already checks the guides' relative files, but not the README or anchors. Cost: one small test file.
- **D16. The Markdown check.** See Global Constraints: a count of prose-only Prettier differences per file, expected per step, instead of `prettier --check` (which fails on `main` for six guides). Cost: a reviewer compares two numbers instead of reading a green check.
- **D17. The §19 registry check, done at authoring (read-only, in scratch).** `npm pack crypto-aio@0.0.1`, `@0.0.2` and `@0.0.3`: each tarball holds only `package/LICENSE`, `package/README.md`, `package/package.json` and `package/dist/**` (the 0.0.x `libs`, `tool` and `type` modules); no `.env` or other env file, no private key, mnemonic, provider key or 32-hex-digit string (a case-insensitive scan for `infura`, `alchemy`, `api_key`, `trongrid`, `mnemonic`, `private` and `secret` finds only compiled class-field helpers and the 0.0.x `account.create` code). SHA-256: 0.0.1 `d3e3e2fb…7dba3b`, 0.0.2 `91cb5ac3…0e8a78`, 0.0.3 `439f2fae…bd67d`. The remote has tags `v0.0.1` and `v0.0.2` only (0.0.3 was published without a tag), so the `[0.1.0]` compare link starts at `v0.0.2`. The advisory's sentence says so (Task 12).

## File Structure

```
src/core/
  secret/fragments.ts          CREATE (Task 1): endpointSecrets, createScrubber, MIN_FRAGMENT_LENGTH
  transport/http-transport.ts  MODIFY (Task 1): Endpoint.scrub; every provider text scrubbed; REST errors name the route
                               MODIFY (Task 6): #body reads at most maxResponseBytes (driver path and SDK bridge)
                               MODIFY (Task 7): rateLimited(); probes skip a pending Retry-After; #decayPeak
  transport/types.ts           MODIFY (Task 6): TransportOptions.maxResponseBytes
  util/names.ts                CREATE (Task 2): unknownName, knownName, listNames, MAX_LISTED_NAMES
  registry/chains.ts           MODIFY (Task 2): unknown chain and network; own-key network lookup
  registry/providers.ts        MODIFY (Task 2): PresetCatalog.names(); unknown preset
  registry/schemes.ts          MODIFY (Task 2): unknown signature scheme
  registry/assets.ts           MODIFY (Task 2): unknown asset alias
  config/resolve.ts            MODIFY (Task 2): unknown provider, library, wallet, signer
  blockchain/handle.ts         MODIFY (Task 2): walletAddress, deriveAddress (own-key lookup)
  signing/wallet.ts            MODIFY (Task 2): signerFor own-key lookups
  model/asset.ts               MODIFY (Task 2): malformed asset id without the id
  container/container.ts       MODIFY (Task 2): invalid namespace without the name
                               MODIFY (Task 8): workerSignal; close() aborts the workers; closed workers refuse
  container/internals.ts       MODIFY (Task 8): RootRuntime.closing
src/native.ts                  MODIFY (Task 2): the library mismatch names the handle's library only
src/adapters/
  utxo/network.ts, utxo/context.ts, tron/network.ts, solana/network.ts, ton/network.ts
                               MODIFY (Task 2): refusals through unknownName / knownName
  evm/rawtx.ts                 CREATE (Task 3): readSentTx, signatureValuesValid, MAX_SENT_BYTES
  evm/errors.ts                MODIFY (Task 3): classifyOwnBroadcast
  evm/builder.ts               MODIFY (Task 3): the broadcaster takes the chain id
                               MODIFY (Task 4): capPrice / assertWithinCeiling in pricing, build and cancel
  evm/driver.ts                MODIFY (Tasks 3, 4): chain id to the broadcaster; ctx.options to the config
  evm/fees.ts                  MODIFY (Task 4): DEFAULT_MAX_FEE_PER_GAS, priceCap, capPrice, assertWithinCeiling
  evm/network.ts               MODIFY (Task 4): options; maxFeePerGas
  evm/index.ts                 MODIFY (Task 4): export DEFAULT_MAX_FEE_PER_GAS
src/testing/contracts/operations.ts  MODIFY (Task 5): SAMPLE_ORDERINGS and the whole-ordering assertion
src/testing/index.ts           MODIFY (Task 5): export SAMPLE_ORDERINGS
scripts/pack-check.mjs         CREATE (Task 11)
.gitleaks.toml                 CREATE (Task 11): the test vectors CI's secret scan allows, by value
test/
  core/secret/fragments.test.ts            CREATE (Task 1)
  core/transport/secret-echo.test.ts       CREATE (Task 1)
  architecture/secret-echo.test.ts         CREATE (Task 1)
  core/util/names.test.ts                  CREATE (Task 2)
  (15 test files, expected texts)          MODIFY (Task 2)
  adapters/evm/rawtx.test.ts               CREATE (Task 3)
  adapters/evm/builder.test.ts             MODIFY (Task 3): the broadcaster's chain id
  adapters/evm/e2e.test.ts                 MODIFY (Task 3): the lone-liar e2e test
  adapters/evm/ceiling.test.ts             CREATE (Task 4)
  adapters/evm/support/env.ts              MODIFY (Task 4): EvmEnvOptions.options
  core/store/ordering-contract.test.ts     CREATE (Task 5)
  core/transport/response-cap.test.ts      CREATE (Task 6)
  core/transport/probe-limits.test.ts      CREATE (Task 7)
  core/transport/probe-rate-limit.test.ts  MODIFY (Task 7): explicit budgets for three long tests
  core/container/close-workers.test.ts     CREATE (Task 8)
  core/lifecycle/workers.test.ts           MODIFY (Task 8): two M8 assertions compare the signal by effect
  docs/links.test.ts                       CREATE (Task 9)
  adapters/ton/{node,builder}.test.ts      MODIFY (Task 13): explicit budgets for two long tests
docs/guides/                   MODIFY (Tasks 1–5, 6–9, 11): the sentences each change makes false; deposits; layout map
README.md                      REWRITE (Task 10)
package.json, pnpm-lock.yaml, jest.config.js, eslint.config.mjs, .gitignore, .github/workflows/*.yml
                               MODIFY (Task 11)
docs/{index,modules,hierarchy}.html, docs/.nojekyll, docs/{assets,classes,functions,interfaces,types}/,
docs/coverage/, docs/coverage.svg
                               DELETE (Task 11): the stale 0.0.x Pages site and coverage output
CHANGELOG.md                   REWRITE with OWNER APPROVAL (Task 12), else untouched
docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md   CREATE (Task 12, only without approval)
docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md          CREATE (Task 12)
```

---

## Task 1: Secret fragments never leave the transport; REST errors name the route (Tier 1a, F3-R20)

**Files:**
- Create: `src/core/secret/fragments.ts`
- Modify: `src/core/transport/http-transport.ts` (imports, `Endpoint`, the constructor, `#httpOnce`, `#exchange`, `#unwrapRpc`, `#classify`, `#disable`; `#scrub` is removed)
- Test: `test/core/secret/fragments.test.ts`, `test/core/transport/secret-echo.test.ts`, `test/architecture/secret-echo.test.ts`
- Docs: `docs/guides/security.md` (the Errors row of "Secrets and redaction", one native-client bullet)

**Interfaces:**
- Consumes: nothing from other tasks. `redactText` (`src/core/secret/redact.ts`), `REDACTED` (`src/core/secret/secret.ts`), each family's `*_PRESETS` (tests only).
- Produces: `endpointSecrets(url: string, headers: Readonly<Record<string, string>>): EndpointSecrets`, `createScrubber(placeholder: string, secrets: EndpointSecrets): (text: string, limit?: number) => string`, `MIN_FRAGMENT_LENGTH = 8`, and the private `Endpoint.scrub(text, limit?)` that Tasks 6 and 7 leave as is. REST error texts now read `${method} ${route} refused (HTTP n)`, or `${method} refused (HTTP n)` without a route.

- [ ] **Step 1: Write the failing unit test**

Create `test/core/secret/fragments.test.ts`:

```ts
import {
  MIN_FRAGMENT_LENGTH,
  createScrubber,
  endpointSecrets,
} from '../../../src/core/secret/fragments';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

describe('endpoint secret fragments (F3-R20)', () => {
  it('derives each path segment, query value, userinfo part and header token', () => {
    const { urls, fragments } = endpointSecrets(
      `https://user:pa55word-long@node.example/v2/${KEY}?api_key=q%2Bvalue%2Fx&flag=1`,
      { authorization: 'Bearer tok_abcdefgh123', 'x-api-key': 'hdr-value-1234' },
    );
    expect(urls).toContain(
      `https://user:pa55word-long@node.example/v2/${KEY}?api_key=q%2Bvalue%2Fx&flag=1`,
    );
    expect(fragments).toEqual(
      expect.arrayContaining([
        KEY,
        'pa55word-long',
        'q%2Bvalue%2Fx',
        'q+value/x',
        'Bearer tok_abcdefgh123',
        'tok_abcdefgh123',
        'hdr-value-1234',
      ]),
    );
  });

  it(`leaves out fragments shorter than ${MIN_FRAGMENT_LENGTH} characters`, () => {
    const { fragments } = endpointSecrets('https://rpc.example/v2/jsonRPC/eth?x=1', {});
    for (const word of ['v2', 'jsonRPC', 'eth', '1', 'user']) {
      expect(fragments).not.toContain(word);
    }
  });

  it('derives the password of a Basic credential', () => {
    const basic = Buffer.from('operator:s3cret-password').toString('base64');
    const { fragments } = endpointSecrets('https://node.example', {
      authorization: `Basic ${basic}`,
    });
    expect(fragments).toEqual(
      expect.arrayContaining([basic, 'operator:s3cret-password', 's3cret-password']),
    );
  });

  it('scrubs every form case-insensitively, the URL as a placeholder, the rest redacted', () => {
    const url = `https://node.example/v2/${KEY}`;
    const scrub = createScrubber('<main>', endpointSecrets(url, {}));
    expect(scrub(`invalid api key ${KEY}`)).toBe('invalid api key [REDACTED]');
    expect(scrub(`invalid api key ${KEY.toLowerCase()}`)).toBe(
      'invalid api key [REDACTED]',
    );
    expect(scrub(`connect ECONNREFUSED ${url}`)).toBe('connect ECONNREFUSED <main>');
    expect(scrub('unknown method eth_foo on v2')).toBe('unknown method eth_foo on v2');
  });

  it('reads a bounded prefix and still removes a secret cut by the limit', () => {
    const scrub = createScrubber(
      '<main>',
      endpointSecrets(`https://n.example/${KEY}`, {}),
    );
    const text = `${'x'.repeat(290)}${KEY}${'y'.repeat(1_000_000)}`;
    const out = scrub(text, 300);
    expect(out).toHaveLength(300);
    expect(out).not.toContain(KEY.slice(0, 10));
    expect(out.startsWith(`${'x'.repeat(290)}[REDACTED]`)).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing transport test**

Create `test/core/transport/secret-echo.test.ts`:

```ts
import { inspect } from 'node:util';
import { secret } from '../../../src/core/secret/secret';
import type { EndpointConfig } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';
const id = (req: FakeRequest) => req.json<{ id: unknown }>().id;

/** Every text a caller, a logger or an event consumer can see of an error. */
async function surfaces(run: () => Promise<unknown>, seen: readonly unknown[]) {
  const error = await run().catch((e: unknown) => e);
  return {
    error,
    text: [
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(seen),
    ].join('\n'),
  };
}

const expectNoKey = (text: string, key = KEY) =>
  expect(text.toLowerCase()).not.toContain(key.toLowerCase());

describe('HttpTransport: a secret echoed back by a provider never leaves (F3-R20)', () => {
  const pathKeyed: EndpointConfig = {
    name: 'keyed',
    url: secret(`https://node.example/v2/${KEY}`),
  };

  it('scrubs a bare key from a JSON-RPC error message and its data, in any case', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: {
        jsonrpc: '2.0',
        id: id(req),
        error: {
          code: -32000,
          message: `invalid api key ${KEY.toUpperCase()}`,
          data: { key: KEY, hint: `use ${encodeURIComponent(KEY)}` },
        },
      },
    }));
    const { transport, clock, seen } = setup([pathKeyed], fake);
    const { error, text } = await surfaces(
      () => drive(clock, transport.rpc('eth_call')),
      seen,
    );
    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      details: { rpcMessage: 'invalid api key [REDACTED]' },
    });
    expectNoKey(text);
  });

  it('scrubs a bare key from a REST error body, and names the route, not the path', async () => {
    const fake = new FakeFetch().route('https://indexer.example', () => ({
      status: 400,
      text: `{"error":"key ${KEY} is not allowed"}`,
    }));
    const { transport, clock, seen } = setup(
      [
        {
          name: 'idx',
          url: 'https://indexer.example/api',
          headers: { 'x-api-key': secret(KEY) },
        },
      ],
      fake,
    );
    const { error, text } = await surfaces(
      () =>
        drive(
          clock,
          transport.http({
            method: 'GET',
            path: '/address/bc1qCUSTOMERADDRESS/txs',
            route: '/address/:address/txs',
          }),
        ),
      seen,
    );
    expect(error).toMatchObject({
      code: 'RPC_ERROR',
      message: 'GET /address/:address/txs refused (HTTP 400)',
      details: { status: 400, body: '{"error":"key [REDACTED] is not allowed"}' },
    });
    expectNoKey(text);
    expect(text).not.toContain('bc1qCUSTOMERADDRESS');
  });

  it('names only the method when a REST call gives no route', async () => {
    const fake = new FakeFetch().route('https://indexer.example', () => ({
      status: 404,
      text: 'not found',
    }));
    const { transport, clock } = setup(
      [{ name: 'idx', url: 'https://indexer.example' }],
      fake,
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/tx/abc123' })),
    ).rejects.toMatchObject({ message: 'GET refused (HTTP 404)' });
  });

  it('scrubs the token after an auth scheme and a Basic password from a fetch failure', async () => {
    const password = 's3cret-password';
    const basic = Buffer.from(`operator:${password}`).toString('base64');
    for (const [header, echoed] of [
      [`Bearer ${KEY}`, KEY],
      [`Basic ${basic}`, password],
    ] as const) {
      const fake = new FakeFetch().route('https://node.example', () => {
        throw new TypeError('fetch failed', {
          cause: new Error(`proxy refused credentials ${echoed}`),
        });
      });
      const { transport, clock, seen } = setup(
        [
          {
            name: 'auth',
            url: 'https://node.example/rpc',
            headers: { authorization: secret(header) },
          },
        ],
        fake,
      );
      const { error, text } = await surfaces(
        () => drive(clock, transport.rpc('x')),
        seen,
      );
      expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
      expectNoKey(text, echoed);
    }
  });

  it('scrubs a query-string key in its decoded and encoded forms', async () => {
    const key = 'k3y+with/slash=and-more';
    const fake = new FakeFetch().route('https://toncenter.example', () => ({
      status: 400,
      text: `bad api_key ${key} (${encodeURIComponent(key)})`,
    }));
    const { transport, clock, seen } = setup(
      [
        {
          name: 'custom',
          url: `https://toncenter.example/api/v2?api_key=${encodeURIComponent(key)}`,
        },
      ],
      fake,
    );
    const { text } = await surfaces(
      () =>
        drive(
          clock,
          transport.http({ method: 'POST', path: '/jsonRPC', route: '/jsonRPC' }),
        ),
      seen,
    );
    expectNoKey(text, key);
    expectNoKey(text, encodeURIComponent(key));
  });

  it('keeps ordinary words of the URL in node texts the drivers classify', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: {
        jsonrpc: '2.0',
        id: id(req),
        error: {
          code: -32601,
          message: 'the method eth_getBlockReceipts does not exist',
        },
      },
    }));
    const { transport, clock } = setup(
      [{ name: 'ankr', url: secret(`https://node.example/eth/${KEY}`) }],
      fake,
    );
    await expect(
      drive(clock, transport.rpc('eth_getBlockReceipts')),
    ).rejects.toMatchObject({
      details: { rpcMessage: 'the method eth_getBlockReceipts does not exist' },
    });
  });

  it('scrubs a key a provider answers to the identity probe with', async () => {
    const fake = new FakeFetch().route('https://node.example', (req) => ({
      json: { jsonrpc: '2.0', id: id(req), result: KEY },
    }));
    const { transport, clock, seen } = setup([pathKeyed], fake);
    transport.setProbes({
      identity: (call) => call.rpc<string>('chain_id'),
      expectedIdentity: '1',
    });
    const { error, text } = await surfaces(() => drive(clock, transport.rpc('x')), seen);
    expect(error).toMatchObject({ code: 'PROVIDER_MISCONFIGURED' });
    expect(seen).toContainEqual(
      expect.objectContaining({ type: 'provider.misconfigured', actual: 'REDACTED' }),
    );
    expectNoKey(text);
  });
});
```

- [ ] **Step 3: Write the failing test over every family's keyed presets (Review Focus 1)**

Create `test/architecture/secret-echo.test.ts`:

```ts
// F3-R20, a release blocker: every family's keyed presets, and custom URLs, with the key
// echoed back by the provider in every place the transport copies provider text.
import { inspect } from 'node:util';
import { EVM_PRESETS } from '../../src/adapters/evm/presets';
import { SOLANA_PRESETS } from '../../src/adapters/solana/presets';
import { TON_PRESETS } from '../../src/adapters/ton/presets';
import { TRON_PRESETS } from '../../src/adapters/tron/presets';
import type { ProviderPreset } from '../../src/core/registry/providers';
import { secret } from '../../src/core/secret/secret';
import type { EndpointConfig } from '../../src/core/transport/types';
import { drive } from '../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../src/testing/fake-fetch';
import { setup } from '../core/transport/support';

const KEY = 'Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

interface Case {
  readonly title: string;
  readonly endpoints: readonly EndpointConfig[];
  readonly style: 'json-rpc' | 'rest';
}

function preset(
  list: readonly ProviderPreset[],
  name: string,
  chain: string,
  network: string,
  kind: 'rpc' | 'indexer' = 'rpc',
): readonly EndpointConfig[] {
  const found = list.find((p) => p.name === name && p.kind === kind);
  if (!found) throw new Error(`no preset ${name}`);
  return found.endpoints({ chain, network, apiKey: secret(KEY) });
}

const CASES: readonly Case[] = [
  ...['alchemy', 'infura', 'ankr'].map((name): Case => ({
    title: `EVM ${name}`,
    endpoints: preset(EVM_PRESETS, name, 'ethereum', 'mainnet'),
    style: 'json-rpc',
  })),
  ...['alchemy', 'infura', 'ankr'].map((name): Case => ({
    title: `Solana ${name}`,
    endpoints: preset(SOLANA_PRESETS, name, 'solana', 'mainnet'),
    style: 'json-rpc',
  })),
  ...(['rpc', 'indexer'] as const).map((kind): Case => ({
    title: `Tron trongrid (${kind})`,
    endpoints: preset(TRON_PRESETS, 'trongrid', 'tron', 'mainnet', kind),
    style: 'rest',
  })),
  ...(['rpc', 'indexer'] as const).map((kind): Case => ({
    title: `TON toncenter (${kind})`,
    endpoints: preset(TON_PRESETS, 'toncenter', 'ton', 'mainnet', kind),
    style: 'rest',
  })),
  {
    title: 'TON custom URL with an api_key query value',
    endpoints: [
      { name: 'custom', url: `https://toncenter.example/api/v2?api_key=${KEY}` },
    ],
    style: 'rest',
  },
  {
    title: 'Bitcoin custom Esplora with a key path segment',
    endpoints: [{ name: 'esplora', url: secret(`https://esplora.example/${KEY}/api`) }],
    style: 'rest',
  },
];

const origin = (endpoint: EndpointConfig) => {
  const url = endpoint.url;
  return new URL(typeof url === 'string' ? url : url.reveal()).origin;
};

function echo(style: Case['style'], req: FakeRequest): FakeReply {
  if (style === 'rest')
    return { status: 400, text: `{"Error":"api key ${KEY} refused"}` };
  return {
    json: {
      jsonrpc: '2.0',
      id: req.json<{ id: unknown }>().id,
      error: { code: -32000, message: `invalid api key ${KEY}`, data: `key=${KEY}` },
    },
  };
}

describe('a key echoed by the provider never reaches an error, a cause or an event', () => {
  it.each(CASES)('$title', async ({ endpoints, style }) => {
    for (const mode of ['answer', 'network'] as const) {
      const fake = new FakeFetch();
      for (const endpoint of endpoints) {
        fake.route(origin(endpoint), (req) => {
          if (mode === 'network') {
            throw new TypeError('fetch failed', { cause: new Error(`refused ${KEY}`) });
          }
          return echo(style, req);
        });
      }
      const { transport, clock, seen } = setup([...endpoints], fake);
      const call =
        style === 'json-rpc'
          ? transport.rpc('getHealth')
          : transport.http({ method: 'POST', path: '/wallet/getnowblock', route: '/x' });
      const error = await drive(clock, call).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: mode === 'answer' ? 'RPC_ERROR' : 'PROVIDER_UNAVAILABLE',
      });
      for (const text of [
        inspect(error, { depth: 10 }),
        JSON.stringify(error),
        JSON.stringify(seen),
        JSON.stringify(transport.status()),
      ]) {
        expect(text.toLowerCase()).not.toContain(KEY.toLowerCase());
      }
    }
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `pnpm exec jest test/core/secret/fragments.test.ts test/core/transport/secret-echo.test.ts test/architecture/secret-echo.test.ts`
Expected: FAIL. `fragments.test.ts` cannot find `../../../src/core/secret/fragments`; in the two echo suites 14 tests fail, for example with `Received string: "providererror: gethealth failed: invalid api key zk8sq2xvw9lmn4pr7ty1ue3io6as5df0 …"` (the key survives) and `Expected: "GET /address/:address/txs refused (HTTP 400)"` (the concrete path). Five pass already (the URL placeholder and the ordinary words).

- [ ] **Step 5: Create the fragment module**

Create `src/core/secret/fragments.ts`:

```ts
/**
 * F3-R20: the secret fragments of one endpoint's configuration, and the scrubber that
 * removes them from every text an error, a `details` field or a `cause` may carry. A
 * provider that refuses a key often echoes the bare key back ("invalid api key <KEY>"),
 * without the URL or header around it, so removing only the whole URL or header value is
 * not enough.
 */
import { redactText } from './redact';
import { REDACTED } from './secret';

/**
 * The shortest fragment scrubbed on its own. Every built-in keyed preset's key is at least
 * 32 characters (Alchemy, Infura, Ankr, TronGrid, toncenter), while the ordinary words of an
 * endpoint URL are shorter than 8 (`v2`, `v3`, `api`, `rpc`, `eth`, `bsc`, `solana`,
 * `jsonRPC`, `mainnet`). Those words also occur inside node texts the drivers classify
 * ("method not found" holds `eth`, a JSON-RPC body holds `jsonrpc`), so scrubbing them would
 * change a verdict's input. A secret shorter than 8 characters is still removed wherever
 * the whole URL, the whole header value or the whole `Scheme token` appears.
 */
export const MIN_FRAGMENT_LENGTH = 8;

/** A whole header value shorter than this is left alone (as before this change). */
const MIN_VALUE_LENGTH = 4;

/** `Scheme token` in an `Authorization`-style value (RFC 9110 §11.4). */
const AUTH_VALUE = /^\s*[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*\s+(\S+)\s*$/;

export interface EndpointSecrets {
  /** The endpoint URL as configured and as parsed: an error shows its placeholder. */
  readonly urls: readonly string[];
  /** Every other text to remove: fragments and whole header values. */
  readonly fragments: readonly string[];
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function base64Text(text: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return undefined;
  const value = Buffer.from(text, 'base64').toString('utf8');
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

/**
 * The URL forms and fragments of one endpoint: the URL as given and as parsed; its path and
 * query together; each userinfo part, path segment, query value and fragment (raw and
 * percent-decoded); each header value whole; the token after an auth scheme, and for
 * `Basic` the decoded `user:password` and password. Fragments shorter than
 * `MIN_FRAGMENT_LENGTH` are left out. The input is trusted configuration (its URL already
 * parsed by the transport).
 */
export function endpointSecrets(
  url: string,
  headers: Readonly<Record<string, string>>,
): EndpointSecrets {
  const parsed = new URL(url);
  const urls = [...new Set([url, parsed.href])];
  const fragments = new Set<string>();
  const add = (text: string, min = MIN_FRAGMENT_LENGTH) => {
    for (const form of [text, decoded(text)]) if (form.length >= min) fragments.add(form);
  };
  add(`${parsed.pathname}${parsed.search}`, 2);
  add(parsed.username);
  add(parsed.password);
  for (const segment of parsed.pathname.split('/')) add(segment);
  for (const pair of parsed.search.replace(/^\?/, '').split('&')) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    const value = pair.slice(at + 1);
    add(value);
    add(value.replace(/\+/g, ' '));
  }
  add(parsed.hash.replace(/^#/, ''));
  for (const value of Object.values(headers)) {
    add(value, MIN_VALUE_LENGTH);
    const token = AUTH_VALUE.exec(value)?.[1];
    if (token === undefined) continue;
    add(token);
    const basic = /^\s*basic\s/i.test(value) ? base64Text(token) : undefined;
    if (basic !== undefined) {
      add(basic);
      add(basic.slice(basic.indexOf(':') + 1));
    }
  }
  return { urls, fragments: [...fragments] };
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A text with every secret of `secrets` replaced, case-insensitively and longest first: a
 * URL form by `placeholder`, anything else by `[REDACTED]`; then any other URL redacted.
 * With `limit`, only the first `limit` characters come back, and only a bounded prefix is
 * read (lesson 20), long enough that a secret starting before the cut is removed whole.
 */
export function createScrubber(
  placeholder: string,
  secrets: EndpointSecrets,
): (text: string, limit?: number) => string {
  const all = [...secrets.urls, ...secrets.fragments].sort((a, b) => b.length - a.length);
  const longest = all[0]?.length ?? 0;
  const urls = new Set(secrets.urls.map((form) => form.toLowerCase()));
  const pattern =
    all.length > 0 ? new RegExp(all.map(escape).join('|'), 'gi') : undefined;
  return (text, limit) => {
    const input = limit === undefined ? text : text.slice(0, limit + longest);
    const replaced = pattern
      ? input.replace(pattern, (match) =>
          urls.has(match.toLowerCase()) ? placeholder : REDACTED,
        )
      : input;
    const out = redactText(replaced);
    return limit === undefined ? out : out.slice(0, limit);
  };
}
```

- [ ] **Step 6: Scrub every provider text in the transport**

In `src/core/transport/http-transport.ts`:

(a) Replace the two secret imports

```ts
import { redactText } from '../secret/redact';
import { REDACTED, reveal } from '../secret/secret';
```

with

```ts
import { createScrubber, endpointSecrets } from '../secret/fragments';
import { reveal } from '../secret/secret';
```

(b) In `interface Endpoint`, replace `readonly secrets: readonly string[];` with

```ts
  /** F3-R20: removes this endpoint's URL, header values and every secret fragment of them
   * from a text; with `limit`, reads and returns at most that many characters. */
  readonly scrub: (text: string, limit?: number) => string;
```

(c) In the constructor, replace

```ts
      const pathAndQuery = `${parsed.pathname}${parsed.search}`;
      const secrets = [
        url,
        parsed.href,
        ...(pathAndQuery.length > 1 ? [pathAndQuery] : []),
      ];
      for (const value of Object.values(headers))
        if (value.length >= 4) secrets.push(value);
      return {
        id,
        kind: config.kind ?? 'rpc',
        url,
        headers,
        secrets: secrets.sort((a, b) => b.length - a.length),
```

with

```ts
      return {
        id,
        kind: config.kind ?? 'rpc',
        url,
        headers,
        scrub: createScrubber(`<${id}>`, endpointSecrets(url, headers)),
```

(`parsed` stays: the protocol check above still uses it.)

(d) In `#httpOnce`, replace the error label's comment and value

```ts
      // Error message text keeps the real path (unchanged, existing behaviour); only the
      // event label above is route-based to avoid leaking identifiers into events.
      `${request.method} ${request.path}`,
```

with

```ts
      // F3-R20 (Plan 7 D2): error texts name the route template, as events do, never the
      // concrete path, which carries addresses and transaction ids.
      routeLabel(request.method, request.route),
```

(e) In `#exchange`, replace `body: this.#scrub(endpoint, text).slice(0, 300),` with `body: endpoint.scrub(text, 300),`.

(f) In `#unwrapRpc`, replace

```ts
      const message = this.#scrub(
        endpoint,
        typeof err.message === 'string' ? err.message : 'unknown error',
      ).slice(0, 300);
      const rawData = err.data;
      const data =
        rawData === undefined
          ? undefined
          : this.#scrub(
              endpoint,
              typeof rawData === 'string' ? rawData : stringifyData(rawData),
            ).slice(0, 512);
```

with

```ts
      const message = endpoint.scrub(
        typeof err.message === 'string' ? err.message : 'unknown error',
        300,
      );
      const rawData = err.data;
      const data =
        rawData === undefined
          ? undefined
          : endpoint.scrub(
              typeof rawData === 'string' ? rawData : stringifyData(rawData),
              512,
            );
```

(g) Delete the whole `#scrub` method, its JSDoc ("Replaces the endpoint URL and header values with placeholders, then redacts URLs.") included.

(h) In `#classify`, replace

```ts
    const clean = new Error(
      this.#scrub(endpoint, inner instanceof Error ? inner.message : String(inner)),
    );
```

with

```ts
    const clean = new Error(
      endpoint.scrub(inner instanceof Error ? inner.message : String(inner), 1_000),
    );
```

(i) In `#disable`, replace `actual: sanitizeIdentityField(String(actual)),` with

```ts
      // F3-R20: an endpoint could answer its identity probe with our own key.
      actual: sanitizeIdentityField(endpoint.scrub(String(actual), 256)),
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm exec jest test/core/secret test/core/transport test/architecture/secret-echo.test.ts`
Expected: PASS (`fragments.test.ts` 5, `secret-echo.test.ts` 7, the preset matrix 12, and every existing transport suite unchanged).

- [ ] **Step 8: Rewrite the guide sentences this makes false**

In `docs/guides/security.md`, "Secrets and redaction", replace the Errors row

```markdown
| Errors | Transport errors name the endpoint (`<provider/endpoint>`), never its URL. A REST error's text may carry the request path, such as an address or a txid, but never the host or a credential. Signer failures carry a sanitized cause |
```

with

```markdown
| Errors | Transport errors name the endpoint (`<provider/endpoint>`), never its URL. Every part of an endpoint's configuration a provider may echo back is removed from error messages, `details` and causes, in any letter case: a key in a path segment, a query value, a header value or the token after an auth scheme (as `[REDACTED]`, for parts of 8 characters or more, and whole URLs and header values of any length). A REST error names the route template, such as `GET /address/:address/txs`, never the path with its address or txid. Signer failures carry a sanitized cause |
```

In the same file, "The native escape hatch", insert this bullet before the bullet that starts "- The root container's `close()`":

```markdown
- **An SDK's own errors are not scrubbed.** The client never sees the real URL or key, but
  an error the SDK raises itself may quote the provider's answer, and a provider may echo
  your key in it. Log a native client's errors by type or code, not by message.
```

Run: `mdcheck docs/guides/security.md`
Expected: `docs/guides/security.md 15` (unchanged: the row stays compact).

- [ ] **Step 9: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2759 passed, 2774 total` (24 new, 137 suites), TypeDoc with no warning.

```bash
git add src/core/secret/fragments.ts src/core/transport/http-transport.ts \
  test/core/secret/fragments.test.ts test/core/transport/secret-echo.test.ts \
  test/architecture/secret-echo.test.ts docs/guides/security.md
git commit -m "fix(core): scrub every secret fragment a provider echoes; REST errors name the route (F3-R20)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Security: "An API key that a provider echoes back is removed from every error message, `details` field, `cause` and event, in any letter case, from a URL path segment, a query value, a header value or the token after an auth scheme, not only as the whole URL or header value. Parts of fewer than 8 characters are removed only as part of the whole URL or header value."
- Changed: "A REST error's message names the route template, as in `GET /address/:address/txs refused (HTTP 400)`, no longer the request path with its address or transaction id; without a route, only the method."

**Review points:**
- Every text copied from a provider or a failure goes through `endpoint.scrub` with a limit: `details.body` (300), `rpcMessage` (300), `rpcData` (512), a network failure's message and `cause` (1,000), the identity answer in `provider.misconfigured` (256). No other transport path copies provider text into an error: the SDK bridge hands the SDK its answer and never builds an error from a 2xx or 4xx body (D1's documented limit).
- The bounded read (`limit + longest`) removes a secret that starts before the cut, and the regular expression is built once per endpoint, longest fragment first.
- `MIN_FRAGMENT_LENGTH` = 8 keeps the classifier words (`eth` in "method not found", R93) intact; the test "keeps ordinary words of the URL" pins it.
- The route label: `routeLabel(method, route)`, identical to the event label; no family's classifier reads the message text of a REST error (UTXO and TON read `details.body`).

## Task 2: One bounded-name helper; no error echoes a caller-typed name (Tier 1a, F6-R24, F3-R16)

**Files:**
- Create: `src/core/util/names.ts`
- Modify: `src/core/registry/chains.ts`, `src/core/registry/providers.ts`, `src/core/registry/schemes.ts`, `src/core/registry/assets.ts`, `src/core/config/resolve.ts`, `src/core/blockchain/handle.ts`, `src/core/signing/wallet.ts`, `src/core/model/asset.ts`, `src/core/container/container.ts`, `src/native.ts`
- Modify: `src/adapters/utxo/network.ts`, `src/adapters/utxo/context.ts`, `src/adapters/tron/network.ts`, `src/adapters/solana/network.ts`, `src/adapters/ton/network.ts`
- Test: `test/core/util/names.test.ts` (new) and the expected texts of 15 existing test files (Step 6)
- Docs: `docs/guides/security.md`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `unknownName(what: string, accepted: Iterable<string>): string`, `knownName(value: unknown, known: readonly string[], unshown: string): string`, `listNames(names: Iterable<string>): string`, `MAX_LISTED_NAMES = 12` (`src/core/util/names.ts`); `PresetCatalog.names(kind?: 'rpc' | 'indexer'): string[]`. Task 4's EVM option refusal uses `unknownName('option', …)`. Refusal texts: `unknown <what>; the accepted names are 'a', 'b' and 'c'`, `unknown <what>; the only accepted name is 'a'`, `unknown <what>; none is configured`.

- [ ] **Step 1: Write the failing test**

Create `test/core/util/names.test.ts`:

```ts
import { inspect } from 'node:util';
import { knownName, listNames, unknownName } from '../../../src/core/util/names';
import { createFakeEnv } from '../../../src/testing';

const PASTED = 'pasted-Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('bounded names (F3-R16, F6-R24)', () => {
  it('lists accepted names sorted and unique, counting beyond twelve', () => {
    expect(listNames(['b', 'a', 'b'])).toBe("'a' and 'b'");
    expect(listNames(['c', 'a', 'b'])).toBe("'a', 'b' and 'c'");
    const many = Array.from({ length: 15 }, (_, i) => `n${String(i).padStart(2, '0')}`);
    expect(listNames(many)).toBe(
      "'n00', 'n01', 'n02', 'n03', 'n04', 'n05', 'n06', 'n07', 'n08', 'n09', 'n10', 'n11' and 3 more",
    );
  });

  it('refuses an unknown name by listing the accepted ones', () => {
    expect(unknownName('wallet', [])).toBe('unknown wallet; none is configured');
    expect(unknownName('option', ['maxFee'])).toBe(
      "unknown option; the only accepted name is 'maxFee'",
    );
    expect(unknownName('network', ['sepolia', 'mainnet'])).toBe(
      "unknown network; the accepted names are 'mainnet' and 'sepolia'",
    );
  });

  it('shows a value only when it is a known fixed word', () => {
    expect(knownName('memo', ['memo', 'tokens'], 'an unknown capability')).toBe("'memo'");
    expect(knownName(PASTED, ['memo'], 'an unknown capability')).toBe(
      'an unknown capability',
    );
    expect(knownName(42, ['memo'], 'an unknown capability')).toBe(
      'an unknown capability',
    );
  });

  it('never repeats a pasted chain, network, library, provider, wallet or signer', async () => {
    const env = await createFakeEnv();
    for (const selection of [
      { chain: PASTED },
      { chain: 'fakechain', network: PASTED },
      { chain: 'fakechain', library: PASTED },
      { chain: 'fakechain', provider: PASTED },
      { chain: 'fakechain', wallet: PASTED },
      { chain: 'fakechain', signer: PASTED },
    ]) {
      const error = thrown(() =>
        env.aio.blockchain(selection as Parameters<typeof env.aio.blockchain>[0]),
      );
      expect(error).toMatchObject({ message: expect.stringMatching(/^unknown /) });
      for (const text of [inspect(error, { depth: 5 }), JSON.stringify(error)]) {
        expect(text).not.toContain(PASTED);
      }
    }
    await expect(env.bc.walletAddress(PASTED)).rejects.toMatchObject({
      message: expect.not.stringContaining(PASTED),
    });
    await expect(env.bc.deriveAddress(PASTED, 0)).rejects.toMatchObject({
      message: expect.not.stringContaining(PASTED),
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec jest test/core/util/names.test.ts`
Expected: FAIL: `Cannot find module '../../../src/core/util/names'`. (With the helper of Step 3 in place and the core unchanged, the last test fails instead: `unknown chain 'pasted-Zk8s…' (registered: fakechain, fakeexpiry, fakeseqno)` repeats the pasted text.)

- [ ] **Step 3: Create the helper**

Create `src/core/util/names.ts`:

```ts
/**
 * F3-R16, F6-R24: how an error names something the caller typed (a chain, network,
 * library, provider, wallet, signer, scheme, asset alias, option key or capability). What a
 * caller typed may be a pasted secret, so an error never repeats it, at any length: it lists
 * the names that would have been accepted instead, which the library or the caller's own
 * configuration defined.
 */

/** At most this many accepted names are listed; the rest are counted. */
export const MAX_LISTED_NAMES = 12;

/** `'a'`, `'a' and 'b'`, `'a', 'b' and 'c'`, or `'a', …, 'l' and 3 more`: sorted, unique. */
export function listNames(names: Iterable<string>): string {
  const sorted = [...new Set(names)].sort();
  const shown = sorted.slice(0, MAX_LISTED_NAMES).map((name) => `'${name}'`);
  const rest = sorted.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) as string}`;
}

/**
 * The text of a refusal of an unknown `what`, listing the accepted names and never the
 * caller's: `unknown network; the accepted names are 'mainnet' and 'sepolia'`.
 */
export function unknownName(what: string, accepted: Iterable<string>): string {
  const names = [...new Set(accepted)];
  if (names.length === 0) return `unknown ${what}; none is configured`;
  if (names.length === 1)
    return `unknown ${what}; the only accepted name is ${listNames(names)}`;
  return `unknown ${what}; the accepted names are ${listNames(names)}`;
}

/**
 * A value as an error may show it: quoted when it is one of `known` (a fixed word of this
 * library, such as a capability name), else `unshown`.
 */
export function knownName(
  value: unknown,
  known: readonly string[],
  unshown: string,
): string {
  return typeof value === 'string' && known.includes(value) ? `'${value}'` : unshown;
}
```

- [ ] **Step 4: Route every core echo through it, with own-key lookups**

(a) `src/core/registry/chains.ts`: add `import { unknownName } from '../util/names';` after the `../model/chain` import. In `get`, replace

```ts
    if (!chain) {
      const known = [...this.#chains.keys()].join(', ') || 'none';
      throw new ConfigError(
        'CONFIG_INVALID',
        `unknown chain '${id}' (registered: ${known})`,
      );
    }
```

with

```ts
    if (!chain) {
      // F6-R24: the caller's text is never repeated; the registered chains are listed.
      throw new ConfigError('CONFIG_INVALID', unknownName('chain', this.#chains.keys()));
    }
```

and in `network`, replace

```ts
    const network = chain.networks[networkId];
    if (!network) {
      const supported = Object.keys(chain.networks).join(', ');
      throw new ConfigError(
        'CONFIG_INVALID',
        `unknown network '${networkId}' for chain '${chainId}' (supported: ${supported})`,
      );
    }
```

with

```ts
    // Own keys only: `toString` or `constructor` is not a network (F3-R2).
    const network = Object.hasOwn(chain.networks, networkId)
      ? chain.networks[networkId]
      : undefined;
    if (!network) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName(`network for chain '${chain.id}'`, Object.keys(chain.networks)),
      );
    }
```

(b) `src/core/registry/providers.ts`: add `import { unknownName } from '../util/names';` after the `../transport/types` import; add this method to `PresetCatalog`, before `resolve`:

```ts
  /** The registered preset names, of one kind or of both. */
  names(kind?: 'rpc' | 'indexer'): string[] {
    return [...this.#presets.keys()].filter((name) => this.has(name, kind));
  }
```

and in `resolve`, replace `` `unknown ${kind} provider preset '${name}'`, `` with `unknownName(`${kind} provider preset`, this.names(kind)),`.

(c) `src/core/registry/schemes.ts`: add `import { unknownName } from '../util/names';` after the `../util/bytes` import; in `get`, replace

```ts
    if (!scheme)
      throw new ConfigError('CONFIG_INVALID', `unknown signature scheme '${id}'`);
```

with

```ts
    if (!scheme) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('signature scheme', this.#schemes.keys()),
      );
    }
```

(d) `src/core/registry/assets.ts`: add `import { unknownName } from '../util/names';` after the `../model/chain` import; in `resolveAlias`, replace

```ts
    if (!info) {
      const known = [...(scope?.keys() ?? [])].sort().join(', ') || 'none';
      throw new ValidationError(
        'ASSET_RESOLUTION',
        `unknown asset alias '${alias.trim()}' on ${scopeKey} (known: ${known})`,
      );
    }
```

with

```ts
    if (!info) {
      throw new ValidationError(
        'ASSET_RESOLUTION',
        unknownName(`asset alias on ${scopeKey}`, scope?.keys() ?? []),
      );
    }
```

(e) `src/core/config/resolve.ts`: add `import { unknownName } from '../util/names';` after the `../util/json` import. In `resolveProviders`, replace

```ts
      else throw new ConfigError('CONFIG_INVALID', `unknown provider '${ref}'`);
```

with

```ts
      else {
        throw new ConfigError(
          'CONFIG_INVALID',
          unknownName(`${kind} provider`, [
            ...Object.keys(effective.providers),
            ...catalogs.presets.names(kind),
          ]),
        );
      }
```

In `resolveSelection`, replace

```ts
      `library '${library}' does not support chain '${chain.id}' (supported: ${manifests.map((m) => m.library).join(', ')})`,
```

with

```ts
      unknownName(
        `library for chain '${chain.id}'`,
        manifests.map((m) => m.library),
      ),
```

replace

```ts
    if (!config)
      throw new ConfigError('CONFIG_INVALID', `unknown wallet '${merged.wallet}'`);
```

with

```ts
    if (!config) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('wallet', Object.keys(effective.wallets)),
      );
    }
```

and replace both

```ts
      if (!own(effective.signers, signerId))
        throw new ConfigError('CONFIG_INVALID', `unknown signer '${signerId}'`);
```

and

```ts
    if (!instance)
      throw new ConfigError('CONFIG_INVALID', `unknown signer '${signerId}'`);
```

with the same refusal in braces (`if (!own(effective.signers, signerId)) {` and `if (!instance) {` respectively):

```ts
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('signer', Object.keys(effective.signers)),
      );
    }
```

(f) `src/core/blockchain/handle.ts`: add `import { unknownName } from '../util/names';` after the `../util/bytes` import. In `walletAddress`, replace `` throw new ConfigError('CONFIG_INVALID', `unknown wallet '${wallet}'`); `` with

```ts
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('wallet', Object.keys(effective.wallets)),
      );
```

In `deriveAddress`, replace

```ts
    const config = containerOf(internals.container).effective().wallets[wallet];
```

with

```ts
    const { wallets } = containerOf(internals.container).effective();
    // Own keys only (F3-R2), and the caller's text is never repeated (F6-R24).
    if (!Object.hasOwn(wallets, wallet)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        unknownName('wallet', Object.keys(wallets)),
      );
    }
    const config = wallets[wallet];
```

(`wallet '${wallet}' has no xpub` stays: that wallet is configured.)

(g) `src/core/signing/wallet.ts`, in `signerFor`, replace

```ts
      const routed = ref?.id !== undefined ? config.signers?.[ref.id] : undefined;
      const id = routed ?? primary?.id;
      if (id === undefined) return undefined;
      const signer = id === primary?.id ? primary.instance : signers[id];
```

with

```ts
      // Own keys only (F3-R2): a key ref named `toString` routes nowhere.
      const routes = config.signers ?? {};
      const routed =
        ref?.id !== undefined && Object.hasOwn(routes, ref.id)
          ? routes[ref.id]
          : undefined;
      const id = routed ?? primary?.id;
      if (id === undefined) return undefined;
      const signer =
        id === primary?.id
          ? primary.instance
          : Object.hasOwn(signers, id)
            ? signers[id]
            : undefined;
```

(h) `src/core/model/asset.ts`, in `parseAssetId`, replace

```ts
  if (!match) throw new ValidationError('ASSET_RESOLUTION', `malformed asset id '${id}'`);
```

with

```ts
  // F6-R24: a malformed id is the caller's text, never repeated.
  if (!match) throw new ValidationError('ASSET_RESOLUTION', 'malformed asset id');
```

(i) `src/core/container/container.ts`, in the constructor, replace

```ts
      throw new ConfigError('CONFIG_INVALID', `invalid namespace '${namespace}'`);
```

with

```ts
      throw new ConfigError(
        'CONFIG_INVALID',
        'invalid namespace: use 1 to 64 letters, digits, dots, underscores or hyphens',
      );
```

(j) `src/native.ts`, in `native`, replace

```ts
      `this handle uses '${internals.selection.library}', not '${library}'`,
```

with

```ts
      // F6-R24: the caller's text is never repeated; the handle's own library is named.
      `this handle's library is '${internals.selection.library}'; ask native() for that one`,
```

- [ ] **Step 5: Replace the families' hand-rolled refusals**

(a) `src/adapters/utxo/network.ts`: add `import { unknownName } from '../../core/util/names';` after the `../../core/model/chain` import; delete the `named` function with its JSDoc ("A name from the configuration (an option key) as an error may show it …"); replace

```ts
    if (!OPTION_KEYS.has(key)) fail(`unknown option ${named(key)}`);
```

with

```ts
    // F3-R16: the accepted names, never the caller's key (it may be a pasted secret).
    if (!OPTION_KEYS.has(key)) fail(unknownName('option', OPTION_KEYS));
```

(b) `src/adapters/utxo/context.ts`: add `import { unknownName } from '../../core/util/names';` after the `../../core/model/asset` import; replace

```ts
      `wallet.utxo has an unknown option; the options are ${WALLET_OPTION_KEYS.join(', ')}`,
```

with

```ts
      `wallet.utxo has an ${unknownName('option', WALLET_OPTION_KEYS)}`,
```

(c) `src/adapters/tron/network.ts`: replace `import type { Capability } from '../../core/model/capability';` with `import { KNOWN_CAPABILITIES, type Capability } from '../../core/model/capability';`, and add `import { knownName, unknownName } from '../../core/util/names';` after the `../../core/model/chain` import. Replace

```ts
/** The accepted option names, as a refusal lists them. */
const OPTION_NAMES = `${OPTION_KEYS.slice(0, -1)
  .map((key) => `'${key}'`)
  .join(', ')} and '${OPTION_KEYS.at(-1) as string}'`;

/**
 * A capability name from the network entry as an error may show it: a short plain
 * identifier only, so a pasted value never reaches a message or a log. Option keys are never
 * shown (F3-R16).
 */
function named(key: unknown): string {
  return typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(key)
    ? `'${key}'`
    : '(name not shown)';
}
```

with

```ts
/**
 * A capability from the network entry as an error may show it (F3-R16): a core capability's
 * name is a fixed word, so it is shown; any other text could be a pasted secret, so it is not.
 */
const named = (key: unknown): string =>
  knownName(key, KNOWN_CAPABILITIES, 'an unknown capability');
```

and replace `` fail(`unknown option; the Tron driver's options are ${OPTION_NAMES}`); `` with `fail(unknownName('option', OPTION_KEYS));`.

(d) `src/adapters/solana/network.ts`: add `import { unknownName } from '../../core/util/names';` after the `../../core/model/chain` import; replace `` fail(`unknown option; the Solana driver's only option is 'maxComputeUnitPrice'`); `` with `fail(unknownName('option', OPTION_KEYS));`.

(e) `src/adapters/ton/network.ts`: add `import { knownName, unknownName } from '../../core/util/names';` after the `../../core/model/chain` import; replace

```ts
const shown = (capability: Capability): string =>
  (KNOWN_CAPABILITIES as readonly string[]).includes(capability)
    ? `'${capability}'`
    : 'an unknown capability';
```

with

```ts
const shown = (capability: Capability): string =>
  knownName(capability, KNOWN_CAPABILITIES, 'an unknown capability');
```

and replace `` fail(`unknown option; the TON driver's only option is 'maxNetworkFee'`); `` with `fail(unknownName('option', OPTION_KEYS));`.

- [ ] **Step 6: Update the expected texts of the existing tests**

Each line below is one replacement, old text first; all are expectations of refusal messages. Run `pnpm format` afterwards: Prettier re-wraps several of them.

- `test/core/registry/schemes.test.ts`: `message: expect.stringMatching(/unknown signature scheme 'bls'/),` → `message: "unknown signature scheme; the accepted names are 'ed25519', 'secp256k1-ecdsa' and 'secp256k1-schnorr'",`
- `test/core/registry/plugin.test.ts`: `message: expect.stringMatching(/unknown signature scheme 'bls'/),` → `message: expect.stringMatching(/^unknown signature scheme; the accepted names are /),`; `message: expect.stringMatching(/unknown indexer provider preset 'acme'/),` → `message: 'unknown indexer provider preset; none is configured',`
- `test/core/registry/assets.test.ts`: the three-line `message: expect.stringMatching(/unknown asset alias 'USDT' on testchain:other \(known: TST\)/, ),` → `message: "unknown asset alias on testchain:other; the only accepted name is 'TST'",`
- `test/core/registry/chains.test.ts`: `message: expect.stringMatching(/unknown chain 'nope' \(registered: testchain\)/),` → `message: "unknown chain; the only accepted name is 'testchain'",`; `message: expect.stringMatching(/supported: local, other/),` → `message: "unknown network for chain 'testchain'; the accepted names are 'local' and 'other'",`
- `test/core/config/config.test.ts`: the three-line `message: expect.stringMatching(/library 'lib-c' does not support chain 'testchain' \(supported: lib-a, lib-b\)/, ),` → `message: "unknown library for chain 'testchain'; the accepted names are 'lib-a' and 'lib-b'",`; `message: expect.stringMatching(/supported: local, other/),` → `message: expect.stringMatching(/the accepted names are 'local' and 'other'/),`; `message: expect.stringMatching(/unknown provider 'ghost'/)` → `message: expect.stringMatching(/^unknown rpc provider; the accepted names are /)`; `message: expect.stringMatching(/unknown wallet 'ghost'/)` and `message: expect.stringMatching(/unknown wallet 'toString'/)` → `message: expect.stringMatching(/^unknown wallet; /)`; `message: expect.stringMatching(/unknown provider/),` → `message: expect.stringMatching(/^unknown rpc provider; /),`; `message: expect.stringMatching(/unknown signer '__proto__'/),` → `message: expect.stringMatching(/^unknown signer; /),`
- `test/core/container/handle.test.ts`: `message: expect.stringMatching(/unknown wallet 'main'/),` → `message: 'unknown wallet; none is configured',`; `message: expect.stringMatching(/unknown wallet 'constructor'/),` → `message: expect.stringMatching(/^unknown wallet; /),`
- `test/adapters/evm/plugin.test.ts`: `message: expect.stringContaining('supported: ethers, web3'),` → `message: "unknown library for chain 'ethereum'; the accepted names are 'ethers' and 'web3'",`
- `test/adapters/solana/plugin.test.ts`: `message: expect.stringContaining('supported: @solana/web3.js'),` → `message: "unknown library for chain 'solana'; the only accepted name is '@solana/web3.js'",`
- `test/adapters/ton/plugin.test.ts`: `message: expect.stringContaining('supported: @ton/ton'),` → `message: "unknown library for chain 'ton'; the only accepted name is '@ton/ton'",`; `message: expect.stringContaining("the TON driver's only option is 'maxNetworkFee'"),` → `message: expect.stringContaining("unknown option; the only accepted name is 'maxNetworkFee'"),`
- `test/adapters/ton/policy.test.ts`: `"unknown option; the TON driver's only option is 'maxNetworkFee'",` → `"unknown option; the only accepted name is 'maxNetworkFee'",`
- `test/adapters/solana/data.test.ts`: `"Solana network solana:devnet: unknown option; the Solana driver's only option is 'maxComputeUnitPrice'",` → `"Solana network solana:devnet: unknown option; the only accepted name is 'maxComputeUnitPrice'",`
- `test/adapters/solana/e2e.test.ts`: `message: expect.stringContaining("only option is 'maxComputeUnitPrice'"),` → `message: expect.stringContaining("the only accepted name is 'maxComputeUnitPrice'"),`
- `test/adapters/utxo/reader.test.ts`: `'wallet.utxo has an unknown option; the options are addressType, changeAddress, allowExternalChangeAddress',` → `"wallet.utxo has an unknown option; the accepted names are 'addressType', 'allowExternalChangeAddress' and 'changeAddress'",`
- `test/adapters/tron/data.test.ts`: `"Tron network tron:nile: unknown option; the Tron driver's options are 'expirationMs', 'energyMarginPercent' and 'maxFeeLimit'",` → `"Tron network tron:nile: unknown option; the accepted names are 'energyMarginPercent', 'expirationMs' and 'maxFeeLimit'",`. In "refuses a capability override the Tron driver cannot serve", remove `'acme:custom',` from the list of capabilities and insert after that loop:

  ```ts
      // F3-R16: only a core capability's fixed name is shown; anything else may be pasted.
      expect(refusal(withCapabilities({ add: ['acme:custom'] }))).toBe(
        'Tron network tron:nile: capabilities.add: the Tron driver does not have an unknown capability',
      );
  ```

  then `"Tron network tron:nile: capabilities.remove: the Tron driver does not have 'memos'",` → `'Tron network tron:nile: capabilities.remove: the Tron driver does not have an unknown capability',`; the comment `// A name is shown only when short and plain, so a pasted value never reaches a message.` → `// A name that is not a core capability is never shown, so a pasted value never is.`; and `expect(message).toContain('(name not shown)');` → `expect(message).toContain('an unknown capability');`
- `test/adapters/utxo/data.test.ts`: replace the head of the test "names an unknown option key only when it is short and plain, never a pasted value"

  ```ts
    it('names an unknown option key only when it is short and plain, never a pasted value', () => {
      const message = (key: string) =>
        (thrown(() => utxoNetworkConfig(BITCOIN_CHAIN, mainnet, { [key]: 1 })) as Error)
          .message;
      expect(message('maxFeeRates')).toBe(
        "UTXO network bitcoin:mainnet: unknown option 'maxFeeRates'",
      );
      expect(message(`a.b:c-d_${'e'.repeat(32)}`)).toContain(`'a.b:c-d_${'e'.repeat(32)}'`);
      for (const key of [
  ```

  with

  ```ts
    it('never names an unknown option key, listing the accepted ones (F3-R16)', () => {
      const message = (key: string) =>
        (thrown(() => utxoNetworkConfig(BITCOIN_CHAIN, mainnet, { [key]: 1 })) as Error)
          .message;
      for (const key of [
        'maxFeeRates',
        `a.b:c-d_${'e'.repeat(32)}`,
  ```

  and its expectation `'UTXO network bitcoin:mainnet: unknown option (name not shown)',` → `"UTXO network bitcoin:mainnet: unknown option; the accepted names are 'coinSelection', 'maxEstimatedFeeRate', 'maxFee', 'maxFeeRate', 'minInputConfirmations', 'nonWitnessUtxo' and 'rbf'",`

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm format && pnpm exec jest test/core test/adapters/evm/plugin.test.ts test/adapters/solana test/adapters/ton test/adapters/tron/data.test.ts test/adapters/utxo`
Expected: PASS (2,034 tests, `names.test.ts`'s 4 included). Before Step 6, the same run shows 20 tests failing on the expectations above.

- [ ] **Step 8: Document it**

In `docs/guides/security.md`, "Secrets and redaction", after the paragraph that starts "`redactUrl(url)` and `redactDeep(value)` are exported", add:

```markdown
An error never repeats a name you typed that the library does not know: a chain, network,
library, provider, wallet, signer, signature scheme, asset alias, option key or capability.
It lists the names it accepts instead (`unknown wallet; the accepted names are 'cold' and
'hot'`), so a secret pasted into the wrong field never reaches a message or a log.
```

Run: `mdcheck docs/guides/security.md`
Expected: `docs/guides/security.md 15`.

- [ ] **Step 9: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2763 passed, 2778 total` (138 suites).

```bash
git add src/core/util/names.ts src/core/registry src/core/config/resolve.ts \
  src/core/blockchain/handle.ts src/core/signing/wallet.ts src/core/model/asset.ts \
  src/core/container/container.ts src/native.ts src/adapters/utxo/network.ts \
  src/adapters/utxo/context.ts src/adapters/tron/network.ts src/adapters/solana/network.ts \
  src/adapters/ton/network.ts test/core/util/names.test.ts test/core/registry \
  test/core/config/config.test.ts test/core/container/handle.test.ts \
  test/adapters/evm/plugin.test.ts test/adapters/solana/plugin.test.ts \
  test/adapters/solana/data.test.ts test/adapters/solana/e2e.test.ts \
  test/adapters/ton/plugin.test.ts test/adapters/ton/policy.test.ts \
  test/adapters/tron/data.test.ts test/adapters/utxo/data.test.ts \
  test/adapters/utxo/reader.test.ts docs/guides/security.md
git commit -m "fix(core): refusals list the accepted names and never echo a caller-typed one (F6-R24, F3-R16)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Security: "An error never repeats a name the caller typed that the library does not know (a chain, network, library, provider or preset, wallet, signer, signature scheme, asset alias, option key or capability): it lists the accepted names instead, so a secret pasted into the wrong field never reaches a message. A malformed asset id, an invalid namespace and a `native()` library name are no longer quoted either."
- Changed: "Refusals of unknown names read `unknown <what>; the accepted names are 'a' and 'b'`; the TON, Solana, Tron, UTXO and EVM option refusals and the core's selection errors use this one form."
- Fixed: "A network, wallet or signer route named like an `Object.prototype` member (`toString`, `constructor`) is an unknown name, never an inherited value."

**Review points:**
- No refusal in `src/**` interpolates a caller-typed name any more: `rg "unknown .*'\\$\\{" src` finds nothing, and the four families' option refusals and the core's selection errors all call `unknownName`.
- A listed name is always the library's own or a key of the caller's own configuration, never the text the caller typed; `MAX_LISTED_NAMES` bounds the list.
- `ChainCatalog.network`, `deriveAddress` and `signerFor` use own-key lookups; the pasted-name test covers `deriveAddress` and `walletAddress`.
- The expected-text changes in Step 6 change messages only, never codes or behaviour.

## Task 3: Lesson 21 for EVM: a node's rejection must hold for the bytes we sent (Tier 2a)

**Files:**
- Create: `src/adapters/evm/rawtx.ts`
- Modify: `src/adapters/evm/errors.ts`, `src/adapters/evm/builder.ts` (`createEvmBroadcaster`), `src/adapters/evm/driver.ts`
- Test: `test/adapters/evm/rawtx.test.ts` (new), `test/adapters/evm/e2e.test.ts`, `test/adapters/evm/builder.test.ts`
- Docs: `docs/guides/transactions.md`

**Interfaces:**
- Consumes: `fromHex` (`src/core/util/bytes.ts`); the test kit's `ScriptedEvmNode.intercept` and `submit`.
- Produces: `readSentTx(hex: string): EvmSentTx | 'malformed' | undefined`, `signatureValuesValid(tx: EvmSentTx): boolean`, `MAX_SENT_BYTES` (`src/adapters/evm/rawtx.ts`); `classifyOwnBroadcast(message: string, sentHex: string, chainId: bigint): BroadcastResult` (`src/adapters/evm/errors.ts`); `createEvmBroadcaster(client: EvmClient, chainId: bigint): Broadcaster` (the signature changes; the driver is its only caller in `src/`). `classifyBroadcastError(message)` stays, reading a node's answer at its word, for tests.

- [ ] **Step 1: Write the failing end-to-end test (Review Focus 2)**

In `test/adapters/evm/e2e.test.ts`, insert before the test `'survives a reorg that drops the transaction, with the orphan check read from both endpoints'`:

```ts
  it('never ends a transfer that a lone endpoint calls invalid, then relays (lesson 21)', async () => {
    const env = await createEvmEnv({ library });
    // A lying endpoint keeps our valid bytes, claims a bad signature, and relays them later.
    let held: string | undefined;
    env.node.intercept = (_endpoint, method, params) => {
      if (method !== 'eth_sendRawTransaction' || held !== undefined) return undefined;
      held = params[0] as string;
      return { error: { code: -32000, message: 'invalid sender' } };
    };
    const error = await env
      .run(env.bc.transfer({ to: RECIPIENT, amount: 7n }, { idempotencyKey: 'liar' }))
      .catch((e: unknown) => e);
    // Before lesson 21 this was TX_REJECTED: the Operation failed and freed its nonce, so a
    // later relay plus a retry under a new key paid twice.
    expect(error).toMatchObject({ code: 'TX_REFUSED' });
    const operationId = String(
      (error as { context: { operationId?: string } }).context.operationId,
    );
    expect((await env.stores.operations.get('default', operationId))?.state).toBe(
      'stalled',
    );
    env.node.submit(held as string);
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(7n);
  });
```

- [ ] **Step 2: Write the failing reader and classifier tests**

Create `test/adapters/evm/rawtx.test.ts` (ethers builds the EIP-2930 vector as an independent encoder; the two other vectors are the frozen ones in `support/vectors.ts`):

```ts
import { Transaction, Wallet } from 'ethers';
import { classifyOwnBroadcast } from '../../../src/adapters/evm/errors';
import {
  MAX_SENT_BYTES,
  readSentTx,
  signatureValuesValid,
} from '../../../src/adapters/evm/rawtx';
import { KEY, RECIPIENT, VECTORS } from './support/vectors';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SEPOLIA = 11_155_111n;
const eip1559 = VECTORS[0]?.raw as string;
const legacy = VECTORS[1]?.raw as string;

/** A signed EIP-2930 transaction, made with ethers as an independent encoder. */
function accessListTx(): string {
  const tx = Transaction.from({
    type: 1,
    chainId: SEPOLIA,
    nonce: 3,
    gasPrice: 2_000_000_000n,
    gasLimit: 21_000n,
    to: RECIPIENT,
    value: 1n,
    accessList: [],
  });
  tx.signature = new Wallet(`0x${KEY}`).signingKey.sign(tx.unsignedHash);
  return tx.serialized;
}

describe('the SDK-free reader of sent EVM bytes (lesson 21)', () => {
  it('reads the checked fields of EIP-1559, EIP-2930 and legacy transactions', () => {
    expect(readSentTx(eip1559)).toMatchObject({
      type: 2,
      chainId: SEPOLIA,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      recovery: 0,
    });
    expect(readSentTx(accessListTx())).toMatchObject({ type: 1, chainId: SEPOLIA });
    expect(readSentTx(legacy)).toMatchObject({ type: 0, chainId: 97n });
    for (const raw of [eip1559, legacy, accessListTx()]) {
      expect(signatureValuesValid(readSentTx(raw) as never)).toBe(true);
    }
  });

  it('calls malformed only what geth cannot decode either', () => {
    for (const hex of [
      '0x', // empty
      '0xzz', // not hex
      '0x80', // a string, not a list
      `${eip1559}00`, // trailing bytes
      eip1559.slice(0, -2), // truncated
      '0x02c0', // too few fields
      '0x02f801c0', // a long-form length under 56
      `0x02f900${eip1559.slice(6)}`, // a length with a leading zero byte
      '0xc9008080808080808080', // an integer with a leading zero byte
    ]) {
      expect(readSentTx(hex)).toBe('malformed');
    }
  });

  it('reads nothing it cannot decode but that may be valid: blob, set-code, oversized', () => {
    expect(readSentTx('0x03f8')).toBeUndefined();
    expect(readSentTx('0x04c0')).toBeUndefined();
    expect(readSentTx(`0x${'00'.repeat(MAX_SENT_BYTES + 1)}`)).toBeUndefined();
    expect(readSentTx(42 as unknown as string)).toBeUndefined();
  });

  it("checks geth's signature values: r and s in range, low s, a recovery id of 0 or 1", () => {
    const tx = readSentTx(eip1559) as Exclude<
      ReturnType<typeof readSentTx>,
      'malformed' | undefined
    >;
    expect(signatureValuesValid({ ...tx, s: N / 2n })).toBe(true);
    expect(signatureValuesValid({ ...tx, s: N / 2n + 1n })).toBe(false);
    expect(signatureValuesValid({ ...tx, r: 0n })).toBe(false);
    expect(signatureValuesValid({ ...tx, r: N })).toBe(false);
    expect(signatureValuesValid({ ...tx, recovery: -1 })).toBe(false);
  });
});

describe('a node rejection of the bytes we sent is a claim (lesson 21, F3-R11)', () => {
  const claims = [
    'invalid chain id for signer',
    'invalid sender',
    'invalid transaction v, r, s values',
    'rlp: expected input list for types.LegacyTx',
    'typed transaction too short',
    'max priority fee per gas higher than max fee per gas',
  ];

  it.each(claims)(
    'refuses, never rejects, valid bytes a node calls invalid: %s',
    (text) => {
      expect(classifyOwnBroadcast(text, eip1559, SEPOLIA)).toEqual({
        kind: 'refused',
        code: 'TX_REFUSED',
        reason: 'the node claimed the transaction is invalid',
      });
    },
  );

  it('rejects when the claim holds for the bytes', () => {
    expect(classifyOwnBroadcast('invalid chain id for signer', eip1559, 97n)).toEqual({
      kind: 'rejected',
      reason: 'wrong chain id',
    });
    expect(classifyOwnBroadcast('rlp: expected input list', '0x80', SEPOLIA)).toEqual({
      kind: 'rejected',
      reason: 'malformed transaction',
    });
    const highS = Transaction.from(eip1559);
    const signature = highS.signature;
    if (!signature) throw new Error('unsigned vector');
    const flipped = `0x${(N - BigInt(signature.s)).toString(16).padStart(64, '0')}`;
    const raw = eip1559.replace(signature.s.slice(2), flipped.slice(2));
    expect(classifyOwnBroadcast('invalid sender', raw, SEPOLIA)).toEqual({
      kind: 'rejected',
      reason: 'invalid signature',
    });
  });

  it('keeps every other answer as the node gave it', () => {
    expect(classifyOwnBroadcast('nonce too low', eip1559, SEPOLIA)).toMatchObject({
      kind: 'refused',
      code: 'NONCE_CONFLICT',
    });
    expect(classifyOwnBroadcast('already known', eip1559, SEPOLIA)).toEqual({
      kind: 'already-known',
    });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec jest test/adapters/evm/e2e.test.ts -t "lesson 21"`, then `pnpm exec jest test/adapters/evm/rawtx.test.ts`
Expected: FAIL. The e2e test fails for both libraries with `Expected: "TX_REFUSED"`, `Received: "TX_REJECTED"`; `rawtx.test.ts` cannot find `../../../src/adapters/evm/rawtx`.

- [ ] **Step 4: Create the SDK-free reader**

Create `src/adapters/evm/rawtx.ts`:

```ts
/**
 * Lesson 21 for EVM: what a node's rejection claims is checked against the bytes we sent,
 * read here SDK-free. The reader is never stricter than geth: it calls bytes `malformed`
 * only for what geth's RLP decoder also refuses (a broken or non-canonical encoding, an
 * integer with a leading zero or over 256 bits, the wrong number of fields, a `to` that is
 * not 20 bytes), and it reads no access list, so a claim it cannot confirm stays a refusal.
 */
import { fromHex } from '../../core/util/bytes';

/** The fields lesson 21 checks, of one signed legacy, EIP-2930 or EIP-1559 transaction. */
export interface EvmSentTx {
  readonly type: 0 | 1 | 2;
  /** Absent for a legacy transaction signed without EIP-155 (v of 27 or 28). */
  readonly chainId?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;
  /** The recovery id: `yParity`, or the legacy `v` reduced to 0 or 1; -1 when neither. */
  readonly recovery: number;
  readonly r: bigint;
  readonly s: bigint;
}

/** Lesson 20: twice geth's 128 KiB pool limit, checked before any decoding. */
export const MAX_SENT_BYTES = 2 * 128 * 1024;

class Malformed extends Error {}
type Item = Uint8Array | readonly Item[];

/** One canonical RLP item at `at`, and the offset after it; throws `Malformed`. */
function item(bytes: Uint8Array, at: number): [Item, number] {
  const lead = bytes[at];
  if (lead === undefined) throw new Malformed();
  const span = (offset: number, length: number): [number, number] => {
    const end = offset + length;
    if (end > bytes.length) throw new Malformed();
    return [offset, end];
  };
  const longLength = (width: number): number => {
    const [start, end] = span(at + 1, width);
    if (bytes[start] === 0) throw new Malformed();
    let length = 0;
    for (let i = start; i < end; i++) length = length * 256 + (bytes[i] as number);
    if (length < 56) throw new Malformed();
    return length;
  };
  if (lead < 0x80) return [bytes.subarray(at, at + 1), at + 1];
  if (lead <= 0xbf) {
    const long = lead > 0xb7;
    const width = long ? lead - 0xb7 : 0;
    const length = long ? longLength(width) : lead - 0x80;
    const [start, end] = span(at + 1 + width, length);
    if (!long && length === 1 && (bytes[start] as number) < 0x80) throw new Malformed();
    return [bytes.subarray(start, end), end];
  }
  const long = lead > 0xf7;
  const width = long ? lead - 0xf7 : 0;
  const length = long ? longLength(width) : lead - 0xc0;
  const [start, end] = span(at + 1 + width, length);
  const items: Item[] = [];
  for (let offset = start; offset < end;) {
    const [next, after] = item(bytes, offset);
    if (after > end) throw new Malformed();
    items.push(next);
    offset = after;
  }
  return [items, end];
}

/** A whole buffer as one list of exactly `fields` items. */
function list(bytes: Uint8Array, fields: number): readonly Item[] {
  const [value, end] = item(bytes, 0);
  if (end !== bytes.length || !Array.isArray(value) || value.length !== fields)
    throw new Malformed();
  return value as readonly Item[];
}

/** A canonical unsigned integer of at most `bits` bits. */
function uint(value: Item | undefined, bits: number): bigint {
  if (!(value instanceof Uint8Array) || value.length * 8 > bits || value[0] === 0)
    throw new Malformed();
  let out = 0n;
  for (const byte of value) out = (out << 8n) | BigInt(byte);
  return out;
}

function address(value: Item | undefined): void {
  if (!(value instanceof Uint8Array) || (value.length !== 0 && value.length !== 20))
    throw new Malformed();
}

/**
 * The sent bytes as lesson 21 reads them: the fields, `'malformed'` when geth could not
 * decode them either, or `undefined` when they are unreadable here but may be valid (an
 * EIP-4844 or EIP-7702 transaction, or more than `MAX_SENT_BYTES`): no claim holds for those.
 */
export function readSentTx(hex: string): EvmSentTx | 'malformed' | undefined {
  if (typeof hex !== 'string' || hex.length > 2 + 2 * MAX_SENT_BYTES) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = fromHex(hex);
  } catch {
    return 'malformed';
  }
  const type = bytes[0];
  if (type === undefined) return 'malformed';
  try {
    if (type >= 0xc0) {
      const [nonce, gasPrice, gas, to, value, , v, r, s] = list(bytes, 9);
      uint(nonce, 64);
      uint(gasPrice, 256);
      uint(gas, 64);
      address(to);
      uint(value, 256);
      const vv = uint(v, 256);
      const eip155 = vv >= 35n;
      return {
        type: 0,
        ...(eip155 ? { chainId: (vv - 35n) / 2n } : {}),
        recovery: eip155
          ? Number((vv - 35n) % 2n)
          : vv === 27n || vv === 28n
            ? Number(vv - 27n)
            : -1,
        r: uint(r, 256),
        s: uint(s, 256),
      };
    }
    if (type === 1 || type === 2) {
      const fields = list(bytes.subarray(1), type === 1 ? 11 : 12);
      const chainId = uint(fields[0], 256);
      uint(fields[1], 64);
      const prices = type === 2 ? [uint(fields[2], 256), uint(fields[3], 256)] : [];
      if (type === 1) uint(fields[2], 256);
      const rest = type === 1 ? 3 : 4;
      uint(fields[rest], 64);
      address(fields[rest + 1]);
      uint(fields[rest + 2], 256);
      const [yParity, r, s] = fields.slice(-3);
      const parity = uint(yParity, 256);
      return {
        type,
        chainId,
        ...(type === 2
          ? {
              maxPriorityFeePerGas: prices[0] as bigint,
              maxFeePerGas: prices[1] as bigint,
            }
          : {}),
        recovery: parity <= 1n ? Number(parity) : -1,
        r: uint(r, 256),
        s: uint(s, 256),
      };
    }
    // geth reads any other first byte above 0x7f as a legacy list, and fails.
    if (type >= 0x80) return 'malformed';
    return undefined;
  } catch (error) {
    if (error instanceof Malformed) return 'malformed';
    throw error;
  }
}

/** secp256k1's group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** geth's `ValidateSignatureValues` with Homestead's low-s rule, over the recovery id. */
export function signatureValuesValid(tx: EvmSentTx): boolean {
  return (
    (tx.recovery === 0 || tx.recovery === 1) &&
    tx.r >= 1n &&
    tx.r < N &&
    tx.s >= 1n &&
    tx.s <= N / 2n
  );
}
```

- [ ] **Step 5: Classify our own broadcasts against our bytes**

In `src/adapters/evm/errors.ts`, add `import { readSentTx, signatureValuesValid, type EvmSentTx } from './rawtx';` after the `BroadcastResult` import, and replace everything from the JSDoc that starts "Invalid by construction: these bytes can never be included on any node." to the end of the file (the `REJECTED` table, `REFUSED_BY_NODE` and `classifyBroadcastError`) with:

```ts
/** A rejection and the check that confirms it for the bytes we sent (lesson 21). */
interface Rejection {
  readonly pattern: RegExp;
  readonly result: BroadcastResult;
  readonly holds: (sent: EvmSentTx | 'malformed', chainId: bigint) => boolean;
}

/**
 * Invalid by construction: these bytes can never be included on any node. Exact texts only,
 * so a state-dependent cause that merely shares a word is never taken for one of these.
 * `invalid chain id` comes first: geth wraps it as "invalid sender: invalid chain id …".
 */
const REJECTED: readonly Rejection[] = [
  {
    pattern: /invalid chain id/i,
    result: rejected('wrong chain id'),
    holds: (sent, chainId) =>
      sent !== 'malformed' && sent.chainId !== undefined && sent.chainId !== chainId,
  },
  {
    pattern: /invalid sender|invalid signature|invalid transaction v, r, s values/i,
    result: rejected('invalid signature'),
    holds: (sent) => sent !== 'malformed' && !signatureValuesValid(sent),
  },
  {
    pattern: /\brlp:|typed transaction too short/i,
    result: rejected('malformed transaction'),
    holds: (sent) => sent === 'malformed',
  },
  {
    pattern: /max priority fee per gas higher than max fee per gas|tip above fee cap/i,
    result: rejected('priority fee above the fee cap'),
    holds: (sent) =>
      sent !== 'malformed' &&
      sent.type === 2 &&
      (sent.maxPriorityFeePerGas as bigint) > (sent.maxFeePerGas as bigint),
  },
];

const REFUSED_BY_NODE = refused('TX_REFUSED', 'refused by the node');

/**
 * `rejected` ends an Attempt without proof, so any doubt falls toward `refused`: the
 * refusal patterns are checked first ("invalid sender: transaction type not supported" is a
 * refusal), and an unlisted text is a refusal.
 */
function classified(message: string): {
  readonly result: BroadcastResult;
  readonly rejection?: Rejection;
} {
  if (ALREADY_KNOWN.test(message)) return { result: ALREADY_KNOWN_RESULT };
  for (const [pattern, result] of REFUSED) {
    if (pattern.test(message)) return { result };
  }
  const rejection = REJECTED.find((entry) => entry.pattern.test(message));
  return rejection
    ? { result: rejection.result, rejection }
    : { result: REFUSED_BY_NODE };
}

/** The node's answer at its word (see `classifyOwnBroadcast` for the bytes we sent). */
export function classifyBroadcastError(message: string): BroadcastResult {
  return classified(message).result;
}

/** A rejection this driver cannot confirm for the bytes it sent: observed, never terminal. */
const UNCONFIRMED: BroadcastResult = refused(
  'TX_REFUSED',
  'the node claimed the transaction is invalid',
);

/**
 * Lesson 21 (F3-R11, F4-R20): a node's rejection is a claim. The answer to `sentHex`, the
 * bytes this driver sent on the network whose chain id is `chainId`: a `rejected` stands
 * only when its reason holds for those bytes, read SDK-free (`readSentTx`); otherwise it is a
 * refusal, so a lying endpoint that relays our bytes can never end the Operation and invite
 * a second payment. Every other answer is the node's, as `classifyBroadcastError` reads it.
 */
export function classifyOwnBroadcast(
  message: string,
  sentHex: string,
  chainId: bigint,
): BroadcastResult {
  const { result, rejection } = classified(message);
  if (!rejection) return result;
  const sent = readSentTx(sentHex);
  return sent !== undefined && rejection.holds(sent, chainId) ? result : UNCONFIRMED;
}
```

In `src/adapters/evm/builder.ts`, replace `import { classifyBroadcastError } from './errors';` with `import { classifyOwnBroadcast } from './errors';`, replace `export function createEvmBroadcaster(client: EvmClient): Broadcaster {` with `export function createEvmBroadcaster(client: EvmClient, chainId: bigint): Broadcaster {`, and in its `catch`, replace

```ts
        // R17: an ambiguous error may hide a delivered transaction; it is never classified.
        if (isCryptoAioError(error, 'RPC_ERROR') && !error.ambiguous) {
          return classifyBroadcastError(
            String(error.details?.rpcMessage ?? error.message),
          );
        }
```

with

```ts
        // R17: an ambiguous error may hide a delivered transaction; it is never classified.
        // Lesson 21: a rejection stands only when its reason holds for the bytes we sent.
        if (isCryptoAioError(error, 'RPC_ERROR') && !error.ambiguous) {
          return classifyOwnBroadcast(
            String(error.details?.rpcMessage ?? error.message),
            signed.raw.data,
            chainId,
          );
        }
```

In `src/adapters/evm/driver.ts`, replace `broadcaster: createEvmBroadcaster(client),` with `broadcaster: createEvmBroadcaster(client, config.chainId),`.

In `test/adapters/evm/builder.test.ts`, replace `broadcaster: createEvmBroadcaster(h.client),` with `broadcaster: createEvmBroadcaster(h.client, h.ctx.config.chainId),`, and in the "EVM broadcaster" stub replace

```ts
    createEvmBroadcaster({
      sendRawTransaction: (_raw: string, tags: EvmCallTags) => send(tags),
    } as unknown as EvmClient);
```

with

```ts
    createEvmBroadcaster(
      {
        sendRawTransaction: (_raw: string, tags: EvmCallTags) => send(tags),
      } as unknown as EvmClient,
      11_155_111n,
    );
```

(The builder test's "wrong chain id" case keeps `rejected`: a Sepolia transaction sent to a Hoodi node carries chain id 11155111, so the claim holds.)

- [ ] **Step 6: Run the EVM suites to see them pass**

Run: `pnpm exec jest test/adapters/evm`
Expected: PASS, 363 tests (the new e2e test for ethers and web3, `rawtx.test.ts` 12 tests, every other EVM test unchanged). Then run the e2e and builder suites 30 times in a row (R46): `for i in $(seq 30); do pnpm exec jest test/adapters/evm/e2e.test.ts test/adapters/evm/builder.test.ts --silent || break; done` — expected: 30 green runs.

- [ ] **Step 7: Rewrite the guide sentence**

In `docs/guides/transactions.md`, "Lifecycle and `stalled`", after the EVM paragraph that ends

```markdown
transfer to yourself, at the smallest valid bump unless you pass `fee`. Arbitrum has no
mempool, so it supports neither (`UNSUPPORTED_CAPABILITY`).
```

add this paragraph:

```markdown
A node's rejection is a claim, and every family checks it against the bytes it sent before
it ends anything: on EVM networks, "invalid sender", "invalid chain id", "rlp: …" and "tip
above fee cap" stand only when the signed bytes, read by the library itself, really carry a
bad signature, another chain id, a broken encoding or a tip above the cap. Otherwise the
answer is a refusal ("the node claimed the transaction is invalid"): the Operation stalls
instead of failing, so an endpoint that lies and relays the bytes later can never make you
pay twice. Retry a stalled transfer only with `rebroadcast` or the same idempotency key.
```

Run: `mdcheck docs/guides/transactions.md`
Expected: `docs/guides/transactions.md 35`.

- [ ] **Step 8: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2777 passed, 2792 total` (139 suites).

```bash
git add src/adapters/evm/rawtx.ts src/adapters/evm/errors.ts src/adapters/evm/builder.ts \
  src/adapters/evm/driver.ts test/adapters/evm/rawtx.test.ts test/adapters/evm/e2e.test.ts \
  test/adapters/evm/builder.test.ts docs/guides/transactions.md
git commit -m "fix(evm): a node's rejection stands only when it holds for the bytes we sent (lesson 21)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Fixed: "EVM: a node's rejection of a broadcast (\"invalid sender\", \"invalid chain id\", \"rlp: …\", \"tip above fee cap\") ends an Operation only when the library's own reading of the signed bytes confirms it; otherwise it is a refusal (`TX_REFUSED`), and the Operation stalls instead of failing, so a lying endpoint that relays the bytes later can no longer make a retry pay twice. The UTXO, Tron, Solana and TON drivers already worked this way."

**Review points:**
- The reader is never stricter than geth: every `'malformed'` case is one geth's RLP decoder refuses too (the malformed vectors in the test), it reads no access list, and EIP-4844, EIP-7702 and oversized envelopes are `undefined` (no claim holds), never `'malformed'`.
- The input is capped at `MAX_SENT_BYTES` before decoding (lesson 20); the RLP walk is linear.
- `signatureValuesValid` is geth's `ValidateSignatureValues(v, r, s, homestead = true)`: r in [1, n), s in [1, n/2], recovery 0 or 1 (legacy `v` 27/28, or EIP-155 `v` ≥ 35).
- `classifyOwnBroadcast` keeps the refusal patterns first ("invalid sender: transaction type not supported" is still a refusal), and every result stays frozen with a fixed reason (R24).
- The e2e test fails on the old code (`TX_REJECTED`) for both libraries.

## Task 4: An EVM fee ceiling no endpoint can raise, and the cross-family bound (Tier 2b)

**Files:**
- Modify: `src/adapters/evm/fees.ts`, `src/adapters/evm/network.ts`, `src/adapters/evm/builder.ts` (`priceFor`, `build`, `buildCancel`), `src/adapters/evm/driver.ts`, `src/adapters/evm/index.ts`
- Test: `test/adapters/evm/ceiling.test.ts` (new); `test/adapters/evm/support/env.ts` (handle options)
- Docs: `docs/guides/networks.md` (EVM networks), `docs/guides/transactions.md` (Fees), `docs/guides/security.md` (checklist)

**Interfaces:**
- Consumes: `unknownName` (Task 2); `readSentTx` (Task 3) in the test.
- Produces: `DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000_000n`, `priceCap(params)`, `capPrice(params, ceiling)`, `assertWithinCeiling(params, ceiling)` (`src/adapters/evm/fees.ts`); `EvmNetworkConfig.maxFeePerGas`; `evmNetworkConfig(chain, network, options = {})`; `DEFAULT_MAX_FEE_PER_GAS` exported from `crypto-aio/evm`. The refusal is `ValidationError('INVALID_INTENT', 'the fee is above maxFeePerGas, the EVM handle option that bounds it (wei per gas)', { details: { required, maxFeePerGas } })`, decimal strings, as Tron's and Solana's are.

- [ ] **Step 1: Let the EVM test environment pass handle options**

In `test/adapters/evm/support/env.ts`, in `interface EvmEnvOptions`, after `readonly lifecycle?: LifecycleOptions;` add

```ts
  /** The handle's driver options (`chains.<id>.options`), such as `maxFeePerGas`. */
  readonly options?: Readonly<Record<string, unknown>>;
```

and in `assemble`'s `chains` entry, after `wallet: 'main',` add

```ts
          ...(options.options ? { options: options.options } : {}),
```

- [ ] **Step 2: Write the failing test (Review Focus 3)**

Create `test/adapters/evm/ceiling.test.ts`:

```ts
import { EVM_CHAINS } from '../../../src/adapters/evm/chains';
import { createEvmBuilder } from '../../../src/adapters/evm/builder';
import {
  DEFAULT_MAX_FEE_PER_GAS,
  assertWithinCeiling,
  capPrice,
  feeDraft,
} from '../../../src/adapters/evm/fees';
import { evmNetworkConfig } from '../../../src/adapters/evm/network';
import { readSentTx } from '../../../src/adapters/evm/rawtx';
import type { ChainInfo, NetworkInfo } from '../../../src/core/model/chain';
import { evmHarness } from './support/context';
import { countingSigner, createEvmEnv } from './support/env';
import { LIBRARIES } from './support/harness';
import { KEY_ADDRESS, RECIPIENT } from './support/vectors';

const GWEI = 1_000_000_000n;
const ethereum = EVM_CHAINS.find((c) => c.id === 'ethereum') as ChainInfo;
const sepolia = ethereum.networks.sepolia as NetworkInfo;
const PASTED = 'pasted-Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0';

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

describe('the EVM fee ceiling, maxFeePerGas (Plan 7 D6, F4-R28 shape)', () => {
  it('takes the handle option, else the network params, else 1,000 gwei', () => {
    expect(DEFAULT_MAX_FEE_PER_GAS).toBe(1_000n * GWEI);
    expect(evmNetworkConfig(ethereum, sepolia).maxFeePerGas).toBe(1_000n * GWEI);
    const own: NetworkInfo = { ...sepolia, params: { maxFeePerGas: 50n * GWEI } };
    expect(evmNetworkConfig(ethereum, own).maxFeePerGas).toBe(50n * GWEI);
    expect(
      evmNetworkConfig(ethereum, own, { maxFeePerGas: 7n * GWEI }).maxFeePerGas,
    ).toBe(7n * GWEI);
  });

  it('refuses a bad ceiling, and any other option key without echoing it', () => {
    for (const value of [0n, -1n, 2n ** 256n, 5, '1000', null]) {
      expect(
        thrown(() => evmNetworkConfig(ethereum, sepolia, { maxFeePerGas: value })),
      ).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          'EVM network ethereum:sepolia: maxFeePerGas must be a bigint of wei per gas from 1 to 2^256 − 1',
      });
    }
    // A network value is checked even where the option overrides it.
    const bad: NetworkInfo = { ...sepolia, params: { maxFeePerGas: 0n } };
    expect(
      thrown(() => evmNetworkConfig(ethereum, bad, { maxFeePerGas: GWEI })),
    ).toMatchObject({ message: expect.stringContaining('params.maxFeePerGas must be') });
    for (const key of [PASTED, 'maxFeeLimit']) {
      const error = thrown(() => evmNetworkConfig(ethereum, sepolia, { [key]: 1n }));
      expect(error).toMatchObject({
        code: 'CONFIG_INVALID',
        message:
          "EVM network ethereum:sepolia: unknown option; the only accepted name is 'maxFeePerGas'",
      });
    }
  });

  it('clamps a suggestion to the ceiling and refuses a price above it', () => {
    const ceiling = 100n * GWEI;
    expect(
      capPrice(
        { type: 'eip1559', maxFeePerGas: 500n * GWEI, maxPriorityFeePerGas: 300n * GWEI },
        ceiling,
      ),
    ).toEqual({ type: 'eip1559', maxFeePerGas: ceiling, maxPriorityFeePerGas: ceiling });
    const within = {
      type: 'eip1559',
      maxFeePerGas: 90n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    } as const;
    expect(capPrice(within, ceiling)).toEqual(within);
    expect(capPrice({ type: 'legacy', gasPrice: ceiling + 1n }, ceiling)).toEqual({
      type: 'legacy',
      gasPrice: ceiling,
    });
    expect(() =>
      assertWithinCeiling({ type: 'legacy', gasPrice: ceiling }, ceiling),
    ).not.toThrow();
    expect(
      thrown(() =>
        assertWithinCeiling({ type: 'legacy', gasPrice: ceiling + 1n }, ceiling),
      ),
    ).toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: String(ceiling + 1n), maxFeePerGas: String(ceiling) },
    });
  });
});

describe.each(LIBRARIES)('the EVM fee ceiling end to end (%s)', (library) => {
  it('never signs above the ceiling however an endpoint prices the fee', async () => {
    // An endpoint suggests a 100,000 gwei tip, and the wallet could afford it.
    const tip = 100_000n * GWEI;
    const env = await createEvmEnv({
      library,
      fund: 10n ** 20n,
      node: { rewards: [tip, tip, tip] },
    });
    const sub = await env.run(
      env.bc.transfer({ to: RECIPIENT, amount: 5n }, { idempotencyKey: 'clamped' }),
    );
    const record = await env.stores.operations.get('default', sub.operationId);
    expect(readSentTx(record?.attempts[0]?.raw.data as string)).toMatchObject({
      type: 2,
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
      maxPriorityFeePerGas: DEFAULT_MAX_FEE_PER_GAS,
    });
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(env.node.balance(RECIPIENT)).toBe(5n);
  });

  it('refuses an explicit fee above the handle option before any fee request or signing', async () => {
    const counting = countingSigner();
    const env = await createEvmEnv({
      library,
      signer: counting.signer,
      options: { maxFeePerGas: 50n * GWEI },
    });
    const error = await env
      .run(
        env.bc.transfer(
          {
            to: RECIPIENT,
            amount: 5n,
            fee: { maxFeePerGas: 51n * GWEI, maxPriorityFeePerGas: GWEI },
          },
          { idempotencyKey: 'too-high' },
        ),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'INVALID_INTENT',
      details: { required: String(51n * GWEI), maxFeePerGas: String(50n * GWEI) },
    });
    expect(counting.calls()).toBe(0);
    const served = env.node.served.map((s) => s.method);
    for (const method of ['eth_feeHistory', 'eth_estimateGas', 'eth_sendRawTransaction'])
      expect(served).not.toContain(method);
  });

  it('refuses a replacement or a cancel that would pay above the ceiling', async () => {
    const ceiling = 50n * GWEI;
    const env = await createEvmEnv({ library, options: { maxFeePerGas: ceiling } });
    const sub = await env.run(
      env.bc.transfer(
        {
          to: RECIPIENT,
          amount: 5n,
          fee: { maxFeePerGas: ceiling, maxPriorityFeePerGas: 2n * GWEI },
        },
        { idempotencyKey: 'at-ceiling' },
      ),
    );
    // The least cancel bump raises the fee cap 10% above the ceiling.
    await expect(env.run(env.bc.cancel(sub.operationId))).rejects.toMatchObject({
      code: 'INVALID_INTENT',
      details: { maxFeePerGas: String(ceiling) },
    });
    await expect(
      env.run(
        env.bc.replace(sub.operationId, {
          fee: { maxFeePerGas: 60n * GWEI, maxPriorityFeePerGas: 3n * GWEI },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    // The original is untouched and lands.
    const final = await env.mineWhile(
      env.bc.waitForConfirmation(sub.operationId, { finality: 'final' }),
    );
    expect(final.operation).toMatchObject({ state: 'final', outcome: 'executed' });
    expect(final.operation?.attempts).toHaveLength(1);
  });

  it('checks the ceiling again in build, whatever produced the fee object', async () => {
    const h = evmHarness(library);
    const builder = createEvmBuilder(h.ctx);
    const fee = feeDraft('custom', 21_000n, {
      type: 'eip1559',
      maxFeePerGas: DEFAULT_MAX_FEE_PER_GAS + 1n,
      maxPriorityFeePerGas: GWEI,
    });
    await expect(
      h.run(
        builder.build(
          {
            asset: 'native',
            outputs: [{ to: RECIPIENT, amount: 1n }],
            from: KEY_ADDRESS,
            fee: 'normal',
          },
          fee,
          {
            from: KEY_ADDRESS,
            keys: h.keys,
            wallet: {},
            ordering: { kind: 'nonce', nonce: 0n },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm exec jest test/adapters/evm/ceiling.test.ts`
Expected: FAIL, 11 of 11. ts-jest compiles each file alone, without type checks (`isolatedModules` in `tsconfig.json`), so the missing exports fail at run time: `(0 , fees_1.capPrice) is not a function`, and the ceiling reads `undefined` where `1000000000000n` is expected. With only the exports of Step 4 in place and nothing wired, the end-to-end cases fail: the signed `maxFeePerGas` is about 100,002 gwei, not 1,000, and the over-ceiling fee, replacement and cancel are signed.

- [ ] **Step 4: Add the ceiling to the fee policy**

In `src/adapters/evm/fees.ts`, after `const invalid = (reason: string) => new ValidationError('INVALID_INTENT', reason);`, add:

```ts
/**
 * Plan 7 D6 (F4-R28's shape): the default `maxFeePerGas`, the highest price per gas an EVM
 * transaction signs, 1,000 gwei. It bounds a plain transfer at 0.021 and a 65,000-gas token
 * transfer at 0.065 of the native coin, however an endpoint prices the fee.
 */
export const DEFAULT_MAX_FEE_PER_GAS = 1_000_000_000_000n;

/** The highest price per gas `params` may pay: the fee cap, or the legacy gas price. */
export function priceCap(params: EvmFeeParams): bigint {
  return params.type === 'eip1559' ? params.maxFeePerGas : params.gasPrice;
}

/**
 * A node's suggestion within the ceiling (D6): the fee cap or gas price at most `ceiling`,
 * and the tip at most the fee cap. No endpoint can raise what a transfer signs.
 */
export function capPrice(params: EvmFeeParams, ceiling: bigint): EvmFeeParams {
  if (params.type === 'legacy')
    return { type: 'legacy', gasPrice: min(params.gasPrice, ceiling) };
  const maxFeePerGas = min(params.maxFeePerGas, ceiling);
  return {
    type: 'eip1559',
    maxFeePerGas,
    maxPriorityFeePerGas: min(params.maxPriorityFeePerGas, maxFeePerGas),
  };
}

/**
 * Refuses, before anything is signed, a fee whose price per gas is above `ceiling` (the
 * handle's `maxFeePerGas`), whatever produced it: an explicit override, a stored fee, or a
 * cancel's least bump. The details carry the price and the bound as decimal strings.
 */
export function assertWithinCeiling(params: EvmFeeParams, ceiling: bigint): void {
  const price = priceCap(params);
  if (price <= ceiling) return;
  throw new ValidationError(
    'INVALID_INTENT',
    'the fee is above maxFeePerGas, the EVM handle option that bounds it (wei per gas)',
    { details: { required: price.toString(), maxFeePerGas: ceiling.toString() } },
  );
}
```

In `src/adapters/evm/index.ts`, before `export { EVM_CAPABILITIES } from './network';` add `export { DEFAULT_MAX_FEE_PER_GAS } from './fees';`.

- [ ] **Step 5: Read and validate the option**

In `src/adapters/evm/network.ts`, replace `import type { EvmFeeModel } from './fees';` with

```ts
import { unknownName } from '../../core/util/names';
import { DEFAULT_MAX_FEE_PER_GAS, type EvmFeeModel } from './fees';
```

In `interface EvmNetworkConfig`, after `readonly capabilities: ReadonlySet<Capability>;` add

```ts
  /**
   * Plan 7 D6: the highest price per gas (wei) a transaction signs: the handle's
   * `maxFeePerGas` option, else the network's `params.maxFeePerGas`, else
   * `DEFAULT_MAX_FEE_PER_GAS`.
   */
  readonly maxFeePerGas: bigint;
```

and after the interface add

```ts

/**
 * The only driver option (`HandleOptions.options`) the EVM driver reads. Any other key is
 * refused, so a typo, or another family's option such as Tron's `maxFeeLimit`, fails loudly
 * instead of leaving the default in place (lesson 10, F6-R25).
 */
const OPTION_KEYS: readonly string[] = Object.freeze(['maxFeePerGas']);

const MAX_UINT256 = 2n ** 256n - 1n;

/** A price ceiling: a bigint of wei per gas that an EVM transaction can carry. */
function priceCeiling(
  value: unknown,
  name: string,
  fail: (reason: string) => never,
): bigint {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_UINT256) {
    fail(`${name} must be a bigint of wei per gas from 1 to 2^256 − 1`);
  }
  return value as bigint;
}
```

Give `evmNetworkConfig` a third parameter, `options: Readonly<Record<string, unknown>> = {},`, after `network: NetworkInfo,`. Before `const replaces = capabilities.has('replace-fee') || capabilities.has('cancel');` add

```ts
  // F3-R16: the refusal lists the accepted name, never the caller's key or its value.
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) fail(unknownName('option', OPTION_KEYS));
  }
  // D6, F4-R28's shape: the handle's option, else the network entry's own, else the
  // default. A network value is checked even where an option overrides it.
  const own = params.maxFeePerGas;
  const networkCeiling =
    own === undefined ? undefined : priceCeiling(own, 'params.maxFeePerGas', fail);
  const maxFeePerGas =
    options.maxFeePerGas !== undefined
      ? priceCeiling(options.maxFeePerGas, 'maxFeePerGas', fail)
      : (networkCeiling ?? DEFAULT_MAX_FEE_PER_GAS);
```

and add `maxFeePerGas,` after `capabilities,` in the returned object.

In `src/adapters/evm/driver.ts`, replace `const config = evmNetworkConfig(ctx.chain, ctx.network);` with

```ts
      // Plan 7 D6: the handle's options too (`maxFeePerGas`); an unknown one is refused.
      const config = evmNetworkConfig(ctx.chain, ctx.network, ctx.options);
```

(`evmChainPlugin` still calls `evmNetworkConfig(chain, network)`, so a custom network's `params.maxFeePerGas` is checked when the plugin is built.)

- [ ] **Step 6: Clamp, refuse and check again in the builder**

In `src/adapters/evm/builder.ts`, add `assertWithinCeiling,` and `capPrice,` to the `./fees` import, after `TRANSFER_GAS,`. In `priceFor`, replace

```ts
  if (typeof fee === 'object') {
    const { params, gasLimit } = parseFeeOverride(fee, config.feeModel);
    return { speed: 'custom', params, ...(gasLimit !== undefined ? { gasLimit } : {}) };
  }
  if (config.feeModel === 'evm-legacy') {
    return {
      speed: fee,
      params: legacyPrice(await client.gasPrice(withSignal(READ, signal)), fee),
    };
  }
```

with

```ts
  if (typeof fee === 'object') {
    const { params, gasLimit } = parseFeeOverride(fee, config.feeModel);
    // D6: an explicit fee above the ceiling is refused before any request.
    assertWithinCeiling(params, config.maxFeePerGas);
    return { speed: 'custom', params, ...(gasLimit !== undefined ? { gasLimit } : {}) };
  }
  // D6: a node's suggestion is clamped to the ceiling, so no endpoint can raise it.
  if (config.feeModel === 'evm-legacy') {
    const gasPrice = await client.gasPrice(withSignal(READ, signal));
    return {
      speed: fee,
      params: capPrice(legacyPrice(gasPrice, fee), config.maxFeePerGas),
    };
  }
```

and at its end replace `return { speed: fee, params, baseFeePerGas };` with `return { speed: fee, params: capPrice(params, config.maxFeePerGas), baseFeePerGas };`. In the builder's `build`, after the fee-model check (the `throw` of `` `this network takes ${ctx.config.feeModel} fees` `` and its closing brace), add

```ts
      // D6: checked again, whatever produced the fee object.
      assertWithinCeiling(params, ctx.config.maxFeePerGas);
```

In `buildCancel`, after `if (!meetsBump(before.params, price.params, bump)) throw tooLow('a cancel');` add

```ts
      // D6: a cancel whose least bump would pay above the ceiling is refused.
      assertWithinCeiling(price.params, config.maxFeePerGas);
```

(`buildReplacement` needs no check of its own: its price comes from `priceFor`, which clamps a speed and refuses an override above the ceiling.)

- [ ] **Step 7: Run the EVM suites to see them pass**

Run: `pnpm exec jest test/adapters/evm`
Expected: PASS, 374 tests (`ceiling.test.ts` 11; every other EVM test unchanged, since none prices above 1,000 gwei).

- [ ] **Step 8: Rewrite the guides**

In `docs/guides/networks.md`, "EVM networks", insert this bullet before the bullet that starts "- **Not in this release:**":

```markdown
- **Fee ceiling.** No transfer, replacement or cancel signs a price per gas above the
  `maxFeePerGas` option, in wei as a bigint (`chains.<id>.options` or a handle's `options`;
  1,000 gwei by default, `DEFAULT_MAX_FEE_PER_GAS` from `crypto-aio/evm`; a custom network
  may set `params.maxFeePerGas`). A node's suggestion is clamped to it, and an explicit fee
  or a cancel's least bump above it fails with `INVALID_INTENT` before signing
  (`details.required`, `details.maxFeePerGas`). If the base fee rises above the ceiling,
  transfers stall as `FEE_TOO_LOW` until it falls or you raise the option. Any other key in
  the EVM options fails with `CONFIG_INVALID`.
```

In `docs/guides/transactions.md`, "Fees", replace

```markdown
to a contract that refuses it, is then signed, broadcast, and burns its gas. The balance
check still runs.
```

with

```markdown
to a contract that refuses it, is then signed, broadcast, and burns its gas. The balance
check still runs. No EVM transaction signs a price per gas above the handle's `maxFeePerGas`
option (1,000 gwei by default): a speed's prices are clamped to it, and an override, or a
cancel's least bump, above it is refused with `INVALID_INTENT` before signing; see
[EVM networks](./networks.md#evm-networks).
```

and after the TON paragraph that ends "[TON networks](./networks.md#ton-networks) covers the charges and the fee ceiling." add

```markdown

**No endpoint can raise a fee above your bound.** Every family's prices come from a node,
so every family bounds them by a handle option that no endpoint can change: EVM
`maxFeePerGas`, Bitcoin `maxFeeRate`, `maxFee` and `maxEstimatedFeeRate`, Tron
`maxFeeLimit`, Solana `maxComputeUnitPrice`, and TON `maxNetworkFee` (on the estimate; TON
signs no fee). A node's suggestion above the bound is clamped to it or not trusted, an
explicit fee above it is refused before signing, and the build checks it again. Set each
bound to your fee policy; the defaults stop an absurd fee, not an expensive one.
```

In `docs/guides/security.md`, "Production checklist", insert before the line that starts "- [ ] Bitcoin: your own Esplora":

```markdown
- [ ] EVM: `maxFeePerGas` set to your fee policy (1,000 gwei per gas by default).
```

Run: `mdcheck docs/guides/networks.md docs/guides/transactions.md docs/guides/security.md`
Expected: `60`, `35` and `15`.

- [ ] **Step 9: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2788 passed, 2803 total` (140 suites); TypeDoc documents `DEFAULT_MAX_FEE_PER_GAS` under `crypto-aio/evm` with no warning.

```bash
git add src/adapters/evm/fees.ts src/adapters/evm/network.ts src/adapters/evm/builder.ts \
  src/adapters/evm/driver.ts src/adapters/evm/index.ts test/adapters/evm/ceiling.test.ts \
  test/adapters/evm/support/env.ts docs/guides/networks.md docs/guides/transactions.md \
  docs/guides/security.md
git commit -m "feat(evm): maxFeePerGas, a fee ceiling no endpoint can raise (D6, F4-R28)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Added: "The EVM handle option `maxFeePerGas` (wei per gas, a bigint; 1,000 gwei by default, exported as `DEFAULT_MAX_FEE_PER_GAS` from `crypto-aio/evm`; a network may set `params.maxFeePerGas`): no EVM transaction signs a higher price per gas. A node's suggestion is clamped to it, and an explicit fee, or a cancel's least bump, above it fails with `INVALID_INTENT` before signing (`details.required`, `details.maxFeePerGas`); the build checks it again. Every family now bounds a node's fee by an operator setting."
- Changed: "The EVM driver reads its handle options: any key but `maxFeePerGas` fails with `CONFIG_INVALID` (other keys were ignored)."

**Review points:**
- Three guards, each pinned by a test that a mutation of it fails (both libraries): the override refusal in `priceFor` ("refuses an explicit fee above the handle option before any fee request or signing"), the re-check in `build` ("checks the ceiling again in build"), and the cancel's check ("refuses a replacement or a cancel that would pay above the ceiling"). The clamp is pinned by "never signs above the ceiling however an endpoint prices the fee", which reads the stored raw bytes with Task 3's reader.
- The clamp keeps the tip at or below the fee cap, so geth's "tip above fee cap" can never be our own doing.
- The option is validated the Solana way: the network's `params` value is checked even when the handle overrides it, and a pasted key is never echoed (`unknownName`).
- No existing EVM test changes: every scripted fee in the suites is far below 1,000 gwei.

## Task 5: Every family's ordering round-trips whole in the store contract (Tier 2c, F4-R15, F5-R14)

**Files:**
- Modify: `src/testing/contracts/operations.ts`, `src/testing/index.ts`
- Test: `test/core/store/ordering-contract.test.ts` (new)
- Docs: `docs/guides/networks.md` ("Testing an adapter or a store")

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SAMPLE_ORDERINGS: readonly (readonly [string, OrderingData])[]`, exported from `crypto-aio/testing`, and one new contract test named "keeps every ordering whole: each property, with its value and its type (F4-R15, F5-R14)", which every store run through `describeOperationStoreContract` now meets.

- [ ] **Step 1: Write the test that the new assertion is not vacuous (Review Focus 4)**

Create `test/core/store/ordering-contract.test.ts`:

```ts
import type { OrderingData } from '../../../src/core/model/ordering';
import { MemoryOperationStore } from '../../../src/core/store/memory';
import type { OperationRecord } from '../../../src/core/store/types';
import {
  describeOperationStoreContract,
  type OperationHarness,
} from '../../../src/testing/contracts/operations';
import { FakeClock } from '../../../src/testing/fake-clock';

type Fault = (ordering: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** A durable-store bug in how one ordering property is kept, applied on every read. */
class FaultyOrderings extends MemoryOperationStore {
  constructor(readonly fault: Fault) {
    super(new FakeClock());
  }

  override async get(namespace: string, id: string): Promise<OperationRecord | null> {
    const record = await super.get(namespace, id);
    if (!record) return record;
    const fix = (ordering: OrderingData) =>
      this.fault(
        ordering as Readonly<Record<string, unknown>>,
      ) as unknown as OrderingData;
    return {
      ...record,
      attempts: record.attempts.map((attempt) => ({
        ...attempt,
        ordering: fix(attempt.ordering),
        unsigned: { ...attempt.unsigned, ordering: fix(attempt.unsigned.ordering) },
      })),
    };
  }
}

/** The contract's ordering test alone, run against the store `create` builds. */
function orderingTest(create: () => OperationHarness): () => Promise<void> {
  let found: (() => Promise<void>) | undefined;
  describeOperationStoreContract(
    {
      describe: (_name, fn) => fn(),
      it: (name, fn) => {
        if (name.startsWith('keeps every ordering whole')) found = fn;
      },
    },
    create,
  );
  if (!found) throw new Error('the contract has no ordering test');
  return found;
}

const without =
  (key: string): Fault =>
  (ordering) => {
    const { [key]: _dropped, ...rest } = ordering;
    return rest;
  };
const map =
  (key: string, change: (value: unknown) => unknown): Fault =>
  (ordering) =>
    key in ordering ? { ...ordering, [key]: change(ordering[key]) } : { ...ordering };

const FAULTS: readonly (readonly [string, Fault])[] = [
  ["Tron's refBlockHash dropped", without('refBlockHash')],
  ['a Solana blockhashSlot read back as a number', map('blockhashSlot', Number)],
  ['a TON validFrom moved later', map('validFrom', (v) => (v as number) + 1)],
  ['an EVM nonce rounded through a double', map('nonce', (v) => BigInt(Number(v)))],
  ['UTXO inputs in another order', map('inputs', (v) => [...(v as string[])].reverse())],
  [
    'an expiresAtMs rounded down to seconds',
    map('expiresAtMs', (v) => Math.floor((v as number) / 1000) * 1000),
  ],
];

describe('the operation-store contract keeps orderings whole (Plan 7 D7)', () => {
  it('passes the memory store', async () => {
    await orderingTest(() => ({
      operations: new MemoryOperationStore(new FakeClock()),
      advance: async () => undefined,
    }))();
  });

  it.each(FAULTS)('fails a store that keeps %s', async (_name, fault) => {
    const run = orderingTest(() => ({
      operations: new FaultyOrderings(fault),
      advance: async () => undefined,
    }));
    await expect(run()).rejects.toThrow(/ordering/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec jest test/core/store/ordering-contract.test.ts`
Expected: FAIL: every test throws `the contract has no ordering test` (the contract does not have it yet).

- [ ] **Step 3: Add the samples and the assertion to the contract**

In `src/testing/contracts/operations.ts`, add `import type { OrderingData } from '../../core/model/ordering';` after `import assert from 'node:assert/strict';`. Before `export interface OperationHarness {` add:

```ts
/**
 * Plan 7 D7 (F4-R15, F5-R14, the Plan 6 handoff §3): an ordering of each kind the built-in
 * families record, with each family's own properties. A store must keep every one whole:
 * a dropped property costs liveness, but a changed one (a `refBlockHash`, a `blockhash`, a
 * `validFrom` moved later, a bigint narrowed to a number) can prove a transaction absent
 * while a block holds it, and `rebuild` then pays twice. The bigints exceed 2^53.
 */
export const SAMPLE_ORDERINGS: readonly (readonly [string, OrderingData])[] =
  Object.freeze([
    ['an EVM nonce', { kind: 'nonce', nonce: 2n ** 64n - 1n }],
    [
      'UTXO inputs',
      {
        kind: 'inputs',
        inputs: [`${'ab'.repeat(32)}:0`, `${'cd'.repeat(32)}:4294967295`],
      },
    ],
    [
      'a Tron expiry',
      {
        kind: 'expiry',
        expiresAtMs: 1_790_000_000_123,
        lastValidHeight: 2n ** 53n + 65_537n,
        refBlockHash: '0a1b2c3d4e5f6071',
      } as OrderingData,
    ],
    [
      'a Solana expiry',
      {
        kind: 'expiry',
        lastValidHeight: 2n ** 63n + 150n,
        blockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
        blockhashSlot: 2n ** 53n + 1n,
      } as OrderingData,
    ],
    [
      'a TON seqno',
      {
        kind: 'seqno',
        seqno: 2n ** 32n - 1n,
        validUntil: 1_790_000_060,
        validFrom: 1_789_999_700,
      } as OrderingData,
    ],
  ]);

/** Every property of `expected`, and no other, with the same value and type. */
function assertWholeOrdering(
  actual: unknown,
  expected: OrderingData,
  where: string,
): void {
  assert.ok(actual !== null && typeof actual === 'object', `${where}: missing`);
  const got = actual as Readonly<Record<string, unknown>>;
  assert.deepEqual(
    Object.keys(got).sort(),
    Object.keys(expected).sort(),
    `${where}: properties`,
  );
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(typeof got[key], typeof value, `${where}.${key}: type`);
    assert.deepEqual(got[key], value, `${where}.${key}: value`);
  }
}
```

In `describeOperationStoreContract`, before `api.it('isolates returned records from the store', async () => {` add:

```ts
    api.it(
      'keeps every ordering whole: each property, with its value and its type (F4-R15, F5-R14)',
      async () => {
        const { operations } = await create();
        for (const [name, ordering] of SAMPLE_ORDERINGS) {
          const { record } = await operations.create(sampleOperation());
          const sample = sampleAttempt('a1');
          const appended = await operations.appendAttempt(
            'ns',
            record.id,
            { ...sample, ordering, unsigned: { ...sample.unsigned, ordering } },
            { state: 'signed', reservation: ordering },
            record.version,
          );
          // Read back after the append, and again after a later write to the record.
          const stored = await operations.get('ns', record.id);
          const updated = await operations.update(
            'ns',
            record.id,
            { state: 'submitted' },
            appended.version,
          );
          const reread = await operations.get('ns', record.id);
          for (const [when, read] of [
            ['appendAttempt', appended],
            ['get', stored],
            ['update', updated],
            ['get after update', reread],
          ] as const) {
            const where = `${name} (${when})`;
            assertWholeOrdering(
              read?.attempts[0]?.ordering,
              ordering,
              `${where} ordering`,
            );
            assertWholeOrdering(
              read?.attempts[0]?.unsigned.ordering,
              ordering,
              `${where} unsigned.ordering`,
            );
            assertWholeOrdering(read?.reservation, ordering, `${where} reservation`);
          }
        }
      },
    );
```

In `src/testing/index.ts`, add `SAMPLE_ORDERINGS,` as the first name of the `export { … } from './contracts/operations';` list.

- [ ] **Step 4: Run the store suites to see them pass**

Run: `pnpm exec jest test/core/store test/e2e/public-api.test.ts`
Expected: PASS (the memory store meets the new contract test; `ordering-contract.test.ts` 7).

- [ ] **Step 5: Rewrite the guide sentence**

In `docs/guides/networks.md`, "Testing an adapter or a store", replace

```markdown
Every Attempt's `ordering` must also read back whole and unchanged, whatever its kind, with
every property the driver put in it and its type; the suites check only nonce orderings
today.
```

with

```markdown
Every Attempt's `ordering` must also read back whole and unchanged, whatever its kind, with
every property the driver put in it and its type, and so must an Operation's `reservation`.
The operation-store suite checks one ordering of each built-in family, with bigints beyond
2^53 (`SAMPLE_ORDERINGS` in `crypto-aio/testing`), after the append and after a later
write.
```

Run: `mdcheck docs/guides/networks.md`
Expected: `docs/guides/networks.md 60`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2796 passed, 2811 total` (141 suites); TypeDoc documents `SAMPLE_ORDERINGS` under `crypto-aio/testing`.

```bash
git add src/testing/contracts/operations.ts src/testing/index.ts \
  test/core/store/ordering-contract.test.ts docs/guides/networks.md
git commit -m "test(stores): the operation-store contract keeps every family's ordering whole (F4-R15, F5-R14)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Changed: "The `OperationStore` contract suite checks that an Attempt's `ordering`, its `unsigned.ordering` and the Operation's `reservation` read back whole, every property with its value and type, for one ordering of each built-in family, after the append and after a later write. A store that drops, retypes or changes a property fails it."
- Added: "`SAMPLE_ORDERINGS` in `crypto-aio/testing`: one Attempt ordering of each built-in family, as the operation-store contract suite checks them."

**Review points:**
- Six faulty stores fail the assertion (a dropped `refBlockHash`, a `blockhashSlot` as a number, a `validFrom` moved later, a nonce through a double, reordered inputs, an `expiresAtMs` rounded to seconds), and the memory store passes it.
- The bigints are above 2^53 (a nonce of 2^64 − 1, a Solana `lastValidHeight` beyond 2^63), so a store that narrows through a JSON number fails.
- This is the one contract change of the plan (Global Constraints); `putObservation`, `update` and every other contract test are untouched.

## Task 6: One answer is at most `maxResponseBytes` (Tier 4, lesson 20)

**Files:**
- Modify: `src/core/transport/types.ts` (`TransportOptions`), `src/core/transport/http-transport.ts` (`DEFAULTS`, `validateOptions`, `#exchange`, the SDK bridge, a new `#body`)
- Test: `test/core/transport/response-cap.test.ts` (new)
- Docs: `docs/guides/concepts.md`

**Interfaces:**
- Consumes: `Endpoint.scrub` (Task 1) is untouched; `#markSent`, `#context`.
- Produces: `TransportOptions.maxResponseBytes?: number` (default `64 * 1024 * 1024`); an answer longer than it is a retryable, possibly-delivered `ProviderError('PROVIDER_UNAVAILABLE', 'endpoint answered more than <n> bytes')`.

- [ ] **Step 1: Write the failing test**

Create `test/core/transport/response-cap.test.ts`:

```ts
import { PLACEHOLDER_ORIGIN } from '../../../src/core/transport/types';
import { drive } from '../../../src/testing/fake-clock';
import { FakeFetch, type FakeRequest } from '../../../src/testing/fake-fetch';
import { setup } from './support';

const CHUNK = 64 * 1024;
const id = (req: FakeRequest) => req.json<{ id: unknown }>().id;

/** An answer that never ends, counting the bytes the transport pulled from it. */
function endless(): { readonly response: Response; pulled(): number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
    },
  });
  return { response: new Response(stream, { status: 200 }), pulled: () => pulled };
}

describe('HttpTransport: an answer is at most maxResponseBytes (Plan 7 D10, lesson 20)', () => {
  const LIMIT = 1024 * 1024;

  it('cancels an endless answer at the cap and fails over to an honest endpoint', async () => {
    const liar = endless();
    const fake = new FakeFetch()
      .route('https://liar.example', () => liar.response)
      .route('https://honest.example', (req) => ({
        json: { jsonrpc: '2.0', id: id(req), result: '0x1' },
      }));
    const { transport, clock } = setup(
      [
        { name: 'liar', url: 'https://liar.example', priority: 0 },
        { name: 'honest', url: 'https://honest.example', priority: 1 },
      ],
      fake,
      { maxResponseBytes: LIMIT },
    );
    await expect(drive(clock, transport.rpc('eth_blockNumber'))).resolves.toBe('0x1');
    expect(liar.pulled()).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
  });

  it('fails a lone oversized answer as a retryable PROVIDER_UNAVAILABLE', async () => {
    const fake = new FakeFetch().route('https://liar.example', () => endless().response);
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
      },
    );
    await expect(drive(clock, transport.rpc('eth_blockNumber'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: `endpoint answered more than ${LIMIT} bytes`,
    });
  });

  it('refuses a declared length above the cap before reading the body', async () => {
    const liar = endless();
    const fake = new FakeFetch().route(
      'https://liar.example',
      () =>
        new Response(liar.response.body, {
          headers: { 'content-length': String(LIMIT + 1) },
        }),
    );
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      { maxResponseBytes: LIMIT, maxAttempts: 1 },
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/blocks', route: '/blocks' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(liar.pulled()).toBeLessThanOrEqual(CHUNK);
  });

  it('reads an answer of exactly the cap whole', async () => {
    const text = 'x'.repeat(LIMIT - 2);
    const fake = new FakeFetch().route('https://node.example', () => ({
      text: JSON.stringify(text),
    }));
    const { transport, clock } = setup(
      [{ name: 'node', url: 'https://node.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
      },
    );
    await expect(
      drive(clock, transport.http({ method: 'GET', path: '/big', route: '/big' })),
    ).resolves.toHaveLength(LIMIT - 2);
  });

  it('caps what the SDK bridge hands a native client too', async () => {
    const fake = new FakeFetch().route('https://liar.example', () => endless().response);
    const { transport, clock } = setup(
      [{ name: 'liar', url: 'https://liar.example' }],
      fake,
      {
        maxResponseBytes: LIMIT,
        maxAttempts: 1,
      },
    );
    const bridged = transport.createFetch();
    await expect(
      drive(clock, bridged(`${PLACEHOLDER_ORIGIN}/x`, { method: 'POST', body: '{}' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('refuses a cap that is not a positive integer', () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(() =>
        setup([{ name: 'n', url: 'https://n.example' }], new FakeFetch(), {
          maxResponseBytes,
        }),
      ).toThrow('maxResponseBytes must be an integer > 0');
    }
  });
});
```

- [ ] **Step 2: Run the safe part of it to see it fail**

Run: `pnpm exec jest test/core/transport/response-cap.test.ts -t "refuses a cap|reads an answer of exactly"`
Expected: FAIL: `refuses a cap that is not a positive integer` (nothing validates the option); the exact-cap test passes. **Do not run the endless-answer tests before Step 3:** on the unchanged transport `response.text()` reads the endless stream until the process runs out of memory, which is the defect.

- [ ] **Step 3: Add the option**

In `src/core/transport/types.ts`, in `interface TransportOptions`, after `readonly healthIntervalMs?: number;` add

```ts
  /**
   * The most bytes one answer may carry (default 64 MiB). A longer answer, by its declared
   * length or as it arrives, is cancelled and fails as a retryable `PROVIDER_UNAVAILABLE`,
   * so one endpoint can never make a call hold unbounded memory (lesson 20).
   */
  readonly maxResponseBytes?: number;
```

In `src/core/transport/http-transport.ts`, in `DEFAULTS`, after `healthIntervalMs: 15_000,` add

```ts
  /** Plan 7 D10: an answer's byte cap; a full Solana block in `jsonParsed` stays far below. */
  maxResponseBytes: 64 * 1024 * 1024,
```

and at the end of `validateOptions`, after the `POSITIVE_MS_OPTIONS` loop, add

```ts
  const cap = options.maxResponseBytes;
  if (cap !== undefined && !(Number.isSafeInteger(cap) && cap > 0)) {
    throw new ConfigError('CONFIG_INVALID', 'maxResponseBytes must be an integer > 0');
  }
```

- [ ] **Step 4: Read every body through the cap**

In the SDK bridge (`createFetch`), replace `const buffer = await response.arrayBuffer();` with `const buffer = await this.#body(endpoint, response);`. In `#exchange`, replace `const text = await response.text();` with

```ts
    const bytes = await this.#body(endpoint, response);
    const text = new TextDecoder().decode(bytes);
```

and replace `this.#emitResponse(endpoint, label, started, new TextEncoder().encode(text).length);` with `this.#emitResponse(endpoint, label, started, bytes.byteLength);`. Before the JSDoc `/** M9: the \`rpc.response\` event is emitted identically from \`#exchange\` and the SDK bridge. */` add:

```ts
  /**
   * Plan 7 D10 (lesson 20): an answer's body, at most `maxResponseBytes`. A longer one, by
   * its declared length or as it streams, is cancelled and fails as a retryable
   * `PROVIDER_UNAVAILABLE`, tagged as possibly delivered, since the server did answer (R16).
   */
  async #body(endpoint: Endpoint, response: Response): Promise<Uint8Array> {
    const limit = this.#opts.maxResponseBytes;
    const tooLarge = () =>
      this.#markSent(
        new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `endpoint answered more than ${limit} bytes`,
          { context: this.#context(endpoint) },
        ),
      );
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (declared > limit) {
      void response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    if (!response.body) return new Uint8Array(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

```

- [ ] **Step 5: Run the transport suites to see them pass**

Run: `pnpm exec jest test/core/transport`
Expected: PASS, 174 tests (`response-cap.test.ts` 6; every existing transport test unchanged, the SDK bridge's included).

- [ ] **Step 6: Document it**

In `docs/guides/concepts.md`, "Provider and transport", after the sentence "SDKs never see real URLs." (the end of its line) add the two lines

```markdown
One answer is at most `transport.maxResponseBytes` (64 MiB by default); a longer one is cut
off and retried elsewhere, so one endpoint cannot exhaust the process's memory.
```

Run: `mdcheck docs/guides/concepts.md`
Expected: `docs/guides/concepts.md 23`.

- [ ] **Step 7: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2802 passed, 2817 total` (142 suites).

```bash
git add src/core/transport/types.ts src/core/transport/http-transport.ts \
  test/core/transport/response-cap.test.ts docs/guides/concepts.md
git commit -m "fix(core): one endpoint answer is at most transport.maxResponseBytes (lesson 20)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Added: "`transport.maxResponseBytes` (64 MiB by default): a longer answer is cancelled and fails as a retryable `PROVIDER_UNAVAILABLE`, so one endpoint cannot exhaust the process's memory."

**Review points:**
- Both body reads go through `#body`: the driver path (`#exchange`, which `rpc`, `rpcRaw`, `http` and the probes use) and the SDK bridge; no other `response.text()` or `arrayBuffer()` remains in the transport (`rg "response\.(text|arrayBuffer)\(" src/core/transport` finds nothing).
- A declared `content-length` above the cap is refused before reading; a streamed answer is cancelled at the first chunk past the cap (the test bounds what is pulled to the cap plus two 64 KiB chunks).
- The error is tagged possibly delivered (R16), so a broadcast whose answer was oversized is ambiguous, never refused.
- `rpc.response` now reports the wire bytes; for valid UTF-8 this equals the old re-encoded length.

## Task 7: Rate-limited probes keep what they knew; one forged head decays (Tier 4, F4-R24, F6-R28, F4-R20 (2), F6-R22)

**Files:**
- Modify: `src/core/transport/http-transport.ts` (`rateLimited`, `#verifiedPeak`, `#peakMisses`, `#checkIdentity`, `#refresh`, a new `#decayPeak`)
- Test: `test/core/transport/probe-limits.test.ts` (new); `test/core/transport/probe-rate-limit.test.ts` (explicit budgets)
- Docs: `docs/guides/concepts.md`, `docs/guides/networks.md` (Tron networks)

**Interfaces:**
- Consumes: `HEALTH_MISS_LIMIT` (3, A24's count), `Endpoint.notBefore` (set by `#applyRateLimit` from a 429's `Retry-After`, or backoff), `isStaleView` (`src/core/transport/stale-view.ts`) in the test.
- Produces: no new public API. `highestHeight()` may now fall, only by `#decayPeak`.

- [ ] **Step 1: Write the failing test (Review Focus 5)**

Create `test/core/transport/probe-limits.test.ts`:

```ts
// Plan 7 D10 (F4-R24, F6-R28, F4-R20 (2), F6-R22): a rate-limited probe keeps the last good
// height and identity, and one forged far-future head no longer stales every view for good.
import { isStaleView } from '../../../src/core/transport/stale-view';
import { drive } from '../../../src/testing/fake-clock';
import {
  FakeFetch,
  type FakeReply,
  type FakeRequest,
} from '../../../src/testing/fake-fetch';
import { setup } from './support';

type Rpc = { id: unknown; method: string };
const answer = (req: FakeRequest, result: unknown): FakeReply => ({
  json: { jsonrpc: '2.0', id: req.json<Rpc>().id, result },
});
const LIMITED: FakeReply = { status: 429, text: '', headers: { 'retry-after': '2' } };

/** A node on chain id 1 at `height()`, whose methods `limit` may answer with a 429. */
function node(height: () => number, limit: Set<string> = new Set(), balance = '0x0') {
  const served: string[] = [];
  const handler = (req: FakeRequest): FakeReply => {
    const { method } = req.json<Rpc>();
    served.push(method);
    if (limit.has(method)) return LIMITED;
    if (method === 'eth_chainId') return answer(req, '0x1');
    if (method === 'eth_blockNumber') return answer(req, `0x${height().toString(16)}`);
    return answer(req, balance);
  };
  return { handler, served, limit };
}

const probes = {
  identity: async (call: { rpc<T>(m: string): Promise<T> }) =>
    String(BigInt(await call.rpc<string>('eth_chainId'))),
  expectedIdentity: '1',
  height: async (call: { rpc<T>(m: string): Promise<T> }) =>
    BigInt(await call.rpc<string>('eth_blockNumber')),
};

describe('rate-limited health probes (F4-R24, F6-R28)', () => {
  it('keeps the last good height through a height-probe 429, so reads go on', async () => {
    const n = node(() => 100);
    const fake = new FakeFetch().route('https://a.example', n.handler);
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    n.limit.add('eth_blockNumber');
    await clock.advance(15_001);
    await drive(clock, transport.refreshHealth());
    expect(transport.status()[0]).toMatchObject({ state: 'healthy', height: 100n });
    n.limit.clear();
    await expect(
      drive(clock, transport.rpc('eth_getBalance', [], { purpose: 'monitor' })),
    ).resolves.toBe('0x0');
  });

  it('waits out an identity-probe 429 for its Retry-After, not a health interval', async () => {
    const n = node(() => 100, new Set(['eth_chainId']));
    const fake = new FakeFetch().route('https://a.example', (req) => {
      const reply = n.handler(req);
      n.limit.clear(); // one 429 (Retry-After: 2), then answers
      return reply;
    });
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes({ identity: probes.identity, expectedIdentity: '1' });
    await expect(drive(clock, transport.rpc('eth_getBalance'))).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    // Before, the endpoint stayed locked out for a whole health interval (15 s).
    await clock.advance(2_001);
    await expect(drive(clock, transport.rpc('eth_getBalance'))).resolves.toBe('0x0');
  });

  it('keeps a rate-limited endpoint in the proof count, so the other never proves alone', async () => {
    const a = node(() => 100, new Set(), '0x1');
    const b = node(() => 100, new Set(), '0x2');
    const fake = new FakeFetch()
      .route('https://a.example', a.handler)
      .route('https://b.example', b.handler);
    const { transport, clock } = setup(
      [
        { name: 'a', url: 'https://a.example' },
        { name: 'b', url: 'https://b.example' },
      ],
      fake,
    );
    transport.setProbes({ identity: probes.identity, expectedIdentity: '1' });
    await drive(clock, transport.refreshHealth());
    b.limit.add('eth_chainId');
    for (let i = 0; i < 4; i++) {
      await clock.advance(15_001);
      await drive(clock, transport.refreshHealth());
    }
    expect(transport.status()[1]).toMatchObject({ state: 'healthy' });
    b.limit.clear();
    await clock.advance(2_001); // a proof read never waits out a pending Retry-After
    // b still counts, so a's answer alone decides nothing; before, three rate-limited
    // re-probes were three health misses, b left the count, and a proved alone.
    await expect(
      drive(clock, transport.rpc('eth_getBalance', [], { quorum: 'proof' })),
    ).rejects.toMatchObject({ code: 'PROVIDER_INCONSISTENT' });
  });

  it('does not probe an endpoint before the Retry-After its 429 asked for', async () => {
    const n = node(() => 100);
    const fake = new FakeFetch().route('https://a.example', n.handler);
    const { transport, clock } = setup([{ name: 'a', url: 'https://a.example' }], fake);
    transport.setProbes(probes);
    await drive(clock, transport.refreshHealth());
    n.limit.add('eth_blockNumber');
    await clock.advance(15_001);
    await drive(clock, transport.refreshHealth()); // the 429 asks for 2 s
    const before = n.served.length;
    await clock.advance(1_000);
    await drive(clock, transport.refreshHealth());
    expect(n.served.length).toBe(before);
  });
});

describe('the height high-water mark (F4-R20 (2), F6-R22)', () => {
  function threeNodes(liar: () => number) {
    const honest = node(() => 100);
    const lying = node(liar);
    const fake = new FakeFetch()
      .route('https://a.example', honest.handler)
      .route('https://b.example', honest.handler)
      .route('https://c.example', lying.handler);
    const { transport, clock } = setup(
      [
        { name: 'a', url: 'https://a.example' },
        { name: 'b', url: 'https://b.example' },
        { name: 'c', url: 'https://c.example' },
      ],
      fake,
    );
    transport.setProbes(probes);
    const refresh = async () => {
      await clock.advance(15_001);
      await drive(clock, transport.refreshHealth());
    };
    return { transport, clock, refresh };
  }

  it('drops a forged far-future head after three refreshes without it', async () => {
    let forged = true;
    const { transport, clock, refresh } = threeNodes(() => (forged ? 10 ** 12 : 100));
    await drive(clock, transport.refreshHealth());
    expect(transport.highestHeight()).toBe(10n ** 12n);
    expect(isStaleView(transport, 100n)).toBe(true);
    forged = false;
    await refresh();
    await refresh();
    expect(isStaleView(transport, 100n)).toBe(true);
    await refresh();
    expect(transport.highestHeight()).toBe(100n);
    expect(isStaleView(transport, 100n)).toBe(false);
  });

  it('keeps a peak that a verified endpoint comes within maxLagBlocks of', async () => {
    let height = 110;
    const { transport, clock, refresh } = threeNodes(() => height);
    await drive(clock, transport.refreshHealth());
    height = 105; // the default maxLagBlocks (5) below the peak of 110
    for (let i = 0; i < 4; i++) await refresh();
    expect(transport.highestHeight()).toBe(110n);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec jest test/core/transport/probe-limits.test.ts`
Expected: FAIL, 5 of 6: the height is cleared (`state: 'unknown'`) and the monitor read finds no endpoint; the identity lockout lasts 15 s; three rate-limited re-probes drop `b` from the proof count, so `a` answers alone (`0x1` instead of `PROVIDER_INCONSISTENT`); a probe goes out before the `Retry-After`; the forged peak stays. "keeps a peak that a verified endpoint comes within maxLagBlocks of" passes already (it guards the decay rule's bound).

- [ ] **Step 3: Keep the last good height and identity through a rate-limited probe**

In `src/core/transport/http-transport.ts`, after `const TIMEOUT = new Error('transport timeout');` add

```ts
/**
 * Plan 7 D10 (F4-R24, F6-R28): whether a probe failed only because the endpoint rate-limited
 * it, directly or as the cause of a failed identity check. Such a probe learned nothing
 * about the endpoint's health, which keeps its last good height and identity.
 */
function rateLimited(error: unknown): boolean {
  return (
    isCryptoAioError(error, 'RATE_LIMITED') ||
    (error instanceof Error && isCryptoAioError(error.cause, 'RATE_LIMITED'))
  );
}
```

In `#checkIdentity`'s `catch`, replace

```ts
      if (!callerAborted) {
        endpoint.identityRetryAt = this.#clock.now() + this.#opts.healthIntervalMs;
      }
```

with

```ts
      if (!callerAborted) {
        // Plan 7 D10: a rate-limited probe waits out the endpoint's own delay (its
        // Retry-After, or backoff), not a whole health interval.
        endpoint.identityRetryAt = rateLimited(error)
          ? endpoint.notBefore
          : this.#clock.now() + this.#opts.healthIntervalMs;
      }
```

In `#refresh`, as the first statement of the `targets.map(async (endpoint) => {` callback, add

```ts
        // Plan 7 D10: an endpoint that asked us to wait (a 429's Retry-After, or backoff) is
        // not probed until then, and keeps its last height and identity meanwhile: neither
        // a miss nor a success.
        if (endpoint.notBefore > this.#clock.now()) return;
```

and as the first statement of its `catch (error) {` block (before `endpoint.height = undefined;`) add

```ts
          // Plan 7 D10 (F4-R24, F6-R28): a rate-limited probe learned nothing, so the
          // endpoint keeps its last good height and identity and records no miss.
          if (rateLimited(error)) return;
```

- [ ] **Step 4: Let a peak no verified endpoint confirms decay**

Replace the field comment and add a counter:

```ts
  /** I2: the highest height ever verified by an identity-checked endpoint; never lowered. */
  #verifiedPeak: bigint | undefined;
```

becomes

```ts
  /** I2: the highest height verified by an identity-checked endpoint; lowered only by
   * `#decayPeak`. */
  #verifiedPeak: bigint | undefined;
  /** Plan 7 D10: completed refreshes in a row whose verified best stayed below the peak. */
  #peakMisses = 0;
```

In `#refresh`, after

```ts
      if (this.#identityProbed())
        this.#verifiedPeak = maxHeight(this.#verifiedPeak, best);
```

add `this.#decayPeak(best);` (inside the same `if (best !== undefined)` block). Before `// ---- errors ----…` add:

```ts
  /**
   * Plan 7 D10 (F4-R20 (2), F6-R22): the high-water mark only rose, so one probe that saw a
   * forged far-future head made every view stale until restart. A peak that no verified
   * endpoint comes within `maxLagBlocks` of, for three completed refreshes in a row (A24's
   * count), falls back to the refresh's verified best. Liveness only: a stale view decides
   * nothing, and proofs never read this mark.
   */
  #decayPeak(best: bigint): void {
    const peak = this.#highest;
    if (peak === undefined || best + BigInt(this.#opts.maxLagBlocks) >= peak) {
      this.#peakMisses = 0;
      return;
    }
    this.#peakMisses += 1;
    if (this.#peakMisses < HEALTH_MISS_LIMIT) return;
    this.#peakMisses = 0;
    this.#highest = best;
    this.#verifiedPeak = best;
  }

```

- [ ] **Step 5: Give the long probe tests explicit budgets**

`test/core/transport/probe-rate-limit.test.ts` fails 4 tests (three test definitions, one run for two intervals) under `--detectOpenHandles` on `main` already (each drives thousands of fake-clock steps and crosses Jest's 5-second default when the flag slows it; the Plan 3–6 handoffs record it). Give each an explicit 30-second budget: before `describe('health probes inside the rate limit (A17)', () => {` add

```ts
// The three long tests drive thousands of fake-clock steps; `--detectOpenHandles` slows each
// past Jest's 5-second default, so they carry explicit budgets (Plan 4 handoff §6).
```

end the tests "keeps probes healthy behind 80 queued reads (M1: no probe starvation)" and "puts probes ahead of reads already waiting for tokens (M1: no probe starvation)" with `}, 30_000);` instead of `});`, and in the `it.each([1_000, 5_000])` test add `30_000,` as the argument after its test function (before the closing `);`).

- [ ] **Step 6: Run the transport suites to see them pass**

Run: `pnpm exec jest test/core/transport`, then `pnpm exec jest test/core/transport/probe-rate-limit.test.ts test/core/transport/probe-limits.test.ts --detectOpenHandles`
Expected: PASS (`probe-limits.test.ts` 6; every existing transport test unchanged), and 13/13 under `--detectOpenHandles`. Then, as for every transport change (P25-R1), run the transport suites 30 times in a row: `for i in $(seq 30); do pnpm exec jest test/core/transport --silent || break; done` — expected: 30 green runs (180 tests each).

- [ ] **Step 7: Rewrite the guides**

In `docs/guides/concepts.md`, "Provider and transport", after the line that ends "set your own for fast testnets with several endpoints." add

```markdown
A health check that an endpoint answers with HTTP 429 learns nothing: the endpoint keeps
its last good height and identity, and is checked again after its `Retry-After`. The
highest height a verified endpoint reported is the mark every view must stay within
`maxLagBlocks` of; a mark that no verified endpoint comes that close to for three health
refreshes in a row is dropped, so one endpoint that once reported a far-future head cannot
leave every view stale.
```

In `docs/guides/networks.md`, "Tron networks", replace

```markdown
  provider:** keyless TronGrid answers mainnet with HTTP 429, and the handle then finds no
  healthy endpoint. TronGrid
```

with

```markdown
  provider:** keyless TronGrid answers most mainnet requests with HTTP 429. An endpoint
  that rate-limits a health check keeps its last good height and is checked again after its
  `Retry-After`, but one that has never answered a check is never confirmed, and the handle
  then finds no healthy endpoint. TronGrid
```

Run: `mdcheck docs/guides/concepts.md docs/guides/networks.md`
Expected: `23` and `60`.

- [ ] **Step 8: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2808 passed, 2823 total` (143 suites).

```bash
git add src/core/transport/http-transport.ts test/core/transport/probe-limits.test.ts \
  test/core/transport/probe-rate-limit.test.ts docs/guides/concepts.md docs/guides/networks.md
git commit -m "fix(core): rate-limited probes keep the last good height; a forged head decays (F4-R24, F6-R28, F4-R20)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Changed: "A health check that an endpoint rate-limits (HTTP 429), or that would come before the `Retry-After` of an earlier 429, keeps the endpoint's last good height and identity and is no health miss; a rate-limited identity check retries after the endpoint's `Retry-After` instead of 15 seconds."
- Changed: "The height high-water mark that a view must stay within `maxLagBlocks` of falls back to the verified best height after three health refreshes in a row in which no verified endpoint comes that close to it, so one endpoint that once reported a far-future head no longer leaves every view stale until restart."

**Review points:**
- Safety first: a rate-limited probe is neither a miss nor a success, so a rate-limiting endpoint stays in the proof count (A24) instead of leaving it and letting the other endpoint prove alone; the test "keeps a rate-limited endpoint in the proof count" pins it.
- A first-use identity check that meets a 429 still fails its request at once (a throttled endpoint is no candidate); what changes is that the lockout lasts the endpoint's `Retry-After` (or backoff), not 15 s.
- The decay reads only verified endpoints' heights (`#verifiedMaxHeight`), counts completed refreshes, and resets as soon as one comes within `maxLagBlocks`; proofs never read `highestHeight()` (they measure lag against the second-highest height).
- A persistently rate-limiting endpoint that never answers a probe keeps counting toward the proof quorum's size forever, so proofs wait (liveness only); Appendix B records it.

## Task 8: The root's `close()` stops the worker loops (Tier 4, N3)

**Files:**
- Modify: `src/core/container/internals.ts` (`RootRuntime.closing`), `src/core/container/container.ts` (`workerSignal`, the `operations` and `monitor` getters, `close`)
- Test: `test/core/container/close-workers.test.ts` (new); `test/core/lifecycle/workers.test.ts` (two M8 assertions)
- Docs: `docs/guides/transactions.md`

**Interfaces:**
- Consumes: `closedError()` (`internals.ts`), `AbortSignal.any` (Node ≥ 20.3).
- Produces: `aio.monitor.start()`, `aio.monitor.runOnce()` and `aio.operations.recover()` run under the caller's signal combined with the root's `closing` signal; on a closed container they reject with `INVALID_TRANSITION`. Their signatures do not change.

- [ ] **Step 1: Write the failing test**

Create `test/core/container/close-workers.test.ts`:

```ts
// N3 (Plan 1 handoff §4): a closed container stops its worker loops and refuses new ones, so
// it never claims another Operation from a shared store and never keeps the process alive.
import { MemoryOperationStore } from '../../../src/core/store/memory';
import { createFakeEnv } from '../../../src/testing';
import { settle } from '../../../src/testing/fake-clock';

/** An operation store that counts the claims workers make. */
class CountingStore extends MemoryOperationStore {
  claims = 0;

  override claimDue(
    ...args: Parameters<MemoryOperationStore['claimDue']>
  ): ReturnType<MemoryOperationStore['claimDue']> {
    this.claims += 1;
    return super.claimDue(...args);
  }
}

describe('close() stops the workers (N3)', () => {
  it('ends a running monitor loop and claims nothing after close', async () => {
    const operations = new CountingStore();
    const env = await createFakeEnv({ stores: { operations } });
    let ended = false;
    const loop = env.aio.monitor.start({ workerId: 'w1' }).then(() => {
      ended = true;
    });
    await env.clock.advance(5_000);
    await settle();
    expect(operations.claims).toBeGreaterThan(0);
    expect(ended).toBe(false);
    await env.aio.close();
    await settle();
    expect(ended).toBe(true);
    const before = operations.claims;
    await env.clock.advance(60_000);
    await settle();
    expect(operations.claims).toBe(before);
    await loop;
  });

  it('stops a loop started with its own signal too', async () => {
    const env = await createFakeEnv();
    const controller = new AbortController();
    let ended = false;
    void env.aio.monitor.start({ signal: controller.signal }).then(() => {
      ended = true;
    });
    await settle();
    await env.aio.close();
    await settle();
    expect(ended).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it('refuses a new loop, pass or recovery once closed', async () => {
    const env = await createFakeEnv();
    await env.aio.close();
    for (const work of [
      () => env.aio.monitor.start(),
      () => env.aio.monitor.runOnce(),
      () => env.aio.operations.recover(),
    ]) {
      await expect(work()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec jest test/core/container/close-workers.test.ts`
Expected: FAIL, 3 of 3: the loop is still running after `close()` and keeps claiming, and `start`, `runOnce` and `recover` all run on a closed container.

- [ ] **Step 3: Give the root a `closing` signal**

In `src/core/container/internals.ts`, in `interface RootRuntime`, after `closed: boolean;` add

```ts
  /** N3: aborted by the root's `close()`, which stops every worker loop and recovery. */
  readonly closing: AbortController;
```

In `src/core/container/container.ts`, after `const NAMESPACE = /^[A-Za-z0-9._-]{1,64}$/;` add

```ts

/**
 * N3: the signal a worker loop, pass or recovery runs under: the caller's, if any, and the
 * root's `closing`, which `close()` aborts. A closed container starts no new work.
 */
function workerSignal(
  runtime: RootRuntime,
  signal: AbortSignal | undefined,
): AbortSignal {
  if (runtime.closed) throw closedError();
  return signal
    ? AbortSignal.any([signal, runtime.closing.signal])
    : runtime.closing.signal;
}
```

In the constructor's `runtime` object, after `closed: false,` add `closing: new AbortController(),`.

- [ ] **Step 4: Run every worker under it, and abort it on close**

In the `operations` getter, replace `recover: (options) => internals.monitor().recover(options),` with

```ts
      recover: async (options = {}) =>
        internals.monitor().recover({
          ...options,
          signal: workerSignal(internals.runtime, options.signal),
        }),
```

In the `monitor` getter, replace

```ts
      start: (options) => internals.monitor().start(options),
      runOnce: (options = {}) =>
        internals.monitor().runOnce({
          workerId: options.workerId ?? internals.runtime.owner,
          ...(options.batch !== undefined ? { batch: options.batch } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }),
```

with

```ts
      start: async (options = {}) =>
        internals.monitor().start({
          ...options,
          signal: workerSignal(internals.runtime, options.signal),
        }),
      runOnce: async (options = {}) =>
        internals.monitor().runOnce({
          workerId: options.workerId ?? internals.runtime.owner,
          ...(options.batch !== undefined ? { batch: options.batch } : {}),
          signal: workerSignal(internals.runtime, options.signal),
        }),
```

In `close()`, after `runtime.closed = true;` add

```ts
    // N3: every worker loop, pass and recovery stops at its next check, and its sleeps end.
    runtime.closing.abort();
```

- [ ] **Step 5: Compare the pass signal by effect in the M8 tests**

Two tests in `test/core/lifecycle/workers.test.ts` ("resends carry the pass signal (M8)") pin that the resend receives the caller's signal object itself; it now receives the caller's signal combined with `closing`. In "passes the pass signal to the rebroadcast of a dropped attempt", replace `expect(signals[0]).toBe(ctl.signal);` with

```ts
    // N3: the pass runs under the caller's signal combined with the container's `closing`.
    expect(signals[0]?.aborted).toBe(false);
    ctl.abort();
    expect(signals[0]?.aborted).toBe(true);
```

and in "passes recovery's signal to the resend of a signed operation", replace `expect(signals[0]).toBe(ctl.signal);` with

```ts
    expect(signals[0]?.aborted).toBe(false);
    ctl.abort();
    expect(signals[0]?.aborted).toBe(true);
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm exec jest test/core/container test/core/lifecycle`
Expected: PASS (`close-workers.test.ts` 3; `workers.test.ts` 35).

- [ ] **Step 7: Document it**

In `docs/guides/transactions.md`, "Background workers and startup recovery", replace

```markdown
- Call `close()` on the root container; a scope's `close()` does nothing. After it, handle
  methods and `native()` throw `StateError` (`INVALID_TRANSITION`).
```

with

```markdown
- Call `close()` on the root container; a scope's `close()` does nothing. After it, handle
  methods and `native()` throw `StateError` (`INVALID_TRANSITION`). It also stops every
  `monitor.start()` loop, and a running `runOnce()` or `recover()` at its next check, so
  the closed container claims no more Operations; starting one afterwards throws
  `INVALID_TRANSITION` too.
```

Run: `mdcheck docs/guides/transactions.md`
Expected: `docs/guides/transactions.md 35`.

- [ ] **Step 8: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2811 passed, 2826 total` (144 suites).

```bash
git add src/core/container/internals.ts src/core/container/container.ts \
  test/core/container/close-workers.test.ts test/core/lifecycle/workers.test.ts \
  docs/guides/transactions.md
git commit -m "fix(core): close() stops the worker loops and refuses new ones (N3)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Changed: "The root container's `close()` also stops every `monitor.start()` loop, and a running `runOnce()` or `operations.recover()` at its next check; starting one on a closed container throws `INVALID_TRANSITION`."

**Review points:**
- `close()` aborts before it closes native clients and the pool, so a loop's sleep ends at once (no real timer keeps the process alive) and a pass skips the Operations it has not started.
- A pass already inside a check sees the abort at its next signal check; its claim then lapses after `claimLeaseMs`, as after a crash. `close()` does not wait for it: a fenced store call of a killed test generation never settles, and "never close the killed container" (R71) must stay safe.
- A scope shares its root's runtime, so a scope's workers stop too; a scope's own `close()` still does nothing.

## Task 9: The guides say how to credit deposits, map spec §18, and name the release (Tier 1b, 1c, 3)

**Files:**
- Modify: `docs/guides/concepts.md`, `docs/guides/security.md`, `docs/guides/networks.md`, `docs/guides/index.md`, `docs/guides/transactions.md`
- Test: `test/docs/links.test.ts` (new)

**Interfaces:**
- Consumes: the final code of Tasks 1–8 (the guides describe it).
- Produces: the anchor `transactions.md#crediting-deposits`, which Tasks 10 and 12 link to; `index.md`'s map of spec §18's guides (D9).

- [ ] **Step 1: Write the link check (D15)**

Create `test/docs/links.test.ts`:

```ts
// Plan 7: every relative link in the README, the changelog and the guides resolves to a
// tracked file, and every `#anchor` to a heading of its target (GitHub's heading ids).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const GUIDES = [
  'concepts.md',
  'index.md',
  'networks.md',
  'quick-start.md',
  'security.md',
  'transactions.md',
  'tutorial.md',
].map((name) => join(ROOT, 'docs/guides', name));
const FILES = [join(ROOT, 'README.md'), join(ROOT, 'CHANGELOG.md'), ...GUIDES];

/** The lines of a Markdown file outside fenced code blocks. */
function prose(text: string): string[] {
  let fenced = false;
  return text.split('\n').filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    return !fenced;
  });
}

/** GitHub's heading ids (github-slugger), with -1, -2 … for repeats. */
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = heading
      .toLowerCase()
      .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    ids.add(count === 0 ? base : `${base}-${count}`);
  }
  return ids;
}

/** Relative link targets outside code: `[text](target)`, never `http(s):` or `mailto:`. */
function links(file: string): string[] {
  const out: string[] = [];
  for (const line of prose(readFileSync(file, 'utf8'))) {
    const text = line.replace(/`[^`]*`/g, '');
    for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] as string;
      if (!/^(https?:|mailto:)/.test(target)) out.push(target);
    }
  }
  return out;
}

describe('documentation links', () => {
  it.each(FILES.map((file) => [relative(ROOT, file), file]))(
    'every relative link in %s resolves',
    (_name, file) => {
      const broken: string[] = [];
      for (const target of links(file)) {
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const resolved = path === '' ? file : join(dirname(file), path);
        if (!existsSync(resolved)) broken.push(`${target} (no such file)`);
        else if (anchor !== undefined && resolved.endsWith('.md')) {
          if (!anchors(resolved).has(anchor)) broken.push(`${target} (no such heading)`);
        }
      }
      expect(broken).toEqual([]);
    },
  );
});
```

Run: `pnpm exec jest test/docs/links.test.ts`
Expected: PASS, 9 tests (the docs of `db73e90` have no broken link). It fails as soon as a link or anchor breaks: appending `See [a](./concepts.md#no-such-heading) and [b](./missing.md).` to `index.md` gives `./concepts.md#no-such-heading (no such heading)` and `./missing.md (no such file)`; restore the file from a byte copy afterwards.

- [ ] **Step 2: Correct the deposit promise (F6-R36, the release blocker)**

In `docs/guides/concepts.md`, "Evidence and finality", replace

```markdown
`finality` is `none`, `probabilistic` (included) or `final`. Credit deposits and complete
withdrawals only on `final` with `proven` evidence.
```

with

```markdown
`finality` is `none`, `probabilistic` (included) or `final`. Complete a withdrawal (your own
Operation) only on `final` with `proven` evidence. A deposit is read, not proven: every
family's scanner, `history` and `getTransaction` report it with `observed` evidence, so
credit it as [Crediting deposits](./transactions.md#crediting-deposits) says.
```

In `docs/guides/security.md`, "Production checklist", replace

```markdown
- [ ] Credit and complete only on `final` with `proven` evidence. Dedupe deposits on the
      transfer id. On Bitcoin, skip a transfer whose `to` is among its `from` addresses
      (change, a cancel's refund), and never use a scanned deposit address as a change
      address.
```

with

```markdown
- [ ] Complete withdrawals only on `final` with `proven` evidence. Credit deposits, which
      are `observed` in every family, only once read `final`, and automatically (or above
      your risk threshold) only once an independent provider reads the same transfer final
      ([Crediting deposits](./transactions.md#crediting-deposits)). Dedupe deposits on the
      transfer id. On Bitcoin, skip a transfer whose `to` is among its `from` addresses
      (change, a cancel's refund), and never use a scanned deposit address as a change
      address.
```

and in the TON line of the same checklist replace

```markdown
      notification, deduped on that transfer id, not on the trace id. TON deposits are
      `observed` only, an exception to "credit only on `proven`" above: credit one only
      once an independent provider and indexer pair has read it final and agrees on it.
```

with

```markdown
      notification, deduped on that transfer id, not on the trace id; the independent read
      that confirms a TON deposit uses another provider **and** indexer pair.
```

In `docs/guides/networks.md`, "TON networks", replace

```markdown
- **Crediting deposits.** History entries are reads of one provider and one indexer, so
  their evidence is `observed` (with `finality: 'final'`), never `proven`. This release has
  no proven deposit read: TON deposits are an explicit exception to "credit only on `final`
  with `proven` evidence", and a jetton deposit's genuineness also rests on the provider's
  get-methods. So before
```

with

```markdown
- **Crediting deposits.** History entries are reads of one provider and one indexer, so
  their evidence is `observed` (with `finality: 'final'`), never `proven`, as every family's
  deposits are ([Crediting deposits](./transactions.md#crediting-deposits)), and a jetton
  deposit's genuineness also rests on the provider's get-methods. So before
```

- [ ] **Step 3: Add "Crediting deposits" (with N8) and the missing error row**

In `docs/guides/transactions.md`, after the paragraph that ends

```markdown
TON reads it from its indexer (toncenter API v3); [TON networks](./networks.md#ton-networks)
shows how its deposits appear there and how to credit them.
```

(the end of "Address history"), add:

```markdown

### Crediting deposits

A deposit is a transfer that none of your Operations made, so no proof backs it: every read
that returns one (`bc.scanner()`, `bc.history()` and `bc.getTransaction()`) reads one
endpoint, and its status carries `evidence: 'observed'` in every family. Its `finality` is
`'final'` once that endpoint reports the block at or below its finalized height. The library
has no proven deposit read yet, so credit a deposit this way:

1. Take it from a `final` read: a scanner in `mode: 'final'`, or a transaction whose
   `status.finality` is `'final'`.
2. Credit only transfers to your own deposit addresses, and dedupe on `transfer.id`: scans
   and history deliver at least once, and a history can list one transaction twice.
3. Before you credit automatically, or above your risk threshold, read the transaction again
   through an independent provider (and indexer, where the family reads one), for example
   `bc.with({ provider: 'second' }).getTransaction(tx.id)`, and credit it only when both
   reads are final and agree on the transaction hash, the recipient, the asset, the amount
   and the memo.
4. Leave a transfer whose asset did not resolve (`transfer.unresolved`) for review.

| Family | Deposit reads | What one read rests on |
| --- | --- | --- |
| EVM | `scanner()`: native transfers and ERC-20 `Transfer` logs from each block's receipts; no `history()` | the block and receipts one endpoint serves |
| Bitcoin | `scanner()`, and `history()` (confirmed only) | one Esplora endpoint's block pages or address history |
| Tron | `scanner()`, and `history()` from TronGrid, each entry read back from the `provider` | one endpoint's block, or one indexer's listing read back from one endpoint |
| Solana | `scanner()`, and `history()` from `getSignaturesForAddress`, each item read back | one endpoint's block or signature list |
| TON | `history()` only, from the indexer, with the provider's get-methods for jettons | one indexer endpoint and one provider endpoint |

Each family's own rules still apply: on Bitcoin skip a transfer whose `to` is among its
`from` addresses (change and cancel refunds); on Solana credit SPL deposits by the owner
wallet (`transfer.to`); on TON credit a jetton deposit only from its arrival in the owner's
jetton wallet ([TON networks](./networks.md#ton-networks)). A scanner in `final` mode emits
a block only once the network's finality policy holds, and it decides a rollback only when
the proof quorum serves a different block hash, but the transfers in a block are what the one
endpoint that served it reported: a lying endpoint could add a transfer to a real block. The
second read through an independent provider catches that.
```

In "Error handling", after the row that starts `| \`INSUFFICIENT_FUNDS\`, \`POLICY_REJECTED\` with state \`failed\` |`, add the row (the Plan 1 handoff §5 note):

```markdown
| `POLICY_REJECTED` with state `prepared` | The `beforeSign` hook vetoed after the address lease was lost (a `prepareTransfer` hook that outlasted `lifecycle.leaseMs`), so nothing was written | Repeat with the **same** key; the hook runs again |
```

(The two other Plan 1 §5 notes are in the guides already: `beforeSign` may run more than once per Operation, in `security.md`; `1n` and `'1'` fee overrides are different intents, in `transactions.md`, "Fees".)

- [ ] **Step 4: One provider-count line (F4-R27)**

In `docs/guides/security.md`, "Production checklist", replace

```markdown
- [ ] At least two independent providers per network, so proofs are cross-checked. No
      `public` preset in production.
```

with

```markdown
- [ ] Two or three independent providers per network, so proofs are cross-checked: with
      two, an outage of one leaves the other deciding alone, so use three for production
      proofs. No `public` preset in production.
```

- [ ] **Step 5: Name the release, and map spec §18's guides (A16, D9)**

In `docs/guides/index.md`, "Status", replace

```markdown
The library ships in roadmap milestones called plans. Plan 1, the core, and Plan 2, the
**EVM family**, are complete: Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain,
Arbitrum, Optimism and Base, through ethers (the default) or web3. The fake family from
`crypto-aio/testing` is a deterministic, in-memory chain for learning and testing. Plan 3,
the **UTXO family**, Plan 4, the **Tron family**, Plan 5, the **Solana family**, and Plan 6,
the **TON family**, are complete too: Bitcoin (mainnet, testnet, testnet4, signet, regtest)
through bitcoinjs-lib and an Esplora indexer, Tron through tronweb, Solana (mainnet, devnet
and testnet) through `@solana/web3.js`, and TON (mainnet and testnet) through `@ton/ton`.
```

with

```markdown
These guides describe crypto-aio 0.1.0, the first release of this API. It ships the core and
five chain families: the **EVM family** (Ethereum, BNB Smart Chain, Polygon, Avalanche
C-Chain, Arbitrum, Optimism and Base, through ethers, the default, or web3), the **UTXO
family** (Bitcoin: mainnet, testnet, testnet4, signet and regtest, through bitcoinjs-lib and
an Esplora indexer), the **Tron family** (tronweb), the **Solana family** (mainnet, devnet
and testnet, through `@solana/web3.js`) and the **TON family** (mainnet and testnet, through
`@ton/ton`; its coin is Gram, formerly Toncoin). The fake family from `crypto-aio/testing` is
a deterministic, in-memory chain for learning and testing.
```

and after the "Map of the guides" table (its last row starts `| [Using any blockchain network](./networks.md)`) add:

```markdown

The design spec plans seven guides under `docs/guide/`; their topics live in the six guides
above:

| Spec guide | Where it is |
| --- | --- |
| `architecture.md` | [Core concepts](./concepts.md#the-layers) |
| `configuration.md` | [Core concepts](./concepts.md#configuration-precedence) and [Keys, signers and secrets](./security.md#secrets-and-redaction) |
| `transactions.md` | [Sending and receiving](./transactions.md#sending) |
| `exchange-operations.md` | [Receiving](./transactions.md#receiving), [Crediting deposits](./transactions.md#crediting-deposits), [Background workers](./transactions.md#background-workers-and-startup-recovery) and the [production checklist](./security.md#production-checklist) |
| `stores.md` | [Stores](./concepts.md#stores) and [Testing an adapter or a store](./networks.md#testing-an-adapter-or-a-store) |
| `writing-adapters.md` | [A new family: the plugin API](./networks.md#3-a-new-family-the-plugin-api) |
| `security.md` | [Keys, signers and secrets](./security.md) |
```

- [ ] **Step 6: Check the guides**

Run: `mdcheck docs/guides/*.md && pnpm exec jest test/docs && pnpm doc`
Expected: `concepts.md 23`, `index.md 26` (18 plus the new 9-line table's 8 compact lines), `networks.md 60`, `quick-start.md 0`, `security.md 15`, `transactions.md 43` (35 plus the deposit table's 7 lines and the new error row), `tutorial.md 12`; the link check and the tutorial tests pass (every new anchor resolves); TypeDoc with no warning.

- [ ] **Step 7: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2820 passed, 2835 total` (145 suites).

```bash
git add test/docs/links.test.ts docs/guides/concepts.md docs/guides/security.md \
  docs/guides/networks.md docs/guides/index.md docs/guides/transactions.md
git commit -m "docs: credit deposits on a second, independent read; name the release; map the spec's guides (F6-R36, F4-R27, A16)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block (Task 12 collects it):**
- Changed: "The guides no longer promise `proven` evidence for deposits: every family's deposit reads (`scanner`, `history`, `getTransaction`) are `observed`, and the new \"Crediting deposits\" section says how to credit them, with a second read through an independent provider."

**Review points:**
- No guide sentence promises "credit … on `proven`" any more: `rg -n "credit.*proven|proven.*credit" docs/guides` finds only the corrected lines, which say the opposite.
- The per-family table matches the code: every `getTransaction` and `history` is a `read`, every scan a `monitor` read of one endpoint (the `ChainDriver` contract table), and `statusFromObservation` never returns `proven`.
- The TON exception sentences are now the general rule; the TON-specific advice (another provider **and** indexer pair, the jetton arrival) stays.

## Task 10: The README of 0.1.0 (Tier 1c, spec §18)

**Files:**
- Rewrite: `README.md`

**Interfaces:**
- Consumes: the guides of Task 9 (links), the API of Tasks 1–8.
- Produces: the README that names 0.1.0, installs from npm and carries the integration matrix; no link to the stale `docs/` site Task 11 deletes.

- [ ] **Step 1: Write the README**

Replace the whole of `README.md` with the text below. It keeps the owner's title and tagline, and runs to 176 lines (spec §18 asks for about 150; the integration matrix and five short examples are all it holds beyond the spec's list). Every TypeScript block type-checks against `src/` (validated by compiling the blocks, grouped as a reader runs them, with `crypto-aio` mapped to `src/`).

````markdown
# Crypto-AIO

All-In-One Crypto-Currency

[![CI](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml/badge.svg)](https://github.com/vhidvz/crypto-aio/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/crypto-aio)](https://www.npmjs.com/package/crypto-aio)
![npm](https://img.shields.io/npm/dm/crypto-aio)
[![License](https://img.shields.io/github/license/vhidvz/crypto-aio?style=flat)](LICENSE)
[![documentation](https://img.shields.io/badge/documentation-click_to_read-c27cf4)](docs/guides/index.md)

One TypeScript API for balances, transfers, confirmations and deposit scanning across EVM
chains, Bitcoin, Tron, Solana and TON, built for exchanges, wallets and payment systems.
Transfers are idempotent and crash-safe, and a signed transaction ends only on proof from
finalized chain data, never on one endpoint's word.

**crypto-aio 0.1.0** is the first release of this API: an SDK-free core, five chain families
and a deterministic testing kit. It replaces the 0.0.x API (`caio.eth.*`) entirely; the
[changelog](CHANGELOG.md) has the migration notes and a security advisory about credentials
that were once committed to this repository.

## Install

crypto-aio needs Node.js 22 or later (Solana: 22.12 or later). Install the package, and only
the SDK of each family you use:

```sh
npm install crypto-aio ethers           # EVM chains (or web3)
npm install crypto-aio bitcoinjs-lib    # Bitcoin
npm install crypto-aio tronweb          # Tron
npm install crypto-aio @solana/web3.js  # Solana
npm install crypto-aio @ton/ton @ton/core @ton/crypto  # TON
```

A handle whose SDK is missing fails with `DEPENDENCY_MISSING` and the install command.

## Quick start

```ts
import { Blockchain, configure, localSigner, secret } from 'crypto-aio';

configure({
  providers: {
    alchemy: { preset: 'alchemy', apiKey: secret(process.env.ALCHEMY_KEY ?? '') },
    infura: { preset: 'infura', apiKey: secret(process.env.INFURA_KEY ?? '') },
  },
  signers: { hot: localSigner({ id: 'hot', secp256k1: secret(process.env.HOT_KEY ?? '') }) },
  wallets: { treasury: { signer: 'hot' } },
  chains: { ethereum: { network: 'sepolia', provider: ['alchemy', 'infura'], wallet: 'treasury' } },
  lifecycle: { requireIdempotencyKey: true },
});

const eth = Blockchain.create({ chain: 'ethereum' });
const me = await eth.walletAddress();
console.log((await eth.getBalance(me.canonical)).amount.format()); // e.g. '0.5 ETH'

const sub = await eth.transfer(
  { to: '0x3535353535353535353535353535353535353535', amount: '0.01' },
  { idempotencyKey: 'withdrawal-42' }, // your own id: repeating the call never pays twice
);
const { status } = await sub.wait({ finality: 'final' });
console.log(status.state, status.evidence); // 'final' 'proven'
```

No key at hand? The [quick start](docs/guides/quick-start.md) runs this on the in-memory
fake chain from `crypto-aio/testing`.

## Configuration: global, scoped and per handle

`configure()` sets up the default container behind `Blockchain.create()`; use one isolated
`new CryptoAio({ namespace })` per tenant. A scope inherits and overrides, and a handle is
immutable: `with()` returns a new one.

```ts
import { CryptoAio, secret } from 'crypto-aio';

const tenant = new CryptoAio({
  namespace: 'tenant-a', // prefixes every store key
  providers: { node: { endpoints: [{ name: 'main', url: secret(process.env.RPC_URL ?? '') }] } },
  chains: { bsc: { network: 'testnet', provider: 'node' } },
});
const eu = tenant.scope({ chains: { bsc: { maxLagBlocks: 20 } } }); // shares the pool and stores
const bsc = eu.blockchain({ chain: 'bsc' });
const viaWeb3 = bsc.with({ library: 'web3' }); // `bsc` is unchanged
```

The most specific value wins: call, handle, scope, container, environment
(`CRYPTO_AIO_<CHAIN>_{NETWORK|LIBRARY|PROVIDER|RPC_URL|INDEXER_URL}`, routing only, never
keys), then built-in defaults.

## Many chains, one shape

```ts
const aio = new CryptoAio({ chains: { ton: { provider: 'public', indexer: 'public' } } });
for (const bc of [
  aio.blockchain({ chain: 'bitcoin', network: 'testnet4', provider: 'public', indexer: 'public' }),
  aio.blockchain({ chain: 'tron', network: 'nile', provider: 'public' }),
  aio.blockchain({ chain: 'solana', network: 'devnet', provider: 'public' }),
  aio.blockchain({ chain: 'ton', network: 'testnet' }),
]) {
  console.log(bc.chain, await bc.getBlockHeight(), bc.supports('replace-fee'));
}
```

Every family has the same handle (`getBalance`, `estimateFee`, `transfer`,
`waitForConfirmation`, `scanner`, `history`) plus a typed `bc.ext.<family>`; what each
network supports is in [Using any blockchain network](docs/guides/networks.md).

## Integration matrix

| Library                                           | Status                                          | Chains                                                                          |
| ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `ethers` 6                                        | Supported, the EVM default                      | Ethereum, BNB Smart Chain, Polygon, Avalanche C-Chain, Arbitrum, Optimism, Base |
| `web3` 4                                          | Supported (sunset upstream; prefer ethers)      | the same EVM chains                                                             |
| `bitcoinjs-lib` 7                                 | Supported, over an Esplora indexer              | Bitcoin mainnet, testnet, testnet4, signet, regtest                             |
| `tronweb` 6                                       | Supported                                       | Tron mainnet, Shasta, Nile                                                      |
| `@solana/web3.js` 1                               | Supported                                       | Solana mainnet, devnet, testnet                                                 |
| `@ton/ton` 16, with `@ton/core` and `@ton/crypto` | Supported, with toncenter API v3 as the indexer | TON mainnet and testnet; the coin is Gram (formerly Toncoin)                    |
| `@tonconnect/sdk`                                 | Replaced by `@ton/ton`                          | TonConnect links dApps to user wallets; it is not a node SDK                    |
| `@avalabs/avalanchejs`                            | Deferred                                        | Avalanche X and P chains (the C-Chain is supported as EVM)                      |
| `@bnb-chain/javascript-sdk`                       | Unsupported                                     | BNB Beacon Chain, sunset in 2024 (BNB Smart Chain is supported as EVM)          |

Only in-memory stores ship. Production needs durable stores of your own (Postgres, Redis,
…), proven with the contract suites in `crypto-aio/testing`.

## Extending

A chain of an existing family is data, served by the built-in driver:

```ts
import { CryptoAio } from 'crypto-aio';
import { evmChainPlugin } from 'crypto-aio/evm';

const aio = new CryptoAio({ plugins: [evmChainPlugin({ name: 'acme', chains: [acmeChain] })] });
```

A provider preset is a plugin too; a custody signer (HSM, KMS, MPC) is three callbacks:

```ts
import { callbackSigner, reveal, secret, type ProviderPreset } from 'crypto-aio';

const acmeCloud: ProviderPreset = {
  name: 'acmecloud',
  kind: 'rpc',
  requiresApiKey: true,
  supports: (chain) => chain === 'acmechain',
  endpoints: ({ apiKey }) => [
    { name: 'main', url: secret(`https://rpc.acme.example/v1/${reveal(apiKey ?? '')}`) },
  ],
};
aio.use({ name: 'acme-presets', presets: [acmeCloud] });

const custody = callbackSigner({
  id: 'mpc-1',
  schemes: ['secp256k1-ecdsa'],
  getPublicKey: async (scheme, keyRef) => vault.publicKey(scheme, keyRef?.id),
  sign: async (requests, ctx) => ({
    status: 'pending', // or { status: 'signed', signatures }
    ticket: await vault.submit(requests, ctx.operationId),
  }),
});
```

A new chain family is a plugin with an adapter: see
[the plugin API](docs/guides/networks.md#3-a-new-family-the-plugin-api).

## Documentation

- [Guides](docs/guides/index.md): concepts, a quick start, a tutorial, sending and receiving,
  keys and secrets (with the [production checklist](docs/guides/security.md#production-checklist)),
  and every network.
- API reference: run `pnpm doc` in a clone, then open `docs/api/index.html`.
- [Changelog](CHANGELOG.md), with the 0.1.0 migration notes.

## License

[MIT](LICENSE)
````

- [ ] **Step 2: Check it**

Run: `mdcheck README.md && pnpm exec jest test/docs/links.test.ts`
Expected: `README.md 0` (the matrix is written padded, as Prettier formats it) and the link check passes (`LICENSE`, `CHANGELOG.md`, the guides and their anchors).

To re-check the examples, copy each `ts` block into a scratch file outside `src/` and `test/`, wrap the top-level `await` in an async function, declare `acmeChain: ChainInfo` and a `vault` object, and compile it with a `tsconfig.json` that extends the repository's and maps `crypto-aio`, `crypto-aio/evm`, `crypto-aio/testing` and `crypto-aio/native` to their `src/` entry files through `paths`: expected, no error.

- [ ] **Step 3: Verify and commit**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2820 passed, 2835 total`.

```bash
git add README.md
git commit -m "docs(readme): the 0.1.0 README: install, quick start, config, matrix, extending (spec §18, A16)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block:** none (the README is not a changelog entry).

**Review points:**
- The owner's title and tagline are unchanged; the badges are the CI workflow, npm version, downloads, license (now the repository's own `LICENSE`, not `blob/master`) and the guides. The coverage badge goes with the tracked coverage report (Task 11).
- The release is named (0.1.0, the first release of this API), TON's coin is "Gram (formerly Toncoin)" (A16), and no sentence says "next release" or "on `main`".
- The integration matrix covers every candidate library of spec §2 with its status.

## Task 11: Release mechanics: version, package contents, coverage, CI, stale files (Tier 3, spec §16–§19)

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`, `jest.config.js`, `eslint.config.mjs`, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/npm-ci.yml`, `docs/guides/quick-start.md`
- Create: `scripts/pack-check.mjs`, `.gitleaks.toml`
- Delete: `docs/index.html`, `docs/modules.html`, `docs/hierarchy.html`, `docs/.nojekyll`, `docs/assets/`, `docs/classes/`, `docs/functions/`, `docs/interfaces/`, `docs/types/`, `docs/coverage/`, `docs/coverage.svg`

**Interfaces:**
- Consumes: every earlier task (the tarball holds their code; the coverage thresholds are measured on it).
- Produces: `pnpm format:check`, `pnpm test:pack`, `pnpm test:coverage` (thresholds enforced); version `0.1.0`; a tarball holding `dist/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md` only.

- [ ] **Step 1: Version, package contents and scripts**

In `package.json`: replace `"version": "0.1.0-dev.0",` with `"version": "0.1.0",`; replace `"files": ["dist"],` with `"files": ["dist", "CHANGELOG.md"],`; replace the three script lines

```json
    "format": "prettier --write \"{src,test}/**/*.ts\" \"*.{js,mjs}\"",
    "test": "jest",
    "test:coverage": "jest --coverage && make-coverage-badge --report-path docs/coverage/coverage-summary.json --output-path docs/coverage.svg",
```

with

```json
    "format": "prettier --write \"{src,test}/**/*.ts\" \"*.{js,mjs}\" \"scripts/*.mjs\"",
    "format:check": "prettier --check \"{src,test}/**/*.ts\" \"*.{js,mjs}\" \"scripts/*.mjs\"",
    "test": "jest",
    "test:coverage": "jest --coverage",
    "test:pack": "pnpm run build && node scripts/pack-check.mjs",
```

and delete the line `"make-coverage-badge": "^1.2.0",` from `devDependencies`. Then regenerate the lockfile with pnpm 10.5.2 (it needs the registry for metadata; `--offline` fails with `ERR_PNPM_NO_OFFLINE_META`):

Run: `pnpm install && git diff --stat pnpm-lock.yaml && pnpm install --frozen-lockfile`
Expected: `- make-coverage-badge 1.2.0`; `pnpm-lock.yaml | 18 ------------------` (the package and its one dependency, `mri`, leave; nothing else changes); the frozen install reports the lockfile up to date.

- [ ] **Step 2: Coverage out of the repository, with thresholds**

Replace `jest.config.js` with:

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  coverageProvider: 'v8',
  coverageReporters: ['json-summary', 'text-summary', 'lcov'],
  // Plan 7: 2 points under 0.1.0's measured coverage (98.45, 98.45, 96.83, 93.14).
  coverageThreshold: {
    global: { lines: 96, statements: 96, functions: 94, branches: 91 },
  },
};
```

In `.gitignore`, after the lines

```
# Output of 'npm pack'
*.tgz
```

add

```

# Coverage reports (pnpm test:coverage)
coverage/
```

Run: `pnpm test:coverage`
Expected: `Tests: 15 skipped, 2820 passed, 2835 total`; the summary reads Statements 98.45%, Branches 93.14%, Functions 96.83%, Lines 98.45%, and no threshold fails. The report lands in the ignored `coverage/`.

- [ ] **Step 3: The packed-tarball check**

In `eslint.config.mjs`, in the block for `['**/*.js', '**/*.mjs']`, replace

```js
      globals: { module: 'writable', require: 'readonly', process: 'readonly' },
```

with

```js
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
```

Create `scripts/pack-check.mjs`:

```js
// Plan 7 (spec §16, §19): packs crypto-aio as `npm publish` would, then checks the tarball as
// a user installs it. Run `pnpm build` first (`pnpm test:pack` does). It needs the npm
// registry, for the package's dependencies and, in the last step, the chain SDKs.
//
// 1. The tarball holds `dist/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`,
//    and nothing else: no source, tests, docs or env files.
// 2. Installed without any SDK, every entry point loads, with `require` and with `import`,
//    and each chain family's handle fails with `DEPENDENCY_MISSING` naming its SDK.
// 3. With every SDK at its tested version (the `devDependencies`), each family's adapter
//    loads: `ready()` gets as far as the (unreachable) endpoint.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'crypto-aio-pack-'));
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const node = (cwd, code, esm = false) =>
  run(process.execPath, [...(esm ? ['--input-type=module'] : []), '-e', code], cwd);

const ALLOWED = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/index.js',
];

/** One handle per family; `x` is an endpoint that refuses connections at once. */
const HANDLES = `
const { CryptoAio } = require('crypto-aio');
const url = 'http://127.0.0.1:9';
const aio = new CryptoAio({
  env: false,
  providers: {
    x: { endpoints: [{ name: 'x', url }] },
    xi: { endpoints: [{ name: 'xi', url, kind: 'indexer' }] },
  },
  transport: { timeoutMs: 1000, maxAttempts: 1 },
});
const CASES = [
  ['ethereum', 'sepolia', 'ethers', {}],
  ['bitcoin', 'testnet4', 'bitcoinjs-lib', { indexer: 'xi' }],
  ['tron', 'nile', 'tronweb', {}],
  ['solana', 'devnet', '@solana/web3.js', {}],
  ['ton', 'testnet', '@ton/ton', { indexer: 'xi' }],
];
async function check(expect) {
  for (const [chain, network, sdk, extra] of CASES) {
    const bc = aio.blockchain({ chain, network, provider: 'x', ...extra });
    const error = await bc.ready().then(() => undefined, (e) => e);
    const missing = error?.code === 'DEPENDENCY_MISSING' && error.message.includes(sdk);
    if (expect === 'missing' ? !missing : error?.code !== 'PROVIDER_UNAVAILABLE') {
      throw new Error(chain + ': expected ' + expect + ', got ' + (error?.code ?? 'no error'));
    }
  }
  await aio.close();
}
`;

try {
  // 1. What npm would publish.
  const [packed] = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', work], root),
  );
  const files = packed.files.map((file) => file.path);
  const unexpected = files.filter(
    (path) => !path.startsWith('dist/') && !ALLOWED.has(path),
  );
  const missing = REQUIRED.filter((path) => !files.includes(path));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `tarball: unexpected ${unexpected.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`,
    );
  }
  console.log(`packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

  // 2. Installed without any SDK.
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true }),
  );
  run('npm', ['install', '--no-audit', '--no-fund', join(work, packed.filename)], app);
  const entries = Object.keys(pkg.exports)
    .filter((key) => key !== './package.json')
    .map((key) => (key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`));
  node(app, `for (const e of ${JSON.stringify(entries)}) require(e);`);
  node(app, `for (const e of ${JSON.stringify(entries)}) await import(e);`, true);
  console.log(
    `${entries.length} entry points load as CommonJS and as ESM with no SDK installed`,
  );
  node(
    app,
    `${HANDLES}\ncheck('missing').catch((e) => { console.error(e.message); process.exit(1); });`,
  );
  console.log('each family without its SDK fails with DEPENDENCY_MISSING');

  // 3. With every SDK at its tested version.
  const sdks = Object.keys(pkg.peerDependencies).map(
    (name) => `${name}@${pkg.devDependencies[name]}`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', ...sdks], app);
  node(
    app,
    `${HANDLES}\ncheck('loaded').catch((e) => { console.error(e.message); process.exit(1); });`,
  );
  console.log(`each family's adapter loads with ${sdks.join(', ')}`);
  console.log('pack check: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
```

Run: `pnpm format:check && pnpm lint && pnpm test:pack`
Expected (about 30 s; it needs the npm registry):

```
packed crypto-aio-0.1.0.tgz: 574 files, 1308338 bytes
8 entry points load as CommonJS and as ESM with no SDK installed
each family without its SDK fails with DEPENDENCY_MISSING
each family's adapter loads with @solana/web3.js@1.99.0, @ton/core@0.63.1, @ton/crypto@3.3.0, @ton/ton@16.3.0, bitcoinjs-lib@7.0.2, ethers@6.17.0, tronweb@6.5.1, web3@4.16.0
pack check: ok
```

(The file count and byte size may differ by a little if Tasks 1–10 were reflowed differently; every other line must match. A `punycode` deprecation warning from an SDK's dependency may appear on stderr.)

- [ ] **Step 4: CI and the publish workflow (spec §17, §19)**

Replace `.github/workflows/ci.yml` with:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: ['22.x', '24.x']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run format:check
      - run: pnpm run lint
      - run: pnpm run typecheck
      # Unit tests make no network calls; the coverage run enforces jest.config.js's thresholds.
      - run: pnpm run test:coverage
      - uses: actions/upload-artifact@v4
        if: matrix.node == '22.x'
        with:
          name: coverage
          path: coverage/
      - run: pnpm run build
      - run: pnpm run doc
  package:
    # Packs the package as npm publishes it and loads every entry point from the tarball
    # (scripts/pack-check.mjs); it installs dependencies and the chain SDKs from npm.
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test:pack
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Refuse tracked env files
        run: |
          if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'; then
            echo "::error::.env files must never be committed"; exit 1
          fi
      # The rules and the allowed test vectors are in .gitleaks.toml; the version is pinned,
      # so a new release's rules cannot turn CI red on an unchanged tree.
      - name: Scan the working tree for secrets
        run: docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo --no-banner --redact
```

Replace `.github/workflows/npm-ci.yml` with:

```yaml
name: Build, Test and Publish
on:
  release:
    # A published release (not a draft) publishes the package.
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          registry-url: 'https://registry.npmjs.org'
          cache: pnpm
      - name: The release tag matches package.json
        run: test "v$(node -p "require('./package.json').version")" = "$TAG"
        env:
          TAG: ${{ github.event.release.tag_name }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm run format:check
      - run: pnpm run check
      - run: pnpm run doc
      - run: pnpm run test:pack
      - run: npm publish --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

What changed and why: `ci.yml` gains read-only token permissions, the format check, the coverage gate (thresholds enforced, the report kept as an artifact from Node 22) and a `package` job running the pack check (it needs the registry, which CI has). The `secrets` job keeps its two checks, with gitleaks pinned to v8.30.1 (Step 5). `npm-ci.yml` now triggers on a **published** release (a draft no longer publishes), refuses a tag that differs from `package.json`'s version, and runs the format check, lint, typecheck, tests, `pnpm doc` and the pack check before `npm publish --provenance`; it never read `.env`, and still does not.

- [ ] **Step 5: Make the secrets job pass on the test vectors, and pin gitleaks (spec §19)**

CI's `secrets` job fails on `main` (run 5 of `ci.yml`, on `db73e90`, where both `check` jobs pass; runs 3 and 4 also ended red): `gitleaks dir` finds 41 "leaks" (19 values) on `db73e90`, every one a test value. They are the web3.js documentation's example key and its accounts, RFC 8032's first test key, BIP86 and BIP341 vectors, sha256-derived test keys, a Bitcoin coinbase txid, and the made-up `sk_live_…` strings the redaction tests and the tutorial plant on purpose; Task 1's tests add one more made-up key, for 44 findings of 20 values (this plan's copy of the test code repeats the same values; Tasks 2 and 4 use `pasted-…`, which no rule matches, because GitHub's push protection blocks a Stripe-shaped `sk_live_` key of full length). Allow exactly those values, never a path or a rule, so a real key anywhere, tests included, still fails the job. Create `.gitleaks.toml` (gitleaks reads it from the scanned directory):

```toml
# The secrets job of CI (gitleaks): the default rules, with these values allowed. Each is a
# public test vector or a key made up for a test, and holds no funds and grants no access.
# Allow a value only after checking that it is one of those; never allow a path or a rule.
title = "crypto-aio"

[extend]
useDefault = true

[[allowlists]]
description = "Public test vectors, test-only keys derived from fixed strings, and their addresses"
regexes = [
  # The web3.js documentation's example key, and its EVM and Tron accounts.
  '''^4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318$''',
  '''^0x2c7536E3605D9C16a7a3D7b1898e529396a65c23$''',
  '''^412c7536e3605d9c16a7a3d7b1898e529396a65c23$''',
  '''^TE2H9hWjzYdwzDFRJfx9BFhr4MmjH1CHaz$''',
  # RFC 8032's first Ed25519 test key (TON).
  '''^9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60$''',
  # Solana: sha256 of fixed strings, as ed25519 seeds, and the test account.
  '''^97710888410ad41b69cb42c4f84f954f7c842f259ca6af5be39872a9ded1f3d1$''',
  '''^8b27be3ee021903655f39e7795662247b046070031091cf3f046f76ec4cd416b$''',
  '''^77PLe4JWFMyQgaUNhWLPA6fsGKGNoGapd2XrbpC2Jhxa$''',
  # Bitcoin: the BIP86 vectors of the "abandon ... about" mnemonic, BIP341's key-path test
  # vector, and block 91842's coinbase txid (BIP30).
  '''^cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115$''',
  '''^a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c$''',
  '''^2405b971772ad26915c8dcdf10f238753a9b837e5f8e6a86fd7c0cce5b7296d9$''',
  '''^d5d27987d2a3dfc724e359870c6644b40e497bdc0589a033220fe15429d88599$''',
]

[[allowlists]]
description = "Made-up provider keys that the redaction tests and the tutorial plant, then look for"
regexes = [
  '''^Zk8sQ2xVw9LmN4pR7tY1uE3iO6aS5dF0$''',
  '''^sk_live_(0123456789abcdef|QUERYSECRET|SECRETKEY123456|SUPERSECRET|TUTORIAL42|USERINFOSECRET)$''',
  '''^tron-key-1234$''',
]
```

The `ci.yml` of Step 4 already pins the image to `v8.30.1` (it was `latest`, so a release with new rules could turn CI red on an unchanged tree).

Run (the job's own command; without Docker, the `gitleaks` 8.30.1 release binary: `gitleaks dir . --no-banner --redact`):
`docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo --no-banner --redact`
Expected: `no leaks found`. Without `.gitleaks.toml` the same run reports `leaks found: 44` (41 on `db73e90`), plus this plan file's copies of the same values once it is in the tree. The allowlist does not blind the scan: after `printf "const API_KEY = 'sk_live_%s';\n" "$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)" > test/planted.ts` the same run gives `leaks found: 1`; `\rm -f test/planted.ts` afterwards. (Never write a key-shaped literal into a tracked file, this plan included: the scan reads every file.) If a later task adds a test vector, add its value here with a comment saying what it is.

- [ ] **Step 6: The quick start installs from npm (D14)**

In `docs/guides/quick-start.md`, "Install", replace

````markdown
crypto-aio needs Node.js 22 or later, and Solana needs Node.js 22.12 or later
([why](./networks.md#solana-networks)). The API in these guides is version 0.1, which is
**not on npm yet**. The 0.0.x releases on npm are an older, unrelated API. Until 0.1.0 is
published, you can build a package from source, but only once the 0.1 work is merged to the
repository's `main` branch:

```sh
git clone https://github.com/vhidvz/crypto-aio.git
cd crypto-aio && pnpm install && pnpm build && pnpm pack # writes crypto-aio-<version>.tgz
npm install /path/to/crypto-aio/crypto-aio-*.tgz # in your project
```

Once 0.1.0 is published, `npm install crypto-aio` is enough. The EVM, UTXO, Tron, Solana and
TON families are on `main` and in the next release. Install only the SDK you use next to the
package:
````

with

````markdown
crypto-aio needs Node.js 22 or later, and Solana needs Node.js 22.12 or later
([why](./networks.md#solana-networks)). These guides describe version 0.1.0, the first
release of this API; the 0.0.x releases on npm are an older, unrelated API.

```sh
npm install crypto-aio
```

Install only the SDK you use next to the package:
````

Run: `mdcheck docs/guides/quick-start.md && rg -n "next release|on \`main\`|not on npm|from source" README.md docs/guides`
Expected: `docs/guides/quick-start.md 0`, and no match.

- [ ] **Step 7: Delete the stale 0.0.x site and coverage output**

Run: `git rm -rq docs/index.html docs/modules.html docs/hierarchy.html docs/.nojekyll docs/assets docs/classes docs/functions docs/interfaces docs/types docs/coverage docs/coverage.svg && ls -a docs`
Expected: `.  ..  api  guides  superpowers` (`docs/api/` is TypeDoc's git-ignored output). The link check still passes: nothing links there any more (the README's coverage badge went in Task 10).

- [ ] **Step 8: Verify and commit**

Run: `pnpm format && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm doc && pnpm test:pack`
Expected: all clean; Jest `Tests: 15 skipped, 2820 passed, 2835 total`; the pack check as in Step 3.

```bash
git add package.json pnpm-lock.yaml jest.config.js eslint.config.mjs .gitignore .gitleaks.toml \
  .github/workflows/ci.yml .github/workflows/npm-ci.yml scripts/pack-check.mjs \
  docs/guides/quick-start.md
git commit -m "build: 0.1.0; ship the changelog; coverage thresholds; the pack check; CI gaps; drop the 0.0.x site (spec §16–§19)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(The deletions of Step 7 are already staged by `git rm`.)

**Changelog block (Task 12 collects it):**
- Changed: "The package also ships `CHANGELOG.md`."
- Removed: "The 0.0.x documentation site and coverage report under `docs/`. The API reference is built with `pnpm doc` into `docs/api/`, and coverage runs in CI."

**Review points:**
- The tarball holds exactly `dist/`, `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md` (no `src/`, `test/`, `docs/` or env file), and every entry point loads as CommonJS and as ESM with no SDK installed: the SDKs stay optional (spec §16).
- The thresholds are 2 points under the measured coverage, so an honest change that lowers coverage slightly does not fail CI, while a large untested addition does.
- The publish workflow cannot publish a version whose tag differs from `package.json`, nor from a draft release; publishing, tagging and the release itself stay the owner's (Task 13).
- `engines` stays `>=22` (the Plan 5 handoff §3): CI's `22.x` resolves to the newest 22, which meets Solana's 22.12.
- `.gitleaks.toml` allows 20 exact values, each named in a comment, and no path or rule; the `secrets` job, red on `main`, passes, and a new key-shaped string anywhere still fails it.

## Task 12: The 0.1.0 changelog (OWNER APPROVAL) and the tracked backlog (Tier 1c, Tier 3, D11, D13)

**Files:**
- Rewrite, **only with the owner's approval**: `CHANGELOG.md`
- Create, **only without it**: `docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md`
- Create: `docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md`

**Interfaces:**
- Consumes: the Changelog blocks of Tasks 1–11; `main`'s `[Unreleased]` section (the family and core bullets of Plans 2–6, authoritative per the Plan 2.5 handoff §5) and the owner's `[0.1.0]` section; the Plan 1 handoff §5 list, the Plan 2 handoff §5 CHANGELOG notes and the Plan 2.5 handoff §5 migration and store notes; D17's registry check; Appendix B.
- Produces: the release notes the owner's GitHub release copies (Task 13), and the post-0.1.0 backlog.

**This task writes the owner's text.** The `[0.1.0]` section is the owner's (commit `eeb992a` and earlier). A subagent never decides the approval: the controller asks the owner, and without a recorded "yes" the proposal goes to its own file and `CHANGELOG.md` stays byte-for-byte as on `main`. Never revert, reword or restage an edit the owner made meanwhile: if `CHANGELOG.md` on the branch differs from `db73e90`'s, stop and show the owner both.

- [ ] **Step 1: Ask the owner (OWNER APPROVAL)**

The controller shows the owner the proposal of Step 2 and asks: "Replace `CHANGELOG.md` with this for 0.1.0? (yes / no / edits)". Edits are applied to the proposal and asked again. Record the answer; "no" or no answer is not approval.

How the proposal was built (the reconciliation the brief and the handoffs ask for):

- **One release section.** `[Unreleased]` is emptied into `[0.1.0]` (the Plan 2 handoff §5): every bullet of `main`'s `[Unreleased]` "Added" and "Changed" appears once, verbatim, in its own order, after the owner's bullets of the same heading; no bullet is added twice (X5). The owner's bullets keep their words, with two changes: the second Security bullet gains the result of the registry check (D17), and the Removed bullet's last sentence points to the new migration notes instead of promising them.
- **False text removed (F4-R26).** The owner's paragraph "Only the fake chain family ships in this release. EVM, Bitcoin, Tron, Solana and TON adapters are planned." goes; a short introduction under the heading names what 0.1.0 is.
- **The §19 advisory stays first**, under "Security", followed by the two Security lines of Tasks 1 and 2.
- **Plan 7's own lines**, from each task's Changelog block, are appended under their heading: Added (Tasks 4, 5, 6), Changed (Tasks 1, 2, 4, 5, 7, 8, 9, 11), Fixed (Tasks 2, 3), Removed (Task 11).
- **Migration and store notes**: "Migrating from 0.0.x" (spec §18, the Plan 1 handoff §5; drawn from the 0.0.3 type declarations on the registry: `caio.eth`, `Ethereum`, `Tronix`, `EthereumOptions.lib`/`client`, `account.getBalance`, `getGasPrice`, `createAccount`, `transact.transfer`, `contract.estimateGas`, the `CRYPTO_AIO_[<ENV>_]<ETH|TRX>_*` variables and the `emitter`); "Notes for builds of `main` before 0.1.0" (the Plan 1 handoff §5 API breaks and additions, which the per-plan bullets do not all state); "For store implementers" (the Plan 2.5 handoff §5: A27 read-your-writes on `findByRef`, the `leaseMs` append bound, P25-R14's absent keys; the Plan 2.5 migration notes, A18, the early `xpub` refusal, the reserved `options.hd` and waiting proofs, are already `[Unreleased]` bullets).
- **Compare links**: `[Unreleased]` compares `v0.1.0...HEAD` and `[0.1.0]` compares `v0.0.2...v0.1.0` (the remote has `v0.0.1` and `v0.0.2`; 0.0.3 has no tag, D17). Both resolve once the owner pushes the tag.
- **The heading keeps `- Unreleased`.** The owner sets the date when tagging (Task 13).

- [ ] **Step 2: The proposal**

The complete proposed `CHANGELOG.md`:

````markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

crypto-aio 0.1.0 is the first release of the blockchain abstraction layer: one API over EVM
chains, Bitcoin, Tron, Solana and TON, with an SDK-free core, optional SDK peers and a
deterministic testing kit. It replaces the 0.0.x API entirely; see "Migrating from 0.0.x"
below.

### Security

- Until this release, the repository tracked a `.env` file containing testnet private keys,
  mnemonics and RPC provider tokens. These credentials remain in the git history and must be
  treated as compromised. The file is no longer tracked, and CI now refuses tracked env files
  and scans for secrets.
- The published npm package was not affected: `files: ["/dist"]` never shipped `.env`. The
  0.0.1, 0.0.2 and 0.0.3 tarballs on the registry were checked: each holds only `dist/`,
  `package.json`, `README.md` and `LICENSE`.
- Owner actions outside this codebase: rotate the provider tokens, move any funds held by
  those keys, and decide whether to rewrite git history.
- An API key that a provider echoes back is removed from every error message, `details`
  field, `cause` and event, in any letter case, from a URL path segment, a query value, a
  header value or the token after an auth scheme, not only as the whole URL or header
  value. Parts of fewer than 8 characters are removed only as part of the whole URL or
  header value.
- An error never repeats a name the caller typed that the library does not know (a chain,
  network, library, provider or preset, wallet, signer, signature scheme, asset alias,
  option key or capability): it lists the accepted names instead, so a secret pasted into
  the wrong field never reaches a message. A malformed asset id, an invalid namespace and a
  `native()` library name are no longer quoted either.

### Added

- A chain-agnostic blockchain abstraction layer: the `CryptoAio` container with scopes, the
  immutable `Blockchain` handle, and layered configuration (call > handle > scope > root >
  environment routing > built-ins).
- Operations and Attempts with idempotency keys, crash-safe signing ("never signed twice"),
  observed vs proven evidence, background workers, recovery, replace, cancel and rebuild.
- Signing through `localSigner` or `callbackSigner` (HSM, KMS, MPC), with a `beforeSign`
  policy hook; `Secret` values and redaction keep keys and credentials out of errors, events
  and logs.
- A multi-endpoint HTTP transport with health checks, quorum reads for proofs, and circuit
  breakers; a block scanner with cursors, acknowledgements and reorg rollback.
- A plugin API for chain families, and the `crypto-aio/native` escape hatch.
- The `crypto-aio/testing` kit: a deterministic fake chain family, `FakeFetch`, `FakeClock`,
  `FaultyOperationStore` and the store contract suites.
- Developer guides and a tested tutorial in `docs/guides/`, rendered with the API reference
  by `pnpm doc`.
- The EVM family, built in: Ethereum (mainnet, Sepolia, Hoodi), BNB Smart Chain, Polygon,
  Avalanche C-Chain, Arbitrum, Optimism and Base, with ethers 6 (the default) or web3 4 as
  optional peer dependencies. A missing SDK fails with `DEPENDENCY_MISSING` and the install
  command.
- Native and ERC-20 transfers with `evm-1559` or `evm-legacy` fees per network, the OP Stack
  L1 data fee as an `l1-data` charge, nonce ordering, and same-nonce replace and cancel
  (except on Arbitrum, which has no mempool).
- Finality from the `finalized` tag, or from confirmations; proofs under the proof quorum,
  including `blockHash`; block scanning of native transfers and ERC-20 `Transfer` logs.
- The `public`, `alchemy`, `infura` and `ankr` provider presets, and USDT and USDC by alias.
- The `crypto-aio/evm` entry: `evmChainPlugin` for EVM chains of your own, registered as
  `evm:<name>`; `EVM_CAPABILITIES` and `EVM_PEER_DEPENDENCIES`; and the SDK types for
  `native(bc, 'ethers')` and `native(bc, 'web3')`.
- `bc.ext.evm.getNonce(address, 'latest' | 'pending')`.
- Typed `ChainRegistry` entries for the seven EVM chains and their networks, and the root
  type exports `EvmExt`, `EvmFeeDetails` and `EvmFeeOverride`.
- The UTXO family, built in: Bitcoin (mainnet, testnet, testnet4, signet, regtest) with
  bitcoinjs-lib 7 as an optional peer dependency, over an Esplora indexer (`mempool`,
  `blockstream` and `public` presets).
- p2wpkh, p2sh-p2wpkh, p2pkh and p2tr wallets; PSBT signing payloads with one request per
  input, and signed PSBTs through `submitSignatures`; batch outputs; `{ satPerVByte }` fee
  overrides and an absurd-fee guard; coin selection (`accumulative`, `all`); BIP125 replace
  and cancel; 6-confirmation finality under the proof quorum; block scanning and address
  history; `bc.ext.utxo.listUnspent` and `bc.ext.utxo.coinSelection`.
- The `crypto-aio/utxo` entry: `UTXO_CAPABILITIES`, `UTXO_PEER_DEPENDENCIES`, the SDK-free
  `Utxo*` types (also exported from `crypto-aio`, with the typed `bitcoin` `ChainRegistry`
  entry) and the type of `native(bc, 'bitcoinjs-lib')`.
- `wallet.utxo.allowExternalChangeAddress`: without it, a `changeAddress` that the wallet's
  key or `xpub` does not derive is refused with `CONFIG_INVALID` (an addition to the spec's
  `utxo` wallet options).
- The Tron family, built in: `tron` on mainnet, Shasta and Nile, with tronweb 6 as an optional
  peer dependency; TRX and TRC-20 transfers with memos; the `tron` fee kind (`bandwidth`,
  `energy`, `activation` and `memo` charges, any of which may be 0) with a `{ feeLimit }`
  override for TRC-20 transfers; `expiry` ordering with proven expiry and `rebuild`; finality
  at the solidified block; block scanning; TronGrid address history through an indexer
  provider; the `trongrid` and `public` presets; and USDT by alias.
- The `crypto-aio/tron` entry: `TRON_CAPABILITIES`, `TRON_INDEXER_CAPABILITIES`,
  `TRON_PEER_DEPENDENCIES`, the expiration, energy-margin and memo limits, and the SDK type
  for `native(bc, 'tronweb')`; also `bc.ext.tron.getResources(address)`, a typed
  `ChainRegistry` entry for `tron`, and the root type exports `TronExt`, `TronFeeDetails`,
  `TronFeeOverride`, `TronResources` and `TronExpiryOrdering`.
- The Tron handle option `maxFeeLimit` (sun, a bigint; default 100 TRX, exported as
  `DEFAULT_MAX_FEE_LIMIT`): a TRC-20 transfer's fee limit is at most min(the estimate plus
  its margin, the network's maximum, `maxFeeLimit`), and a transfer whose simulated energy
  needs more is refused with `INVALID_INTENT` before signing. The node reports its maximum,
  the energy price and the simulated energy, so this is the one bound no endpoint can raise.
- The Solana family, built in: `solana` on mainnet, devnet and testnet, with
  `@solana/web3.js` 1.99 as an optional peer dependency. It needs Node.js 22.12 or later: on
  Node 22.0 to 22.11, loading the SDK fails with Node's own `ERR_REQUIRE_ESM`.
- SOL and classic SPL token transfers (`transferChecked`) with memos, one output per
  transfer. A missing associated token account of the recipient is created, with its rent as
  a separate `rent` charge. Transfers that could strand funds (to a program, a program-owned
  account or a token account), frozen token accounts, and accounts left below the
  rent-exempt minimum are refused before signing. Token-2022 mints throw
  `UNSUPPORTED_CAPABILITY`.
- The `solana` fee kind: the signature fee plus a priority fee priced from recent
  prioritization fees, with a `{ computeUnitPrice, computeUnitLimit? }` override. `expiry`
  ordering on the blockhash's last valid block height, with expiry proven from the
  blockhash's own block and every block of its window, and `rebuild`; finality at the
  `finalized` commitment, with quorum proofs.
- Block scanning over dense block heights, address history from `getSignaturesForAddress`
  without an indexer, the `public`, `alchemy`, `infura` and `ankr` presets, USDC and USDT by
  alias, and `bc.ext.solana.getTokenAccounts(owner, mint?)`.
- The `crypto-aio/solana` entry: `SOLANA_CAPABILITIES`, `SOLANA_PEER_DEPENDENCIES` and the
  SDK type for `native(bc, '@solana/web3.js')` (a `Connection`); also a typed
  `ChainRegistry` entry for `solana`, and the root type exports `SolanaExpiryOrdering`,
  `SolanaExt`, `SolanaFeeDetails`, `SolanaFeeOverride` and `SolanaTokenAccount`.
- The Solana handle option `maxComputeUnitPrice` (`chains.solana.options`): the highest
  compute-unit price a transfer signs, 10,000,000 micro-lamports per compute unit by default
  (`DEFAULT_MAX_COMPUTE_UNIT_PRICE`, exported from `crypto-aio/solana`), so no endpoint can
  raise a transfer's priority fee above 0.014 SOL by default. Speeds are clamped below it,
  an override above it is refused before signing, and any other option key is
  `CONFIG_INVALID`.
- The TON family, built in: `ton` on mainnet and testnet, with `@ton/ton` 16, `@ton/core`
  0.63 and `@ton/crypto` 3 as optional peer dependencies, over toncenter's API v2 (the
  `provider`) and its API v3 (the `indexer`, which TON requires); the `toncenter` (keyed)
  and `public` (keyless) presets. The native coin is Gram (`GRAM`, formerly Toncoin), and
  `TON` is an alias for it; USDT by alias on mainnet.
- v4r2 and v5r1 wallets set by `wallets.<name>.ton`; Gram and jetton transfers with text
  memos, one output per transfer (TON batches are not supported yet: a partly delivered
  batch has no safe single verdict); bounce decided by the recipient address's form; the
  `ton` fee kind with an `{ attached }` override for jettons and a ceiling on a node's
  estimate; seqno ordering with a 60-second message lifetime, proven expiry and `rebuild`;
  Attempts identified by their message hash and resolved to transaction hashes; finality on
  masterchain inclusion plus a completed message trace; address history through the
  indexer (no block scan: TON is sharded); `bc.ext.ton.getSeqno` and
  `bc.ext.ton.jettonWallet`.
- The `crypto-aio/ton` entry: `TON_CAPABILITIES`, `TON_INDEXER_CAPABILITIES`,
  `TON_PEER_DEPENDENCIES`, and the SDK type for `native(bc, '@ton/ton')` (a `TonClient`);
  also a typed `ChainRegistry` entry for `ton`, and the root type exports `TonExt`,
  `TonFeeDetails`, `TonFeeOverride`, `TonWalletIdentity` and `TonWalletVersion`.
- TON resends are guarded: before the TON driver sends stored bytes again (a same-key retry,
  a dropped rebroadcast, `rebroadcast`, `recover()` or a bare `broadcast`), it walks the
  wallet's authenticated chain, so a message that already ran is never sent into a wallet
  reset, and it withholds the bytes (a retryable, ambiguous `PROVIDER_UNAVAILABLE`) while it
  cannot decide.
- `TonSeqnoOrdering`, an Attempt's TON ordering with its build's chain time (`validFrom`),
  exported from the root entry and from `crypto-aio/ton`, for store authors.
- The TON driver's `maxNetworkFee` option (`{ basechain?, masterchain? }`, nanograms), in
  `chains.ton.options` or a handle's `options`; any other TON option key is refused with
  `CONFIG_INVALID`.
- `CallOptions.quorumKey`: under a quorum, endpoints must agree only on the part of the
  result that the key returns.
- `CallOptions.exactIntegers`: `Transport.rpc`, `rpcRaw` and `http` can parse JSON integers
  beyond 2^53 − 1 as `bigint`, so amounts are never rounded and a quorum compares them exactly.
- `Blockchain.submitSignatures(operationId, signed)` also takes a whole transaction signed
  elsewhere (a `RawTx`, such as a PSBT) where the chain's driver implements the optional
  `TxBuilder.signaturesFrom` port. Only its signatures are used, each verified against its
  stored request.
- `DriverOutput` and `DriverIntent.outputs[i].variant`: the recipient address's variant (TON's
  bounce flag) reaches drivers and is part of the intent hash. Outputs without a variant hash
  as before.
- `TxStatus.reason` for on-chain failures: a driver may return a short fixed `reason` from
  `observe` and `ProofSource.includedFinal`.
- `WalletHdOptions`, and an `hd` entry in `WalletOptions`: drivers receive the wallet's
  extended public key.
- The EVM handle option `maxFeePerGas` (wei per gas, a bigint; 1,000 gwei by default,
  exported as `DEFAULT_MAX_FEE_PER_GAS` from `crypto-aio/evm`; a network may set
  `params.maxFeePerGas`): no EVM transaction signs a higher price per gas. A node's
  suggestion is clamped to it, and an explicit fee, or a cancel's least bump, above it fails
  with `INVALID_INTENT` before signing (`details.required`, `details.maxFeePerGas`); the
  build checks it again. Every family now bounds a node's fee by an operator setting.
- `transport.maxResponseBytes` (64 MiB by default): a longer answer is cancelled and fails
  as a retryable `PROVIDER_UNAVAILABLE`, so one endpoint cannot exhaust the process's memory.
- `SAMPLE_ORDERINGS` in `crypto-aio/testing`: one Attempt ordering of each built-in family,
  as the operation-store contract suite checks them.

### Changed

- `DEPENDENCY_MISSING` carries the original error as its `cause`, and a missing module that
  is not a peer dependency keeps its own error instead of being reported as a missing SDK.
- A token's own permanent metadata failure (a non-retryable `ASSET_RESOLUTION`) is cached per
  container; any other failure is looked up again.
- Closing a container waits at most 5 seconds for each native client to close.
- `getNetworkStatus()` never reports a finalized height above the head height.
- The proof contract (`ProofSource`): on a proof path, only a definitive negative answer
  says "no". Every other RPC error, such as state not available or an index still being
  built, is a retryable `PROVIDER_UNAVAILABLE` that decides nothing.
- Health probes wait for their endpoint's rate-limit tokens, ahead of requests already
  waiting, and a first-use identity probe goes before the request's own token, so a keyless
  1 request/second endpoint stays healthy. After a fully failed health refresh, the next one
  waits at least until each bucket has refilled the probes' tokens plus one.
- On an endpoint's first use, the `rpc.error` event's `latencyMs` and the endpoint's
  `latencyMs` in `status()` no longer include the identity check.
- A proof quorum (every `quorum: 'proof'` read, whatever its `purpose`, and any quorum read
  for a monitor or proof purpose) is never asked of fewer endpoints than the quorum because
  of height lag, an unknown height, an identity not yet confirmed or an open circuit
  breaker. An endpoint keeps counting until its identity is proven mismatched or three
  health refreshes in a row, at most one per `healthIntervalMs`, fail its identity or height
  probe or find its requests failing (its breaker not closed, or `failureThreshold` failures
  in a row); with an identity probe alone, each refresh re-probes a confirmed identity. An
  endpoint out of the count never answers toward a proof: while its breaker is half-open it
  is tried alongside the others and can only block the proof (its disagreement or refusal
  decides nothing); once it answers, it rejoins the count at the next health refresh, if
  its probes answer; the next proof read triggers that refresh. A proof read waits for a
  trial it sends, up to the call's timeout; a trial whose endpoint has no rate-limit token
  free is skipped for that read, and each concurrent proof read in a half-open window may
  send its own trial. Only a confirmed, in-range endpoint whose breaker lets requests
  through answers; otherwise the read decides nothing (a retryable `PROVIDER_UNAVAILABLE`).
  A `quorum: 'proof'` read keeps health fresh under any purpose. With no probe configured,
  the quorum counts only the usable endpoints, as before, so a chain family sets its
  probes.
- For proof reads and proof quorums, lag is measured against the second-highest known
  height, so one endpoint that over-reports its head never marks honest ones as lagging.
  With two endpoints that excludes neither, so a proof read should be anchored to a block
  height. A single monitor read and `status()` still measure lag against the highest known
  height.
- In a proof quorum, a definitive error decides only when every endpoint of the quorum
  returns an equivalent one: the same error code, HTTP status and JSON-RPC error code, and
  for a JSON-RPC code whose meaning each server defines (-32000 to -32099, and -32603) the
  same message. Against an answer, or a different error, the read decides nothing (a
  retryable `PROVIDER_INCONSISTENT`). While at least two endpoints are in the count, one
  endpoint's revert therefore never fails a token for good. The `provider.inconsistent`
  event is now also emitted when a proof quorum sees a refusal against an answer, or unlike
  refusals.
- A quorum compares answers in a form where an object never equals a `bigint`, so under
  `exactIntegers` an endpoint's `{"$bigint": …}` object no longer agrees with another's
  exact integer.
- These cost liveness. Proofs wait at startup until enough endpoints are confirmed and in
  range, and while an honest endpoint's breaker is open for less than three health
  intervals. An endpoint that stops answering its probes or its requests holds them back for
  about three health intervals; after that it no longer counts, so with two endpoints the
  other decides alone until the first answers a trial again and rejoins at the next health
  refresh, if its probes answer; the next proof read triggers that refresh. With two
  endpoints both must answer, so use three or more for production proofs. Errors worded
  differently decide nothing.
- An observation clears an earlier failure or refusal reason once the transaction succeeds,
  leaves its block or is proven replaced, and whenever a rebroadcast, accepted or
  ambiguous, makes it `pending` again. `TxStatus.reason` is present only with `failed`,
  `refused` or `rejected`.
- The `OperationStore` contract suite now checks that `putObservation` replaces the whole
  observation, and that a field left out or set to `undefined` reads back `undefined`
  (never `null`).
- An Operation whose signed transaction is identical to another Operation's fails with
  `NONCE_CONFLICT` (`details.heldBy`) before anything is sent; a replacement, cancel or
  rebuild in that case is refused and its Operation is unchanged. The testing kit's `expiry`
  fake chain, which signs identical transfers into identical bytes, shows it. Durable stores:
  `findByRef` must be read-your-writes consistent across processes.
- A plugin registered under a name that a different plugin already holds throws
  `CONFIG_INVALID` (it was silently ignored). Registering the same plugin again stays a no-op;
  a plugin whose functions are rebuilt on each call is a different plugin.
- `deriveAddress` on UTXO chains refuses an extended key whose Bitcoin SLIP-0132 version is of
  the other network class with `CONFIG_INVALID`; `deriveXpubChild` takes an optional `network`.
- `deriveXpubChild` refuses a key that is not a string, and a private key named by its
  SLIP-0132 prefix (such as `xprv`), with `CONFIG_INVALID` instead of a `TypeError` or an
  unsupported-prefix error. Its unsupported-format message no longer quotes the key's
  prefix, and "invalid extended public key" no longer carries the parser's error as its
  `cause`.
- An address codec whose `normalize` returns a `variant` holding anything but JSON scalars
  (strings, finite numbers, booleans, `null`) under string keys now fails transfers to that
  address with `INVALID_ADDRESS`. This affects custom chain plugins.
- A wallet whose `xpub` is private, unreadable, or in a format that needs `xpubVersions` (a
  SLIP-0132 `ypub`, `zpub` or `vpub` without them) is now refused with `CONFIG_INVALID`
  when the wallet is resolved, so on every use of that wallet: sends, `walletAddress`,
  `ready()`, `limits()` and the writes on its stored Operations that resolve the wallet (the
  all-rejected verdict, nonce reconciliation and recovery's resend), not only
  `deriveAddress`. The refusal repeats no part of the key. An empty `xpub` counts as none.
  An `xpubPath` that is not a string is refused the same way, at resolution and in
  `deriveAddress`.
- `hd` in `WalletOptions` is reserved: neither a wallet's own `options.hd` nor the
  `options` passed to `Blockchain.addressFromPublicKey` bring an `hd` to a driver.
  `addressFromPublicKey` reads `null` options as none.
- A REST error's message names the route template, as in
  `GET /address/:address/txs refused (HTTP 400)`, no longer the request path with its
  address or transaction id; without a route, only the method.
- Refusals of unknown names read `unknown <what>; the accepted names are 'a' and 'b'`; the
  TON, Solana, Tron, UTXO and EVM option refusals and the core's selection errors use this
  one form.
- The EVM driver reads its handle options: any key but `maxFeePerGas` fails with
  `CONFIG_INVALID` (other keys were ignored).
- The `OperationStore` contract suite checks that an Attempt's `ordering`, its
  `unsigned.ordering` and the Operation's `reservation` read back whole, every property
  with its value and type, for one ordering of each built-in family, after the append and
  after a later write. A store that drops, retypes or changes a property fails it.
- A health check that an endpoint rate-limits (HTTP 429), or that would come before the
  `Retry-After` of an earlier 429, keeps the endpoint's last good height and identity and is
  no health miss; a rate-limited identity check retries after the endpoint's `Retry-After`
  instead of 15 seconds.
- The height high-water mark that a view must stay within `maxLagBlocks` of falls back to
  the verified best height after three health refreshes in a row in which no verified
  endpoint comes that close to it, so one endpoint that once reported a far-future head no
  longer leaves every view stale until restart.
- The root container's `close()` also stops every `monitor.start()` loop, and a running
  `runOnce()` or `operations.recover()` at its next check; starting one on a closed
  container throws `INVALID_TRANSITION`.
- The guides no longer promise `proven` evidence for deposits: every family's deposit reads
  (`scanner`, `history`, `getTransaction`) are `observed`, and the new "Crediting deposits"
  section says how to credit them, with a second read through an independent provider.
- The package also ships `CHANGELOG.md`.

### Fixed

- EVM: a node's rejection of a broadcast ("invalid sender", "invalid chain id", "rlp: …",
  "tip above fee cap") ends an Operation only when the library's own reading of the signed
  bytes confirms it; otherwise it is a refusal (`TX_REFUSED`), and the Operation stalls
  instead of failing, so a lying endpoint that relays the bytes later can no longer make a
  retry pay twice. The UTXO, Tron, Solana and TON drivers already worked this way.
- A network, wallet or signer route named like an `Object.prototype` member (`toString`,
  `constructor`) is an unknown name, never an inherited value.

### Removed

- The 0.0.x API: the `CryptoAio` chain getters, `Ethereum`, `Tronix`, `*Account`,
  `*Contract` and `*Transact`. The library was rebuilt; see "Migrating from 0.0.x" below.
- The 0.0.x documentation site and coverage report under `docs/`. The API reference is
  built with `pnpm doc` into `docs/api/`, and coverage runs in CI.

### Migrating from 0.0.x

The 0.0.x API had no stored transfers, no proofs and few working write paths, so there is
no mechanical upgrade; the new API maps onto the old ideas as follows.

- `new CryptoAio()` with `caio.eth` (`Ethereum`) and the `Tronix` class becomes a container
  and one handle per chain: `new CryptoAio({ providers, signers, wallets, chains })` and
  `aio.blockchain({ chain: 'ethereum' })`, or `configure(…)` and
  `Blockchain.create({ chain: 'tron' })`. Install the SDK of each chain you use (`ethers` or
  `web3`, `tronweb`, …); they are optional peer dependencies.
- `EthereumOptions.lib` (`'web3' | 'ethers'`) becomes the handle's `library`; a `client`
  you built yourself becomes a provider (`{ endpoints: [{ name, url }] }` or a preset with
  an `apiKey`), and the SDK client is reachable only through `crypto-aio/native`.
- `caio.eth.account.getBalance(address)` becomes `bc.getBalance(address, asset?)`, which
  returns an exact `Amount`; `caio.eth.getGasPrice()` becomes `bc.estimateFee(intent)`.
- `caio.eth.createAccount()` and `account.create()`, which emitted private keys through the
  event emitter, are gone: keys exist only inside signers. Use
  `localSigner.generate({ curves: ['secp256k1'] })` for its public keys and
  `bc.addressFromPublicKey(publicKey)`, or import a key with
  `localSigner({ secp256k1: secret(hex) })`.
- `transact.transfer` and `contract.estimateGas` become
  `bc.transfer({ to, amount, asset? }, { idempotencyKey })`, with ERC-20 and TRC-20 tokens
  as an `asset` (an alias such as `'USDT'`, or `{ standard: 'erc20', contract }`) and
  offline signing through `prepareTransfer` and `submitSignatures`.
- The `CRYPTO_AIO_[<ENV>_]<ETH|TRX>_<URL|ADDRESS|PRIVATE|PHRASES|CONTRACT|ABI>` variables
  are gone. The environment now carries routing only,
  `CRYPTO_AIO_[<PROFILE>_]<CHAIN>_{NETWORK|LIBRARY|PROVIDER|RPC_URL|INDEXER_URL}` with
  `CRYPTO_AIO_ENV` naming the profile, and never a key, a mnemonic or an address.
- The `emitter` option becomes typed events (`aio.on(type, handler)`) that carry ids,
  states, codes and timings only; `debug` logging stays (`DEBUG=crypto-aio:*`), or pass
  `createLogger(namespace, writer)`.

### Notes for builds of `main` before 0.1.0

Code built from `main` during 0.1 development saw these changes before the release:

- `Transfer` is `ResolvedTransfer | UnresolvedTransfer`: a transfer whose asset cannot be
  resolved arrives with `unresolved: { asset, amount, code }` and its transaction
  `decoding: 'partial'`.
- `TERMINAL_STATES` is a frozen array, not a `Set`, and every exported table is
  deep-frozen. `Scanner` is exported as a type only (get one from `bc.scanner()`), and
  `ScanEventBody` is exported.
- `createNativeClient` returns `{ client, close? }` (`DisposableNativeClient`); after the
  root's `close()`, handle work and `native()` fail with `INVALID_TRANSITION`.
- `Transport` gained the `maxLagBlocks` accessor and `hasProbes()`; `ProofSource` gained
  `blockHash(height, level)`; `HttpRequest` gained `route`; `chains.<id>.maxLagBlocks` and
  `lifecycle.signTimeoutMs` (120 s) are new.
- The `STATE_UNRECORDED` error code (category `state`, retryable) reports a step that may
  have happened but was not recorded, with the original code in `details.causeCode`; an
  ambiguous error keeps its own code and retryability and adds `ambiguous: true` and the
  `operationId`.
- A pending signing result is stored as `signerTickets` (one per signer); `cancel` and
  `buildCancel` take an optional `fee`.
- The testing kit gained `restart({ killPrevious })`, `forkAbove` and `fake_getBlockHash`.

### For store implementers

The four contract suites in `crypto-aio/testing` define what a durable store must do; run
them against yours. Beyond the suites, which test one store instance:

- `findByRef` must be read-your-writes consistent across every process that shares the
  store, and `appendAttempt` must complete within `lifecycle.leaseMs` (see "Changed").
- Keep each Attempt's `ordering` whole, and store a patch key set to `undefined` as absent,
  never as `null` (the suites check both).
- `DATA_CLASSIFICATION` names each field's class for encryption and retention.

[Unreleased]: https://github.com/vhidvz/crypto-aio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vhidvz/crypto-aio/compare/v0.0.2...v0.1.0
````

- [ ] **Step 3a: With approval, replace the changelog**

Write the text of Step 2 (between the four-backtick fences, without them) to `CHANGELOG.md`, ending with one newline.

Run:

```sh
git show db73e90:CHANGELOG.md > /tmp/changelog-main.md
python3 - /tmp/changelog-main.md CHANGELOG.md <<'EOF'
import re, sys
from collections import Counter
def bullets(text):
    out, cur = [], None
    for line in text.split('\n'):
        if line.startswith('- '):
            if cur: out.append(cur)
            cur = line[2:]
        elif line.startswith('  ') and cur is not None:
            cur += ' ' + line.strip()
        else:
            if cur: out.append(cur)
            cur = None
    if cur: out.append(cur)
    return [re.sub(r'\s+', ' ', b).strip() for b in out]
old, new = (open(p).read() for p in sys.argv[1:])
flat = re.sub(r'\s+', ' ', new)
print('not kept verbatim:', [b[:60] for b in bullets(old) if b not in flat])
print('duplicates:', [b[:60] for b, n in Counter(bullets(new)).items() if n > 1])
EOF
mdcheck CHANGELOG.md && pnpm exec jest test/docs/links.test.ts
```

Expected: `not kept verbatim: ['The 0.0.x API: the `CryptoAio` chain getters, `Ethereum`, `T']` (the owner's Removed bullet, whose last sentence now points to the migration notes; it is the only one), `duplicates: []`, `CHANGELOG.md 0`, and the link check passes (9 tests).

- [ ] **Step 3b: Without approval, write the proposal to its own file**

Leave `CHANGELOG.md` untouched. Create `docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md` with these lines, then a blank line, then the text of Step 2 verbatim:

```markdown
<!-- Plan 7, Task 12: the proposed CHANGELOG.md for 0.1.0, awaiting the owner's approval.
Everything from the "# Changelog" line to the end is the proposed file, byte for byte; to
apply it: sed -n '/^# Changelog$/,$p' <this file> > CHANGELOG.md -->
```

Run: `sed -n '/^# Changelog$/,$p' docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md > /tmp/proposed.md && mdcheck /tmp/proposed.md && git diff --exit-code db73e90 -- CHANGELOG.md && echo untouched`
Expected: `/tmp/proposed.md 0` and `untouched`. **The release is blocked until the owner applies it**: `main`'s `[0.1.0]` still calls the adapters "planned" (F4-R26), which Task 13's checklist repeats.

- [ ] **Step 4: Write the tracked backlog (D13)**

Create `docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md` with this header, then a blank line, then the whole of Appendix B.5 (its introduction and its table, from "Items" to the table's last row) verbatim:

```markdown
# crypto-aio: the backlog after 0.1.0

The items the 0.1.0 release plan (Plan 7, `docs/superpowers/plans/2026-09-30-plan-7-release.md`,
Appendix B.5) left for later, each with its source and the reason it waited. Ids refer to the
plan handoffs in this directory. Keep this file current: strike an item through when a change
closes it, and add new ones at the end.

## Backlog
```

Run: `mdcheck docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md && grep -c '^| B' docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md`
Expected: `docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md 68` (the table is compact, like the guides': its header, its separator and 66 rows) and `66`, the Tier 5 row count of Appendix B's "Counts".

- [ ] **Step 5: Verify and commit**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm doc`
Expected: all clean; Jest `Tests: 15 skipped, 2820 passed, 2835 total` (Markdown only changed; with approval the link check reads the new `CHANGELOG.md`).

With approval:

```bash
git add CHANGELOG.md docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md
git commit -m "docs(changelog): 0.1.0 (owner-approved); the post-0.1.0 backlog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Without approval:

```bash
git add docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md \
  docs/superpowers/plans/2026-09-30-post-0.1.0-backlog.md
git commit -m "docs(plans): the proposed 0.1.0 changelog, awaiting the owner; the post-0.1.0 backlog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

**Changelog block:** none (this task writes the changelog).

**Review points:**
- Every `[Unreleased]` bullet of `main` appears once, verbatim (Step 3a's check); the owner's words change only where D11 says; no Plan 2–6 bullet is added twice (X5).
- The §19 advisory is first and complete: the credentials are compromised, the npm tarballs were checked (all three, D17), and the owner's actions are listed.
- No sentence calls a family "planned", and the compare links name tags that exist once the owner tags `v0.1.0`.
- Without approval, `CHANGELOG.md` is byte-identical to `main`'s.

## Task 13: The final gate, and the owner's release checklist

**Files:**
- Modify: `test/adapters/ton/node.test.ts`, `test/adapters/ton/builder.test.ts` (explicit budgets for two long tests)

**Interfaces:**
- Consumes: the branch after Tasks 1–12.
- Produces: the evidence the owner needs to tag; the checklist below.

- [ ] **Step 1: Give the two long TON tests explicit budgets**

Under `--detectOpenHandles` Jest runs every file in one process and tracks every async resource, which slows the fake-clock tests. On this branch after Task 12, `pnpm exec jest --detectOpenHandles` fails exactly two tests at Jest's 5-second default, both of which pass alone and in the normal parallel run: "lets a test script a late answer, or one that never comes (intercept)" in `test/adapters/ton/node.test.ts` and "rethrows 429, 408, 5xx and timeouts unclassified: the ambiguous path" in `test/adapters/ton/builder.test.ts`. (On `db73e90` the same run fails six: these two and four in `probe-rate-limit.test.ts`, which Task 7 gave budgets.) A timeout is not an open handle, so give each the budget Task 7 gave the probe tests:

```diff
diff --git a/test/adapters/ton/builder.test.ts b/test/adapters/ton/builder.test.ts
--- a/test/adapters/ton/builder.test.ts
+++ b/test/adapters/ton/builder.test.ts
@@ -883,6 +883,9 @@ describe('the TON broadcaster', () => {
     }
   });
 
+  // Four fresh transports and a timeout on the fake clock: `--detectOpenHandles` slows it
+  // past Jest's 5-second default, so it carries an explicit budget (as
+  // probe-rate-limit.test.ts does).
   it('rethrows 429, 408, 5xx and timeouts unclassified: the ambiguous path', async () => {
     type Reply = (signal: AbortSignal | undefined) => FakeReply | Promise<FakeReply>;
     const replies: readonly (readonly [Reply, Record<string, unknown>])[] = [
@@ -910,7 +913,7 @@ describe('the TON broadcaster', () => {
       );
       expect(s.h.node.served.some((r) => r.route === '/sendBocReturnHash')).toBe(true);
     }
-  });
+  }, 30_000);
 
   it('never classifies a 4xx after an attempt that may have been delivered (D16)', async () => {
     const s = setup();
diff --git a/test/adapters/ton/node.test.ts b/test/adapters/ton/node.test.ts
--- a/test/adapters/ton/node.test.ts
+++ b/test/adapters/ton/node.test.ts
@@ -1384,6 +1384,9 @@ describe('the scripted toncenter node: never more lenient than the chain (F6-R5)
     expect(s.node.status(s.wallet)).toBe('active');
   });
 
+  // Retries and a timeout on the fake clock: `--detectOpenHandles` slows it past Jest's
+  // 5-second default, so it carries an explicit budget (as probe-rate-limit.test.ts
+  // does).
   it('lets a test script a late answer, or one that never comes (intercept)', async () => {
     const t = tonNode();
     const info = { method: 'GET', path: '/getMasterchainInfo' } as const;
@@ -1407,7 +1410,7 @@ describe('the scripted toncenter node: never more lenient than the chain (F6-R5)
       endpoint: 'main',
       route: '/getMasterchainInfo',
     });
-  });
+  }, 30_000);
 });
 
 describe('the scripted toncenter node: the raw chain, deletion and re-deploy (F6-R21)', () => {
```

- [ ] **Step 2: Run the whole suite under `--detectOpenHandles`**

Run: `pnpm exec jest --detectOpenHandles`
Expected (about 4½ minutes, in one process): `Test Suites: 5 skipped, 140 passed, 140 of 145 total`, `Tests: 15 skipped, 2820 passed, 2835 total`, exit code 0, and no "Jest has detected the following … open handle" report. Before Step 1 the same run ends `Tests: 2 failed, 15 skipped, 2818 passed` with the two tests above, each "Exceeded timeout of 5000 ms".

- [ ] **Step 3: Run the release gate**

Run: `pnpm install --frozen-lockfile && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm doc && pnpm test:pack`
Expected:
- the install reports the lockfile up to date; `format:check` "All matched files use Prettier code style!"; ESLint and `tsc --noEmit` silent;
- Jest `Tests: 15 skipped, 2820 passed, 2835 total`, with coverage Statements 98.45%, Branches 93.14%, Functions 96.83%, Lines 98.45% (within a few hundredths) and no threshold failure;
- TypeDoc writes `docs/api/` with no warning;
- the pack check prints the five lines of Task 11 Step 3, ending `pack check: ok` (with the approved changelog the tarball is 1,311,628 bytes; without it, as in Task 11).

Then CI's secret scan, as in Task 11 Step 5 (`docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 dir /repo --no-banner --redact`, or the release binary): `no leaks found`, with this plan file and Task 12's files in the tree.

Then the sweeps:

```sh
rg -n "planned|next release|not on npm|from source" README.md docs/guides
rg -n "Toncoin" README.md docs/guides | rg -v "formerly Toncoin"
git log --name-only --format= db73e90..HEAD | sort -u | rg '^(\.claude/|\.superpowers/|\.env$|dist/|coverage/)'
git status --short
```

Expected: no match from the first three (the second only if a guide names the coin without "formerly"), and a clean tree (`docs/api/`, `dist/` and `coverage/` are ignored).

- [ ] **Step 4: Commit**

```bash
git add test/adapters/ton/node.test.ts test/adapters/ton/builder.test.ts
git commit -m "test(ton): explicit budgets for two long tests, so --detectOpenHandles passes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Hand the branch to the final review, then to the owner**

The controller runs the final whole-branch review (every Review Focus pin, the D1–D17 costs, Appendix B's dispositions against the diff) and, when it is clean, merges `plan/7-release` into `main` locally. The agent's work ends there. Everything below is the owner's.

**Changelog block:** none.

**Review points:**
- The two budgets change no assertion; each test still fails if its behaviour breaks (the budget only bounds wall time).
- The full suite under `--detectOpenHandles` reports no open handle: every timer, socket and worker loop the tests start is closed (Task 8's `close()` included).

### The owner's release checklist (owner actions, never agent steps)

Agents never tag, push, force-push, create the GitHub release or run `npm publish`. In order:

1. **Credentials (spec §19).** Rotate every provider token that was in the tracked `.env`, and move any funds held by its private keys and mnemonics to new keys. They are in the public git history and must be treated as compromised, whatever happens next.
2. **History.** Decide whether to rewrite git history to drop `.env`. Rotation (item 1) is what protects the funds; a rewrite only removes the copy, and forks and clones keep theirs. If you rewrite, do it yourself; an agent never force-pushes.
3. **The changelog.** If Task 12 ran without approval, review `docs/superpowers/plans/2026-09-30-plan-7-changelog-proposal.md` and apply it (`sed -n '/^# Changelog$/,$p' <file> > CHANGELOG.md`), or write your own `[0.1.0]` section. Do not release while `[0.1.0]` says the adapters are "planned".
4. **Date the release.** On `main`, change `## [0.1.0] - Unreleased` to `## [0.1.0] - <YYYY-MM-DD>` and commit.
5. **Tag and push.** `git tag -a v0.1.0 -m "crypto-aio 0.1.0"` on that commit, then `git push origin main v0.1.0`. The compare links of the changelog resolve from here on.
6. **The GitHub release.** Check that the repository secret `NPM_TOKEN` holds a publish token for `crypto-aio`, then create a **published** (not draft) release from `v0.1.0`, with the `[0.1.0]` section as its notes and the security advisory first. Publishing it runs `npm-ci.yml`: the tag check, the format check, lint, typecheck, tests, `pnpm doc`, the pack check, then `npm publish --provenance`. If any step fails, nothing is published; fix it on `main` and re-run the workflow.
7. **After the publish.** `npm view crypto-aio@0.1.0 version` answers `0.1.0`, and `npm view crypto-aio dist-tags.latest` answers `0.1.0`. The quick start and README already say `npm install crypto-aio` (D14): between the merge and this step they described a version npm did not serve yet, so keep that window short. `rg -n "from source|not on npm" README.md docs/guides` finds nothing.
8. **Optional.** Delete the remote `renovate/*` branches you no longer want (`git push origin --delete <branch>`, one per branch). Consider `npm deprecate 'crypto-aio@<0.1.0' "0.0.x is an unrelated, unmaintained API; see the 0.1.0 migration notes"`, which is your call.

---

## Appendix A: Validation record

Every code block of Tasks 1–13 was applied in order to a detached worktree of `db73e90` and validated there (Node 22.22.2, pnpm 10.5.2, a 4-core container). "Red" is the new tests run against the code before the task's fix.

| Task | Jest after the task (passed, skipped 15) | Suites (of total) | Red before the fix | Other evidence |
|---|---|---|---|---|
| base `db73e90` | 2,735 | 129 of 134 | — | `pnpm exec jest --detectOpenHandles` fails 6 (4 in `probe-rate-limit.test.ts`, 2 TON), all 5-second timeouts |
| 1 | 2,759 | 132 of 137 | 14 fail, 5 pass (the passing ones pin behaviour that must not change) | every keyed preset of the five families and a custom toncenter `api_key` URL |
| 2 | 2,763 | 133 of 138 | the pasted-name test fails (`unknown chain 'pasted-Zk8s…'`); 20 existing assertions fail on the old texts until Step 6 | the 15 test files listed in Task 2 |
| 3 | 2,777 | 134 of 139 | the lone-liar e2e test fails for both libraries (`TX_REJECTED` where `TX_REFUSED` is expected) | EVM e2e and builder suites green 30 runs in a row |
| 4 | 2,788 | 135 of 140 | the e2e cases sign about 100,002 gwei, and the over-ceiling fee, replacement and cancel are signed | the three guards of the review points each mutated out: each mutation fails its pinned test |
| 5 | 2,796 | 136 of 141 | every test throws "the contract has no ordering test" | six faulty stores fail the new assertion; the memory store passes |
| 6 | 2,802 | 137 of 142 | the option test fails (the endless-answer tests are not run on the old code: they exhaust the process's memory, which is the defect) | transport suites 174 tests |
| 7 | 2,808 | 138 of 143 | 5 of 6 fail (the peak-within-lag test pins unchanged behaviour) | transport suites green 30 runs in a row (180 tests) |
| 8 | 2,811 | 139 of 144 | 3 of 3 fail | the M8 tests compare the pass signal by effect |
| 9 | 2,820 | 140 of 145 | — (docs) | link check fails on an appended broken link and anchor, then passes restored |
| 10 | 2,820 | 140 of 145 | — (docs) | README snippets typechecked against the source (`tsc` with the package paths) |
| 11 | 2,820 | 140 of 145 | gitleaks finds 41 test values on `db73e90` and 44 after Task 1 (CI's `secrets` job is red on `main`) | coverage 98.45 / 93.14 / 96.83 / 98.45 (statements, branches, functions, lines) against thresholds 96 / 91 / 94 / 96; `pnpm test:pack` ok against the registry; gitleaks 8.30.1 and 8.28.0 find no leak with `.gitleaks.toml`, and still find a planted key |
| 12 | 2,820 | 140 of 145 | — (docs) | the proposal keeps all 63 other bullets of `main` verbatim, once; link check passes with it |
| 13 | 2,820 | 140 of 145 | 2 timeouts under `--detectOpenHandles` before the budgets | `pnpm exec jest --detectOpenHandles`: 2,820 passed, no open handle; the full release gate of Step 3; gitleaks on the final tree with this plan in it: no leak |

After every task: `prettier --check` on the changed TypeScript, ESLint, `tsc --noEmit` and `pnpm doc` were clean, and each Markdown file touched gave the count its step names. The plan contains 181 fenced code blocks; every one that is code, configuration or a guide edit was applied as written (prose reflowed by Prettier, as noted in Tasks 2 and 3), and the command blocks were run with the outputs shown.

## Appendix B: Inventory and dispositions (scope ruling A29)

Every item the handoffs (Plan 1 §4–§5, Plan 2 §5, Plan 2.5 §5, Plans 3–5 §5, Plan 6 §3 and §5), the brief and the author's review raised, exactly once. Sources: P1 = Plan 1 handoff, P2 = Plan 2, P25 = Plan 2.5, P3–P6 = Plans 3–6; "author" = found while writing this plan. A row that changed tier says so, with the reason, and is listed under its final tier.

### Counts

| Tier | Rows | Moved in | Done in this plan | Closed before Plan 7 | Owner | Deferred |
|---|---|---|---|---|---|---|
| 1. Release blockers | 10 | 0 | 10 | 0 | 0 | 0 |
| 2. Fund-critical | 5 | 0 | 5 | 0 | 0 | 0 |
| 3. Release mechanics | 29 | 0 | 21 | 4 | 4 | 0 |
| 4. Core hygiene | 6 | 0 | 6 | 0 | 0 | 0 |
| 5. Backlog | 66 | 16 | 0 | 0 | 0 | 66 |
| **Total** | **116** | **16** | **42** | **4** | **4** | **66** |

Tier moves (16, all to Tier 5): from Tier 2, F3-R11 (b) and (c) and F4-R8 (3) (D5), the typed ordering home (D7), the EVM gas-limit bound (D6), the A24 quorum floor and the dormant USDT `upgradedAddress` risk (B51–B57); from Tier 3, R5's tool bumps, R81, F4-R7, the jayson install note and spec §17's funded write tests (B58–B62); from Tier 4, the `require.cache` boundary test and N7 (D10), `deepFreeze` and `MAX_COINS` (B63–B66). Added by the author: B6 (Tier 1), B15 (Tier 2), the red `secrets` job in B34 (Tier 3), B55, B62 and B75.

### B.1 Tier 1: release blockers

| # | Item | Source | Summary | Disposition |
|---|---|---|---|---|
| B1 | F3-R20 | P3, P4, P5, P6 §5 | A bare key a provider echoes back (path segment, query value, header value, token after an auth scheme) survives the whole-string scrub into messages, `details` and `cause` | Task 1 (D1); Review Focus 1 |
| B2 | F3-R20, the path question | P3 §5 | REST error texts carry concrete paths (addresses, txids) | Task 1 (D2): the route template |
| B3 | F3-R20, per-family tests | P4, P5, P6 §5 | Test every keyed preset (Tron's header, Solana's path keys, TON's `X-API-Key`) and a custom toncenter `api_key` URL | Task 1 (`test/architecture/secret-echo.test.ts`) |
| B4 | F6-R24 | P6 §5 | Selection errors echo a caller-typed chain, network, library, wallet or signer name | Task 2 |
| B5 | F3-R16, the helper | P3, P4, P5 §5 | One bounded-name helper; UTXO's and Tron's `named()` echo up to 40 characters; Solana and TON refuse option keys by hand | Task 2 (D3) |
| B6 | the `native()` echo | author | `native(bc, name)` echoes the caller's library name | Task 2 |
| B7 | F6-R36 | P6 §5, the board | "Credit deposits only on `final` with `proven` evidence" is a promise no family meets | Task 9 (D8); the proven read is B67 |
| B8 | F4-R26 | P4, P5, P6 §5 | The owner's `[0.1.0]` line calls the adapters "planned" | Task 12 (OWNER APPROVAL) |
| B9 | A16 | P6 §5, the board | The README names the release, and TON's coin as "Gram (formerly Toncoin)" | Task 10; `index.md` in Task 9 |
| B10 | R87 | P2, P3, P4 §5 | "next release", "on `main`", "Plan 3 adds Bitcoin", "not on npm yet" | Tasks 9–11 (swept in Task 11 Step 5 and Task 13 Step 3) |

### B.2 Tier 2: fund-critical

| # | Item | Source | Summary | Disposition |
|---|---|---|---|---|
| B11 | Lesson 21 for EVM (F3-R10, F4-R20, R64) | P3, P4, P5, P6 §5 | EVM ends an Operation on one node's "invalid", freeing its nonce while the bytes may land | Task 3 (D4); Review Focus 2 |
| B12 | EVM fee ceiling (F4-R28) | P4, P5, P6 §5 | `maxFeePerGas` comes from the node, with no operator bound | Task 4 (D6); Review Focus 3 |
| B13 | The cross-family fee policy | P3, P4, P5, P6 §5 | One stated rule for the operator bounds of all five families | Task 4 (`transactions.md`) |
| B14 | Orderings round-trip whole (F4-R14 M3, F4-R15, F5-R10, F5-R13, F5-R14) | P4, P5 §5, P6 §3, §5 | The store contract pins only nonce orderings; a store that changes an expiry ordering can pay twice | Task 5 (D7); Review Focus 4 |
| B15 | `native()` SDK errors | author (D1) | An SDK's own error, from a `native()` client, may quote a provider's answer, key included | Documented in `security.md` (Task 1); the SDK received the text, so the core cannot scrub it |

### B.3 Tier 3: release mechanics

| # | Item | Source | Summary | Disposition |
|---|---|---|---|---|
| B16 | Version | P1 §5 | `0.1.0-dev.0` becomes `0.1.0` (the owner's `efe5639` "1.0.0" text is gone from `main`) | Task 11 |
| B17 | `[Unreleased]` into `[0.1.0]` (X5) | P2, P25, P3–P6 §5 | One release section; every family bullet once | Task 12 |
| B18 | Compare links | P2 §5 | `[Unreleased]` to `v0.1.0...HEAD`; `[0.1.0]` to `v0.0.2...v0.1.0` | Task 12 |
| B19 | The §19 advisory | spec §19, P1 §5 | Keep the advisory first, with the registry result | Task 12 |
| B20 | Pre-1.0 API breaks | P1 §5 | `Transfer` union, frozen tables, `Scanner` type-only, `DisposableNativeClient`, `Transport` accessors, `ProofSource.blockHash`, `maxLagBlocks`, `STATE_UNRECORDED`, `ambiguous`, `signTimeoutMs`, `signerTickets`, cancel `fee`, `HttpRequest.route`, kit additions | Task 12 ("Notes for builds of `main` before 0.1.0") |
| B21 | 0.0.x migration notes | P1 §5, spec §18 | `caio.eth.*`, `Ethereum`, `Tronix`, `*Account`, `*Contract`, `*Transact` | Task 12 ("Migrating from 0.0.x") |
| B22 | Plan 2.5 migration and store notes | P25 §5 | A18, the early `xpub` refusal, the reserved `options.hd`, waiting proofs; P25-R14, A27, the `leaseMs` bound | Task 12 (the migration lines were already `[Unreleased]` bullets; "For store implementers") |
| B23 | README | spec §18, P1 §5 | About 150 lines: what, install, quick start, config, many chains, matrix, extending, links | Task 10 (176 lines) |
| B24 | Guide layout (P1 D1) | P1 handoff | `docs/guides/` versus spec §18's `docs/guide/` | Task 9 (D9): keep `docs/guides/`, map spec §18 in `index.md` |
| B25 | `beforeSign` may run more than once (R23) | P1 §5 | Docs note | Closed before Plan 7 (`security.md`, "It may run more than once per Operation") |
| B26 | `POLICY_REJECTED` while `prepared` | P1 §5 | Docs note | Task 9 (`transactions.md`, the error table) |
| B27 | `1n` and `'1'` hash differently | P1 §5 | Docs note | Closed before Plan 7 (`transactions.md`, "an override is hashed as written") |
| B28 | N8 | P1 §4–§5 | A `final`-mode scan trusts the block contents one endpoint serves | Task 9 ("Crediting deposits") |
| B29 | F4-R27 | P4, P5, P6 §5 | "At least two independent providers" beside the families' "two or three" | Task 9 (`security.md`) |
| B30 | Quick start from npm | P1 §5 | Install from source until published | Task 11 Step 5 (D14) |
| B31 | The stale Pages site | P1, P2 §5 | `docs/{index,modules,hierarchy}.html`, `.nojekyll`, `assets/`, `classes/`, `functions/`, `interfaces/`, `types/` | Task 11 Step 6 |
| B32 | Stale coverage and its badge | P1 §5 | Tracked `docs/coverage*`, and the README badge that links there | Tasks 10 and 11 |
| B33 | Coverage thresholds | P1 §5 | Left to Plan 7 | Task 11 (96 / 91 / 94 / 96) |
| B34 | CI gaps | the brief, spec §17, author | Format check, coverage gate, token permissions, a publish that checks the tag and waits for a published release; the `secrets` job, red on `main` (gitleaks flags the test vectors), and its unpinned image | Task 11 (Steps 4–5: `.gitleaks.toml` allows the 20 test values; gitleaks pinned to v8.30.1) |
| B35 | The packaging check | the brief, spec §16 | Tarball contents; every entry loads as CJS and ESM; SDKs optional | Task 11 (`scripts/pack-check.mjs`); Task 13 |
| B36 | §19 registry check of 0.0.1 and 0.0.2 | P1 §5 | Only 0.0.3 had been checked | Done at authoring (D17); stated in Task 12's advisory |
| B37 | `pnpm doc` at every commit | the brief, R55 | — | Global Constraints; every task's last step |
| B38 | `--detectOpenHandles` failures (F3-R23) | P3, P5, P6 §5 | `probe-rate-limit.test.ts` (and, found here, two TON tests) time out in band | Task 7 Step 5; Task 13 Step 1 |
| B39 | Family documented limits | P4, P5, P6 §5 | Tron internal TRX, TRC-10, Solana and TON limits | Closed before Plan 7 (each family's `networks.md` section) |
| B40 | Plan 2 merge approval | P2 §5 | Owner action | Closed before Plan 7 (merged) |
| B41 | Rotate the credentials, move the funds | spec §19, P1, P2 §5 | Owner action | Owner (Task 13, item 1) |
| B42 | History rewrite | spec §19, P1, P2 §5 | Owner decision; never a force-push by an agent | Owner (Task 13, item 2) |
| B43 | Tag, release, publish | the brief, §19 | Owner action | Owner (Task 13, items 3–7) |
| B44 | Remote `renovate/*` branches | the brief, P6 §4 | Not the plans' branches | Owner (Task 13, item 8), optional |

### B.4 Tier 4: cheap core hygiene

| # | Item | Source | Summary | Disposition |
|---|---|---|---|---|
| B45 | Response byte cap (F4-R3) | P25, P3, P4, P5, P6 §5 | `response.text()` is unbounded; only the timeout bounds a hostile answer | Task 6 |
| B46 | Own-key lookups (F3-R2) | P25, P3 §5, P1 §5 | `ChainCatalog.network`, `deriveAddress`, `signerFor` read inherited keys | Task 2 |
| B47 | N3 | P1 §4 | `close()` does not stop the worker loops | Task 8 |
| B48 | The monotone height (N5 second half, F4-R20 (2), F6-R22) | P1 §4, P2, P4, P6 §5 | One forged far-future head stales every view until restart | Task 7 (the decay) |
| B49 | Probe 429s (F4-R24, F6-R28) | P3, P4, P6 §5 | A height-probe 429 clears the height; an identity-probe 429 locks the endpoint out 15 s | Task 7; Review Focus 5 |
| B50 | Keyless presets under load | P3, P4 §5 | The keyless Esplora, TronGrid and toncenter presets fail under load | Task 7 (the same fix; measured only on the fake transport) |

### B.5 Tier 5: the backlog

Items deferred past 0.1.0, each with the reason. None is a secret leak. Two could make a transfer that paid look failed, which invites a second payment: B57 (dormant until Tron deprecates USDT) and B102 (a TON quorum of one indexer service); both are documented with their mitigation. The rows marked "liveness" can stall an Operation or a read, the safe direction.

| # | Item | Source | Summary | Why it waits |
|---|---|---|---|---|
| B51 | F3-R11 (c) | P3, P4, P6 §5 (moved from Tier 2) | A second endpoint before a first-broadcast `rejected` | D5: every family now verifies a rejection against its own bytes; a `Broadcaster` port change for defence in depth |
| B52 | F3-R11 (b) | P3 §5 (moved from Tier 2) | A must-conflict set in the core | D5: moot while every family checks its own bytes |
| B53 | F4-R8 (3), R64 | P4 §5 (moved from Tier 2) | The broadcast fanout returns the first HTTP 200 answer | D5: after lesson 21 a liar's 200 refusal is only a transient `TX_REFUSED` (Tron) |
| B54 | Typed ordering home (F4-R15, F5-R14) | P4, P5, P6 §5 (moved from Tier 2) | Give the families' ordering fields a typed core home | D7: a public type change with no safety gain over the contract pin (Task 5) |
| B55 | EVM gas-limit bound | author, D6 (moved from Tier 2) | `eth_estimateGas` sets the gas limit; no operator bound | An inflated estimate only raises the reserved maximum (the funds check refuses what the wallet cannot cover) and burns more only when execution fails; a bound needs per-token limits |
| B56 | The A24 quorum floor | P25 §5 (moved from Tier 2) | `max(1, min(requested, counted))` lets a liar prove alone when every honest endpoint is out of the count | A ruling (A24) chose liveness; changing it changes every family's proofs. Task 7 narrows it: a rate-limited endpoint stays counted |
| B57 | USDT `upgradedAddress` | P2, P4 §5 (moved from Tier 2) | If Tron deprecates USDT to a new contract, emitter checks report `failed` for transfers that moved | Dormant (not deprecated); documented in `networks.md`; the fix is an alias migration when it happens |
| B58 | R5 tool bumps | P1 §2 (moved from Tier 3) | prettier and ts-jest pinned one release behind | Not needed for the release; a bump can reformat and needs its own run |
| B59 | R81 | P2 §5 (moved from Tier 3) | Split `crypto-aio/evm` typings per library | No user-visible defect; a packaging change after 0.1.0 |
| B60 | F4-R7 | P4 §5 (moved from Tier 3) | A structured HTTP status on `PROVIDER_MISCONFIGURED`; the `JSON.rawJSON` note | Additive; the message already names the status |
| B61 | The jayson install note | P25 §5 (moved from Tier 3) | A harmless unmet-peer warning (jayson → ws → utf-8-validate@^5) with the Solana SDK | A docs line only; no behaviour |
| B62 | Funded write tests (spec §17) | author (moved from Tier 3) | `CRYPTO_AIO_INTEGRATION_WRITE=1` enables no test; only read-only integration exists | Needs funded testnet keys in CI (owner secrets), after the credential rotation |
| B63 | The cross-family `require.cache` boundary test (F3-R16, F4-R17) | P3, P4, P5, P6 §5 (moved from Tier 4) | Watch `require.cache` by resolved path per family | D10: a guard for future changes; Task 11's pack check proves today that every entry loads with no SDK |
| B64 | N7 | P1 §4 (moved from Tier 4) | The memory store turns a non-iterable `clear` into `[]` | D10: the engine always passes an array |
| B65 | One shared `deepFreeze` (F4-R2, F6-R2) | P25, P4, P6 §5 (moved from Tier 4) | Four copies | D10: duplication, no gap |
| B66 | One `MAX_COINS` (F6-R10) | P6 §5 (moved from Tier 4) | Three copies | D10: duplication, no gap |
| B67 | A proven deposit read (F6-R30 (2), F6-R36) | P6 §5, the board | No driver raises a deposit above `observed` | D8: a new read path per family, and scanner trust first (B68); the guides now say how to credit `observed` deposits |
| B68 | Scanner trust | P3, P4 §5 | Bind Bitcoin block pages to the header, a merkle root and raw bytes; Tron's transaction list to the header hash | Not small; with a second read per deposit (Task 9) one endpoint cannot credit alone |
| B69 | F6-R34, a resend hook | P6 §3, §5 | Hand the ordering to the `Broadcaster`, or a veto hook, so any family whose ordering can repeat guards its resends | A port change; TON guards in its broadcaster today |
| B70 | F6-R37 Q2, read-path leniency | P6 §5 | Retryable asset failures on the read path | Liveness; needs the junk-jetton tests kept |
| B71 | Caller-supplied decimals (F6-R26, F6-R13) | P6 §5 | A decimals option on the asset or transfer path | Additive; a default could mis-scale 1,000×, so none exists |
| B72 | F5-R20, per-method limits | P4, P5, P6 §5 | Per-method rate limits; proof reads that wait out a short 429; measure Tron's reference search and TON's walk | Liveness; needs measurement on live endpoints |
| B73 | One bucket per host (F6-R2, F6-R25) | P6 §5 | toncenter limits per IP across v2, v3 and every handle's transports | Liveness; a transport-sharing change |
| B74 | A bounded token wait for trials (P25-R24; P25-R23 in P6) | P25, P6 §5 | A burst of 1 can keep a recovering proof endpoint out | Liveness |
| B75 | A persistently rate-limited proof endpoint | author (Task 7) | It stays in the proof count, so proofs wait while it answers 429 | The safe direction (Task 7's choice); a bounded demotion needs the A24 review (B56) |
| B76 | N5, first half | P1 §4, P2 §5 | No demotion after a quorum disagreement, so a liar among the first proof endpoints stalls verdicts | Liveness |
| B77 | N5 (Plan 2), the non-proof quorum | P2, P25 §5 | The non-proof quorum path throws the first endpoint's definitive error (P25-R10 closed the proof path) | Liveness (one token unresolvable until restart) |
| B78 | N1 | P1 §4 | `recover()` skips its checks when the write target cannot be resolved | Rebroadcast still requires `assertOwnedBy` |
| B79 | N2 | P1 §4 | Wallet resolution for the all-rejected verdict is not bounded by the caller's signal or a per-pass cache | Liveness |
| B80 | N4 (Plan 1) | P1 §4 | The first inclusion is recorded from one endpoint's `observe` | Verdicts stay under the proof quorum |
| B81 | N4 (Plan 2) | P2 §5 | EVM repeats the R88 nonce search each pass | Cost only; cache per `(from, nonce)` |
| B82 | R73 | P2 §5 | EVM `cancelBase` ranks by total charges; needs a price comparator | Closed for UTXO, Tron, Solana and TON; EVM precision only |
| B83 | R76 (narrowed) | P2 §5 | An endpoint-set change between `slotConsumed` and `includedFinal` decides nothing on EVM | Closed for the other families; liveness |
| B84 | A15 and the F3-R12 audit | P3–P6 §5 | Attempt-id uniqueness; quorum on what you parse | Closed for UTXO, Tron, Solana and TON by their final reviews; EVM's proof keys are unaudited (liveness: a raw-text difference is a disagreement) |
| B85 | EIP-7702 | P2 §5 | An authorization that consumes our nonce leaves R88 undecided | The safe direction |
| B86 | A "token did not log" code | P2 §5 | A distinct code instead of `TX_REVERTED`, every family | The R87 docs close the trap; a new code is out of Plan 7's scope (no new error codes) |
| B87 | A21 | P2, P3 §5 | `BuildContext.schemes`: a p2tr wallet with an ECDSA-only signer fails at signing | Safe (fails before any broadcast) |
| B88 | OP Stack operator fee | P2 §5 | Unverified, and not in the fee report | Estimate precision |
| B89 | F3-R25 R2-M1 | P3 §5 | Clear the own-transaction record on replace or cancel | Precision |
| B90 | F3-R25 R2-M2 | P3 §5 | Prove a double-spent parent dead, and the child with it | Liveness |
| B91 | F3-R25 R2-M3 | P3 §5 | Embed authenticated parents via `updateInput`; finalize p2pkh without the quadratic decode | Performance |
| B92 | F3-R6 | P3 §5 | A reorg-dropped transaction on full-mode electrs still shows unconfirmed by id | Documented in `networks.md` "Reorgs" |
| B93 | F3-R5, hardware wallets | P3 §5 | An optional key-origin setting (`bip32Derivation`) | Additive |
| B94 | Determinism (F3-R17 (4), F4-R20 (3), F5-R16) | P25, P3, P4, P5, P6 §5 | A container option for the transport id and `random`; a store clock; seedable build variants; one shared e2e env | Test ergonomics; no production effect |
| B95 | F4-R29 N1 | P4 §5 | Read `getForbidTransferToContract` under the proof quorum | Liveness |
| B96 | F4-R29 N2 | P4 §5 | The scripted Tron node's genesis timestamp | Test fidelity |
| B97 | Solana's fee quote (B8, M4) | P5 §5 | A sanity bound on `getFeeForMessage` | Never signed; a wrong quote mis-states an estimate or stalls |
| B98 | F5-R19 | P5 §5 | Node 22.0–22.11 surfaces `ERR_REQUIRE_ESM`, not `DEPENDENCY_MISSING` | Documented (Solana needs 22.12) |
| B99 | F5-R7 | P5 §5 | A mint every endpoint calls absent is cached for the container's life | A core rule to decide |
| B100 | N3 (Plan 5) | P5 §5 | Skip F5-R14's slot read while the finalized slot is below `blockhashSlot` | Optional, cost only |
| B101 | File splits | P1, P3, P6 §5 | `engine.ts`, TON `proofs.ts`, `reader.ts`, `api.ts`, the TON and UTXO e2e tests | Structure only |
| B102 | TON `failed(bounced)` | P6 §5 | Authenticate a bounce from our own chain | Optional (the final review); needs two independent indexers, which the TON guide recommends |
| B103 | TON batches (F6-R15) | P6 §5 | A core per-leg outcome | A feature |
| B104 | TON bounceable opt-in (D7) | P6 §5 | Send `UQ…` to active contracts bounceable, as TEP-2 wallets do | An opt-in candidate |
| B105 | `aio.signers` merge | P1 §5 | Rough edges | Minor |
| B106 | `acquireTimeoutMs` | P1 §5 | Shorter than `signTimeoutMs` | Minor |
| B107 | `resolve.ts` schemes | P1 §5 | Reads `instance.schemes` unguarded | Minor |
| B108 | `#withdraw` | P1 §5 | Loses the error's stack | Minor |
| B109 | Watch-only `publicKey` | P1 §5 | Its length is unchecked | Minor; the derived address is checked |
| B110 | Store contract gaps | P1 §5 | No pin for "no keys in error messages" or `purge` | Minor |
| B111 | `onReleaseError` | P1 §5 | An async rejection goes unhandled | Minor |
| B112 | Transport status | P1 §5 | `status()` healthy while the height is unknown; a half-open endpoint can admit a second request | Minor |
| B113 | Lifecycle minors | P1 §5 | Reconciliation scans from `chainPending`; a refusal can hide behind `dropped` after an ambiguous resend; the `TX_REPLACED` floor is untested | Minor |
| B114 | Hardening minors | P1 §5 | The only-native guard is text-based; the pooled driver is reachable through TS-protected methods | Minor |
| B115 | `.gitignore` and `.claude/` | P1 §5 | `.gitignore` does not list `.claude/` | The owner's call: the owner's checkout stages `.claude/settings*.json` |
| B116 | `cloneValue`/`deepFreeze` cycle guard | P1 §5 | No cycle guard | Config is plain data; a cycle throws a stack overflow at startup, not at runtime |

## Unresolved assumptions and risks

- **Sources not in the tree.** The brief cites the board, the common brief and the archive; none is in this repository. This plan works from the six handoffs, the spec and the code, which restate the rulings. A board ruling the handoffs do not restate is not reflected.
- **The owner's CHANGELOG approval** is the release's gate (Task 12): without it, `main` still says "planned".
- **Live endpoints were not exercised.** Task 7's 429 behaviour, the byte cap and the scrub are tested on `FakeFetch` and the scripted nodes; the keyless mainnet presets' behaviour under load is inferred from the Plan 4 and 6 reports.
- **The 64 MiB cap** is a guess at "larger than any honest answer": an EVM `eth_getLogs` over a wide range can be large. A higher value is one option away.
- **The EVM default of 1,000 gwei** stalls transfers during a fee spike above it (Polygon has seen several thousand gwei); the guide says so, and the option raises it.
- **The minimum fragment length of 8** leaves a secret shorter than 8 characters, echoed alone, unscrubbed (D1); no documented preset has one.
- **No `v0.0.3` tag.** The compare link starts at `v0.0.2`.
- **CI's `secrets` job is red on `main` today** (run 5 of `ci.yml`, on `db73e90`), on test values only; it stays red until Task 11 merges. A new key-shaped test value later needs an allowlist line (Task 11 Step 5).
- **`--detectOpenHandles` on a slower machine** may time out tests other than the five with budgets; a timeout is not an open handle.
