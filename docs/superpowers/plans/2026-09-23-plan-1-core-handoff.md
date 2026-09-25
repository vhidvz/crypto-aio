# Plan 1 (core) handoff

What Plans 2–7 still need from Plan 1's scratch ledger (`.superpowers/sdd/2026-09-23-plan-1-core/`, git-ignored, deleted after this commit). Read it with the spec (`docs/superpowers/specs/2026-09-23-blockchain-adapter-layer-design.md`), the Plan 1 file and the code. "Rn" is a controller ruling; "Nn" is a residual from the final re-review.

## 1. Status

- Delivered: the SDK-free core (`src/core/**`: model, catalogs, config, transport, signing, stores, Operation/Attempt engine, monitor, workers, scanner), `crypto-aio/native` and the testing kit `crypto-aio/testing` (FakeChain, FakeFetch, FakeClock, fake plugin with `fakechain` nonce / `fakeexpiry` / `fakeseqno` chains, FaultyOperationStore, store contract suites).
- Branch `feat/blockchain-adapter-layer`: 137 commits ahead of `main` (merge base `bd836f6`) before this handoff. All 29 tasks reviewed; the final opus review of the fix wave said "ready to finish the branch".
- Checks: 711 tests passing in 48 suites; `pnpm doc` 0 warnings (`treatWarningsAsErrors`); coverage at Task 29: lines 96.7%, branches 90.3%.
- Guides: `docs/guides/` (7 files). `test/docs/tutorial.test.ts` and `tutorial-sync.test.ts` keep the tutorial in step with the code.

## 2. Rulings

Each line gives the decision, then the cost if it is wrong.

- **R1.** Work in place on the branch, with no worktree. Cost: none.
- **R2.** Stage explicit paths only; `.superpowers/` is git-ignored; never commit `.claude/`. Cost: none. **(binds Plans 2–7)**
- **R3.** No baseline run before Task 1, because the old suite needed live Sepolia. Cost: none.
- **R4.** Model tiers: sonnet/haiku implementers, sonnet/opus reviewers. **Superseded by R21.**
- **R5.** Pin prettier `^3.9.8` and ts-jest `29.4.12` instead of exempting fresher releases from pnpm's minimum-release-age gate. Cost: one patch release behind; Plan 7 may bump them.
- **R6.** A commit trailer names the model that wrote the commit. Under R21 that is Opus. Cost: cosmetic. **(binds Plans 2–7)**
- **R7.** Redaction strips trailing punctuation after a URL and redacts objects and arrays under sensitive keys; over-redaction is the safe direction. Cost: some non-secret values (e.g. `publicKey` objects) log as `[REDACTED]`.
- **R8.** `null` and `undefined` pass through under sensitive keys, and a trailing `]` or `}` is stripped. Cost: `http://[::1]` at the end of a message is over-redacted.
- **R9.** `SigningOrchestrator` is the single guard for every `Signer`: it sanitizes the cause, checks the `SigningResult` shape and guards `getPublicKey`. Signers themselves stay passthrough. Cost: a code path that calls a signer directly can leak a custodian's message. **(binds Plans 2–6: never call a `Signer` outside the orchestrator)**
- **R10.** secp256k1 HD derivation uses `parsePath` segments, so there is one parser. Cost: none.
- **R11.** Store records hold plain data only: plain objects, arrays, primitives, `bigint` and `Uint8Array`. `clone` throws on class instances, `Date` and `Map`. Cost: storing a class instance fails loudly. **(binds Plans 2–6: `UnsignedTx`, `SignedTx`, orderings, `fee.details` and observations)**
- **R12.** Opus reviewer for the Task 12 store contract. **Superseded by R21.**
- **R13.** `OperationStore.update` rejects keys outside `OPERATION_PATCH_KEYS`/`CLEARABLE_FIELDS` before it mutates anything; the engine builds explicit patches. Cost: none. Binds durable stores through the contract suite.
- **R14.** The transport fix set: `HttpRequest.route`, breaker `onAbandon`, per-endpoint `notBefore`, `mayHaveSent` ambiguity, `redirect: 'error'`. M2, M7 and M8 are deferred. Cost: a larger transport. **(binds Plans 2–6: REST calls set `route`)**
- **R15.** Split an oversized fix into sequential dispatches that use targeted Edits. Cost: more dispatches.
- **R16.** Any endpoint failure after `fetch` was invoked marks the call may-have-been-delivered, except HTTP 401/403/429 and JSON-RPC -32005. Cost: some undelivered broadcasts are monitored as ambiguous. **(binds Plans 2–6)**
- **R17** (refines R16). A definitive answer (a JSON-RPC error, or a REST 4xx other than 401/403/408/429) is not ambiguous by itself, but it inherits ambiguity from an earlier tagged attempt. Cost: none. **(binds Plans 2–6)**
- **R18.** Health probes do no breaker bookkeeping, identity-throttled endpoints are skipped, an all-failed refresh sets a retry floor, and request-construction errors are `CONFIG_INVALID`. Cost: reads may wait out `openMs` after an outage.
- **R19.** Only identity-verified endpoints feed health heights. Cost: a slower first read after identity recovers. **(binds Plans 2–6: every factory sets `identity` and `height` probes)**
- **R20.** `env.restart()` starts a second live process, and `restart({ killPrevious: true })` means the old one died. `ready()` refreshes health and resolves wallets. `statusFromObservation` never says `final`. Cost: crash tests must opt into `killPrevious`. **(binds Plans 2–6 tests)**
- **R21.** All subagents run on opus (user instruction, 2026-09-24). Supersedes R4 and R12. Cost: spend. **(binds Plans 2–7)**
- **R22.** A pending signing result carries `tickets: {signerId, ticket}[]`, stored as `signerTickets` (the spec has `signerTicket`). Each ticket is cancelled through its own signer. Cost: a schema rename.
- **R23.** Every transition of an Operation that holds a reservation runs under the address lease, and the release happens under the same lease. Hooks may run more than once. Cost: `abandon` waits for the lease.
- **R24.** Broadcast handling never overwrites stronger evidence. `observation.reason` is sensitive. Late pending tickets are cancelled. Lease-less orderings take a per-Operation sign lock. New `lifecycle.signTimeoutMs` (120 s) with heartbeat renewal. Cost: an extra observe per rejection. **(binds Plans 2–6: normalize reasons)**
- **R25.** An Attempt that a node ever accepted is never made terminal by a later broadcast rejection; only proofs end it. `replaced` and `expired` count as on-chain states. Cost: it stays `submitted` until proven.
- **R26.** Read-only calls write only when state, outcome or error changes, and never write `nextCheckAt`. Post-broadcast writes re-read on `VERSION_CONFLICT` or surface `ambiguous`. The monitor hands all-rejected verdicts to `engine.failRejected` under the lease. Cost: reads no longer reschedule checks.
- **R27.** New error code `STATE_UNRECORDED` (category state, retryable) for "may have happened but was not recorded", with the original code in `details.causeCode`. Cost: callers see a new code. **(binds Plan 7: changelog, §13)**
- **R28.** `recordAmbiguous` keeps the original code and its catalogue retryability and only adds `ambiguous: true` and `operationId`. Cost: callers key retries on `ambiguous`. **(binds Plan 7 docs)**
- **R29.** Reconciliation CAS-bumps live, reservation-less `created` Operations before it computes the held set. The contract pins that a no-op `update` bumps `version`. Cost: one extra write per such Operation. Binds durable stores.
- **R30.** `replace` is idempotent per fee spec. A repeat `cancel` bumps a stuck one. `buildCancel` gains an optional `fee`, and the core writes `fee.details.requestedFee`. Cost: re-bumping at the same speed needs a higher explicit fee. **(binds Plans 2–6)**
- **R30.1.** A repeat cancel bumps only a refused or dropped cancel. An explicit `{ fee }` builds a new cancel while none is on chain. Cost: a cancel stuck below the floor needs `{ fee }`.
- **R30.2.** A `rejected` active replacement or cancel is treated as `refused`. Cost: none.
- **R31.** A failed own-ref lookup on the restored-away resend path surfaces `STATE_UNRECORDED` as ambiguous. Cost: an extra retry-with-key signal.
- **R32.** Monitoring and recovery are signer-free (`ReadTarget`). The wallet is resolved lazily, for writes only. The lease key comes from `op.intent.from`. The public key is cached per container and bounded by `signTimeoutMs`. Cost: one more wallet-resolution path. **(binds Plans 2–6: reads work from `(ref, ordering, from)` alone)**
- **R33.** New `ProofSource.blockHash(height, level)`, served with `quorum: 'proof'`. It must confirm orphan decisions and scanner rollback/TOO_DEEP verdicts; a disagreement or `null` decides nothing. Cost: one more port method per adapter. **(binds Plans 2–6)**
- **R34.** `createNativeClient?(): { client, close? }`. The root `close()` closes each registered client, then the pool. A closed container refuses handle and native work. Cost: a port shape change, cheapest before Plan 2. **(binds Plans 2–6)**
- **R35.** A transfer whose asset cannot be resolved becomes an `UnresolvedTransfer`: `unresolved: { asset, amount, code }`, with transaction `decoding: 'partial'`. Retryable and foreign errors still propagate. Cost: consumers must handle the variant. **(binds Plans 2–7)**
- **R36.** Lag tolerance precedence: `chains.<id>.maxLagBlocks`, then root `transport.maxLagBlocks`, then the plugin network's default, then the built-in 5. Cost: a plugin that needs a stricter value must document it. **(binds Plans 2–6)**
- **R37.** In-package registry augmentations target the entry module (`declare module '../index'`), never `core/model/ids`. Cost: a one-line revert. **(binds Plans 2–6)**
- **R38.** Condense the ledger into this committed file before deleting the workspace. Cost: one file to delete.
- **D1.** Guides live in tracked `docs/guides/*.md` and render through TypeDoc `projectDocuments` into git-ignored `docs/api/`. The stale 0.0.x site in `docs/` is left for Plan 7. The tutorial runs on the fake chain and is mirrored by a test. Cost: Plan 7 reconciles this with the spec §18 layout. **(binds Plan 7)**
- **D2.** Docs were drafted in git-ignored scratch alongside the fix wave, then verified against the final API. Cost: none (done).

## 3. Obligations for adapter plans (2–6)

The `ChainDriver` JSDoc table in `src/core/driver/types.ts` is the contract. The points below are the ones the core relies on and cannot detect.

**Per-method purpose, retry and quorum**

- Reads (`getBalance`, `getBlock`, `getTransaction`, `getTokenMetadata`, builder `estimateFee`/`checkFunds`/`build`, replacement builders, `history.list`): purpose `read`, retry `safe`, `null` when not found. `history` uses the indexer transport when one is configured.
- `getBlockHeight`, `getFinalizedHeight`, `observe`, `sequence.*` and `blocks.*`: purpose `monitor`, which only reaches non-lagging endpoints.
- `proofs.*`, including `blockHash`: purpose `proof`, `quorum: 'proof'`. A disagreement throws a retryable `PROVIDER_INCONSISTENT`. Only `slotConsumed(…, 'latest')` may be a single `monitor` read.
- `broadcast`: purpose `broadcast`, retry `ambiguous-on-failure`. Pass `fanout` and `signal` through.

**Broadcast ambiguity**

- Map a node `RPC_ERROR` to `refused`, `rejected` or `already-known` only when `!error.ambiguous`. Rethrow an ambiguous one, and every other failure, unclassified. The fake driver's Task 19 rule is the reference.
- `rejected` means permanently invalid by construction; it is the only outcome that ends an Attempt without proof. Everything state-dependent is `refused`, and the core runs an own-ref lookup for "nonce too low" or "already spent".
- `signed.ref.id` is empty for bare broadcasts; never rely on it.
- Reasons are stored as sensitive (R24). Still normalize them to short text with no addresses or amounts.

**Errors and assets**

- Throw classified crypto-aio errors. A foreign error is treated as a driver bug and fails the read (R35).
- A token's own metadata failure is a non-retryable crypto-aio error, e.g. `ASSET_RESOLUTION` (N6). Transient failures are retryable.
- Fees must be in a resolvable asset: an unresolvable fee asset still fails the read.
- **M10 (open; Plan 4 must decide).** `DriverContext` has no asset resolver, and `DriverIntent` carries base units with no decimals.

**Ordering and replacement**

- `build` returns `UnsignedTx.ordering` of the driver's `ordering` kind, carrying exactly the allocated nonce or seqno (`assertBuiltOrdering`). An `inputs` ordering never spends `ctx.excludeInputs`.
- The built ordering is authoritative for `validUntil` and expiry: the core reads it, never the reservation.
- A replacement or cancel must be `mutuallyExclusive` with every earlier Attempt. For `inputs`, exclusion is not transitive, so share at least one input with each earlier Attempt.
- `buildCancel` honours a given `fee` and refuses with `FEE_TOO_LOW` below the network's bump. Never set or read `fee.details.requestedFee` (R30).

**Block-source rules**

- Heights are dense: use block height, not slot, on Solana. `header(h)` is `null` only while `h` is not yet visible.
- Serve headers at least about 2 × `reorgWindow` below the head.
- `addresses: []` or absent means no filter. A non-empty list returns at least every transaction from or to those addresses.
- `assets` is a hint only; the core does not filter again.
- `transactions(block)` throws a retryable `PROVIDER_INCONSISTENT` when the block at that height no longer has `block.hash`.
- `observe` may get `ordering` and `from` as `undefined` for an unmanaged transaction, and returns `{ seen: 'none' }` when the transaction is not visible.
- `blockHash` returns `null` above the head, or above the finalized height for `'finalized'`.

**Native clients**

- `createNativeClient` builds a fresh SDK instance on every call, never the pooled one. The core can only check isolation by object identity.
- `close` must release sockets, timers and workers. Plan 2 adds a timeout around it (N6).

**Factory and transport**

- `create()` calls `transport.setProbes({ identity, expectedIdentity, height })` exactly once, right after construction and before any traffic, on every transport it receives, including `indexer` (M12).
- The identity probe returns a short network id that equals `NetworkInfo.identity`. It is emitted in `provider.misconfigured`, so never a message or URL. Without probes, endpoints stay `unknown`.
- SDKs use `PLACEHOLDER_ORIGIN` with `transport.createFetch(classify)`. Classify each call's purpose and retry class; broadcasts are `ambiguous-on-failure`.
- `rpcRaw` returns the parsed body unvalidated (deferred M7), so check envelope ids and `result`/`error` yourself.
- Other deferred transport limits: no shared identity-check deadline (M2); fanout waits for every endpoint (M8); one attempt can take up to 3 × `timeoutMs`.
- Never mutate the deep-frozen config objects: `ResolvedProvider`, endpoints and `DriverContext.options`.
- `AdapterManifest.load()` must be idempotent: catalog clones load it again. It `require()`s the SDK lazily; `src/` has no `import()`.

**Plugins, data and logs**

- Augment `ChainRegistry`, `FamilyRegistry` and `NativeClientMap` through the entry module (R37). Extend `test/architecture/registry-augmentation.test.ts` for each new family.
- `src/core/**` stays SDK-free; `test/architecture/boundaries.test.ts` and ESLint enforce this. SDKs go in `peerDependencies`.
- Id charsets: chain `[a-z][a-z0-9-]*`, network `[a-z0-9-]+`, token standard `[a-z0-9-]+`. `assetId()` does not validate the standard, and a round trip through `parseAssetId` breaks without it.
- `ChainCatalog.register` freezes shallowly, so never mutate `networks`, `nativeAsset` or `schemes`. Explorer templates hold one `{id}` or `{address}`; only the first is replaced.
- A plugin's `SignatureScheme.verify` returns `false` and never throws: a throw escapes the orchestrator raw (open Task 21 item).
- Driver logs and events carry codes, ids and sizes only. Never addresses, amounts, raw transactions, signatures, URLs or `IntentSummary`.

**Tests**

- Crash-then-recover tests use `env.restart({ killPrevious: true })`. Plain `restart()` is only for generations that run concurrently.
- **Plan 3.** The `inputs` ordering has no end-to-end coverage: FakeChain is account-only, and only the helpers are unit-tested. Add a UTXO fake, then run the crash matrix, Review Focus 3 (concurrent transfers), replace/cancel exclusion and `slotConsumed` on `inputs`.

## 4. Residuals N1–N8 (final re-review, none load-bearing)

- **N1 (Plan 7).** `recover()` skips its checks when the write target cannot be resolved. Rebroadcast still requires `assertOwnedBy`.
- **N2 (Plan 7).** Wallet resolution for the all-rejected verdict is not bounded by the caller's signal or a per-pass cache, so N such Operations can each wait `signTimeoutMs`.
- **N3 (Plan 7).** `close()` does not stop worker loops; `operations.recover()` and `monitor.runOnce()` still run after close.
- **N4 (Plan 7).** The first inclusion is recorded from one endpoint's `observe`.
- **N5 (Plans 2–7).** An endpoint is not demoted after a quorum disagreement, so a liar among the first two proof endpoints stalls verdicts. The verified peak never drops, so one absurd height makes every view stale.
- **N6 (Plan 2).** Add the `getTokenMetadata` classification rule to the contract table. Cache non-retryable metadata failures (a failing token is now re-queried per transfer). Bound native `close()` with a timeout.
- **N7 (Plan 7, minor).** The memory store turns a non-iterable `clear` into `[]`. Pin a rejection in the contract.
- **N8 (Plan 7 docs).** Final-mode scanning trusts the header endpoint's block contents; R33 covers verdicts only.

## 5. Plan 7 (release) items

**Changelog: pre-1.0 API breaks and additions**

- `Transfer` is now `ResolvedTransfer | UnresolvedTransfer` (R35).
- `TERMINAL_STATES` is a frozen array, not a `Set`, and every exported table is deep-frozen (M1).
- `Scanner` is exported as a type only; get one from `bc.scanner()`. `ScanEventBody` is exported (M2).
- `DisposableNativeClient` is new, and `createNativeClient` returns `{ client, close? }`. After close, work fails with `INVALID_TRANSITION` (R34).
- `Transport` gains the `maxLagBlocks` accessor and `hasProbes()`, and `highestHeight()` is monotonic.
- `ProofSource.blockHash` (R33).
- `chains.<id>.maxLagBlocks` (R36).
- New `STATE_UNRECORDED` code (R27) and the `ambiguous` semantics (R28).
- New `lifecycle.signTimeoutMs` (R24).
- `signerTickets` (R22).
- `cancel`/`buildCancel` take an optional `fee` (R30).
- `HttpRequest.route` (R14).
- Testing kit: `restart({ killPrevious })`, `forkAbove` and `fake_getBlockHash`.

**CHANGELOG and version (reconcile with the owner)**

- The owner's commit `efe5639` made `CHANGELOG.md` read "1.0.0 – initial release". That drops the spec §19 security advisory; the original text is in Plan 1, Task 1. Meanwhile `package.json` is `0.1.0-dev.0`, and the guides say 0.1.
- Add migration notes from the 0.0.x API (`caio.eth.*`, `Ethereum`, `Tronix`, `*Account`, `*Contract`, `*Transact`), per spec §18.

**Stale files and docs**

- The 0.0.x GitHub Pages files in `docs/`: `index.html`, `modules.html`, `hierarchy.html`, `.nojekyll`, `assets/`, `classes/`, `functions/`, `interfaces/` and `types/`.
- Stale 0.0.x coverage output in `docs/coverage/lcov-report/src/{libs,tool,type}`. `pnpm test:coverage` writes the tracked `docs/coverage*`, and the README coverage badge links there.
- The full README (spec §18, about 150 lines).
- The quick start installs from source (`crypto-aio-*.tgz`); switch to `npm install` once the release is published.
- Coverage thresholds, which Plan 1 left to Plan 7.
- Docs notes:
  - `beforeSign` can run more than once per Operation (R23).
  - `POLICY_REJECTED` can surface while an Operation stays `prepared` after its lease was lost.
  - `1n` and `'1'` fee overrides hash as different intents: a false conflict, in the safe direction.
  - N8.

**Owner actions (never done by agents)**

- Rotate the compromised `.env` credentials and move any funds they hold.
- Decide whether to rewrite git history. Agents never force-push.
- The published 0.0.3 tarball was verified free of `.env`; 0.0.1 and 0.0.2 were not checked.

**Open core minors to triage**

- Config:
  - `cloneValue`/`deepFreeze` have no cycle guard.
  - Plain-index lookups in `deriveAddress` (handle.ts) and `signerFor` (wallet.ts).
  - `aio.signers` merge rough edges.
  - The container's `acquireTimeoutMs` (= `leaseMs`) is shorter than `signTimeoutMs`.
- Signing:
  - `resolve.ts` reads `instance.schemes` unguarded.
  - `#withdraw` loses the error's stack.
  - Watch-only `publicKey` length is unchecked.
- Stores:
  - The contract suites do not pin "no keys in error messages" or `purge`.
  - An async `onReleaseError` rejection goes unhandled.
- Transport: `status()` reports healthy while the height is unknown, and a half-open endpoint can admit a second request.
- Lifecycle:
  - Reconciliation scans from `chainPending`.
  - A refusal can hide behind `dropped` after an ambiguous resend.
  - The `TX_REPLACED` floor is untested.
- Hardening:
  - The only-native guard is text-based.
  - The pooled driver is reachable through TS-protected handle methods.
  - `engine.ts` (2,254 lines) is not split.
  - `.gitignore` does not list `.claude/`.

## 6. Spec-vs-code gaps (deliberate; the code and guides follow the code)

- **No `aio.assets.register`** (spec §6). Assets come from plugins.
- **`TransferOptions` is `{ idempotencyKey?, signal? }`** (spec §5 also lists `wallet`, `signer` and `confirmations`). Those three are handle and scope options (`HandleOptions`, `chains.<id>`), and `confirmations` also goes to `wait`.
- **`abandon` is not allowed from `stalled`.** This matches spec §8.2 ("only before signed"), but the docs brief assumed otherwise. A `stalled` Operation resolves only by `rebroadcast`, `replace`, `cancel`, `rebuild` or a proven verdict.
- **Replace, cancel and rebuild need a synchronous signer.** A `pending` answer fails with `SIGNING_FAILED`.
- **Port additions:** `signerTickets[]` instead of `signerTicket` (R22); `STATE_UNRECORDED`, with no `INTERNAL` code (`serializeError` takes a fallback code); `ProofSource.blockHash`; the `createNativeClient` shape; the `Transfer` union; the lag precedence and its new config field; `lifecycle.signTimeoutMs`.
- **Testing kit:** `FakeFetch` instead of `FakeRpcTransport`, and FakeChain is account-only (spec §17 says account and UTXO).
- **Guides:** `docs/guides/` has index, quick-start, concepts, tutorial, transactions, networks and security. Spec §18 lists `docs/guide/` with architecture, configuration, exchange-operations, stores and writing-adapters.
- **Stores:** only the in-memory stores ship; durable stores are the user's (spec §20).

## 7. Process notes for later plans

- Run every subagent (implementer, reviewer, final review) on opus (R21). Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Implementers hit the 64k output cap: use targeted Edits, never whole-file rewrites, and split large fixes into groups (R15).
- Stage explicit paths only. Never commit `.claude/`, `.superpowers/` or `.env`. Never push, and never touch `main`.
- pnpm 10.5.2 (`packageManager`; `onlyBuiltDependencies` is pnpm 10 syntax, although the Plan 1 file says pnpm 11). Before each commit, run `pnpm format && pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm doc` when docs change.
- `pnpm format` covers only `{src,test}/**/*.ts` and root `*.{js,mjs}`. Run `pnpm exec prettier --write <file>` for Markdown.
- The store contract suites are the compatibility boundary for Redis and Postgres stores. Change them only on purpose, and keep the memory stores as strict as a serialized store (R11, R13, R29).
- Owner invariants still bind: never sign twice; never lose a persisted signed Attempt; observed evidence never becomes terminal; redaction, failover, identity and lag hold jointly; the testing kit stays deterministic.
