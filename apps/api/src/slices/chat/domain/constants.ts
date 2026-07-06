import { AdmissionHookName, PolicyHooks, SettlementHookName } from '@hushbox/shared';

/**
 * The chat turn: a single-model text definition run on the in-conversation
 * workflow executor. These constants pin the turn's shape (one input, one
 * `modelCall` node) and its billing/idempotency policy.
 */

/** The turn's one named input port — the user's prompt. */
export const CHAT_TURN_INPUT = 'prompt';

/** The turn's one `modelCall` node id; also the sink-output and charge key. */
export const CHAT_TURN_NODE_ID = 'answer';

/**
 * The idempotency-key scope route for a chat turn. The run referee is claimed
 * in the conversation DO (not the HTTP handler), so the scope's `route` is
 * this stable constant rather than a matched URL pattern — the client key plus
 * the paying user still uniquely identify the run.
 */
export const CHAT_TURN_ROUTE = 'chat.turn';

/**
 * Per-wallet concurrent-run cap enforced at admission. One conversation
 * already hard-blocks a second run at both layers; this bounds a user starting
 * turns across many conversations at once, keeping the chargeback-cycle
 * exposure formula bounded.
 */
export const PER_WALLET_CONCURRENT_RUN_CAP = 5;

/**
 * The declared policy-hook names, the discriminants the DO's binder dispatches
 * on. `chat` resolves to the balance-hold admission and the persist-then-charge
 * settlement; `trial` resolves to the quota admission and the no-op settlement.
 * The turn pipeline is the same; only the bound policy differs.
 */
export const CHAT_ADMISSION_HOOK = AdmissionHookName.parse('chat');
export const CHAT_SETTLEMENT_HOOK = SettlementHookName.parse('chat');
export const TRIAL_ADMISSION_HOOK = AdmissionHookName.parse('trial');
export const TRIAL_SETTLEMENT_HOOK = SettlementHookName.parse('trial');

/** The paid chat turn's declared hooks. */
export const CHAT_TURN_HOOKS = PolicyHooks.parse({ admission: 'chat', settlement: 'chat' });

/** The trial turn's declared hooks — the same pipeline, the no-persist/no-charge policy. */
export const TRIAL_TURN_HOOKS = PolicyHooks.parse({ admission: 'trial', settlement: 'trial' });
