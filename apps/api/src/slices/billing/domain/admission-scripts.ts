/**
 * The admission Lua sources. The repo file IS the pin: the client derives the
 * script SHA at first use and runs EVALSHA with an EVAL fallback on NOSCRIPT,
 * so the canonical source here is what always executes.
 *
 * Number-precision note: Lua 5.1 numbers are doubles — exact integers up to
 * 2^53 ≈ $9.007M in nano-USD. User-wallet magnitudes never approach that
 * (admission runs only against user wallets; house-account aggregates never
 * enter Redis), and the ledger — not this advisory hold state — is the
 * durable money truth.
 */

/**
 * Atomic admission check-and-add.
 *
 * KEYS[1] snapshot key · KEYS[2] wallet holds hash · KEYS[3..] budget scope
 * hashes. ARGV: holdId, estimate, nowMs, holdTtlSeconds, concurrentRunCap,
 * then one remaining-budget per scope key (same order).
 *
 * The balance check derives from the snapshot's wallet type: only `free`
 * wallets skip it (their balance is always 0 — the daily allowance rides in
 * as a budget scope). A snapshot missing `type` fails closed toward
 * checking, so a stale entry can only refuse, never over-admit.
 *
 * Returns 'no-snapshot' | 'run-cap' | 'insufficient-balance' |
 * 'budget-exceeded' | 'admitted'. Expired holds are pruned lazily on every
 * pass; the hold is written to the wallet hash AND every scope hash only
 * after every check passes, so N racers can never jointly over-admit.
 */
export const ADMISSION_SCRIPT = `
local snapshot = redis.call('GET', KEYS[1])
if not snapshot then return 'no-snapshot' end
local snap = cjson.decode(snapshot)
local balance = tonumber(snap.balanceNanoUsd)
local estimate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4]) * 1000

local function activeHolds(key)
  local fields = redis.call('HGETALL', key)
  local sum = 0
  local count = 0
  for i = 1, #fields, 2 do
    local sep = string.find(fields[i + 1], ':', 1, true)
    local held = tonumber(string.sub(fields[i + 1], 1, sep - 1))
    local expires = tonumber(string.sub(fields[i + 1], sep + 1))
    if expires <= now then
      redis.call('HDEL', key, fields[i])
    else
      sum = sum + held
      count = count + 1
    end
  end
  return sum, count
end

local heldSum, heldCount = activeHolds(KEYS[2])
if heldCount >= tonumber(ARGV[5]) then return 'run-cap' end
if snap.type ~= 'free' and balance - heldSum < estimate then return 'insufficient-balance' end
for i = 3, #KEYS do
  local remaining = tonumber(ARGV[i + 3])
  local scopeSum = activeHolds(KEYS[i])
  if remaining - scopeSum < estimate then return 'budget-exceeded' end
end

local value = ARGV[2] .. ':' .. string.format('%.0f', now + ttlMs)
redis.call('HSET', KEYS[2], ARGV[1], value)
redis.call('PEXPIRE', KEYS[2], ttlMs, 'GT')
redis.call('PEXPIRE', KEYS[2], ttlMs, 'NX')
for i = 3, #KEYS do
  redis.call('HSET', KEYS[i], ARGV[1], value)
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'GT')
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'NX')
end
return 'admitted'
`;

/**
 * Scope-only admission check-and-add — the trial policy's global Sybil budget.
 *
 * Unlike {@link ADMISSION_SCRIPT} there is NO wallet: no snapshot, no balance
 * leg, no run-cap. It reserves against ONE period-keyed scope holds hash and
 * nothing else, so a trial run (no wallet, no epoch) is bounded purely by the
 * aggregate concurrent budget.
 *
 * KEYS[1] scope holds hash. ARGV: holdId, estimate, nowMs, holdTtlSeconds,
 * remaining. Expired holds are pruned lazily on every pass; the hold is added
 * only after the budget check passes, so N racers can never jointly
 * over-commit. Returns 'budget-exceeded' | 'admitted'.
 */
export const SCOPE_ADMISSION_SCRIPT = `
local key = KEYS[1]
local estimate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4]) * 1000
local remaining = tonumber(ARGV[5])

local fields = redis.call('HGETALL', key)
local sum = 0
for i = 1, #fields, 2 do
  local sep = string.find(fields[i + 1], ':', 1, true)
  local held = tonumber(string.sub(fields[i + 1], 1, sep - 1))
  local expires = tonumber(string.sub(fields[i + 1], sep + 1))
  if expires <= now then
    redis.call('HDEL', key, fields[i])
  else
    sum = sum + held
  end
end

if remaining - sum < estimate then return 'budget-exceeded' end

local value = ARGV[2] .. ':' .. string.format('%.0f', now + ttlMs)
redis.call('HSET', key, ARGV[1], value)
redis.call('PEXPIRE', key, ttlMs, 'GT')
redis.call('PEXPIRE', key, ttlMs, 'NX')
return 'admitted'
`;

/**
 * Snapshot write-through CAS: writes ARGV[1] (the snapshot JSON) only when
 * its ledgerSeq (ARGV[2]) is newer than the stored one, so two racing
 * commits can never regress the snapshot to an older balance. ARGV[3] = TTL
 * seconds. Returns 1 when written, 0 when the stored snapshot was newer.
 */
export const SNAPSHOT_CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and tonumber(cjson.decode(current).ledgerSeq) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;
