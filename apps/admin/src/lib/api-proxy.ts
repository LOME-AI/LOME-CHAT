/**
 * Strip the SPA-facing `/api` prefix so the product Worker sees its real
 * root-mounted paths (`/admin/...`, `/dev/...`). Used by the Vite dev proxy
 * (vite.config.ts), which locally plays the role of the production
 * `admin.hushbox.ai/api/*` edge route. See src/lib/api-client.ts for the full
 * path-mapping story.
 */
export function stripApiPrefix(path: string): string {
  return path.replace(/^\/api/, '');
}
