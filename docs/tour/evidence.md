---
title: Evidence, proofs and finality
description: How the transport checks endpoints, how proof reads use a quorum, and why an Operation ends only on proven evidence.
---

# Evidence, proofs and finality

> [!TIP]
> **The short version.** Every status crypto-aio reports says what it rests on: **observed**
> (one endpoint's current view) or **proven** (finalized chain data that a quorum of endpoints
> agree on). After signing, an Operation ends only on proven evidence. The **transport** makes
> that possible: it checks each endpoint's network and height, keeps lagging ones out of
> decisions, and runs proof reads as quorum reads, where disagreement decides nothing. A lying
> endpoint can delay a verdict, never fake one.

**Builds on:** [Blocks, confirmations and finality](../learn/foundations/blocks.md),
[Trust: one server's word is not proof](../learn/engineering/trust.md) and
[Retries, ambiguity and recovery](./recovery.md).

## Two kinds of evidence

Every `TxStatus` carries:

| Field | Values | Says |
| --- | --- | --- |
| `state` | `pending`, `included`, `final`, `failed`, `dropped`, `replaced`, `expired`, … | Where the transaction is |
| `finality` | `none`, `probabilistic`, `final` | Whether it could still be reorganized |
| `evidence` | `observed`, `proven` | What the status rests on |
| `confirmations`, `blockHeight`, `blockHash`, `reason` | | The details |

- **Observed** is what one endpoint says right now. It can change: a reorg, a lagging node, a
  node that dropped the transaction. Observed data moves an Operation forward (`included`), and
  never ends it.
- **Proven** is finalized chain data, read with a **quorum**: enough independent endpoints must
  return the same answer. Every terminal state after signing needs it.

There is one deliberate exception: when nodes **reject** every Attempt as never valid, and the
driver confirms that from the bytes it sent, the Operation fails with `TX_REJECTED` without chain
proof, because those bytes can never land. And there is one deliberate non-rule: **absence is
never proof**. `dropped` and `refused` are never terminal, and a reorg verdict needs the quorum
to serve a different block hash.

## The transport

Every request any driver makes goes through the core's transport. Before it trusts an endpoint
with a decision, it checks it:

```mermaid
flowchart LR
  req["A driver's request<br/>(purpose, retry class, quorum)"] --> pick["Pick endpoints<br/>by health and priority"]
  pick --> rl["Rate limit<br/>per endpoint"]
  rl --> cb{"Circuit<br/>open?"}
  cb -- "yes: skip it" --> pick
  cb -- no --> send["Send, with a timeout<br/>and a size cap"]
  send --> ok{"Answer?"}
  ok -- "failure" --> retry["Retry by class,<br/>with backoff, elsewhere"]
  ok -- "yes" --> q{"Quorum<br/>needed?"}
  q -- "no" --> result["Result"]
  q -- "yes" --> agree{"Enough endpoints<br/>agree?"}
  agree -- yes --> result
  agree -- no --> inc["PROVIDER_INCONSISTENT<br/>(retryable: decides nothing)"]
```

- **Identity.** Each endpoint is asked which network it serves (a chain id, a genesis hash, the
  id of block 0). One that answers for another network is disabled, emits
  `provider.misconfigured`, and fails with `PROVIDER_MISCONFIGURED`.
- **Height.** Each endpoint's height is probed every `healthIntervalMs` (15 s). One more than
  `maxLagBlocks` behind the best verified height is **lagging**: the monitor and the scanner
  never decide anything from a view that far behind. Until its height is known, an endpoint
  reads `unknown`, not `healthy`, in `getNetworkStatus()`, and `bc.ready()` fails while no
  endpoint has answered its height probe.
- **Retries by class.** Each request declares how it may be retried: `safe` (reads),
  `ambiguous-on-failure` (broadcasts, whose failure may hide a success), or `never-auto` (one
  attempt, no retry). Each also declares its purpose: `read`, `monitor`, `proof` or
  `broadcast`.
- **Limits.** Per-endpoint rate limits, a circuit breaker (after 5 failures, an endpoint rests
  30 s), a 15 s timeout, and a 64 MiB cap on any one answer, so one endpoint cannot exhaust the
  process's memory.

## Proof reads

A driver's `proofs` port asks the questions behind every verdict: is this transaction in a final
block, and did it succeed? Is this nonce used at a final height? What is the hash of the
finalized block at this height? Those reads run with `quorum: 'proof'`: `proofQuorum` endpoints
(2 by default), capped by the endpoints you configured, must return the same answer. Endpoints
that disagree make the read throw a retryable `PROVIDER_INCONSISTENT`; too few endpoints able to
answer make it throw a retryable `PROVIDER_UNAVAILABLE`. Either way, nothing is decided.

The quorum's size counts every endpoint you configured that is not proven to serve another
network, including ones that are down, lagging, or resting after their breaker opened. Only
endpoints within `maxLagBlocks` of the best height are asked. So one endpoint never proves a
fact alone while the others are away: with two endpoints and one of them down, `final` waits
until it comes back. Configure three or more endpoints from independent providers, so one outage
leaves two to agree. With only one endpoint configured, that endpoint proves alone. Setting
`transport: { degradedProofs: true }` lets an endpoint that has been down for about three health
intervals stop counting, so the rest prove without it: liveness first, at the cost of the
corroboration.

A proof may also answer "no" only on a **definitive** negative. "Not found", "pruned", "state
unavailable", an index still building: each throws a retryable `PROVIDER_UNAVAILABLE`, and decides
nothing.

## A lying endpoint, in practice

Here one of two endpoints lies about finalized data. The transfer is included, but it cannot be
proven final while the endpoints disagree. When the liar is fixed, the proof goes through:

<!-- runnable -->
```ts
import { createFakeEnv } from 'crypto-aio/testing';

const env = await createFakeEnv({ endpoints: ['a', { name: 'b', forkFinalized: true }] });
let disagreements = 0;
env.aio.on('provider.inconsistent', () => disagreements++);

const sub = await env.run(env.bc.transfer({ to: env.stranger(), amount: 5n }));
env.chain.mine(6);
const late = await env
  .run(sub.wait({ finality: 'final', timeoutMs: 20_000 }), 500)
  .catch((e: { code: string }) => e.code);
console.log(late); // TIMEOUT
const op = await env.run(env.bc.getOperation(sub.operationId));
console.log(op?.state, op?.attempts[0]?.status?.evidence, disagreements > 0); // included observed true

env.chain.configureEndpoint('b', { forkFinalized: false }); // the liar is fixed
const done = await env.run(sub.wait({ finality: 'final' }));
console.log(done.status.state, done.status.evidence); // final proven
```

The disagreement cost time, not money: the Operation stayed `included`, and the wait timed out
without changing anything. That is the trade the library makes everywhere: when in doubt, wait.

## Verdicts, family by family

What "proven" means depends on the chain's rules, and each driver implements its family's
proofs: an EVM nonce used at a final height and the receipt from that block; a Bitcoin input
spent at final depth; a Tron or Solana transaction absent from every block of its validity
window; a TON message trace completed in the masterchain. Token transfers are judged by what the
token contract logged, not only by the receipt's success: a token transfer that executed but
shows no transfer to the recipient (no `Transfer` event to it on EVM or Tron, or TON jettons
sent to a wallet the master does not name) fails with `TX_UNEVIDENCED`, and its observation
records `failure: 'unevidenced'`. Value may have moved, so it is never a "safe to pay again"
failure. `TX_REVERTED` (`failure: 'reverted'`) is kept for a transaction whose execution
failed.
[Wait for confirmation](../build/confirmations.md) gives every family's verdict rules.

## Where it lives

| Path | What is there |
| --- | --- |
| `src/core/transport/http-transport.ts` | Endpoint selection, health and identity probes, retries, quorum reads, redaction |
| `src/core/transport/circuit.ts`, `rate-limit.ts`, `backoff.ts`, `stale-view.ts` | The transport's building blocks |
| `src/core/lifecycle/evaluate.ts`, `observations.ts` | Turning observations and proofs into Attempt and Operation verdicts |
| `src/core/driver/types.ts` | The `ProofSource` port and its "definitive negative" rule |

## Check yourself

1. What can move an Operation from `submitted` to `included`? From `included` to `final`?
2. One of your three endpoints is 40 blocks behind. Can it make a proof fail? Make one succeed?
3. Why does a proof read throw instead of answering "no" when the data is pruned?

<details>
<summary>Answers</summary>

1. Observed data from one endpoint; only proven data, read under the quorum.
2. It still counts toward the quorum's size, but a lagging endpoint is never asked in a proof,
   so it can neither disagree nor prove anything. It can hold a proof up only by leaving too few
   in-range endpoints to answer, and the monitor never decides from its lagging view.
3. Missing data is not evidence of absence: answering "no" could prove a landed transaction
   failed, and invite a second payment.

</details>

## What's next

Sending is half of a payment system. How money arriving at your addresses is found, and credited,
safely: [How receiving works](./receiving.md).
