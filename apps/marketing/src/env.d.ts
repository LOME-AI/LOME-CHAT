/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  // Dev-only: the crawler-eye badge's origin and the E2E-build discriminator.
  // Present only in Development / E2E builds (Destination.Frontend, VITE_ prefix).
  readonly VITE_CRAWLER_VIEW_URL?: string;
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
