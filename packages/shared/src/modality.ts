import { z } from 'zod';

/**
 * The single closed set of model modalities. One source feeding the pgEnum,
 * the Zod contracts, and the dispatch types — adding a member is a deliberate
 * enum migration plus one dispatch adapter, never ad-hoc data.
 */
export const MODALITIES = ['text', 'image', 'audio', 'video', 'embedding'] as const;

/** Zod schema for modality validation */
export const Modality = z.enum(MODALITIES);

/** TypeScript type for modality */
export type Modality = z.infer<typeof Modality>;
