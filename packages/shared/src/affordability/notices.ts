/**
 * The one home for money copy (`docs/BILLING.md` §Notices & Refusals).
 *
 * Every unavailable option and every blocked send carries a machine-readable
 * reason, and this table is the reason→sentence map. The pre-send notice and
 * the wire refusal for one condition are the same string because both resolve
 * through here; `error-codes.test.ts` pins that derivation for every wire code
 * that shares a condition with this vocabulary, so a re-typed sentence at the
 * wire end fails a test rather than passing a review.
 *
 * Three properties this module guarantees, by shape rather than by review:
 *
 * - **An action is required.** An entry is a cause plus a non-empty action
 *   clause, so an entry that names a cause and leaves the user to guess which
 *   input to change does not typecheck.
 * - **Severity has one declaration.** An entry declares only whether the
 *   condition blocks; the rendered `type` is computed from it, so a dismissible
 *   error is unrepresentable here. What a surface does with `type` is that
 *   surface's own rule, pinned by that surface's tests.
 * - **Magnitudes are absent.** No sentence here names an amount, a token count
 *   or a threshold; the enumeration test in this directory asserts it over
 *   every wording, so a new entry inherits the rule instead of being trusted
 *   with it.
 */

import { ROUTES } from '../routes.js';
import { REFUSAL_CODES } from './turn-types.js';

/** A segment of a rendered message, optionally carrying an in-app destination. */
export interface MessageSegment {
  /** The text content of this segment */
  text: string;
  /** Route path if this segment should be a clickable link */
  link?: string;
}

export interface BudgetError {
  /** The typed reason this notice was produced from. */
  id: string;
  /** Severity: 'error' blocks send, 'warning' allows, 'info' is informational */
  type: 'warning' | 'error' | 'info';
  /** Human-readable message to display (plain text fallback) */
  message: string;
  /** Structured message with optional links for rendering */
  segments?: MessageSegment[];
}

/**
 * Every condition the money vocabulary explains. The refusal codes the turn
 * arithmetic produces are spread in whole — a reason that can grey an option
 * must be explainable — and the turn-level conditions the arithmetic cannot see
 * follow.
 *
 * Two reasons are deliberately kept apart wherever their ACTIONS differ, since
 * an action the user cannot take is worse than no action: premium splits on
 * whether an account exists, and held funds split from an empty balance because
 * paying fixes one and only waiting fixes the other.
 */
export const NOTICE_REASONS = [
  ...REFUSAL_CODES,
  /** The free daily allowance cannot cover this message; credit or tomorrow can. */
  'free_allowance_exhausted',
  /** A link guest with no allocation — no wallet of their own exists to fall back on. */
  'guest_no_group_budget',
  /** An owner-funded turn the owner's wallet can no longer cover. */
  'group_owner_funds_unavailable',
  /** The payer's funds are reserved by a run in flight, not spent. */
  'funds_held_by_run',
  /** This conversation is already generating; one run per conversation is hard-blocked. */
  'run_already_in_progress',
  /** The sender has read access only, so no paid action is available at all. */
  'conversation_read_only',
  /**
   * A refusal whose specific condition did not survive the wire: admission
   * answers several distinct refusals with one code, so the caller knows only
   * that the send was refused. This entry is the copy for that unresolved case.
   * It names no condition and offers no action that is false for any of them,
   * which is why it exists instead of borrowing a condition's wording — and it
   * becomes dead the day the emitter carries its reason.
   */
  'send_cannot_start',
  /** The turn will be charged to the sender rather than to the conversation owner. */
  'payer_switched_to_personal',
  /** The conversation owner's budget is covering this sender's messages. */
  'group_budget_pays',
  /** The free daily allowance is covering this message. */
  'free_allowance_pays',
  /** The trial's fixed per-message ceiling is covering this message. */
  'trial_preview_pays',
  /** The prompt is close enough to the model's context that replies may be cut short. */
  'context_near_capacity',
  /** Funds remain, but not enough to buy a full-length reply. */
  'answer_may_be_shortened',
] as const;

export type NoticeReason = (typeof NOTICE_REASONS)[number];

/**
 * Whether the condition blocks the send. Everything else about severity is
 * derived from it, so a dismissible error is unrepresentable; `tone` exists
 * only on the arm where a choice remains.
 */
type NoticeSeverity =
  | { readonly blocking: true }
  | { readonly blocking: false; readonly tone: 'warning' | 'info' };

export interface NoticeCopy {
  /** What happened, in the user's terms. Never a magnitude, never an internal bound. */
  readonly cause: string;
  /**
   * What the user can do about it. Non-empty by type: the first segment
   * continues the sentence the cause opened, and a linked segment names an
   * in-app destination. Waiting is an action; an absent action is not.
   */
  readonly action: readonly [MessageSegment, ...MessageSegment[]];
  readonly severity: NoticeSeverity;
}

const BLOCKING: NoticeSeverity = { blocking: true };
const INFO: NoticeSeverity = { blocking: false, tone: 'info' };
const WARNING: NoticeSeverity = { blocking: false, tone: 'warning' };

/**
 * One entry per reason. This object is the whole vocabulary: adding a condition
 * is adding a row, and every surface that renders availability picks it up
 * without change because reasons travel with options.
 */
export const NOTICE_COPY: Readonly<Record<NoticeReason, NoticeCopy>> = {
  premium_requires_account: {
    cause: 'This model is available with an account.',
    action: [{ text: 'Sign up', link: ROUTES.SIGNUP }, { text: ' to chat with premium models.' }],
    severity: BLOCKING,
  },
  premium_requires_credit: {
    cause: 'Premium models run on a paid balance.',
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ' to unlock them.' }],
    severity: BLOCKING,
  },
  trial_message_cap_exceeded: {
    cause: 'This message is too costly for the free trial.',
    action: [
      { text: 'Shorten it, or ' },
      { text: 'sign up', link: ROUTES.SIGNUP },
      { text: ' to keep chatting.' },
    ],
    severity: BLOCKING,
  },
  insufficient_funds: {
    cause: "Your balance can't cover this message.",
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ', or choose a more affordable model.' },
    ],
    severity: BLOCKING,
  },
  prompt_too_long: {
    cause: 'This conversation is too long for the selected model to answer.',
    action: [
      {
        text: 'Shorten your message, start a new conversation, or choose a model that reads more.',
      },
    ],
    severity: BLOCKING,
  },
  model_output_cap_too_low: {
    cause: "This model can't write a usable answer for a conversation this size.",
    action: [{ text: 'Choose a different model.' }],
    severity: BLOCKING,
  },
  option_not_offered: {
    cause: "The selected model doesn't offer that setting.",
    action: [{ text: 'Choose a different setting, or a different model.' }],
    severity: BLOCKING,
  },
  model_not_priceable: {
    cause: "This model isn't available to send to right now.",
    action: [{ text: 'Choose a different model.' }],
    severity: BLOCKING,
  },
  modality_not_priceable: {
    cause: "The selected model can't produce this kind of content.",
    action: [{ text: 'Choose a different content type, or a different model.' }],
    severity: BLOCKING,
  },
  free_allowance_exhausted: {
    cause: "Your free daily allowance can't cover this message.",
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ', or come back tomorrow.' }],
    severity: BLOCKING,
  },
  guest_no_group_budget: {
    // A guest holds no wallet of their own, so a payment path here would be a
    // false path: only the owner can make this send possible.
    cause: 'No budget is allocated to you in this conversation.',
    action: [{ text: 'Ask the conversation owner to allocate some.' }],
    severity: BLOCKING,
  },
  group_owner_funds_unavailable: {
    // Names the cause without disclosing what the owner's wallet is doing: the
    // served owner figure is hold-blind for privacy, and the sender is not
    // entitled to infer the owner's activity from a refusal.
    cause: "The conversation owner's budget can't cover this message.",
    action: [{ text: 'Ask the conversation owner for budget, or try again shortly.' }],
    severity: BLOCKING,
  },
  funds_held_by_run: {
    // Reserved funds return when the run finishes, so paying would not help and
    // offering it would be a false path. The conversation holding the reservation
    // is deliberately unnamed.
    cause: "Your funds are reserved by a reply that's still generating.",
    action: [{ text: 'Wait for it to finish, then send again.' }],
    severity: BLOCKING,
  },
  run_already_in_progress: {
    cause: 'This conversation is already generating a reply.',
    action: [{ text: 'Wait for it to finish, then send again.' }],
    severity: BLOCKING,
  },
  conversation_read_only: {
    cause: 'You have read-only access to this conversation.',
    action: [{ text: 'Ask the conversation owner for permission to send.' }],
    severity: BLOCKING,
  },
  send_cannot_start: {
    // Every clause has to be true of all three collapsed conditions, and no
    // clause may be an action that cannot help one of them: a payer whose funds
    // are merely reserved, or whose run cap is reached, would be told to pay.
    // Checking and waiting are offered as alternatives precisely because the
    // caller cannot be told which one applies.
    cause: "This message can't start right now.",
    action: [
      {
        text: 'Check your balance and budgets, or wait for your other replies to finish, then try again.',
      },
    ],
    severity: BLOCKING,
  },
  payer_switched_to_personal: {
    cause: 'This message will be charged to your own balance.',
    action: [{ text: 'Ask the conversation owner for budget to change that.' }],
    severity: INFO,
  },
  group_budget_pays: {
    // An informational notice rides alongside whatever blocking notice the
    // precedence picked, so its action stays verdict-neutral: telling the user
    // to send would invite exactly the action a disabled composer refuses.
    cause: "The conversation owner's budget covers your messages, so you won't be charged.",
    action: [{ text: 'Ask them for more if it runs out.' }],
    severity: INFO,
  },
  free_allowance_pays: {
    // The offer is about how many messages the day holds, never about how much
    // one message may contain: this renders beside a length refusal, and money
    // does not move a context bound.
    cause: 'This message uses your free daily allowance.',
    action: [
      { text: 'Add credit', link: ROUTES.BILLING },
      { text: ' for more messages each day.' },
    ],
    severity: INFO,
  },
  trial_preview_pays: {
    cause: 'You are chatting in the free preview.',
    action: [{ text: 'Sign up', link: ROUTES.SIGNUP }, { text: ' for full access.' }],
    severity: INFO,
  },
  context_near_capacity: {
    cause: 'This conversation is getting long for the selected model, so replies may be cut short.',
    action: [{ text: 'Start a new conversation to keep full-length replies.' }],
    severity: WARNING,
  },
  answer_may_be_shortened: {
    cause: 'Your balance is running low, so replies may be shortened.',
    action: [{ text: 'Add credit', link: ROUTES.BILLING }, { text: ' for longer replies.' }],
    severity: WARNING,
  },
};

/**
 * A notice produced from the vocabulary. It narrows {@link BudgetError} on both
 * fields a derived notice always has: its identity is the typed reason, and its
 * segments are present, because copy here is always a cause plus an action.
 */
export interface Notice extends BudgetError {
  id: NoticeReason;
  segments: MessageSegment[];
}

/** The rendered sentence for a reason: its cause, then its action clause. */
export function noticeText(reason: NoticeReason): string {
  const copy = NOTICE_COPY[reason];
  return `${copy.cause} ${copy.action.map((segment) => segment.text).join('')}`;
}

/**
 * The renderable notice for a reason. `type` is computed from the declared
 * blocking flag rather than declared beside it, so no entry can carry a
 * severity that disagrees with whether it blocks.
 */
export function notices(reason: NoticeReason): Notice {
  const copy = NOTICE_COPY[reason];
  return {
    id: reason,
    type: copy.severity.blocking ? 'error' : copy.severity.tone,
    message: noticeText(reason),
    segments: [{ text: `${copy.cause} ` }, ...copy.action],
  };
}
