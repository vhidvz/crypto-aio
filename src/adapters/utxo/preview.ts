/**
 * `ext.utxo.coinSelection`: a dry run of the configured coin selection. Signs nothing. The
 * change output is sized for the sending address (the wallet's `changeAddress` is not known
 * here), so the fee may differ from a build's by a change output's size difference.
 */
import { ValidationError } from '../../core/errors/error';
import { selectCoins } from './coinselect';
import type { UtxoContext } from './context';
import { plannedOutputs, rateOf, senderOf, spendable } from './spend';
import type { UtxoSelectionPreview, UtxoSelectionRequest } from './types';

/**
 * A caller's request reaches this method unchecked by the core (ext methods are the
 * family's), so its shape is checked here: a malformed one is a fixed-text validation
 * error, never a foreign `TypeError`. Addresses are checked where they are decoded.
 */
function assertRequest(request: UtxoSelectionRequest): void {
  const invalid = (reason: string) => new ValidationError('INVALID_INTENT', reason);
  if (request === null || typeof request !== 'object') {
    throw invalid('a coin selection request is { from, outputs, fee?, exclude? }');
  }
  if (!Array.isArray(request.outputs)) {
    throw invalid('outputs must be an array of { to, amount }');
  }
  for (const output of request.outputs as readonly unknown[]) {
    if (output === null || typeof output !== 'object') {
      throw invalid('outputs must be an array of { to, amount }');
    }
    const { amount } = output as { readonly amount?: unknown };
    if (typeof amount !== 'bigint' || amount <= 0n) {
      throw new ValidationError(
        'INVALID_AMOUNT',
        'an output amount must be a positive bigint (satoshis)',
      );
    }
  }
  const exclude: unknown = request.exclude;
  if (
    exclude !== undefined &&
    (!Array.isArray(exclude) || !exclude.every((o) => typeof o === 'string'))
  ) {
    throw invalid('exclude must be an array of outpoints (txid:vout)');
  }
}

export async function coinSelectionPreview(
  ctx: UtxoContext,
  request: UtxoSelectionRequest,
): Promise<UtxoSelectionPreview> {
  assertRequest(request);
  const sender = senderOf(ctx, request.from);
  const outputs = plannedOutputs(ctx, request.outputs);
  const rate = await rateOf(ctx, request.fee ?? 'normal');
  const candidates = await spendable(
    ctx,
    sender.from.canonical,
    request.exclude,
    ctx.config.minInputConfirmations,
  );
  const selection = selectCoins({
    candidates,
    outputs,
    changeScript: sender.from.script,
    inputType: sender.type,
    rate,
    dustRelayFee: ctx.config.dustRelayFee,
    strategy: ctx.config.coinSelection,
  });
  const inputs = selection.ok ? selection.inputs : candidates;
  return {
    inputs: inputs.map((i) => ({ outpoint: i.outpoint, value: i.value })),
    fee: selection.fee,
    satPerKvB: rate,
    vsize: selection.vsize,
    change: selection.ok ? selection.change : 0n,
    sufficient: selection.ok,
  };
}
