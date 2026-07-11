/**
 * Client-side parser for the ConversationRoom server→client frame union
 * (`ServerFrame` in @hushbox/realtime/protocol). The server serializes frames
 * with `serializeFrame`; this is the receiving end. Malformed frames return
 * null — transit corruption cannot be fixed client-side, and the server
 * validates before broadcast, so a parse failure is dropped, never thrown.
 */
import { z } from 'zod';
import { InferenceEvent } from '@hushbox/shared';
import { realtimeEventSchema } from '@hushbox/realtime/events';
import type { ServerFrame } from '@hushbox/realtime/protocol';

const flowRunOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded') }),
  z.object({ outcome: z.literal('stopped') }),
  z.object({ outcome: z.literal('failed'), code: z.string().min(1) }),
]);

const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('event'), event: realtimeEventSchema }),
  z.object({
    type: z.literal('stream'),
    streamId: z.string().min(1),
    cursor: z.number().int().positive(),
    event: InferenceEvent,
  }),
  z.object({ type: z.literal('stream-gone'), streamId: z.string().min(1) }),
  z.object({ type: z.literal('run-started'), runId: z.string().min(1) }),
  z.object({
    type: z.literal('run-finished'),
    runId: z.string().min(1),
    outcome: flowRunOutcomeSchema,
  }),
]);

/** The run-output subset of the frame union (everything but ready/event). */
export type RunFrame = Extract<
  ServerFrame,
  { type: 'stream' | 'stream-gone' | 'run-started' | 'run-finished' }
>;

export function parseServerFrame(raw: string): ServerFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = serverFrameSchema.safeParse(data);
  // The zod-validated failure `code` is a plain string on the wire; the
  // protocol types it as ErrorCode. The widening is safe for rendering (the
  // friendly-message map falls back on unknown codes).
  return parsed.success ? (parsed.data as ServerFrame) : null;
}
