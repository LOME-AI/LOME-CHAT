/**
 * The canonical storage rates in exact integer nano-USD. Storage is a
 * pass-through cost (R2 + backup, 50-year retention), charged additively and
 * NEVER marked up. The money path is bigint nano-USD end to end, so THESE are
 * the single source of truth for the storage rates; any float/dollar
 * representation needed for display derives from them, never a mirrored literal.
 *
 *  - $0.0000003/char  = 300 nano-USD/char
 *  - $0.000000018/byte = 18 nano-USD/byte
 */

export const STORAGE_COST_PER_CHARACTER_NANO = 300n;

export const MEDIA_STORAGE_COST_PER_BYTE_NANO = 18n;
