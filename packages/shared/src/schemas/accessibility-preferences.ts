import { z } from 'zod';

export const accessibilityPreferencesSchema = z.object({
  version: z.literal(1),

  // Visual
  contrast: z.enum(['normal', 'increased', 'high', 'low']).default('normal'),
  saturation: z.enum(['0', '50', '100', '150']).default('100'),
  colorblindSimulate: z
    .enum(['none', 'protan', 'deutan', 'tritan', 'achroma', 'achromatomaly'])
    .default('none'),

  // Typography
  fontSize: z.enum(['88', '100', '112', '124', '141']).default('100'),
  letterSpacing: z.enum(['0', '0.05', '0.12']).default('0'),
  lineHeight: z.enum(['1.0', '1.5', '2.0']).default('1.5'),
  paragraphSpacing: z.enum(['1', '2']).default('1'),
  fontFamily: z.enum(['system', 'atkinson', 'open-dyslexic', 'lexend']).default('system'),

  // Reading aids
  magnifier: z.boolean().default(false),
  readingGuide: z.boolean().default(false),
  // Blog/document read-aloud: highlight the sentence currently being spoken.
  // Default on; toggled from the blog "Listen" control, shared across readers.
  readingHighlight: z.boolean().default(true),

  // Audio
  ttsEnabled: z.boolean().default(false),
  ttsVoice: z
    .enum(['af_heart', 'am_michael', 'bf_emma', 'bm_george', 'af_nicole'])
    .default('af_heart'),
  streamChatAloud: z.boolean().default(false),
  muteSounds: z.boolean().default(false),

  // Motion
  stopAnimations: z.boolean().default(false),

  // Pointer & focus
  cursorSize: z.enum(['normal', 'large', 'xlarge']).default('normal'),
  cursorColor: z.enum(['black', 'white']).default('black'),
  // '0' means "off" — disables the always-on focus ring; browser default rings still apply.
  focusWidth: z.enum(['0', '2', '4', '6']).default('0'),
  focusColor: z.enum(['yellow', 'magenta', 'cyan', 'lime', 'red']).default('yellow'),
  focusHalo: z.boolean().default(false),
});

export type AccessibilityPreferences = z.infer<typeof accessibilityPreferencesSchema>;
export const ACCESSIBILITY_PREFERENCES_DEFAULTS = accessibilityPreferencesSchema.parse({
  version: 1,
});

/**
 * Schema-driven per-field reconcile. Iterates the schema's own `.shape`, parsing
 * each field independently: valid persisted values are kept, invalid or missing
 * values fall back to that field's `.default()`. Unknown keys in the input are
 * dropped. Non-object inputs (null, primitives) collapse to full defaults.
 *
 * Adding or removing a field in `accessibilityPreferencesSchema` flows through
 * without touching this function — the shape iteration is the contract.
 */
export function reconcileAccessibilityPreferences(input?: unknown): AccessibilityPreferences {
  const blob =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const result: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(accessibilityPreferencesSchema.shape)) {
    const parsed = (fieldSchema as z.ZodType).safeParse(blob[key]);
    result[key] = parsed.success
      ? parsed.data
      : ACCESSIBILITY_PREFERENCES_DEFAULTS[key as keyof AccessibilityPreferences];
  }
  return result as AccessibilityPreferences;
}
