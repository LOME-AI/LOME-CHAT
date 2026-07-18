/**
 * The crawler-view origin for the dev-only crawler-eye badge. `env.isDevServer`
 * (the badge's gate) is true only in Development mode, where env.config
 * guarantees this var; a missing value behind that gate is a config defect, so
 * this fails fast rather than silently no-op.
 */
export function crawlerViewOrigin(): string {
  const url = import.meta.env['VITE_CRAWLER_VIEW_URL'] as string | undefined;
  if (url === undefined) {
    throw new Error('VITE_CRAWLER_VIEW_URL must be defined when the dev server runs');
  }
  return url;
}
