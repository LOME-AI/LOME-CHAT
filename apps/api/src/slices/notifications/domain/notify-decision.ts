import { isWithinQuietHours } from './quiet-hours.js';
import { CATEGORY_TOGGLE, DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { NotificationCategory } from '@hushbox/shared';
import type { ConversationMemberView, NotificationPreferences } from '../ports/index.js';

/**
 * Whether the actor is dropped from their own event, per category. It is
 * category-scoped because "the actor" means different things: for a message or
 * a membership change the event IS the thing they just did, so telling them
 * about it is noise. A run completion is the MODEL's work finishing — the
 * person who started it is the one waiting on it, and the settings copy
 * promises them that notification. Presence still suppresses a requester who
 * is watching the run, so this never nags someone already looking at it.
 */
const EXCLUDES_ACTOR: Readonly<Record<NotificationCategory, boolean>> = {
  message: true,
  runCompletion: false,
  membership: true,
};

export interface SelectNotifyRecipientsParams {
  readonly members: readonly ConversationMemberView[];
  readonly category: NotificationCategory;
  /** Per-user preference rows; a user absent from the map takes the defaults. */
  readonly prefsByUser: ReadonlyMap<string, NotificationPreferences>;
  /** Users with an open socket on the conversation — they see the event live. */
  readonly presentUserIds: readonly string[];
  /** The user who caused the event; dropped only for the categories above. */
  readonly actorUserId: string | null;
  /** Injected clock instant for the quiet-hours evaluation. */
  readonly now: Date;
}

/**
 * The single server-authoritative "should this member be notified" decision.
 * A member is dropped by conversation-scoped signals (they are the actor of a
 * category that excludes actors, they are present, they muted the
 * conversation) and by account-level controls (the global switch, the
 * per-category toggle, and the quiet-hours window evaluated in the member's
 * stored timezone). A missing preferences row means every default (all on, no
 * quiet hours). The client never re-implements this.
 */
export function selectNotifyRecipients(params: SelectNotifyRecipientsParams): readonly string[] {
  const present = new Set(params.presentUserIds);
  const toggle = CATEGORY_TOGGLE[params.category];
  const excludesActor = EXCLUDES_ACTOR[params.category];
  return params.members
    .filter((member) => {
      if (excludesActor && member.userId === params.actorUserId) return false;
      if (member.muted) return false;
      if (present.has(member.userId)) return false;
      const prefs = params.prefsByUser.get(member.userId) ?? DEFAULT_NOTIFICATION_PREFERENCES;
      return passesAccountControls(prefs, toggle, params.now);
    })
    .map((member) => member.userId);
}

/**
 * The account-level gate: the global switch, the per-category toggle, and the
 * quiet-hours window evaluated in the member's stored timezone.
 */
function passesAccountControls(
  prefs: NotificationPreferences,
  toggle: 'messages' | 'runCompletion' | 'membership',
  now: Date
): boolean {
  if (!prefs.globalEnabled) return false;
  if (!prefs[toggle]) return false;
  if (
    prefs.quietHoursStartMinutes !== null &&
    prefs.quietHoursEndMinutes !== null &&
    prefs.timezone !== null &&
    isWithinQuietHours(
      now,
      prefs.quietHoursStartMinutes,
      prefs.quietHoursEndMinutes,
      prefs.timezone
    )
  ) {
    return false;
  }
  return true;
}
