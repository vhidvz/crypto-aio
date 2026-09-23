import { callbackSigner } from '../../../src/core/signing/callback';
import { thrown } from '../../helpers';
import { ctx } from './fixtures';

describe('callbackSigner', () => {
  it('delegates to the callbacks', async () => {
    const calls: string[] = [];
    const signer = callbackSigner({
      id: 'remote',
      schemes: ['ed25519'],
      getPublicKey: async () => new Uint8Array(32),
      sign: async (requests) => {
        calls.push(...requests.map((r) => r.id));
        return { status: 'pending', ticket: 't-1' };
      },
      cancelRequest: async (ticket) => {
        calls.push(`cancel:${ticket}`);
      },
    });
    expect(
      await signer.sign(
        [
          {
            id: 'r0',
            scheme: 'ed25519',
            payload: new Uint8Array(),
            payloadKind: 'message',
            publicKey: new Uint8Array(32),
          },
        ],
        ctx,
      ),
    ).toEqual({ status: 'pending', ticket: 't-1' });
    await signer.cancelRequest?.('t-1');
    expect(calls).toEqual(['r0', 'cancel:t-1']);
    expect(Object.isFrozen(signer)).toBe(true);
  });

  it('validates id and schemes', () => {
    const base = {
      getPublicKey: async () => new Uint8Array(),
      sign: async () => ({ status: 'pending' as const }),
    };
    expect(
      thrown(() => callbackSigner({ ...base, id: '', schemes: ['ed25519'] })),
    ).toMatchObject({ code: 'CONFIG_INVALID' });
    expect(thrown(() => callbackSigner({ ...base, id: 'x', schemes: [] }))).toMatchObject(
      { code: 'CONFIG_INVALID' },
    );
  });
});
