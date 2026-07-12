/**
 * Ground-truth action log emitted by capture scripts. Timestamps are
 * milliseconds from recording start; coordinates are CSS pixels in the
 * capture viewport. The Remotion edit consumes this to drive zoom/pan and
 * the rendered cursor sprite — it is the replacement for inferring motion
 * from pixels the way screen-recorder apps do.
 */
export type CaptureActionKind =
  | 'move'
  | 'click'
  | 'type'
  | 'scroll'
  | 'waitStart'
  | 'waitEnd'
  | 'mark';

export interface CaptureAction {
  t: number;
  x: number;
  y: number;
  kind: CaptureActionKind;
  /** Semantic label, e.g. the test-id clicked or a scene beat name. */
  label: string;
}

export interface CaptureLog {
  startedAt: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  videoFile: string;
  actions: CaptureAction[];
}
