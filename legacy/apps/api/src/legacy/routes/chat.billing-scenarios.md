# Billing Integration Test Scenarios

Test dimensions and scenario matrix for `chat.billing-integration.test.ts`.

## Dimensions

- **Tier**: `free` (0 cushion), `paid` (50¢ cushion)
- **Reserved**: existing Redis `chatReservedBalance` — 0, partial, near-full
- **Model**: `basic` (gpt-3.5-turbo), `premium` (gpt-4-turbo)
- **Balance**: sufficient, just enough, insufficient

### Token Estimation Direction

| Direction                     | Free/Trial/Guest                        | Paid                                   | Design intent                            |
| ----------------------------- | --------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Input (chars→tokens)          | 2 chars/tok (conservative, pessimistic) | 4 chars/tok (standard, optimistic)     | Free overestimates tokens → higher cost  |
| Output storage (tokens→chars) | 4 chars/tok (standard, pessimistic)     | 2 chars/tok (conservative, optimistic) | Free overestimates storage → higher cost |

Output estimation is **inverted** from input: the same tier that is pessimistic for input is also pessimistic for output, but the chars/token values swap because the conversion direction is reversed (chars→tokens vs tokens→chars).

### No Rounding

- No `Math.ceil` on `estimatedMinimumCostCents` or `worstCaseCents`
- No headroom reduction (`MAX_TOKENS_HEADROOM` deleted)
- `Math.floor` in `calculateBudget` guarantees `worstCaseCents ≤ availableCents`
- Redis `INCRBYFLOAT` handles float reservations natively

## Models

| Model                 | Input Price      | Output Price     | Context |
| --------------------- | ---------------- | ---------------- | ------- |
| basic (gpt-3.5-turbo) | $0.0000005/token | $0.0000015/token | 16K     |
| premium (gpt-4-turbo) | $0.00001/token   | $0.00003/token   | 128K    |

Prices are pre-fee. A 15% fee is applied via `applyFees()`.

## Scenario Matrix

### Free Tier (freeAllowance = 5¢, cushion = 0)

| #   | Balance | Reserved | Model   | Expected   | Error Code                 | Rationale                                  |
| --- | ------- | -------- | ------- | ---------- | -------------------------- | ------------------------------------------ |
| F1  | 5¢      | 0¢       | basic   | PASS (200) | —                          | Full allowance available                   |
| F2  | 5¢      | 3¢       | basic   | PASS (200) | —                          | 2¢ remaining >= estimatedMinimumCostCents  |
| F3  | 5¢      | 4.9¢     | basic   | DENY (402) | `INSUFFICIENT_BALANCE`     | 0.1¢ remaining < estimatedMinimumCostCents |
| F4  | 5¢      | 5¢       | basic   | DENY (402) | `INSUFFICIENT_BALANCE`     | Nothing remaining                          |
| F5  | 5¢      | 0¢       | premium | DENY (402) | `PREMIUM_REQUIRES_BALANCE` | Free can't access premium                  |
| F6  | 0¢      | 0¢       | basic   | DENY (402) | `INSUFFICIENT_BALANCE`     | No allowance at all                        |

### Paid Tier (cushion = 50¢)

| #   | Balance | Reserved | Model   | Expected   | Error Code             | Rationale                             |
| --- | ------- | -------- | ------- | ---------- | ---------------------- | ------------------------------------- |
| P1  | $10     | 0¢       | premium | PASS (200) | —                      | Full $10 + 50¢ cushion                |
| P2  | $10     | $9.50    | premium | PASS (200) | —                      | 50¢ + 50¢ cushion = $1 budget         |
| P3  | $10     | $10.49   | basic   | PASS (200) | —                      | -49¢ + 50¢ cushion = 1¢ effective     |
| P4  | $10     | $10.50   | premium | DENY (402) | `INSUFFICIENT_BALANCE` | 0¢ effective (cushion fully consumed) |
| P5  | $0.01   | 0¢       | basic   | PASS (200) | —                      | 1¢ + 50¢ cushion = 51¢ effective      |
| P6  | $0.01   | 0¢       | premium | PASS (200) | —                      | 1¢ + 50¢ cushion = 51¢ effective      |

### Trial Tier

Trial tier (`userId === null`) uses a separate endpoint (`/trial`, tested in `trial-chat.test.ts`).
Authenticated users on `/stream` are never trial — `getUserTier` returns `'free'` or `'paid'` based on wallet balances.

### Race Guard (TOCTOU — Redis eval returns simulated concurrent totals)

| #   | Tier | Balance | Eval Returns     | Expected   | Error Code         | Rationale                           |
| --- | ---- | ------- | ---------------- | ---------- | ------------------ | ----------------------------------- |
| R1  | paid | $10     | > cushion limit  | DENY (402) | `BALANCE_RESERVED` | Concurrent race pushed past cushion |
| R2  | paid | $10     | at cushion limit | PASS (200) | —                  | Exactly at cushion boundary         |
| R3  | free | 5¢      | > allowance      | DENY (402) | `BALANCE_RESERVED` | Concurrent race on free tier        |
| R4  | paid | $10     | within cushion   | PASS (200) | —                  | Within cushion                      |

### Minimum Output Token Boundary (MINIMUM_OUTPUT_TOKENS = 1000)

| #   | Tier | Allowance/Balance | Reserved | Model | Max Tokens | Expected | Rationale                          |
| --- | ---- | ----------------- | -------- | ----- | ---------- | -------- | ---------------------------------- |
| M1  | free | 5¢                | 0¢       | basic | >>1000     | PASS     | Well above minimum                 |
| M2  | free | exact for 1000    | 0¢       | basic | =1000      | PASS     | Exactly at minimum boundary        |
| M3  | free | exact for 999     | 0¢       | basic | <1000      | DENY     | Below minimum                      |
| M4  | paid | $0                | 0¢       | basic | >>1000     | PASS     | Cushion affords well above minimum |
| M5  | paid | $0                | 49¢      | basic | >1000      | PASS     | -49¢ + 50¢ cushion = 1¢ effective  |

### Budget Accuracy (assert callCostCents and maxOutputTokens)

| #   | Tier | Balance | Reserved | Model   | Assert                      |
| --- | ---- | ------- | -------- | ------- | --------------------------- |
| B1  | free | 5¢      | 0¢       | basic   | callCost <= availableCents  |
| B2  | free | 5¢      | 3¢       | basic   | callCost <= remainingCents  |
| B3  | paid | $10     | $9.50    | premium | callCost <= effectiveCents  |
| B4  | paid | $10     | 0¢       | premium | callCost matches max tokens |

### Token Estimation by Tier

| #   | Tier  | Chars | Expected Tokens | chars/token      | Rationale                               |
| --- | ----- | ----- | --------------- | ---------------- | --------------------------------------- |
| TE1 | free  | 4000  | 2000            | 2 (conservative) | Free overestimates tokens (pessimistic) |
| TE2 | paid  | 4000  | 1000            | 4 (standard)     | Paid underestimates tokens (optimistic) |
| TE3 | trial | 4000  | 2000            | 2 (conservative) | Same as free                            |

### Reservation Lifecycle

| #   | Test                             | Rationale                                 |
| --- | -------------------------------- | ----------------------------------------- |
| L1  | Released after successful stream | `finally` block always runs               |
| L2  | Released on stream error         | Error doesn't leak reservations           |
| L3  | Released on empty model content  | Empty response still releases reservation |

### computeWorstCaseCents Unit Tests

| #   | Test                              | Rationale                     |
| --- | --------------------------------- | ----------------------------- |
| CW1 | Raw float (no ceiling rounding)   | Verifies no `Math.ceil`       |
| CW2 | Zero inputs return zero           | Edge case: empty message      |
| CW3 | Linear scaling with output tokens | Cost increases proportionally |

## Test Helpers

### `computeScenario(input)`

Forward computation: derives all billing expectations from scenario inputs.
Mirrors production math with the reservation-aware fix applied.
Uses actual tier for input token estimation and inverted output storage.

### `allowanceForTargetTokens(model, tier, targetTokens, content)`

Inverse computation: finds the exact `freeAllowanceCents` that produces `targetTokens` output tokens from `calculateBudget`. Since the pre-check now uses actual tier (matching `calculateBudget`), M2 can assert exact token count.
