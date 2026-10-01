import type { Hooks } from '../config/types';
import {
  SigningError,
  ValidationError,
  isCryptoAioError,
  withContext,
  type ErrorContext,
} from '../errors/error';
import type { EventBus } from '../events/bus';
import type { SchemeCatalog } from '../registry/schemes';
import { sanitizeError } from '../secret/redact';
import type { Clock } from '../util/clock';
import type {
  SignatureBundle,
  Signer,
  SignerTicket,
  SigningContext,
  SigningRequest,
} from './types';
import { signerFailure, signerSchemes } from './guard';
import type { ResolvedWallet } from './wallet';

export type OrchestratedResult =
  | { readonly status: 'signed'; readonly signatures: readonly SignatureBundle[] }
  | {
      readonly status: 'pending';
      /** One entry per pending signer that issued a ticket. */
      readonly tickets: readonly SignerTicket[];
      readonly signatures: readonly SignatureBundle[];
    };

export interface OrchestratorDeps {
  readonly schemes: () => SchemeCatalog;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly hooks: () => Hooks;
}

/** A signer's `SigningResult` after shape validation, holding the orchestrator's own copies. */
type CheckedResult =
  | { readonly status: 'signed'; readonly signatures: readonly SignatureBundle[] }
  | { readonly status: 'pending'; readonly ticket?: string };

type Reject = (problem: string) => never;

/** Validates one signature bundle and returns a copy its producer cannot mutate later. */
function checkBundle(value: unknown, reject: Reject): SignatureBundle {
  if (typeof value !== 'object' || value === null) reject('is not an object');
  const { requestId, bytes, recovery } = value as Record<string, unknown>;
  if (typeof requestId !== 'string') reject('has no string requestId');
  if (!(bytes instanceof Uint8Array)) reject('has bytes that are not a Uint8Array');
  if (recovery !== undefined) {
    if (typeof recovery !== 'number' || !Number.isInteger(recovery)) {
      reject('has a recovery that is not an integer');
    }
    if (recovery < 0 || recovery > 3) reject('has a recovery outside 0..3');
  }
  return {
    requestId,
    bytes: new Uint8Array(bytes),
    ...(recovery !== undefined ? { recovery } : {}),
  };
}

function checkResult(value: unknown, reject: Reject): CheckedResult {
  if (typeof value !== 'object' || value === null) reject('result is not an object');
  const { status, signatures, ticket } = value as Record<string, unknown>;
  if (status === 'pending') {
    if (ticket !== undefined && typeof ticket !== 'string')
      reject('ticket is not a string');
    return ticket === undefined ? { status } : { status, ticket };
  }
  if (status !== 'signed') reject('status is neither signed nor pending');
  if (!Array.isArray(signatures)) reject('signatures is not an array');
  // An index loop, not `.map`: an own `map` property on the array cannot skip the checks.
  const checked: SignatureBundle[] = [];
  for (let index = 0; index < signatures.length; index++) {
    const entry: unknown = signatures[index];
    checked.push(
      checkBundle(entry, (problem) => reject(`signature #${index} ${problem}`)),
    );
  }
  return { status, signatures: checked };
}

/** Copies a request's bytes (and keyRef/params) so its holder cannot change the original. */
function snapshotRequest(request: SigningRequest): SigningRequest {
  const { keyRef, params } = request;
  return {
    id: request.id,
    scheme: request.scheme,
    payload: new Uint8Array(request.payload),
    payloadKind: request.payloadKind,
    publicKey: new Uint8Array(request.publicKey),
    ...(keyRef ? { keyRef: { ...keyRef } } : {}),
    ...(params
      ? {
          params: {
            ...params,
            ...(params.tweak ? { tweak: new Uint8Array(params.tweak) } : {}),
          },
        }
      : {}),
  };
}

/** Cancels one ticket; false when the signer cannot cancel or its cancellation failed. */
async function cancelTicket(
  signer: Signer | undefined,
  ticket: string,
): Promise<boolean> {
  try {
    if (typeof signer?.cancelRequest !== 'function') return false;
    await signer.cancelRequest(ticket);
    return true;
  } catch {
    return false;
  }
}

export class SigningOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Runs the `beforeSign` policy hook; any throw is a veto. */
  async authorize(ctx: SigningContext): Promise<void> {
    const hook = this.deps.hooks().beforeSign;
    if (!hook) return;
    try {
      await hook(ctx);
    } catch (error) {
      if (isCryptoAioError(error, 'POLICY_REJECTED')) throw error;
      const cause = sanitizeError(error);
      throw new SigningError(
        'POLICY_REJECTED',
        error instanceof Error ? cause.message : 'signing vetoed by policy',
        { cause, context: { operationId: ctx.operationId } },
      );
    }
  }

  /**
   * Signs requests not covered by `existing`, batching per signer and verifying every
   * signature. Each `existing` entry for one of `requests` is shape-checked, copied and
   * re-verified first (SIGNATURE_MISMATCH otherwise); entries for other ids are ignored.
   */
  async sign(
    wallet: ResolvedWallet,
    callerRequests: readonly SigningRequest[],
    ctx: SigningContext,
    existing: readonly SignatureBundle[] = [],
  ): Promise<OrchestratedResult> {
    // Private snapshots: neither the caller nor a signer can change what gets verified.
    const requests = callerRequests.map(snapshotRequest);
    const done = this.#adopt(existing, new Map(requests.map((r) => [r.id, r])));
    const groups = new Map<string, { signer: Signer; requests: SigningRequest[] }>();
    for (const request of requests) {
      if (done.has(request.id)) continue;
      const route = this.#route(wallet, request, { operationId: ctx.operationId });
      const group = groups.get(route.id) ?? { signer: route.signer, requests: [] };
      group.requests.push(request);
      groups.set(route.id, group);
    }
    let pending = false;
    const tickets: SignerTicket[] = [];
    for (const [signerId, group] of groups) {
      let result: CheckedResult;
      try {
        result = await this.#signGroup(signerId, group.signer, group.requests, ctx, done);
      } catch (error) {
        throw await this.#withdraw(error, tickets, groups);
      }
      if (result.status === 'pending') {
        pending = true;
        if (result.ticket !== undefined)
          tickets.push({ signerId, ticket: result.ticket });
      }
    }
    const signatures = requests
      .map((request) => done.get(request.id))
      .filter((s): s is SignatureBundle => s !== undefined);
    return pending
      ? { status: 'pending', tickets, signatures }
      : { status: 'signed', signatures };
  }

  verify(request: SigningRequest, signature: SignatureBundle): void {
    const valid = this.deps
      .schemes()
      .get(request.scheme)
      .verify({
        publicKey: request.publicKey,
        payload: request.payload,
        signature: signature.bytes,
        ...(signature.recovery !== undefined ? { recovery: signature.recovery } : {}),
        ...(request.params ? { params: request.params } : {}),
      });
    if (!valid) {
      throw new SigningError(
        'SIGNATURE_MISMATCH',
        `signature for request '${request.id}' does not verify against the expected public key`,
      );
    }
  }

  /**
   * Merges externally produced signatures (cold/offline/MPC) after verifying each one, and
   * re-verifies `existing` the same way `sign()` does.
   */
  accept(
    requests: readonly SigningRequest[],
    provided: readonly SignatureBundle[],
    existing: readonly SignatureBundle[],
  ): SignatureBundle[] {
    if (!Array.isArray(provided)) {
      throw new ValidationError('INVALID_INTENT', 'external signatures must be an array');
    }
    const byId = new Map(requests.map((r) => [r.id, r]));
    const merged = this.#adopt(existing, byId);
    for (const [index, entry] of provided.entries()) {
      const signature = checkBundle(entry, (problem) => {
        throw new ValidationError(
          'INVALID_INTENT',
          `external signature #${index} ${problem}`,
        );
      });
      const request = byId.get(signature.requestId);
      if (!request) {
        throw new ValidationError(
          'INVALID_INTENT',
          `unknown signing request '${signature.requestId}'`,
        );
      }
      this.verify(request, signature);
      merged.set(signature.requestId, signature);
    }
    return requests
      .map((r) => merged.get(r.id))
      .filter((s): s is SignatureBundle => s !== undefined);
  }

  /** Picks the signer for a request; the routing reads are guarded like signer calls. */
  #route(
    wallet: ResolvedWallet,
    request: SigningRequest,
    context: ErrorContext,
  ): { readonly id: string; readonly signer: Signer } {
    const unavailable = `no signer of wallet '${wallet.name}' can sign request '${request.id}' (${request.scheme})`;
    let route: { readonly id: string; readonly signer: Signer } | undefined;
    try {
      route = wallet.signerFor(request.keyRef);
    } catch (error) {
      throw signerFailure(error, 'SIGNER_UNAVAILABLE', unavailable, context);
    }
    if (
      !route ||
      !signerSchemes(route.id, route.signer, context).includes(request.scheme)
    ) {
      throw new SigningError('SIGNER_UNAVAILABLE', unavailable, { context });
    }
    return route;
  }

  /**
   * Re-checks previously collected signatures before trusting them: each entry whose
   * `requestId` names one of `byId` is shape-checked, copied and verified; others are ignored.
   */
  #adopt(
    existing: readonly SignatureBundle[],
    byId: ReadonlyMap<string, SigningRequest>,
  ): Map<string, SignatureBundle> {
    const adopted = new Map<string, SignatureBundle>();
    for (let index = 0; index < existing.length; index++) {
      const entry: unknown = existing[index];
      const id =
        typeof entry === 'object' && entry !== null
          ? (entry as { requestId?: unknown }).requestId
          : undefined;
      if (typeof id !== 'string' || !byId.has(id)) continue;
      const signature = checkBundle(entry, (problem) => {
        throw new SigningError(
          'SIGNATURE_MISMATCH',
          `existing signature for request '${id}' ${problem}`,
        );
      });
      const request = byId.get(signature.requestId);
      if (!request) continue;
      this.verify(request, signature);
      adopted.set(request.id, signature);
    }
    return adopted;
  }

  /**
   * Asks one signer for its batch. The signer gets fresh copies; its signatures are verified
   * against `requests` (the orchestrator's snapshots) and land in `done`.
   */
  async #signGroup(
    signerId: string,
    signer: Signer,
    requests: readonly SigningRequest[],
    ctx: SigningContext,
    done: Map<string, SignatureBundle>,
  ): Promise<CheckedResult> {
    const started = this.deps.clock.now();
    this.deps.events.emit('signer.requested', {
      namespace: ctx.namespace,
      operationId: ctx.operationId,
      signerId,
      requests: requests.length,
    });
    try {
      const result = await this.#request(
        signerId,
        signer,
        requests.map(snapshotRequest),
        ctx,
      );
      if (result.status === 'signed') {
        for (const request of requests) {
          const signature = result.signatures.find((s) => s.requestId === request.id);
          if (!signature) {
            throw new SigningError(
              'SIGNING_FAILED',
              `signer '${signerId}' returned no signature for request '${request.id}'`,
              { context: { operationId: ctx.operationId } },
            );
          }
          this.verify(request, signature);
          done.set(request.id, signature);
        }
      }
      this.#completed(ctx, signerId, result.status, started);
      return result;
    } catch (error) {
      this.#completed(ctx, signerId, 'error', started);
      throw error;
    }
  }

  /**
   * Before a failure escapes `sign()`, cancels (best effort) every ticket issued earlier
   * in the same call through the signer that issued it. A ticket that could not be cancelled
   * (no `cancelRequest`, or it threw) is counted in `details.cancelFailures`.
   */
  async #withdraw(
    error: unknown,
    tickets: readonly SignerTicket[],
    groups: ReadonlyMap<string, { readonly signer: Signer }>,
  ): Promise<unknown> {
    if (tickets.length === 0) return error;
    let cancelFailures = 0;
    for (const { signerId, ticket } of tickets) {
      if (!(await cancelTicket(groups.get(signerId)?.signer, ticket)))
        cancelFailures += 1;
    }
    if (!isCryptoAioError(error)) return error;
    return withContext(error, {}, { details: { ...error.details, cancelFailures } });
  }

  /**
   * Calls one signer and validates what it returns. A non-CryptoAioError failure (including
   * a malformed result that cannot even be read) becomes SIGNING_FAILED with a sanitized
   * cause: custody backends put URLs and credentials in their messages.
   */
  async #request(
    signerId: string,
    signer: Signer,
    requests: readonly SigningRequest[],
    ctx: SigningContext,
  ): Promise<CheckedResult> {
    const context = { operationId: ctx.operationId };
    try {
      const raw: unknown = await signer.sign(requests, ctx);
      return checkResult(raw, (problem) => {
        throw new SigningError(
          'SIGNING_FAILED',
          `signer '${signerId}' returned a malformed result: ${problem}`,
          { context },
        );
      });
    } catch (error) {
      throw signerFailure(
        error,
        'SIGNING_FAILED',
        `signer '${signerId}' failed`,
        context,
      );
    }
  }

  #completed(
    ctx: SigningContext,
    signerId: string,
    status: 'signed' | 'pending' | 'error',
    started: number,
  ): void {
    this.deps.events.emit('signer.completed', {
      namespace: ctx.namespace,
      operationId: ctx.operationId,
      signerId,
      status,
      latencyMs: this.deps.clock.now() - started,
    });
  }
}
