import * as React from 'react';

/**
 * Every state the panel mirrors into the status element. 'rendered' is reached
 * only on the sandbox bridge's `rendered` message and 'complete' only on its
 * `result`, so proofs keying on those states prove real execution; 'streaming'
 * means the message is still arriving and nothing has rendered yet.
 */
export type DocumentRenderStatusValue =
  | 'streaming'
  | 'booting'
  | 'idle'
  | 'loading'
  | 'running'
  | 'rendered'
  | 'complete'
  | 'error';

/**
 * What the panel says while a document's message is still streaming and no
 * attempt has rendered yet. Deliberately not a failure: the code is unfinished,
 * not wrong, and the reader has nothing to act on.
 */
export const PENDING_PREVIEW_TEXT = 'Preview starts when the code is ready.';

/**
 * The panel's single lifecycle mirror. The literal HTML `id` (a distinct
 * mechanism from `data-testid`) is what Playwright and the Android Maestro flow
 * select — Android's devtools hierarchy sees app-origin DOM but not the inside
 * of the sandbox iframe, so this element is the only programmatic proof of what
 * the preview is doing.
 */
export function DocumentRenderStatus({
  status,
  text,
}: Readonly<{ status: DocumentRenderStatusValue; text: string }>): React.JSX.Element {
  return (
    <div id="document-render-status" role="status" aria-live="polite" data-status={status}>
      <span className="sr-only">{text}</span>
    </div>
  );
}
