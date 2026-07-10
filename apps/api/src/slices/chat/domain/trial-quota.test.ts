import { describe, expect, it, vi } from 'vitest';
import { consumeTrialQuota, hashIp } from './trial-quota.js';
import type { ConsumeTrialQuotaArgs } from './trial-quota.js';

type Redis = Parameters<typeof consumeTrialQuota>[0];

interface ExpireCall {
  readonly key: string;
  readonly mode: string | undefined;
}

/** An in-memory Redis double: atomic INCR + a recording EXPIRE. */
function fakeRedis(seed: Record<string, number> = {}): {
  redis: Redis;
  expireCalls: ExpireCall[];
} {
  const store = new Map<string, number>(Object.entries(seed));
  const expireCalls: ExpireCall[] = [];
  const redis = {
    incr: (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
    expire: (key: string, _seconds: number, mode?: string) => {
      expireCalls.push({ key, mode });
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  return { redis, expireCalls };
}

const ARGS: ConsumeTrialQuotaArgs = { sessionId: 's1', ipHash: 'ip1' };

describe('consumeTrialQuota', () => {
  it('allows a fresh session within the daily limit', async () => {
    const { redis } = fakeRedis();
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
  });

  it('refuses once the higher of the two identities exceeds the limit', async () => {
    // Session already at the limit; the next increment (6) exceeds it.
    const { redis } = fakeRedis({ 'trial:usage:session:s1': 5, 'trial:usage:ip:ip1': 2 });
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: false, count: 6 });
  });

  it('takes the IP count when it is the higher identity (rotated token evasion)', async () => {
    const { redis } = fakeRedis({ 'trial:usage:session:s1': 0, 'trial:usage:ip:ip1': 5 });
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: false, count: 6 });
  });

  it('anchors each counter TTL with EXPIRE … NX (no window extension)', async () => {
    const { redis, expireCalls } = fakeRedis();
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome.isOk()).toBe(true);
    expect(expireCalls).toHaveLength(2);
    expect(expireCalls.every((call) => call.mode === 'NX')).toBe(true);
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const redis = { incr: vi.fn(() => Promise.reject(new Error('down'))) } as unknown as Redis;
    const result = await consumeTrialQuota(redis, ARGS);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});

describe('hashIp', () => {
  it('returns a stable 64-char SHA-256 hex digest', async () => {
    const a = await hashIp('203.0.113.7');
    const b = await hashIp('203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('produces different digests for different IPv4 addresses (never stores a raw IP)', async () => {
    expect(await hashIp('203.0.113.7')).not.toBe(await hashIp('203.0.113.8'));
  });

  it('hashes IPv4 verbatim — byte-identical to a raw SHA-256 of the address', async () => {
    // The verbatim path must not change: the digest equals SHA-256 of the
    // untouched dotted-quad string, so existing per-IPv4 counters keep their keys.
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('203.0.113.7'));
    const expected = [...new Uint8Array(raw)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(await hashIp('203.0.113.7')).toBe(expected);
  });

  it('leaves the unroutable sentinel 0.0.0.0 hashed verbatim', async () => {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('0.0.0.0'));
    const expected = [...new Uint8Array(raw)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(await hashIp('0.0.0.0')).toBe(expected);
  });

  // Two addresses inside the SAME /64 must collapse to one counter; two in
  // DIFFERENT /64s must not. The host bits (last 64) are attacker-rotatable.
  const sameSixtyFour: readonly (readonly [string, string, string])[] = [
    ['compressed vs expanded host bits', '2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:ffff'],
    ['link-local host rotation', 'fe80::1', 'fe80::abcd:1234:5678:9abc'],
    [
      'embedded IPv4 tail differs (beyond the prefix)',
      '2001:db8:1:2::192.0.2.1',
      '2001:db8:1:2::192.0.2.254',
    ],
    ['uppercase vs lowercase hextets', '2001:DB8:1:2::1', '2001:db8:1:2::9'],
    ['leading-zero hextets', '2001:0db8:0001:0002::1', '2001:db8:1:2::2'],
  ];
  it.each(sameSixtyFour)('collapses same-/64 pair (%s) to one hash', async (_label, a, b) => {
    expect(await hashIp(a)).toBe(await hashIp(b));
  });

  const differentSixtyFour: readonly (readonly [string, string, string])[] = [
    ['adjacent subnet', '2001:db8:1:2::1', '2001:db8:1:3::1'],
    ['different second hextet', '2001:db8:1:2::1', '2001:dead:1:2::1'],
    ['loopback vs link-local', '::1', 'fe80::1'],
  ];
  it.each(differentSixtyFour)('keeps different-/64 pair (%s) distinct', async (_label, a, b) => {
    expect(await hashIp(a)).not.toBe(await hashIp(b));
  });

  it('does not collapse an IPv6 /64 into an unrelated IPv4 address', async () => {
    expect(await hashIp('2001:db8:1:2::1')).not.toBe(await hashIp('203.0.113.7'));
  });

  // Malformed IPv6-shaped input can never be parsed to a prefix; it falls back
  // to a verbatim hash rather than throwing, so a garbage header still yields a
  // stable key (and never crashes the quota gate).
  const malformed: readonly (readonly [string, string])[] = [
    ['two :: groups', '2001:db8::1::2'],
    ['nine hextets, no ::', '1:2:3:4:5:6:7:8:9'],
    ['invalid hextet, no ::', '1:2:3:4:5:6:7:zzzz'],
    ['over-long after :: fill', '1:2:3:4:5::6:7:8:9'],
    ['non-hex hextet', '2001:xyz::1'],
    ['embedded IPv4 not last', '2001:1.2.3.4:db8::1'],
    ['short embedded IPv4', '::ffff:1.2.3'],
    ['out-of-range embedded octet', '::ffff:256.1.1.1'],
    ['non-numeric embedded octet', '::ffff:1.2.3.a'],
  ];
  it.each(malformed)(
    'falls back to a stable verbatim hash for malformed input (%s)',
    async (_label, ip) => {
      expect(await hashIp(ip)).toMatch(/^[0-9a-f]{64}$/);
    }
  );

  it('normalizes a full uncompressed IPv6 address by its /64 prefix', async () => {
    expect(await hashIp('2001:0db8:0001:0002:0003:0004:0005:0006')).toBe(
      await hashIp('2001:db8:1:2::7')
    );
  });

  it('strips an IPv6 zone id before deriving the prefix', async () => {
    expect(await hashIp('fe80::1%eth0')).toBe(await hashIp('fe80::2%wlan0'));
  });
});
