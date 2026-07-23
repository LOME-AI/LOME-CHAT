# Web app (apps/web)

The React SPA. Visual identity and copy rules: `docs/DESIGN.md` + `docs/PRODUCT.md`
govern any user-facing surface.

## API calls

- `src/lib/api-client.ts` is the sole typed API surface: `hc<AppType>()` plus the
  `fetchJson()` unwrap, injecting the `X-HushBox-Platform` / `X-App-Version` /
  `X-Link-Public-Key` headers. Never raw `fetch()` for endpoints the typed client
  covers.
- Server state goes through TanStack Query hooks wrapping the typed client.
- **Query-key factories are per-hook-file objects** (the `billingKeys` / `usageKeys`
  pattern in `src/hooks/`) — there is no central key registry and none should be
  invented (`src/lib/query-keys/` holds only blob-cache keys).

## UI conventions

- Test ids come only from the `TEST_IDS` / `TEST_ID_BUILDERS` registry in
  `@hushbox/shared` — literal `data-testid` strings are lint-banned.
- Use `@hushbox/ui` primitives; the accessibility wrappers are lint-enforced:
  `<Img>` / `<Logo>` (never raw `<img>`), `useAnimationFrame` (never raw
  `requestAnimationFrame`), no inline color/font styles — every color and font from
  Tailwind tokens.
- Assistant text may embed reasoning in the canonical inline format — always render
  via the shared parser from `@hushbox/shared`; never write literal think-delimiters
  or display raw message text unparsed.
