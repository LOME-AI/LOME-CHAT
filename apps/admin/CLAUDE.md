# Admin SPA

The admin panel: a static SPA served on `admin.hushbox.ai` behind Cloudflare Access,
talking to the product Worker's admin slice via `hc<AppType>()`. Visual identity:
`docs/DESIGN.md` §Admin app (density-first deltas on the product identity). Backend
rules: `apps/api/src/slices/admin/CLAUDE.md`. Implementation plan and full UI spec:
`docs/plans/ADMIN-PLANE.md` (archives to `docs/history/` once built; this file is the
permanent home for the conventions below).

## Conventions

- **One generic `<OpForm>`, never bespoke op forms.** Forms render from the shared op
  contracts' Zod schemas. If a form can't be generated, the op's input schema is wrong
  (inputs must stay flat) — fix the contract, don't hand-build the form.
- **Every mutation flows through the OpModal** — the form → preview-diff → execute/undo
  grammar is the app's one interaction signature. No bespoke confirm dialogs, no
  mutation outside it. The modal mints the `Idempotency-Key` at form-submit.
- **Preview before execute, undo after.** The preview step renders the engine's dry-run
  effects via `<DiffList>`; guardrail violations surface there as blocking errors. The
  result state always offers Undo (the inverse op through the same modal).
- **Panels load and fail independently.** Customer-360 panels are parallel queries with
  per-panel skeletons and per-panel errors — one broken query never blanks the page.
- **Palette-first navigation.** ⌘K reaches any user (by email/id), any op, any screen;
  every workflow must be completable without a pointer.
- **Ops appear automatically.** The ops catalog and nav derive from `GET /api/ops`;
  adding an op requires zero code in this app.
- **Vendor internals deep-link out.** HushBox-owned data renders here; Sentry stack
  traces and raw Workers logs link to their dashboards, never re-implemented.
- **Density is correct here:** tables over cards, monospace ids with copy buttons,
  counts over charts. Do not "improve" this app toward the product's warmth.
- Follow the web app's mechanics: TanStack Router/Query, centralized query-key
  factories, shared-Zod response re-validation, the `TEST_IDS` registry (no raw
  testids), `@hushbox/ui` primitives, the accessibility conventions.
