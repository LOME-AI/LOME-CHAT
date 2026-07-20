// `-`-prefixed sibling module: excluded from the TanStack route tree so the
// route file (`dev.emails.tsx`) can export only `Route` and stay code-split.
export const devEmailsKeys = {
  all: ['dev-emails'] as const,
};
