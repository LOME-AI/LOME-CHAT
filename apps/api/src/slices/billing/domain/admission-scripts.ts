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
 * Atomic admission check-and-add over the HOLDS state only.
 *
 * KEYS[1] wallet holds hash · KEYS[2..] budget scope hashes. ARGV: holdId,
 * estimate, nowMs, holdTtlSeconds, concurrentRunCap, effectiveSpendable,
 * applyBalanceCheck (1|0), then one remaining-budget per scope key (same order).
 *
 * The spendable-funds rule (`balance + paid cushion`, free/unknown → raw
 * balance) is computed ONCE in TypeScript by `spendableFundsNanoUsd` and passed
 * in as `effectiveSpendable`; this script never re-derives it. The advisory
 * balance is TS-supplied on purpose (the ledger is truth and same-wallet
 * settlement serializes under FOR UPDATE), but every check that reads-and-writes
 * mutable Redis state — the active-holds sum, the concurrent-run cap, and each
 * per-scope check-and-add — stays inside this atomic section, because those are
 * the parts that race between concurrent admissions.
 *
 * `applyBalanceCheck` is 0 for free wallets (no balance gate; the daily
 * allowance rides in as a budget scope) and 1 for paid/unknown wallets, so a
 * stale/untyped snapshot still fails closed.
 *
 * Returns 'run-cap' | 'insufficient-balance' | 'budget-exceeded' | 'admitted'.
 * Expired holds are pruned lazily on every pass; the hold is written to the
 * wallet hash AND every scope hash only after every check passes, so N racers
 * can never jointly over-admit.
 */
export const ADMISSION_SCRIPT = `
local estimate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttlMs = tonumber(ARGV[4]) * 1000
local effectiveSpendable = tonumber(ARGV[6])
local applyBalanceCheck = tonumber(ARGV[7])

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

local heldSum, heldCount = activeHolds(KEYS[1])
if heldCount >= tonumber(ARGV[5]) then return 'run-cap' end
if applyBalanceCheck == 1 and effectiveSpendable - heldSum < estimate then return 'insufficient-balance' end
for i = 2, #KEYS do
  local remaining = tonumber(ARGV[i + 6])
  local scopeSum = activeHolds(KEYS[i])
  if remaining - scopeSum < estimate then return 'budget-exceeded' end
end

local value = ARGV[2] .. ':' .. string.format('%.0f', now + ttlMs)
redis.call('HSET', KEYS[1], ARGV[1], value)
redis.call('PEXPIRE', KEYS[1], ttlMs, 'GT')
redis.call('PEXPIRE', KEYS[1], ttlMs, 'NX')
for i = 2, #KEYS do
  redis.call('HSET', KEYS[i], ARGV[1], value)
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'GT')
  redis.call('PEXPIRE', KEYS[i], ttlMs, 'NX')
end
return 'admitted'
`;

/**
 * Daily trial-spend increment — the trial policy's cumulative Sybil ceiling.
 *
 * Unlike {@link ADMISSION_SCRIPT} there is NO wallet and NO reservation: the
 * counter is a single cumulative total fed by each trial run's ACTUAL provider
 * cost at settlement. It folds this run's cost into the day's counter atomically
 * with anchoring the counter's expiry to the next UTC midnight (NX — set once,
 * never extended, no reset job), and reports the ONE increment that crosses the
 * cap so a human is alerted exactly once per day.
 *
 * KEYS[1] daily-spend counter. ARGV: amount (nano-USD decimal string, never a
 * JS number — money stays integer across the wire), cap (nano-USD), ttlSeconds.
 * Crossing is computed from the atomic pre/post values of THIS increment, so
 * exactly one increment per day satisfies `pre < cap <= post`. Returns
 * `<crossed|below>:<total>` — a non-numeric prefix so the total round-trips as
 * a string (never parsed back into a lossy JS number), read as a bigint.
 */
export const TRIAL_SPEND_INCREMENT_SCRIPT = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
local total = redis.call('INCRBY', key, ARGV[1])
redis.call('EXPIRE', key, ttlSeconds, 'NX')
local status = 'below'
if total >= cap and (total - amount) < cap then status = 'crossed' end
return status .. ':' .. string.format('%.0f', total)
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
