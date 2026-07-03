import { describe, expect, it } from 'vitest';
import { match } from 'ts-pattern';
import { toBase64 } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { resolveLinkGuestPrincipal } from './link-guest.js';
import type { Principal } from '../../../lib/context/index.js';
import type { LinkResolutionPort } from '../ports/index.js';

const LINK_KEY_BYTES = new Uint8Array([1, 2, 3, 4]);
const LIVE = { linkId: 'link-1', conversationId: 'conv-1' };

/** Port double resolving exactly one live credential (byte-equal match). */
const livePort: LinkResolutionPort = {
  resolveLinkCredential: (linkPublicKey) =>
    okAsync(
      linkPublicKey.length === LINK_KEY_BYTES.length &&
        linkPublicKey.every((byte, index) => byte === LINK_KEY_BYTES[index])
        ? LIVE
        : null
    ),
};

describe('resolveLinkGuestPrincipal', () => {
  it('resolves a live link credential to a typed link-guest principal', async () => {
    const result = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(LINK_KEY_BYTES),
    });
    expect(result._unsafeUnwrap()).toEqual({
      kind: 'link-guest',
      linkId: 'link-1',
      conversationId: 'conv-1',
    });
  });

  it('degrades an unknown credential to none', async () => {
    const result = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(new Uint8Array([9, 9, 9])),
    });
    expect(result._unsafeUnwrap()).toEqual({ kind: 'none' });
  });

  it('degrades a malformed base64 credential to none without consulting the port', async () => {
    let consulted = false;
    const port: LinkResolutionPort = {
      resolveLinkCredential: () => {
        consulted = true;
        return okAsync(LIVE);
      },
    };
    const result = await resolveLinkGuestPrincipal({ port, credential: '!!!not-base64!!!' });
    expect(result._unsafeUnwrap()).toEqual({ kind: 'none' });
    expect(consulted).toBe(false);
  });

  it('propagates a port failure instead of degrading to none', async () => {
    const port: LinkResolutionPort = {
      resolveLinkCredential: () => errAsync(unavailableError('link store down')),
    };
    const result = await resolveLinkGuestPrincipal({
      port,
      credential: toBase64(LINK_KEY_BYTES),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('lets a consumer authorize by exhaustive kind match with no field sniffing', async () => {
    // A realtime-shaped consumer: which conversation may this principal join?
    // The exhaustive match over the FULL union is the acceptance shape —
    // adding a Principal variant fails compilation here, and the guest arm
    // reads only typed scope fields.
    function authorizeJoin(principal: Principal): { allowed: boolean; scope: string } {
      return match(principal)
        .with({ kind: 'link-guest' }, (guest) => ({
          allowed: guest.conversationId === 'conv-1',
          scope: guest.linkId,
        }))
        .with({ kind: 'full' }, (session) => ({ allowed: true, scope: session.claims.userId }))
        .with({ kind: 'billing-only' }, () => ({ allowed: false, scope: 'billing' }))
        .with({ kind: 'pending-2fa' }, () => ({ allowed: false, scope: '2fa' }))
        .with({ kind: 'none' }, () => ({ allowed: false, scope: 'anonymous' }))
        .exhaustive();
    }
    const resolved = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(LINK_KEY_BYTES),
    });
    expect(authorizeJoin(resolved._unsafeUnwrap())).toEqual({ allowed: true, scope: 'link-1' });
  });
});
