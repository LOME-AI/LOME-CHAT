import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { createSessionRevokeJobRegistration } from './session-revoke-job.js';
import { issueSession } from './session.js';
import { checkSessionLiveness } from './revocation.js';
import type { JobExecution } from '../../../lib/jobs/index.js';
import type { EvictUserPort } from '../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const SECRET = 'secret-at-least-32-characters-long!!';

function executionFor(userId: string): JobExecution<{ userId: string }> {
  return {
    jobId: crypto.randomUUID(),
    payload: { userId },
    claims: 1,
    heartbeat: () => Promise.reject(new Error('heartbeat unexpectedly invoked')),
    completeWithinTx: () => Promise.reject(new Error('completeWithinTx unexpectedly invoked')),
  };
}

async function issueFullSession(userId: string, createdAt: number): Promise<string> {
  const result = await issueSession({
    request: new Request('http://localhost/auth/login/finish'),
    response: new Response(),
    redis,
    secret: SECRET,
    isProduction: false,
    userId,
    kind: 'full',
    now: createdAt,
  });
  return result._unsafeUnwrap().sessionId;
}

function recordingEvict(): { port: EvictUserPort; evicted: string[] } {
  const evicted: string[] = [];
  return {
    evicted,
    port: {
      evictUser: (userId) => {
        evicted.push(userId);
        return Promise.resolve();
      },
    },
  };
}

describe('createSessionRevokeJobRegistration handler', () => {
  it('bumps the watermark so a prior active session is revoked, then evicts', async () => {
    const userId = crypto.randomUUID();
    const createdAt = Date.now();
    const sessionId = await issueFullSession(userId, createdAt);
    const before = await checkSessionLiveness(redis, { userId, sessionId, createdAt });
    expect(before._unsafeUnwrap()).toBe('active');

    const evict = recordingEvict();
    const registration = createSessionRevokeJobRegistration({
      redis,
      evictUser: evict.port,
      now: () => createdAt + 1000,
    });
    const outcome = await registration.handler(executionFor(userId));

    expect(outcome).toEqual({ kind: 'ok', result: { revoked: userId } });
    const after = await checkSessionLiveness(redis, { userId, sessionId, createdAt });
    expect(after._unsafeUnwrap()).toBe('revoked');
    expect(evict.evicted).toEqual([userId]);
  });

  it('returns fail (retried, not lost) when the watermark bump cannot be written', async () => {
    const unreachable = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const registration = createSessionRevokeJobRegistration({ redis: unreachable });
    const outcome = await registration.handler(executionFor(crypto.randomUUID()));
    expect(outcome.kind).toBe('fail');
  });

  it('evicts best-effort — an eviction failure never fails the must-happen job', async () => {
    const userId = crypto.randomUUID();
    const failingEvict: EvictUserPort = {
      evictUser: () => Promise.reject(new Error('DO unreachable')),
    };
    const registration = createSessionRevokeJobRegistration({
      redis,
      evictUser: failingEvict,
      now: () => Date.now(),
    });
    const outcome = await registration.handler(executionFor(userId));
    expect(outcome.kind).toBe('ok');
  });

  it('registers on the bulk shard with the natural idempotency class', () => {
    const registration = createSessionRevokeJobRegistration({ redis });
    expect(registration.shard).toBe('bulk');
    expect(registration.idempotency).toBe('natural');
    expect(registration.schema.safeParse({ userId: crypto.randomUUID() }).success).toBe(true);
    expect(registration.schema.safeParse({ userId: 'not-a-uuid' }).success).toBe(false);
  });
});
