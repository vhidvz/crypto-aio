import type { Hooks } from '../config/types';
import { SigningError, ValidationError, isCryptoAioError } from '../errors/error';
import type { EventBus } from '../events/bus';
import type { SchemeCatalog } from '../registry/schemes';
import { sanitizeError } from '../secret/redact';
import type { Clock } from '../util/clock';
import type { SignatureBundle, Signer, SigningContext, SigningRequest } from './types';
import type { ResolvedWallet } from './wallet';

export type OrchestratedResult =
  | { readonly status: 'signed'; readonly signatures: readonly SignatureBundle[] }
  | {
      readonly status: 'pending';
      readonly ticket?: string;
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
  return {
    status,
    signatures: signatures.map((entry: unknown, index) =>
      checkBundle(entry, (problem) => reject(`signature #${index} ${problem}`)),
    ),
  };
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

  /** Signs requests not covered by `existing`, batching per signer and verifying every signature. */
  async sign(
    wallet: ResolvedWallet,
    requests: readonly SigningRequest[],
    ctx: SigningContext,
    existing: readonly SignatureBundle[] = [],
  ): Promise<OrchestratedResult> {
    const done = new Map(existing.map((s) => [s.requestId, s]));
    const groups = new Map<string, { signer: Signer; requests: SigningRequest[] }>();
    for (const request of requests) {
      if (done.has(request.id)) continue;
      const route = wallet.signerFor(request.keyRef);
      const schemes = route?.signer.schemes;
      if (!route || !Array.isArray(schemes) || !schemes.includes(request.scheme)) {
        throw new SigningError(
          'SIGNER_UNAVAILABLE',
          `no signer of wallet '${wallet.name}' can sign request '${request.id}' (${request.scheme})`,
          { context: { operationId: ctx.operationId } },
        );
      }
      const group = groups.get(route.id) ?? { signer: route.signer, requests: [] };
      group.requests.push(request);
      groups.set(route.id, group);
    }
    let pending = false;
    let ticket: string | undefined;
    for (const [signerId, group] of groups) {
      const started = this.deps.clock.now();
      this.deps.events.emit('signer.requested', {
        namespace: ctx.namespace,
        operationId: ctx.operationId,
        signerId,
        requests: group.requests.length,
      });
      let result: CheckedResult;
      try {
        result = await this.#request(signerId, group.signer, group.requests, ctx);
        if (result.status === 'signed') {
          for (const request of group.requests) {
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
      } catch (error) {
        this.#completed(ctx, signerId, 'error', started);
        throw error;
      }
      if (result.status === 'pending') {
        pending = true;
        ticket ??= result.ticket;
      }
      this.#completed(ctx, signerId, result.status, started);
    }
    const signatures = requests
      .map((request) => done.get(request.id))
      .filter((s): s is SignatureBundle => s !== undefined);
    return pending
      ? { status: 'pending', ...(ticket !== undefined ? { ticket } : {}), signatures }
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

  /** Merges externally produced signatures (cold/offline/MPC) after verifying each one. */
  accept(
    requests: readonly SigningRequest[],
    provided: readonly SignatureBundle[],
    existing: readonly SignatureBundle[],
  ): SignatureBundle[] {
    if (!Array.isArray(provided)) {
      throw new ValidationError('INVALID_INTENT', 'external signatures must be an array');
    }
    const byId = new Map(requests.map((r) => [r.id, r]));
    const merged = new Map(existing.map((s) => [s.requestId, s]));
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
      if (isCryptoAioError(error)) throw error;
      throw new SigningError('SIGNING_FAILED', `signer '${signerId}' failed`, {
        cause: sanitizeError(error),
        context,
      });
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
