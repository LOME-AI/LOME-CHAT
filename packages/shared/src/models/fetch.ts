import { z } from 'zod';

/**
 * Per-entry schema is permissive on unknown fields (passthrough) but strict
 * on the fields we actually consume. Unknown-shape entries get filtered
 * downstream via the `has flat pricing` check — no need to fail the whole
 * batch over a single unknown pricing variant.
 */
export const publicModelEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  created: z.number().optional(),
  released: z.number().optional(),
  context_window: z.number().optional(),
  type: z.string().optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
});

export type PublicModelEntry = z.infer<typeof publicModelEntrySchema>;
