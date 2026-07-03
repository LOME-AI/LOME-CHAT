import { describe, expect, it } from 'vitest';
import { createOpaqueClient, startRegistration, startLogin } from '@hushbox/crypto';
import {
  deserializeKe1,
  deserializeKe3,
  deserializeRegistrationRecord,
  deserializeRegistrationRequest,
  duplicateFreshHandshakeDefect,
  opaqueProtocolError,
  requireOpaqueMasterSecret,
  throwIfOpaqueError,
} from './opaque.js';

describe('OPAQUE wire codecs', () => {
  it('accepts a client-produced registration request', async () => {
    const { serialized } = await startRegistration(createOpaqueClient(), 'correct horse battery');
    expect(deserializeRegistrationRequest(serialized).isOk()).toBe(true);
  });

  it('rejects garbage registration-request bytes as a validation error', () => {
    const result = deserializeRegistrationRequest([1, 2, 3]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects garbage registration-record bytes as a validation error', () => {
    const result = deserializeRegistrationRecord([9, 9, 9]);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('accepts a client-produced KE1', async () => {
    const { ke1 } = await startLogin(createOpaqueClient(), 'correct horse battery');
    expect(deserializeKe1(ke1).isOk()).toBe(true);
  });

  it('rejects garbage KE1 bytes as a validation error', () => {
    expect(deserializeKe1([0])._unsafeUnwrapErr().code).toBe('validation');
  });

  it('rejects garbage KE3 bytes as a validation error', () => {
    expect(deserializeKe3([0])._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('throwIfOpaqueError', () => {
  it('passes a protocol value through unchanged', () => {
    const value = { ok: true };
    expect(throwIfOpaqueError(value)).toBe(value);
  });

  it('converts a library Error value into a throw', () => {
    expect(() => throwIfOpaqueError(new Error('bad KE1'))).toThrow('bad KE1');
  });
});

describe('opaqueProtocolError', () => {
  it('maps a rejection cause into the typed validation channel', () => {
    const error = opaqueProtocolError('OPAQUE authInit rejected the request')(
      new Error('protocol failure')
    );
    expect(error.code).toBe('validation');
  });
});

describe('duplicateFreshHandshakeDefect', () => {
  it('throws: a server-minted handshake id cannot be claimed twice', () => {
    expect(() => duplicateFreshHandshakeDefect()).toThrow(/server-minted handshake id/);
  });
});

describe('requireOpaqueMasterSecret', () => {
  it('returns the configured secret', () => {
    expect(requireOpaqueMasterSecret({ OPAQUE_MASTER_SECRET: 's3cret' })).toBe('s3cret');
  });

  it('fails fast when the binding is missing (deployment misconfiguration)', () => {
    expect(() => requireOpaqueMasterSecret({})).toThrow(/OPAQUE_MASTER_SECRET/);
  });

  it('fails fast when the binding is blank', () => {
    expect(() => requireOpaqueMasterSecret({ OPAQUE_MASTER_SECRET: '' })).toThrow(
      /OPAQUE_MASTER_SECRET/
    );
  });
});
