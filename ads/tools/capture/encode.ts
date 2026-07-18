export interface ConcatFrame {
  /** Ms since action-time zero (shared with the ActionLogger clock). */
  tMs: number;
  file: string;
}

/** Escapes a path for an ffmpeg concat-demuxer `file '…'` line. */
export function escapeConcatPath(p: string): string {
  return p.replaceAll("'", String.raw`'\''`);
}

/**
 * Builds an ffmpeg concat-demuxer list with per-frame durations so the encode
 * preserves the capture's real pacing. The first frame is stretched back to
 * t=0 (video time == action-log time), and the last frame is repeated because
 * the demuxer ignores the final entry's duration unless the file recurs.
 */
export function buildConcatList(frames: readonly ConcatFrame[], finalHoldMs: number): string {
  const lines: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const startMs = index === 0 ? 0 : frame.tMs;
    const next = frames.at(index + 1);
    const endMs = next ? next.tMs : frame.tMs + finalHoldMs;
    const durSec = Math.max((endMs - startMs) / 1000, 1 / 1000);
    lines.push(`file '${escapeConcatPath(frame.file)}'\nduration ${durSec.toFixed(4)}`);
  }
  const lastFrame = frames.at(-1);
  if (lastFrame) lines.push(`file '${escapeConcatPath(lastFrame.file)}'`);
  return lines.join('\n');
}
