# Origin & model-cache dedup — authoritative finding

Status: Verified (this session, orchestrator).

- Production origins: web app (`FRONTEND_URL`) and marketing site (`MARKETING_URL`) are BOTH `https://hushbox.ai` (`apps/api/wrangler.toml:58-59`; `apps/marketing/astro.config.mjs:26` sets `site: 'https://hushbox.ai'`). Same origin.
- transformers.js / kokoro-js caches model weights in the browser **Cache API**, origin-scoped (see `research/tts-landscape.md`). Same origin ⇒ the cache is shared between /blog and /chat automatically.
- Therefore: model-download dedup between blog TTS and chat TTS requires ONLY that both surfaces initialize kokoro-js with the **identical model id, dtype/quantization, and transformers.js env settings** — i.e. both must go through the one existing engine in `packages/ui/src/components/accessibility/lib/tts-engine.ts`. No service worker, no cross-origin machinery, no new storage layer.
- Corollary constraint for all tasks: never fork or re-configure model loading on the marketing side; import the shared engine so the cache keys stay byte-identical.
- Local dev note: Vite (web) and Astro (marketing) dev servers run on different localhost ports ⇒ different origins in dev; the cache is NOT shared locally. This is dev-only behavior, not a production defect.
