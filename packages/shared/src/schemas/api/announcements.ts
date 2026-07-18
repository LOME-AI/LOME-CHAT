import { z } from 'zod';

/**
 * App-wide announcement banner contracts, shared by the API, the React app, and
 * the Astro marketing site.
 *
 * `banner_config` has a single writer — the announcements slice, via its
 * published write path composed by the admin `banner.set` operation — but the
 * jsonb stays untrusted at read time (legacy hand-edited rows and any
 * historical data predate that path): `bannerConfigSchema` salvages what it
 * can (drops invalid messages,
 * strips unsafe links, falls each message's unknown variant back to `info`) and
 * degrades a broken row to disabled rather than throwing. The hash that keys dismissal is computed
 * server-side over the normalized content and is opaque to clients, so the wire
 * contract (`bannerResponseSchema`) carries clean data only.
 */

export const BANNER_VARIANTS = ['info', 'warning', 'critical'] as const;
export const MAX_BANNER_MESSAGES = 20;
export const MAX_BANNER_TEXT_LENGTH = 280;
export const MAX_BANNER_LINK_TEXT_LENGTH = 60;

export const bannerVariantSchema = z.enum(BANNER_VARIANTS);
export type BannerVariant = z.infer<typeof bannerVariantSchema>;

export interface BannerMessage {
  id?: string;
  text: string;
  variant: BannerVariant;
  href?: string;
  linkText?: string;
}

function isBannerVariant(value: unknown): value is BannerVariant {
  return typeof value === 'string' && (BANNER_VARIANTS as readonly string[]).includes(value);
}

/**
 * A link target is safe only as a relative path or an http(s) absolute URL.
 * `javascript:`/`data:` and protocol-relative (`//host`) targets are rejected so
 * an operator typo can never become a script-injection or open-redirect vector.
 */
function isSafeHref(value: string): boolean {
  if (value.startsWith('//')) return false;
  if (value.startsWith('/')) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const bannerHrefSchema = z
  .string()
  .refine(isSafeHref, 'must be a relative path or an http(s) URL');

/** Trim, then enforce a non-empty bounded length, so whitespace-only copy is rejected. */
const boundedText = (max: number): z.ZodType<string> =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(max));

/**
 * `text` is validated (a message with no usable text is dropped at the set level);
 * `variant`/`href`/`linkText` are lenient — an unknown variant salvages to `info`
 * and an unsafe or malformed link is stripped to keep the message rather than
 * discarding the announcement.
 */
export const bannerMessageSchema = z
  .object({
    id: z.string().min(1).optional(),
    text: boundedText(MAX_BANNER_TEXT_LENGTH),
    variant: z.unknown().optional(),
    href: z.unknown().optional(),
    linkText: z.unknown().optional(),
  })
  .transform((raw): BannerMessage => {
    const message: BannerMessage = {
      text: raw.text,
      variant: isBannerVariant(raw.variant) ? raw.variant : 'info',
    };
    if (raw.id !== undefined) message.id = raw.id;
    if (typeof raw.href === 'string' && isSafeHref(raw.href)) message.href = raw.href;
    const linkText = typeof raw.linkText === 'string' ? raw.linkText.trim() : '';
    if (linkText.length > 0 && linkText.length <= MAX_BANNER_LINK_TEXT_LENGTH) {
      message.linkText = linkText;
    }
    return message;
  });

/** Clean wire contract the client re-parses; `hash` is null when the banner is disabled. */
export const bannerResponseSchema = z.object({
  hash: z.string().nullable(),
  messages: z.array(bannerMessageSchema).max(MAX_BANNER_MESSAGES),
});
export type BannerResponse = z.infer<typeof bannerResponseSchema>;

function salvageMessages(raw: unknown): BannerMessage[] {
  const items = Array.isArray(raw) ? raw : [];
  return items
    .flatMap((item) => {
      const parsed = bannerMessageSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_BANNER_MESSAGES);
}

const bannerConfigObjectSchema = z.object({
  enabled: z
    .unknown()
    .optional()
    .transform((value) => value === true),
  messages: z.unknown().optional().transform(salvageMessages),
});

/**
 * Salvaging parse of the operator-edited `banner_config` row. Never throws:
 * `z.unknown()` makes the top level total, a non-object row degrades to disabled,
 * an unknown per-message variant becomes `info`, a non-boolean `enabled` becomes
 * `false`, and invalid messages are dropped. The endpoint logs a counts-only warning when it
 * drops anything.
 */
export const bannerConfigSchema = z
  .unknown()
  .transform((raw) =>
    bannerConfigObjectSchema.parse(typeof raw === 'object' && raw !== null ? raw : {})
  );
export type BannerConfig = z.infer<typeof bannerConfigSchema>;
