/**
 * Whether the user's attention is currently somewhere other than this app.
 *
 * The activity badge counts what arrived while the user was looking away, so
 * both halves matter: a backgrounded tab (`hidden`) and a foreground tab the
 * user has clicked away from (visible, unfocused) are equally "away".
 */
export function isAwayFromApp(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus();
}
