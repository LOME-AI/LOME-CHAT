/**
 * Resolves the marketing API base URL. Read lazily (not at module load) so
 * islands that only call the API on user action still fail fast with a clear
 * message the moment a request is attempted in a misconfigured build.
 */
export function getApiUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  if (typeof fromEnv !== 'string' || fromEnv.length === 0) {
    throw new Error(
      'VITE_API_URL is required for the marketing React islands. Check envConfig and run pnpm generate:env.'
    );
  }
  return fromEnv;
}
