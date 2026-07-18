import { writeFileSync } from 'node:fs';

import type { CaptureAction, CaptureActionKind, CaptureLog } from './types.js';

export class ActionLogger {
  private readonly actions: CaptureAction[] = [];
  private readonly t0: number;

  constructor(
    private readonly viewport: CaptureLog['viewport'],
    private readonly videoFile: string
  ) {
    this.t0 = Date.now();
  }

  /** Epoch ms of action-time zero, so a screen recorder can share this clock. */
  get startedAtMs(): number {
    return this.t0;
  }

  log(kind: CaptureActionKind, x: number, y: number, label: string): void {
    this.actions.push({ t: Date.now() - this.t0, x, y, kind, label });
  }

  /** Beat marker with no coordinates (scene boundaries, stream-in start…). */
  mark(label: string): void {
    const last = this.actions.at(-1);
    this.log('mark', last?.x ?? 0, last?.y ?? 0, label);
  }

  save(path: string): CaptureLog {
    const log: CaptureLog = {
      startedAt: new Date(this.t0).toISOString(),
      viewport: this.viewport,
      videoFile: this.videoFile,
      actions: this.actions,
    };
    writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`);
    return log;
  }
}
