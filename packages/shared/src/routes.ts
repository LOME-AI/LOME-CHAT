/** Production marketing site base URL (used for native deep links and external page opens). */
export const MARKETING_BASE_URL = 'https://hushbox.ai';

/**
 * Centralized route constants.
 * Single source of truth for all navigation paths.
 */
export const ROUTES = {
  CHAT: '/chat',
  CHAT_NEW: '/chat/new',
  CHAT_ID: '/chat/$id',
  CHAT_TRIAL: '/chat/trial',
  BILLING: '/billing',
  USAGE: '/usage',
  SETTINGS: '/settings',
  ACCESSIBILITY: '/accessibility',
  DEMO: '/demo',

  LOGIN: '/login',
  SIGNUP: '/signup',
  VERIFY: '/verify',

  SHARE_CONVERSATION: '/share/c/$conversationId',
  SHARE_MESSAGE: '/share/m/$shareId',

  MARKETING: '/welcome',
  BLOG: '/blog',
  NEWSLETTER: '/newsletter',
  NEWSLETTER_CONFIRMED: '/newsletter/confirmed',
  NEWSLETTER_UNSUBSCRIBED: '/newsletter/unsubscribed',
  ROADMAP: '/roadmap',
  LEADERBOARD: '/leaderboard',
  PRIVACY: '/privacy',
  TERMS: '/terms',

  DEV_PERSONAS: '/dev/personas',
  DEV_EMAILS: '/dev/emails',
  DEV_ASSETS: '/dev/assets',
  DEV_RENDER_ASSET: '/dev/render-asset/$name',
} as const;

/**
 * Routes served by the Astro marketing site (prerendered HTML with hashed
 * inline scripts via `experimental.csp`). Consumed by
 * `scripts/generate-headers.ts` to decide which paths get the per-page CSP
 * with extracted hashes vs the SPA `/*` fallback. Add a new entry here AND
 * an Astro page under `apps/marketing/src/pages/` together — the generator
 * fails loud if a listed route has no matching built HTML.
 */
export const MARKETING_ROUTES = [
  ROUTES.MARKETING,
  ROUTES.BLOG,
  ROUTES.NEWSLETTER,
  ROUTES.ROADMAP,
  ROUTES.LEADERBOARD,
  ROUTES.PRIVACY,
  ROUTES.TERMS,
] as const;

export const FOOTER_LINKS = [
  { group: 'Product', label: 'Welcome', href: ROUTES.MARKETING },
  { group: 'Product', label: 'Chat', href: ROUTES.CHAT },
  { group: 'Product', label: 'Blog', href: ROUTES.BLOG },
  { group: 'Product', label: 'Roadmap', href: ROUTES.ROADMAP },
  { group: 'Product', label: 'Leaderboard', href: ROUTES.LEADERBOARD },
  { group: 'Account', label: 'Log In', href: ROUTES.LOGIN },
  { group: 'Account', label: 'Sign Up', href: ROUTES.SIGNUP },
  { group: 'Legal', label: 'Privacy', href: ROUTES.PRIVACY },
  { group: 'Legal', label: 'Terms', href: ROUTES.TERMS },
] as const;
