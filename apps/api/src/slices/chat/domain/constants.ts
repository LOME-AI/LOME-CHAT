import { AdmissionHookName, PolicyHooks } from '@hushbox/shared';

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
 * The `chat` admission-policy discriminant the DO's binder dispatches on. A
 * definition declaring it binds the balance-hold admission and the
 * persist-then-charge settlement. The binder dispatches on the declared name
 * rather than a hardcoded policy, so a trial policy plugs in as another name
 * without a second turn pipeline.
 */
export const CHAT_ADMISSION_HOOK = AdmissionHookName.parse('chat');

/** The paid chat turn's declared hooks. */
export const CHAT_TURN_HOOKS = PolicyHooks.parse({ admission: 'chat', settlement: 'chat' });

/**
 * The `trial` admission-policy discriminant. A definition declaring it binds
 * the no-wallet Sybil-budget admission and the no-op settlement — the trial
 * variant of the SAME turn pipeline, plugged in as another hook name rather
 * than a second pipeline.
 */
export const TRIAL_ADMISSION_HOOK = AdmissionHookName.parse('trial');

/** The trial turn's declared hooks (no-persist / no-charge policy). */
export const TRIAL_TURN_HOOKS = PolicyHooks.parse({ admission: 'trial', settlement: 'trial' });
