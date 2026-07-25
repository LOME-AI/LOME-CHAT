import type { DocumentErrorCode } from '@hushbox/shared/documents';

/**
 * Interactive stdin has no transport into the opaque sandbox iframe, so the
 * Python runtime replaces `builtins.input` with a function that raises a
 * RuntimeError carrying this exact marker. The runtime and this classifier are
 * the two sides of that contract; the marker is defined once here and imported
 * by the runtime's Python preamble so the two can never drift apart.
 */
export const INPUT_UNSUPPORTED_MARKER = '__HUSHBOX_INPUT_UNSUPPORTED__';

/**
 * Map a raised Python error's traceback text onto the closed set of document
 * error codes. A traceback bearing the input marker is the author calling
 * `input()`; everything else is an ordinary execution failure whose detail the
 * `message` field already carries verbatim.
 */
export function classifyPythonError(text: string): DocumentErrorCode {
  return text.includes(INPUT_UNSUPPORTED_MARKER) ? 'input_unsupported' : 'python_error';
}
