/**
 * Demo-only click guardrails. The demo runs the real app, so unsupported
 * controls (settings, logout, billing, group management, message writes) are
 * present. A capture-phase interceptor blocks them and shows a sign-up nudge,
 * turning every dead-end into a conversion moment. Touches NO real component —
 * it only listens on `document` and keys off the centralized test-ids /
 * aria-labels. Supported controls (conversation switching, new chat, model
 * picker, copy) pass through untouched.
 *
 * LegacyModality-switch icons are a special case: real (trusted) user clicks are
 * nudged, but the director's synthetic (untrusted) clicks pass so conversations
 * still auto-switch modality. See `composer-cues.ts` for the matching visuals.
 */
import { MODALITY_SWITCH_SELECTOR } from './composer-cues';

const BLOCKED_TESTIDS = new Map<string, string>([
  ['menu-settings', 'open settings'],
  ['menu-logout', 'log out'],
  ['menu-add-credits', 'add credits'],
  ['menu-usage', 'see usage'],
  ['menu-accessibility', 'open accessibility settings'],
  ['new-member-button', 'invite people'],
  ['invite-link-button', 'create invite links'],
  ['chat-item-more-button', 'manage conversations'],
  // Leaving a conversation is reachable from the member panel (a separate path
  // from the blocked sidebar kebab) and is destructive — block it and its
  // confirm button.
  ['member-leave-action', 'leave conversations'],
  ['leave-confirmation-confirm', 'leave conversations'],
]);

const BLOCKED_TESTID_PREFIXES = new Map<string, string>([
  ['member-remove-action-', 'manage members'],
  ['member-change-privilege-', 'manage members'],
  // The per-member / per-link action menus open the destructive remove/revoke
  // /privilege options; block the menu triggers so those never surface.
  ['member-actions-', 'manage members'],
  ['link-revoke-action-', 'manage links'],
  ['link-change-privilege-', 'manage links'],
  ['link-actions-', 'manage links'],
]);

// Message-write actions only carry aria-labels (no test-ids). Copy, Regenerate
// and Retry are omitted — they run against the fake backend (regenerate
// re-streams a reply), so they stay supported. Fork/Share/Edit have no demo
// backing and are nudged.
const BLOCKED_ARIA = new Map<string, string>([
  ['Fork', 'fork conversations'],
  ['Share', 'share messages'],
  ['Edit', 'edit messages'],
]);

/** True if the target is (or is inside) a composer modality-switch icon. */
export function isModalitySwitchTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(MODALITY_SWITCH_SELECTOR) !== null;
}

/** Returns a friendly action label if the event target is an unsupported control, else null. */
export function findBlockedAction(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  for (const [testid, label] of BLOCKED_TESTIDS) {
    if (target.closest(`[data-testid="${testid}"]`) !== null) return label;
  }
  for (const [prefix, label] of BLOCKED_TESTID_PREFIXES) {
    if (target.closest(`[data-testid^="${prefix}"]`) !== null) return label;
  }
  for (const [aria, label] of BLOCKED_ARIA) {
    if (target.closest(`[aria-label="${aria}"]`) !== null) return label;
  }
  return null;
}

/**
 * Decide whether a click should be nudged (and with what label), or allowed
 * (null). Unconditionally-blocked controls nudge regardless of trust; modality
 * icons nudge only on real (trusted) clicks so the director's synthetic switch
 * passes.
 */
export function resolveClickNudge(target: EventTarget | null, isTrusted: boolean): string | null {
  const blocked = findBlockedAction(target);
  if (blocked !== null) return blocked;
  if (isTrusted && isModalitySwitchTarget(target)) return 'switch modes';
  return null;
}

interface Nudge {
  readonly el: HTMLElement;
  show: (label: string) => void;
}

function createNudge(): Nudge {
  const el = document.createElement('div');
  el.className =
    'z-overlay fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background opacity-0 shadow-lg transition-opacity duration-200 pointer-events-none';
  el.setAttribute('role', 'status');
  el.dataset['testid'] = 'demo-signup-nudge';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (label: string): void => {
    el.textContent = `Create a free account to ${label}.`;
    el.classList.remove('opacity-0');
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.add('opacity-0');
    }, 2600);
  };
  return { el, show };
}

/** Install the capture-phase interceptor + nudge. Returns a disposer. */
export function installGuardrails(): () => void {
  const nudge = createNudge();
  document.body.append(nudge.el);
  const onClick = (event: MouseEvent): void => {
    const label = resolveClickNudge(event.target, event.isTrusted);
    if (label !== null) {
      event.preventDefault();
      event.stopPropagation();
      nudge.show(label);
    }
  };
  document.addEventListener('click', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    nudge.el.remove();
  };
}
