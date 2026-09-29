# Plan 3 (UTXO) handoff

What Plans 4–7 need from Plan 3's scratch workspace, `.superpowers/sdd/2026-09-25-plan-3-utxo/` (the controller ledger, briefs, reports, reviews and review packages). It is git-ignored and is deleted after this commit. Read this with the Plan 2 handoff (R39–R94, A1–A27, lessons 1–18), the Plan 2.5 handoff (P25-R1–R25, X2–X7), the Plan 3 file (`2026-09-25-plan-3-utxo.md`: decisions D1–D30, the risk table, the merge notes; D19 and Appendix A were corrected in `362f8a2`, and its task code blocks are historical, so the code is authoritative) and the code. "F3-Rn" is a Plan 3 controller ruling; "D-Tn-m" is a Task n implementer deviation that its review accepted. A28 and lessons 20–21 come from the cross-plan board and are restated here.

## 1. Status

- **Delivered:** the UTXO family (`src/adapters/utxo/**`, entry point `crypto-aio/utxo`). Chain `bitcoin` (mainnet, testnet, testnet4, signet, regtest) with bitcoinjs-lib 7.0.2 as an optional peer (`^7.0.2`) behind an ECC backend on `@noble/curves` (no WASM); p2wpkh (default), p2sh-p2wpkh, p2pkh and p2tr wallets; PSBT (base64) payloads with one signing request per input, and signed PSBTs through `submitSignatures` (Plan 2.5's `signaturesFrom`); `inputs` ordering; coin selection `accumulative` and `all`; `{ satPerVByte }` overrides, the absurd-fee guard and the `maxEstimatedFeeRate` cap; BIP125 replace and cancel; 6-confirmation finality under the proof quorum; block scans; confirmed-only address history; `ext.utxo.listUnspent` and `coinSelection`; `native(bc, 'bitcoinjs-lib')`; miner-malleated p2pkh copies recognised (C2).
- **Modules (23):** data (`types`, `chains`, `presets`, `network`); policy (`address`, `fees`, `coinselect`, `errors`, `spend`); codec (`sdk`, `ecc`, `codec`, `signed-psbt`; only `sdk.ts` requires bitcoinjs-lib); Esplora I/O and the ports (`esplora`, `context`, `decode`, `reader`, `builder`, `proofs`, `preview`); wiring (`driver` with `utxoDriverFactory` (D24), `plugin`, `index`).
- **Presets:** `mempool`, `blockstream` and `public` (mempool.space, then blockstream.info; `production: false`; mempool.space alone on testnet4). Each is registered as both an `rpc` and an `indexer` provider (D1). All are keyless, with no `rateLimit` (F3-R1). Regtest needs your own Esplora.
- **Entry points.** `crypto-aio/utxo` exports `UTXO_CAPABILITIES`, `UTXO_PEER_DEPENDENCIES`, the SDK-free `Utxo*` types and the `NativeClientMap` augmentation (`UtxoNativeClient`); there is no `utxoChainPlugin`. The main entry registers `utxoPlugin()` and re-exports nine `Utxo*` types; `dist/index.d.ts` names no SDK.
- **Shared files:** `package.json` (the `7.0.2` devDependency, the optional peer, and `./utxo` in `exports` and `typesVersions`), `pnpm-lock.yaml` (+84 lines, pnpm 10.5.2), `src/index.ts`, `typedoc.json` and `test/architecture/registry-augmentation.test.ts`. There is no `src/core/**` or `src/testing/**` change.
- **Tests:** 14 suites in `test/adapters/utxo/`, over a test-only scripted Esplora node (`support/node.ts`, `script.ts`, `esplora.ts`; A7, D20) that follows Bitcoin Core 30's `sendrawtransaction` order and texts (v29 behind `legacyScriptErrors`) and verifies every signature. Also the opt-in, read-only `test/integration/utxo.test.ts`.
- **Guides**, edited by hand (D27): `index.md`, `quick-start.md` ("Configuring a real network (Bitcoin)"), `networks.md` ("Bitcoin networks"), `transactions.md` ("On Bitcoin, …" paragraphs) and `security.md` ("Bitcoin safeguards"). Also `README.md`, and four bullets under `CHANGELOG.md` `[Unreleased]` → Added.
- **Merged** into local `main` on 2026-09-29 by fast-forward to `021f69f` (not pushed). Plan 4 (Tron) had merged first (`d20facc`), so `plan/3-utxo` was rebased onto `main` (`eeb992a`) with every shared-file conflict resolved by union: 40 commits over `eeb992a` (the 39 branch commits and one R2-M2 docs commit). The branch and its worktree are deleted; the ledger is archived in `.superpowers/archive/plan-3-utxo-*`.
- **Commits by task** (the ledger's SHAs for Tasks 2–5 predate the rebase onto `759e4c8`; Task 1 was lifted into Plan 2.5): 2 `2da200e` `da454bd`; 3 `6939141` `db2563a`; 4 `9466234` `bfd817e`; 5 `144570e` `6cf03dc`; 6 `aeaeb1f` `8d3f8c1` `4995a1b`; 7 `8ff75cf` `db1d748`; 8 `8f0d9a4` `e2549ca`; 9 `e688b1c`; 10 `7d9f3e8`; 11 `2fac0f3`; 12 `dd416c4`; 13 `995e305`; final wave `ac91a59..5271bb0`; final-wave round 2 `9ff2281..e7d6e74` (pre-rebase SHAs).
- **Reviews.** Every task was reviewed on opus, and every fix round got a scoped re-review. The final whole-branch review (`759e4c8..995e305`) found 0 Critical, 2 Important (I1, deposit crediting in the guides; I2, a flaky and slow xpub change search) and 4 Minor: "Ready to merge — With fixes". The final wave (`995e305..5271bb0`, F3-R23) landed every item except an optional e2e file split. The same reviewer's scoped re-review then found two more Important gaps from the brief's own scope (F1: a made-up previous transaction still froze a transfer for good; F2: bitcoinjs's quadratic decoder ran on untrusted bytes). Round 2 (F3-R24) closed both at the root, and the round-2 re-review said "Ready to merge: Yes" with three Minors (F3-R25).
- **Checks on merged `main` at `021f69f`:** format, lint, typecheck, build and `pnpm doc` are clean; 1,935 pass, 9 skipped (the opt-in suites), 0 fail, in 98 suites; `dist/index.d.ts` names neither SDK. Before the rebase, at `e7d6e74`: 1629 pass, 6 skipped; round 2's sweep killed 18 of 19 mutants (one equivalent). The UTXO suites passed 20 consecutive runs (411 tests each) at load 10–18 on 8 cores, and the final-wave sweep killed 31/31 mutants. The opt-in suite passed live on mainnet, testnet and signet through blockstream, BIP30 check included; Task 12 had passed live on 7 routes, mempool.space included.

## 2. Rulings F3-R1–F3-R25

Each entry gives the decision, then why. **Fund-critical** marks a ruling without which a transfer could pay twice, a deposit could be over-credited, or an Operation could end on false evidence. F-R1 (the user's) is in §4.

- **F3-R1 (A28).** A keyless preset sets `rateLimit` only when its operator publishes a rate. Esplora hosts publish none, so no Bitcoin preset sets one, and the guide tells production users to set their own. A published rate is split when one host backs two presets. Why: a guessed rate throttles for nothing or protects nothing.
- **F3-R2.** Preset and network tables use own-key lookups (`Object.hasOwn`), and the applied options are pinned. Why: `toString` read as a supported network. The core's `ChainCatalog.network` has the same pattern (Plan 7).
- **F3-R3 (lesson 20).** Addresses are capped at 90 characters before any decoding. Other checks: the taproot tweak must be on the curve, output programs must be exactly 20 or 32 bytes, dust uses the full CompactSize, and the HRP is at most 30. Why: scure's base58 is O(n²), and a 10,000-character recipient blocked the event loop for 67 s.
- **F3-R4.** A structural lesson-20 pin replaces a wall-clock test. An estimate outside 0–10⁷ sat/vB is a retryable `PROVIDER_UNAVAILABLE`. `accumulative` settles on every coin before it reports a shortfall. Why: the timing test flaked, and p2tr at 1 sat/vB reported a shortfall with available ≥ required.
- **F3-R5 (fund-critical: the cold-signing boundary).** Core-coordinated signed PSBTs are accepted.
  - A previous transaction is checked by its strictly decoded txid and the output it spends. Ours is stored witness-stripped, and a coordinator may add one to a non-taproot input.
  - Change-output fields and proprietary keys are ignored, and PSBT version 0 is allowed.
  - Script-path fields, unknown keys, signatures from a foreign key or another scheme, and other sighashes are still refused.

  Why: nothing a signer adds reaches the spend. The unsigned transaction must be byte-equal, and every signature is verified against the stored digest.

- **F3-R6.** Superseded by F3-R8. It had put the reorg-drop test on `lightMode` and proposed a Plan 7 resend of long-pending Attempts.
- **F3-R7.** Reading a signed PSBT is bounded:
  - a byte-equal fast path for our own previous transactions;
  - at most 4,000,000 bytes of coordinator-added data in all;
  - `Buffer` base64 decoding with a canonical round-trip check.

  Why: 160 inputs with `nonWitnessUtxo` off took 8 s of synchronous decoding.

- **F3-R8 (fund-critical).** The node and the classifier follow Bitcoin Core 30's real texts.
  - Core 30 has no consensus re-check when it accepts a transaction to its mempool. Every script failure reads `mempool-script-verify-flag-failed (…)` under code -26, which we classify as `refused`, and `block-script-verify-flag-failed` never reaches `sendrawtransaction`.
  - Replacement rule 6 is compared exactly.
  - When `/tx` says a transaction is unconfirmed, `observe` reads its first input's `outspend`. Unspent gives `none`, and the core rebroadcasts. Another spender also gives `none`, and our own gives mempool.

  Why: the old texts made `rejected` reachable where Core 30 refuses. Also, full-mode electrs serves a reorg-dropped transaction as unconfirmed forever.

- **F3-R9.** `observe` runs inside `proofRead`. An index contradiction is a retryable `PROVIDER_INCONSISTENT`, never `none`. Output addresses are derived from the script, never from `scriptpubkey_address`. Why: a provider that omits that field would make a deposit `partial`.
- **F3-R10.** Task 8 was accepted with `broadcastFanout ≥ 2` in the guides, against a lone fabricated first-broadcast `rejected`. F3-R11 superseded it in substance, and the final review found its rebuild question moot.
- **F3-R11 (fund-critical; lesson 21).** A node's `rejected` is a claim. The broadcaster returns `rejected` only when the claimed reason holds for our own bytes, checked locally: the bytes do not decode, or they break a `CheckTransaction` byte rule (empty inputs or outputs, oversize, value range, output total, duplicate inputs, null prevout, coinbase). Script and prevout-dependent reasons are `refused`. A cancel pays `sender.from`. Why: a terminal `rejected` frees the inputs. If a lying endpoint relayed our valid bytes, the caller's retry spends other coins, and both transactions confirm.
- **F3-R12 (fund-critical: D-T9-1, D-T9-2, BIP30).**
  - D-T9-1: our transaction in a block while another transaction's spend of its input is final is `PROVIDER_INCONSISTENT`, never "not included".
  - D-T9-2: each block page is bound to its block. The tx count must be 1–1,000,000, the page length exact, no txid repeated, and every status must name this block. A missing page is retryable.
  - D-T9-3: scan filters match inputs as well as outputs.
  - BIP30: blocks 91812/91842 and 91722/91880 repeat a coinbase txid, and `/tx/:txid/status` names the first of each pair. Both providers label page entries with the page's own block (checked live), so the strict check holds. A mainnet-gated test pins block 91842.
  - The final wave keyed the three proof reads of block hashes on `parseHash`.

  Why: a false "not included" is a proven `replaced`; an unbound page can skip a deposit; and a trailing newline split the quorum forever.

- **F3-R13.** Task 8's residual concerns became carries: an engine-level pin that the Operation stays alive, and guide text recommending fanout ≥ 2 and `nonWitnessUtxo` on. Why: a liar that rejects every broadcast can only stall the transfer.
- **F3-R14 (fund-critical).** Every input spent, including those a replacement or cancel adds, is authenticated against its previous transaction's raw bytes (`/tx/:txid/hex`). This covers all types, p2tr included, whatever `nonWitnessUtxo` says.
  - The previous transaction is accepted only when its computed txid equals the outpoint's, so one endpoint suffices.
  - It is capped at 4,000,000 bytes before decoding, and the output must exist in it.
  - A p2tr previous transaction is authenticated but never embedded.
  - Reads run 4 at a time, and a per-client cache keyed by txid holds at most 1,000 entries and 8 MB.
  - A mismatch is a retryable `PROVIDER_INCONSISTENT` at build time.

  Why: a lied value made our own bytes invalid for good. The Operation stalled with its inputs held and no way out, because `abandon` refuses signed bytes. This also closes the BIP143 two-session fee attack and the phantom-outpoint stall.

- **F3-R15.** A custom network may advertise only the capabilities the driver serves; anything else is `CONFIG_INVALID`, which lists the accepted names. `plan()` refuses a memo. Why: `add: ['memo']` let the core accept a memo that the builder dropped.
- **F3-R16.** A test pins "requires an indexer provider". The cross-family lazy boundary test and a bounded-name helper go to Plan 7 (§5). Why: `doMock` of bare names misses subpaths, and a bounded echo can still hold a token.
- **F3-R17.** A signed Operation stalled on `refused` cannot be abandoned (`INVALID_TRANSITION`). A replacement over a CPFP child is `FEE_TOO_LOW`, and a higher explicit fee wins. Why: the bytes may still be relayed, so the inputs stay held. It confirmed that F3-R14 was necessary.
- **F3-R18.** The e2e checks were tightened:
  - the original's two inputs are captured before eviction;
  - the crash tests use stores on the FakeClock;
  - the crash matrix runs to `final` and checks the payee was paid once.

  Why: the "same inputs" check was vacuous.

- **F3-R19.** Task 12's departures were accepted. The public presets refuse `/address/:a/utxo` beyond 500 UTXOs (HTTP 400, not retryable), so the live estimate uses an unfunded `from`. Why: the suite stays read-only and independent of network state.
- **F3-R20.** The secret-fragment scrub is a Plan 7 **release blocker** (core, all families). Concrete REST paths in errors are a Plan 7 privacy decision. In the opt-in suite, the 91842 check runs only on mainnet, and `maxEstimatedFeeRate` replaces `fee: 'slow'`.
- **F3-R21.** The guide sentences that F3-R14 changes, and the plan's Core 30 text (D19), joined the final wave. `security.md` keeps its claim for hosts and credentials.
- **F3-R22 (fund-critical docs).**
  - Never retry a stalled transfer as a new transfer: a new idempotency key spends other coins, and both can confirm. Repeat with the same key, or use `rebroadcast`, `replace` or `cancel`.
  - The guides now list what a signed PSBT may add, and say that error texts may carry the request path.
  - A test pins replace and cancel after the original is mined: `TX_REFUSED` before the workers see the block, `INVALID_TRANSITION` after it.
- **F3-R23.** One final-wave dispatch covered A1–A5 (merge-blocking), B1–B11 and C1–C3.
  - **Fund-critical I1:** credit a Bitcoin transfer only when its `to` is not among `transfer.from`, because change and cancel refunds return to the sender. Never use a scanned deposit address as `changeAddress`.
  - I2: the xpub is parsed once, and its chains are cached (3.3 s → 0.2 s).
  - B10: the node-trusting `classifyBroadcast` is removed.
- **F3-R24 (fund-critical, round 2).**
  - **F1:** every new input's parent transaction must sit in a block attested by the proof quorum at the parent's own height, at least `max(1, minInputConfirmations)` deep and still canonical (cached once final). Under `minInputConfirmations: 0`, an unconfirmed output is spendable only if its transaction is the wallet's own accepted Attempt whose bytes this client keeps; anyone else's unconfirmed payment waits for a block (retryable `PROVIDER_UNAVAILABLE`).
  - **F2:** untrusted transaction bytes are read by an SDK-free linear reader (counts bounded against the remaining bytes, non-witness part ≤ 1,000,000 bytes), and the txid is checked before any bitcoinjs decode on every untrusted path. A 3.98 MB hostile transaction is refused in about 10 ms (was 53 s).
  - N1/N2: "nothing new can land" after a mined original; `classifyOwnBroadcast` decodes the sent hex itself.
- **F3-R25.** Merge approved. R2-M2 (docs) landed with the merge: a reorg after the build that double-spends a parent shallower than finality can freeze a transfer at any `minInputConfirmations` below 6. R2-M1 and R2-M3 go to Plan 7 (§5).

## 3. Binding notes for Plans 4–6, and the merge convention

**Merge convention.** Plan 3 merges first. Then Plans 4–6 each run `git rebase main`, one at a time.

- **`package.json`.**
  - `exports` and `typesVersions["*"]` keys stay alphabetical: `.`, `./evm`, `./native`, `./solana`, `./testing`, `./ton`, `./tron`, `./utxo`, then `./package.json` last. This overrides the briefs' "after `./evm`", and UTXO's `plugin.test.ts` pins the order.
  - The `"testing"` line's trailing comma conflicts in every family; fix it by hand.
  - Keep peers and devDependencies sorted.
  - Regenerate the lockfile with pnpm 10.5.2 only.
- **`src/index.ts` and `typedoc.json`.**
  - `BUILTIN_PLUGINS` is the union, `[evmPlugin(), utxoPlugin(), …]`, in any order.
  - Type exports and TypeDoc entry points are appended.
  - **The stale comment** "SDK client types are in `crypto-aio/evm`" is fixed at Plan 3's merge to name every family subpath; each later merge adds its own.
- **The no-SDK guard hides the whole SDK scope**, not only the SDK package.
  - UTXO's `hidden` regex lists `bitcoinjs-lib`, `bip174`, `valibot`, `varuint-bitcoin`, `uint8array-tools`, `bech32`, `bs58check`, `bs58` and `base-x`. Concatenate the alternations; Solana repeating `bs58` and `base-x` is harmless.
  - The registry-augmentation test conflicts in six places, each resolved by union: `OPTIONS.paths`, `USE_MAIN`, `declarations()`, the `withoutSdks` paths and `hidden`, the comment and title naming every SDK, and the control tests.
- **The lazy test lists every SDK.** UTXO's `lazy.test.ts` reads `SDKS` from `package.json` `peerDependencies`, and asserts that `load()` pulls in its own SDK and no other. After a merge it therefore checks each family against all of them. Copy this shape: the EVM/Tron shape checks only its own SDK, so it misses a cross-family require.
- **Guide conflicts resolve by union.**
  - Family-owned blocks:
    - table rows in `index.md` and `networks.md`;
    - `### <Family> networks` in `networks.md`;
    - `## Configuring a real network (<Family>)` in `quick-start.md`, before `## Next steps`;
    - `## <Family> safeguards` in `security.md`, before `## Production checklist`, plus one checklist line;
    - `transactions.md` paragraphs that start `On <Family>, …`;
    - `CHANGELOG.md` bullets, add-only, after the last family's.
  - Fix these by hand:
    - the entry-point count: "five entry points" in `index.md` and `quick-start.md`, plus one per family;
    - the plan lists: "Plans 4 to 6" and "today the EVM and UTXO families" in `networks.md`, "Tron, Solana and TON arrive in Plans 4–6" in the README, and "The other real chain families are planned." in `index.md`;
    - the planned-chain example in `index.md`, now `tron`;
    - Task 13 review M4's EVM-only shared lines.
  - Several families may each register a `public` preset.
  - Run a pack-install-load smoke test at each merge.

**Lessons and notes (binding where a family has the analogue):**

- **Lesson 20 (F3-R3).** Cap untrusted input before decoding. A regex reads only a bounded prefix. Large payloads get linear checks.
- **Lesson 21 (F3-R11).** Re-verify a claimed rejection against our own bytes; otherwise the result is `refused`. Make it hold at the type level: `nodeClaim` returns `invalid`, which is not a `BroadcastResult` kind, and only `classifyOwnBroadcast(error, bytes)` returns `rejected`. Plans 4 and 5 applied it in their Task 10b; TON has no `rejected` from node text (F6-R9).
- **Quorum on what you parse (F3-R12).** A proof or strict-quorum read passes the answer's normalizer as its `quorumKey`, and the key is exactly the value the verdict uses. Comparing raw text makes two honest providers disagree forever.
- **Authenticate an indexer's spendable state (F3-R14)** against self-authenticating chain data (bytes that hash to the id) before signing. A lie that makes our bytes invalid is a stall with no way out.
- **Error texts (F3-R16, B8).** Unknown options list the accepted names and never echo the caller's key.
- **Deposits (F3-R23 I1).** Where change or refunds return to the sender, a transfer back to the sender is not a deposit. A withdrawal to another customer's deposit address still is.
- **Keyless rate limits:** never guess one (A28).
- **Proof endpoints.** Recommend at least 2 independent ones, and `broadcastFanout ≥ 2`, which is first documented in the Bitcoin section.
- **Test techniques.**
  - Crash tests take a store factory, `(clock) => Partial<Stores>`, so that store times follow the FakeClock.
  - `@scure/base`'s `chain()` coders cannot be spied: load the module under `jest.isolateModules` with counting coders via `doMock`.

## 4. Execution order and branch map

1. **Plan 4 (Tron) merged first** (`d20facc`, 2026-09-29), because its final wave cleared before Plan 3's round 2.
2. **Plan 3 merged second** (`021f69f`): rebased onto `main`, the shared files resolved by union (§3), the full verify on the merged result, then a fast-forward of `main` and deletion of `plan/3-utxo` and its worktree.
3. **Plans 5 and 6 rebase onto `main`** one at a time and resolve the shared files per §3 and the Plan 4 handoff. The entry-point count is now six; the last family to merge sets it to eight or its final value. F-R1 (the user, 2026-09-27) still governs: finish every branch as fast as possible, with agents running concurrently. Each branch is pipelined: task N is reviewed while N+1 is implemented, with one writer per worktree.
4. **Plan 7 last:** release, docs and residuals.
5. From 2026-09-29 the user asked that agents run **one at a time** after rate-limit stops.

| Branch          | Tip at writing | Base      | Plan file (`docs/superpowers/plans/`) | State at writing                                                                                                       |
| --------------- | -------------- | --------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `plan/3-utxo`   | `021f69f`      | `eeb992a` | `2026-09-25-plan-3-utxo.md`           | MERGED into `main`; branch deleted                                                                                     |
| `plan/4-tron`   | `d20facc`      | `759e4c8` | `2026-09-25-plan-4-tron.md`           | MERGED into `main` first                                                                                               |
| `plan/5-solana` | `3cab8fe`      | `759e4c8` | `2026-09-25-plan-5-solana.md`         | all tasks done; final review and Task 12 review pending                                                                |
| `plan/6-ton`    | `892e361`      | `759e4c8` | `2026-09-25-plan-6-ton.md`            | Task 13 on `plan/6-ton-t10fix` (from `ef8d542`), which then fast-forwards `plan/6-ton`; then the final review and wave |

## 5. Plan 7 items raised by Plan 3

- **F3-R25 (round-2 Minors):** R2-M1, clear the own-transaction record when its Attempt is replaced or cancelled (or require the proof quorum to know an own parent); R2-M3, embed authenticated parents via `psbt.data.updateInput` and finalize p2pkh without bitcoinjs's quadratic lazy decode; R2-M2's core idea, prove a double-spent parent dead and with it the child.

- **RELEASE BLOCKER: scrub secret fragments, not only whole strings (F3-R20; core, all families).**
  - The core removes an endpoint's secret only as the whole URL or header value. A bare key echoed back by a provider survives into REST `details.body` and JSON-RPC messages (`http-transport.ts:1603`).
  - The fix: derive every fragment from each endpoint's config and scrub them all from every message, `details` field and `cause`. The fragments are query values, key-carrying path segments, header values, and the token after an auth scheme. Test each fragment echoed back.
  - Also decide whether REST error texts keep concrete paths (addresses, txids) or use route templates (`http-transport.ts:1341`). This is a privacy question, not a secrets one.
- **Lesson 21 for EVM**, and the core options (F3-R10, F3-R11 (b)/(c)): a must-conflict set, and a second endpoint required for a first-broadcast `rejected`. Both are moot for UTXO.
- **Quorum on what you parse (F3-R12).** Audit every family's proof and strict-quorum reads for raw-text comparison. UTXO's last three were fixed in B1.
- **F3-R16.**
  - A cross-family boundary test that watches `require.cache` by resolved path (with F4-R17). It catches subpath requires, an SDK's own dependencies and another family's SDK.
  - A shared bounded-name helper that lists the accepted names and never echoes the caller's key. Two known echoes remain: UTXO's `network.ts` `named()`, up to 40 characters, and the core's selection errors (a Plan 6 note).
- **Probe 429s (board, F4-R24).** A 429 on a health probe excludes the endpoint: a height-probe 429 clears its height, and an identity-probe 429 locks it out for 15 s.
  - Instead, back off and keep the last good height and identity.
  - The keyless Esplora presets set no `rateLimit`, so they meet this under load.
  - Separately, `probe-rate-limit.test.ts` fails 4 tests under `--detectOpenHandles`, the same on `main` (F3-R23).
- **Determinism.**
  - `CryptoAio` cannot inject the transport id or `random`, so UTXO's e2e pins `Math.random` for the whole suite (F3-R17 (4)).
  - `MemoryOperationStore` defaults to the system clock. UTXO works around it with a store factory; a core option would cover every family.
  - The EVM harness should pass fixed ids and `random` (restated from the Plan 2.5 handoff).
- **Resending long-pending Attempts (F3-R6)** is unnecessary for Bitcoin after F3-R8. One case remains: a lookup by id alone of a reorg-dropped transaction on full-mode electrs still shows it unconfirmed. This is documented in `networks.md` "Reorgs".
- **Hardware wallets (F3-R5).** Add an optional key-origin setting (fingerprint and path, emitted as `bip32Derivation`/`tapBip32Derivation`); it is additive. The plan assumes, unverified, that Trezor and Ledger accept `nonWitnessUtxo` on segwit v0.
- **Scanner trust (final review).** Bind Bitcoin block pages to `/block/:hash/header`, to a merkle root over `/block/:hash/txids`, and to raw bytes, so one lying monitor endpoint cannot inject a phantom deposit (as with EVM receipts). Optionally, flag outputs that return to a sender (`details.vout[n].toSender`).
- **Confirmed from earlier lists:**
  - A21 (`BuildContext.schemes`: a p2tr wallet with an ECDSA-only signer fails at signing, which is safe);
  - `ChainCatalog.network`'s inherited-key lookup (F3-R2);
  - a response byte cap in `HttpTransport`;
  - the cross-family fee-ceiling policy (UTXO has `maxFeeRate`, `maxFee` and `maxEstimatedFeeRate`).
- **CHANGELOG.** `wallet.utxo.allowExternalChangeAddress` (A19) is an additive deviation from spec §9 and is already in `[Unreleased]`. Do not add Plan 3's bullets again (X5). The README says "Plan 3 adds Bitcoin"; Plan 7 names the release.
- **Closed for Bitcoin:**
  - R76, by C1: "not included" only on an attested final spend by another transaction;
  - R73: cancels are all the same size;
  - A15: no UTXO analogue.

  Optional cleanup: split `e2e.test.ts` (about 1,020 lines; B6 (4)).

## 6. Process notes

- The §6 notes of the Plan 2 and Plan 2.5 handoffs still apply, except that mutants are no longer restored with `git checkout` (below).
- **Session rate limits stopped every running agent three times**: twice on 2026-09-28, the second time eight agents across the plans, and once on 2026-09-29, six agents. There were also two user pauses, of 2 h and 4 h.
  - Each time, check every worktree against the ledger for uncommitted edits and stray scratch worktrees.
  - Then resume the same agents with `SendMessage`, never a fresh agent over half-done work. Uncommitted work survived every stop.
  - Log each stop and resume, with agent ids.
- **After a resume, check that every new commit stands alone.** In the final wave, two unpushed commits did not: a test imported a removed export. They were soft-reset and recommitted, and each intermediate commit was verified in a throwaway detached worktree.
- **Mutation sweeps never restore a mutant with `git checkout` on a dirty tree**: it wipes uncommitted work. This replaces the Plan 2 handoff's advice. Commit first and mutate on top, or run the mutants in a throwaway detached worktree and restore each from a byte copy, checked with `cmp` and `git diff --quiet`.
- **The review package leaves out the lockfile.** The controller writes `.superpowers/sdd/<plan>/review-<base>..<head>.diff`:
  - a header line stating the exclusion;
  - `git log --oneline B..H`;
  - `git diff --stat B..H`, which still lists `pnpm-lock.yaml`;
  - `git diff -U10 B..H -- . ':(exclude)pnpm-lock.yaml'`.

  Reviewers read the package, never the live worktree, where the next implementer may be editing. They run tests only in a throwaway worktree at the reviewed HEAD, where `pnpm install --offline --frozen-lockfile` also validates the lockfile.

- **Resume the original agents:** the task's implementer for its fix round, and its reviewer for the scoped re-review. Fix rounds queue behind the active implementer.
- **Budget heavy tests explicitly.** At a load of 15–20, a 3.3 s test crossed Jest's 5 s default in 4 of 6 runs. Run the touched suites 20 times under load before a merge.
