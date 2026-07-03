import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueClient,
  finishRegistration,
  startRegistration,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { rotatePasswordCredentials } from './credentials.js';
import { deserializeRegistrationRequest, runNewPasswordRegisterInit } from './opaque.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type {
  IdentityUserRecord,
  IdentityUsersStore,
  PasswordChangedEmailPort,
} from '../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const MASTER_SECRET = 'secret-at-least-32-characters-long!!';
const WRAPPED_KEY = toBase64(new Uint8Array([4, 5, 6]));

/** A real OPAQUE registration record, produced by the full client/server dance. */
async function validRecord(userId: string): Promise<number[]> {
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, 'rotated password');
  const request = deserializeRegistrationRequest(serialized)._unsafeUnwrap();
  const response = await runNewPasswordRegisterInit(MASTER_SECRET, userId, request);
  const { record } = await finishRegistration(
    client,
    response._unsafeUnwrap(),
    OPAQUE_SERVER_IDENTIFIER
  );
  return record;
}

interface SentNotification {
  readonly to: string;
  readonly userName?: string;
}

function recordingPort(result: () => ResultAsync<void, DomainError>): {
  port: PasswordChangedEmailPort;
  sends: SentNotification[];
} {
  const sends: SentNotification[] = [];
  const port: PasswordChangedEmailPort = {
    sendPasswordChangedEmail: (args) => {
      sends.push({
        to: args.to,
        ...(args.userName !== undefined && { userName: args.userName }),
      });
      return result();
    },
  };
  return { port, sends };
}

interface StoreHarness {
  store: IdentityUsersStore;
  events: string[];
}

function fakeStore(args: {
  user: Pick<IdentityUserRecord, 'id' | 'email' | 'username'> | null;
  rotateResult?: () => ResultAsync<void, DomainError>;
}): StoreHarness {
  const events: string[] = [];
  const store = {
    findById: (): ResultAsync<IdentityUserRecord | null, DomainError> => {
      events.push('findById');
      return okAsync(args.user as IdentityUserRecord | null);
    },
    rotatePassword: (): ResultAsync<void, DomainError> => {
      events.push('rotate');
      return args.rotateResult === undefined ? okAsync() : args.rotateResult();
    },
  } as unknown as IdentityUsersStore;
  return { store, events };
}

describe('rotatePasswordCredentials password-changed notification', () => {
  const user = {
    id: crypto.randomUUID(),
    email: 'rotated@identity-domain.test',
    username: 'rotated-user',
  };

  async function rotate(harness: StoreHarness, port: PasswordChangedEmailPort): Promise<boolean> {
    const result = await rotatePasswordCredentials({
      redis,
      store: harness.store,
      emailPort: port,
      userId: user.id,
      newRegistrationRecord: await validRecord(user.id),
      newPasswordWrappedPrivateKey: WRAPPED_KEY,
      now: Date.now(),
    });
    return result.isOk();
  }

  it('sends the notification to the account email after the rotation commits', async () => {
    const harness = fakeStore({ user });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toEqual([{ to: user.email, userName: user.username }]);
    expect(harness.events.indexOf('rotate')).toBeLessThan(harness.events.indexOf('findById'));
  });

  it('sends nothing when the credential rotation fails', async () => {
    const harness = fakeStore({
      user,
      rotateResult: () => errAsync(unavailableError('store down')),
    });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(false);
    expect(sends).toEqual([]);
  });

  it('still succeeds when the notification send fails', async () => {
    const harness = fakeStore({ user });
    const { port, sends } = recordingPort(() => errAsync(unavailableError('sender down')));
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it('still succeeds, without sending, when the rotated user cannot be resolved', async () => {
    const harness = fakeStore({ user: null });
    const { port, sends } = recordingPort(() => okAsync());
    expect(await rotate(harness, port)).toBe(true);
    expect(sends).toEqual([]);
  });
});
