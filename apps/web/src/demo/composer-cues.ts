/**
 * Demo-only composer cues that signal the chat box isn't a live input. Injects
 * one stylesheet that (1) replaces the per-modality placeholder ("Describe the
 * image you want...", etc.) with a sign-up prompt and (2) dims the
 * modality-switch icons so they read as locked. Pure CSS — it touches no real
 * component and self-heals across re-renders.
 *
 * The director is unaffected: it switches modality with synthetic (untrusted)
 * clicks that guardrails lets through, and types via the native value setter,
 * neither of which these visual-only rules block.
 */
import { MODALITY_ARIA_LABELS } from '@hushbox/shared';

export const DEMO_COMPOSER_PLACEHOLDER = 'This is a live demo, sign up to start your own chats';

/**
 * Exact aria-labels of the composer's modality-switch icons, sourced from the
 * shared registry the prompt-input renders from. Matched exactly — a prefix
 * like `"Switch to "` would also catch the header's "Switch to dark mode"
 * toggle.
 */
export const MODALITY_SWITCH_LABELS: readonly string[] = Object.values(MODALITY_ARIA_LABELS);

/** CSS/`closest()` selector matching any modality-switch icon. */
export const MODALITY_SWITCH_SELECTOR = MODALITY_SWITCH_LABELS.map(
  (label) => `[aria-label="${label}"]`
).join(',');

// Hide the real animated placeholder text and overlay the demo copy via ::after
// (inheriting the overlay's muted color, font, and position). The overlay only
// mounts while the textarea is empty, so the copy disappears as the director
// types. ChatModality icons stay clickable for the director (dimming is cosmetic);
// trusted user clicks are stopped by guardrails.
const COMPOSER_CUE_CSS = `
[data-testid="animated-placeholder"] [data-testid="typing-animation"] {
  display: none !important;
}
[data-testid="animated-placeholder"]::after {
  content: '${DEMO_COMPOSER_PLACEHOLDER}';
  position: absolute;
  top: 0;
  left: 0;
}
${MODALITY_SWITCH_SELECTOR} {
  opacity: 0.5;
  cursor: not-allowed;
}
`;

/** Inject the composer-cue stylesheet. Returns a disposer that removes it. */
export function installComposerCues(): () => void {
  const style = document.createElement('style');
  style.dataset['testid'] = 'demo-composer-cues';
  style.textContent = COMPOSER_CUE_CSS;
  document.head.append(style);
  return () => {
    style.remove();
  };
}
