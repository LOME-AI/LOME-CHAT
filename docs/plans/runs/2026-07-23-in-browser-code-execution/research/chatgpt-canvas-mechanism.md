# How ChatGPT Canvas renders/executes code artifacts (2026 state)

Research date: 2026-07-24. Grading: **Verified** = fetched/read the source this session; **Inferred** = deduced from sources read but not stated outright; **Assumed** = training-data recall, flagged as such.

---

## Distilled summary (read this first)

1. **Canvas is being wound down on the flagship model path.** Per OpenAI's own release notes, on **May 28, 2026** ("GPT-5.5 Instant Update") canvas was removed from GPT-5.5 Instant and GPT-5.5 Thinking; writing/coding now renders as inline blocks in the chat stream instead. Canvas persists only "for a limited time through legacy models until those models are sunset." Verified — https://help.openai.com/en/articles/6825453-chatgpt-release-notes (fetched via Wayback snapshot 2026-07-23).
2. **React/HTML preview mechanism**: OpenAI's own help doc says only "React/HTML code is rendered in a **sandbox environment**... Many npm packages and JavaScript libraries will work." No official statement names an iframe, a specific transpiler, or a bundler. Verified (the sandboxing claim) / **not confirmed** (the exact rendering pipeline) — https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it (Wayback 2026-07-20).
3. **Domain evidence**: OpenAI's own IT-allowlist doc lists `*.oaistatic.com` (static assets) and `*.oaiusercontent.com` (sandboxed/user content, explicitly cited for failed-upload/preview troubleshooting) as first-party domains to allowlist. Verified — https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps (Wayback 2026-07-16).
4. **The specific sandbox subdomain pattern** — `<id>.web-sandbox.oaiusercontent.com`, one origin per widget/app instance, loaded in a nested ("double") iframe with a `postMessage` JSON-RPC bridge — is **confirmed for the Apps SDK** (ChatGPT Apps / MCP widgets) via OpenAI's own developer docs and independent reverse-engineering. It is **not officially confirmed to be the identical code path for Canvas's HTML/React preview**, though the shared `oaiusercontent.com` domain family and OpenAI's own "sandbox environment" wording make it very likely the same underlying sandbox-iframe infrastructure is reused. Inferred.
5. **No transpiler/bundler is named anywhere in official docs.** No source found (official or reverse-engineered) states whether Canvas uses `@babel/standalone`, a bundler, or a server-side build step for the React preview. This remains a **gap**.
6. **Canvas Python is confirmed client-side via Pyodide** (Python-to-WebAssembly), independently verified at launch (Dec 2024) and consistent with the still-current (2026) help-doc wording "execute... Python directly on your browser." Verified for 2024 launch mechanism, Inferred that this is unchanged in 2026 (no source states a mechanism change, and the current help doc's wording is consistent with it).
7. **Network access is user/org-gated, not blocked outright**: Canvas Python (Pyodide) can make direct outbound `fetch` calls to CORS-permissive endpoints — no server-side proxy. Enterprise workspaces default to code-execution **on** but network access **off**, independently toggleable. Verified.
8. **No service worker found in ChatGPT's main web app.** An independent June 2026 frontend reverse-engineering deep-dive states explicitly "there's no service worker" on chatgpt.com, contrasted with Linear's offline-precaching SW. This covers the parent app; it does not directly test the sandboxed `oaiusercontent.com` iframe origin, which is a separate origin and could in principle register its own SW — no evidence either way was found for that specific origin. Verified (for chatgpt.com) / gap (for the sandbox origin specifically).
9. **Mobile (iOS/Android): Canvas is explicitly "coming soon," i.e. not yet shipped**, per OpenAI's own help doc as of a July 20, 2026 snapshot: "canvas is available on Web, Windows, and MacOS. Coming soon to mobile platforms (iOS, Android, mobile web)." This directly **conflicts** with several lower-quality secondary/blog sources found in search results claiming Canvas already works on iOS/Android via the same-menu shortcut. The primary source (OpenAI itself, current as of last week) is preferred. Verified + noted conflict.
10. **ChatGPT "Apps" (MCP-based, the newer platform surface) is architecturally distinct from Canvas** but reveals the general sandboxing pattern OpenAI uses for untrusted rendered content: widget resources are served as MCP-typed HTML (`text/html;profile=mcp-app`, formerly/internally called "Skybridge," MIME `text/html+skybridge` in some SDK examples), rendered inside a per-app `<id>.web-sandbox.oaiusercontent.com` iframe with declarative CSP (`connectDomains`, `resourceDomains`, `frameDomains`), and bridged to host via `postMessage` JSON-RPC (`window.openai`). Verified — https://developers.openai.com/apps-sdk/build/mcp-server.
11. **Independent reverse-engineering corroborates the double-iframe pattern** for the Apps SDK specifically (not Canvas): a fixed, host-allowlisted proxy origin loads an inner iframe via `document.write()` and relays `postMessage`s, because a CSP `frame-src` allowlist can't include "every MCP app that will ever exist." Verified — https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3.
12. **Evidence quality is uneven**: the mobile-availability and GPT-5.5/canvas-retirement facts are strongly Verified from OpenAI's own current docs. The exact HTML/React execution pipeline (transpiler, bundler, iframe sandbox attributes, whether Canvas literally reuses the Apps-SDK sandbox) is **not documented anywhere found**, official or unofficial, and should be treated as an open gap, not inferred by analogy alone.

---

## 1. Web mechanism — Canvas HTML/React preview

### What OpenAI itself says
Official help-center wording (current as of the 2026-07-20 archive snapshot, article "Updated: 6 days ago" relative to that capture):

> "How does React/HTML rendering work? React/HTML code is rendered in a sandbox environment, allowing you to view the output of the code. Many npm packages and JavaScript libraries will work, but previews that need to load external packages or web resources may depend on your workspace's canvas network access settings."

> "Canvas can preview websites and other web content. Web content is necessarily online and has the ability to communicate with third-parties that are not OpenAI... When you interact with canvas web preview, ChatGPT will ask you to confirm communications with third-parties OpenAI doesn't know about."

> "Some JS/HTML Canvas previews need the user's browser to load external packages or other web resources before they can render. If 'Allow canvas code to access the network' is turned off, or if browser or organization network controls block a required external domain, the preview may not finish loading. Check the browser console for errors such as Failed to fetch, Refused to connect, or Content Security Policy errors... it's likely the IT team in your company network needs to allowlist `*.oaiusercontent.com`."

Verified — https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it (fetched via Wayback Machine snapshot `20260720213323`, since the live URL 403s to automated fetchers).

**What this tells us, precisely:**
- It is browser-side rendering ("sandbox environment" the user's own browser loads/executes), not a server-side headless-browser screenshot — the network-access toggle and CORS confirmation dialog only make sense if the code is executing client-side and making its own network calls.
- The preview can pull "external packages or web resources," implying a runtime capable of fetching and running third-party JS at preview time (e.g., a CDN-fetched library), not a fixed pre-bundled sandbox.
- `*.oaiusercontent.com` is the domain OpenAI itself points IT admins to for Canvas-preview network troubleshooting — strong evidence this is the origin the preview iframe (or equivalent sandbox) is served from/communicates through.

**What is NOT stated anywhere found:**
- Whether the preview is an `<iframe sandbox="...">`, and with which sandbox flags.
- Which exact transpiler handles JSX/TSX (no source names `@babel/standalone`, esbuild-wasm, SWC-wasm, or similar). A web search for this returned only generic pages about `@babel/standalone` as a plausible *candidate* technology — never a confirmation it's what OpenAI uses. This is a gap, not an inference.
- Whether a bundler resolves `import` statements for "npm packages," or whether only packages available via a global CDN-script pattern (e.g., UMD builds on a CDN) work. The "many npm packages... will work" phrasing, plus the network-access toggle being the thing that breaks package loading, is consistent with a CDN-fetch-based resolution scheme (à la esm.sh / Skypack / unpkg), but no source names such a CDN. Inferred, weakly.

### Reused sandbox infrastructure (Apps SDK) — architecturally adjacent, not proven identical
OpenAI's Apps SDK (the MCP-based "ChatGPT Apps" platform, distinct from Canvas but part of the same "render untrusted UI inside ChatGPT" problem space) is much better documented and independently reverse-engineered:

- Widget UI is served by the developer's own MCP server as an HTML resource; setting `_meta.ui.domain` makes ChatGPT "render the widget under `<domain>.web-sandbox.oaiusercontent.com`." Verified — https://developers.openai.com/apps-sdk/build/mcp-server.
- The sandbox "blocks all network access except explicitly allowlisted domains," configured per-widget via `_meta.ui.csp` with `connectDomains` (fetch targets), `resourceDomains` (scripts/styles/images/fonts), and `frameDomains` (nested iframes — off by default, "apps that declare it face higher scrutiny"). Verified — same source.
- Host↔iframe communication is JSON-RPC 2.0 over `postMessage`, part of the open **MCP Apps** spec; the client-side compatibility surface is `window.openai` (`toolOutput`, `setWidgetState`, `requestModal`, `openExternal`, etc.). Verified — same source.
- Independent reverse-engineering (a Postman staff engineer who built the same "double iframe" pattern for MCP-UI before Apps SDK existed) confirms: a fixed, host-allowlisted **proxy** origin loads first; it signals readiness; the host `postMessage`s the actual app's HTML + CSP metadata to the proxy; the proxy creates an **inner** iframe and injects the HTML via `document.write()`, relaying messages between host and inner app from then on. Rationale given: a CSP `frame-src` allowlist can't enumerate "every MCP app that will ever exist," so a single trusted proxy origin is allowlisted once, and it controls what loads behind it. The MCP Apps spec formalizes this: host and sandbox must be different origins; the sandbox iframe must be `sandbox="allow-scripts allow-same-origin"`; the proxy enforces a CSP derived from the UI resource's declared metadata. Verified — https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3 (author: Ruben Casas, Staff Engineer, Postman; posted "Jan 22," year not stated on the fetched page but content and surrounding site context place it in the Apps SDK era, i.e. 2025–2026).
- A separate deep-dive (Vercel, on shipping Next.js apps for this same Apps SDK surface) independently confirms the **three-layer** nesting — `chatgpt.com` → sandbox iframe on `web-sandbox.oaiusercontent.com` → inner iframe (also on that domain) → the app's actual HTML — and documents the practical consequences: the app's real origin is masked, so Next.js needs `assetPrefix` fixes for `/_next/` chunk requests, a `<base href>` fix for relative URLs, `history.pushState` patched to avoid leaking the real domain, `window.fetch` patched to redirect same-origin RSC-payload requests to the real server with CORS mode, permissive CORS headers added server-side, a `MutationObserver` to strip attributes the parent frame injects onto `<html>` (paired with React's `suppressHydrationWarning` to dodge hydration mismatches from that DOM tampering), and a capture-phase click handler to route off-origin links through `openai.openExternal()` so they open in the user's real browser instead of the constrained iframe. Verified — https://vercel.com/blog/running-next-js-inside-chatgpt-a-deep-dive-into-native-app-integration. Notably: **no service worker or transpiler is mentioned anywhere in this account either** — it describes ordinary framework-standard React/Next.js execution once the origin-masking problems are worked around, i.e., **no special client-side transpilation step for this surface** — Next.js is pre-built and served normally by the developer's own server; ChatGPT's iframes only proxy/frame it.

**Bottom line for §1**: The Apps-SDK sandbox mechanism (double iframe on `<id>.web-sandbox.oaiusercontent.com`, `postMessage`-JSON-RPC bridge, per-widget CSP) is Verified in detail. Whether Canvas's HTML/React *preview* (a different, older, non-MCP feature) is implemented on the *same* sandbox infrastructure is Inferred at best — the shared `oaiusercontent.com` domain family and OpenAI's own "sandbox environment" language are suggestive, but no source explicitly states Canvas previews are Apps-SDK widgets or share the identical iframe-nesting code path. Treat this as a plausible architecture, not a confirmed one.

---

## 2. Canvas Python — client-side Pyodide, confirmed and apparently still current

At launch (Dec 10, 2024), Simon Willison directly tested and documented the mechanism:

> "Canvas runs Python via Pyodide... it's an entirely new implementation of code execution — it runs the code directly in your browser using Pyodide (Python compiled to WebAssembly)... it can make direct HTTP calls from your browser to anywhere online with compatible CORS headers... Canvas Python can install [packages], but this will only work for pure Python wheels compatible with Pyodide."

He explicitly contrasts this with the older, separate, server-side **Code Interpreter**, which "executes Python server-side in a tightly locked-down Kubernetes container" and has no network access at all — a different feature from Canvas's in-browser execution. Verified — https://simonwillison.net/2024/Dec/10/chatgpt-canvas/ (fetched directly, HTTP 200).

The current (2026) OpenAI help doc uses consistent language without naming Pyodide explicitly:

> "You can execute code canvas files for Python directly on your browser when you are using canvas by selecting the Execute button... the output will appear in the console at the bottom of the screen... This feature is currently only available for Python code."

> Enterprise defaults: "canvas code execution is turned on while 'Allow canvas code to access the network' is turned off... Online [package install] only works for pure Python wheels compatible with Pyodide" (this exact "compatible with Pyodide" phrase appears in the current help content per search-snippet excerpts, consistent with the 2024 mechanism persisting).

Verified (2024 mechanism) / Inferred (unchanged through 2026 — no source states a change, and current wording is consistent with, though doesn't explicitly re-name, Pyodide). No 2025/2026 source was found announcing a *replacement* of the Pyodide-based execution model, and the "directly on your browser" language in the still-current help doc is inconsistent with a switch to server-side execution.

---

## 3. Mobile apps (iOS/Android) — Canvas is not yet shipped there as of July 2026

Direct quote, current help doc (Wayback snapshot dated 2026-07-20, article marked "Updated: 6 days ago" relative to that capture, i.e. reflecting mid-July 2026 state):

> "Please note that canvas is available on **Web, Windows, and MacOS**. **Coming soon to mobile platforms (iOS, Android, mobile web).**"

Verified — https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it (Wayback `20260720213323`).

This is a **direct conflict** with lower-quality secondary sources surfaced in search (e.g., a general "ChatGPT Mobile App Guide 2026" blog claiming "Canvas is in the iOS and Android apps, same Share button shortcut menu, though the screen is cramped"). Given one side is OpenAI's own current help documentation and the other is an unverified SEO/guide blog post never directly fetched and confirmed, **the primary source is preferred**: as of the most recent confirmable snapshot, Canvas previews/execution are **not** available in the native iOS/Android apps — only web, Windows, and macOS. Whether "mobile web" (i.e., a mobile browser hitting chatgpt.com) counts as excluded too is explicit in the same sentence — it does, it's also listed as "coming soon."

Combine this with the GPT-5.5 retirement fact (§ below): even where Canvas exists (web/Windows/macOS, legacy models only), it is a shrinking surface, not an expanding one — which makes a "coming soon to mobile" note as of mid-2026 read as likely to stay unfulfilled rather than imminent. Inferred (product-trajectory judgment, not a claim OpenAI made).

**No source was found describing what would happen if/when Canvas did reach the native apps** — i.e., no confirmation of a "same WebView-loading-remote-sandbox pattern" on mobile, because the feature is not there to observe. This is a hard gap, not an inference: the question can't currently be verified because the artifact under investigation doesn't exist on that platform.

---

## 4. GPT-5.5 and the Canvas retirement (context OpenAI didn't ask for but is highly relevant to "current state")

Official OpenAI release notes, dated entry **May 28, 2026**, "GPT-5.5 Instant Update":

> "We're updating GPT-5.5 Instant in ChatGPT and the API to improve response style and quality... With this update, canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking. Writing and coding functionality is now supported directly in chat responses through writing blocks and code blocks. Paid users can continue using canvas for a limited time through legacy models until those models are sunset."

Verified — https://help.openai.com/en/articles/6825453-chatgpt-release-notes (Wayback `20260723192434`, i.e. yesterday relative to this research).

This is corroborated by the current Canvas help doc itself: "Model compatibility: Canvas is not supported by GPT-5.5 or later models. When Canvas is enabled for a Custom GPT, choose a recommended model that supports Canvas. Models that do not support Canvas will be unavailable while the capability is enabled." Verified — same help doc as §1/§3.

A secondary source (Krasa.ai, single-source, not independently corroborated) adds color: the replacement is "writing blocks and code blocks" that render inline in the chat thread rather than a side panel, framed as pursuit of "one rendering model across iOS, Android, web, desktop" and possibly lower-than-hoped Canvas usage; it also notes OpenAI has not said Canvas is gone forever. Inferred/unverified beyond the official release-note text — treat the "why" as speculation, only the "what" (canvas removed from GPT-5.5, kept on legacy models temporarily) is Verified.

**Practical implication for this research task**: if the goal is evaluating in-browser code execution mechanisms to learn from, Canvas-the-artifact-preview-surface is present-tense only on legacy GPT-4o-era models in ChatGPT, on web/Windows/macOS, and is explicitly a shrinking/deprecated surface as of mid-2026 — not the forward-looking reference implementation it was in 2024–2025.

---

## 5. Service worker involvement

No official OpenAI source mentions a service worker anywhere in Canvas documentation (searched specifically; found nothing).

The strongest available evidence is a June 1, 2026 independent frontend reverse-engineering deep-dive of chatgpt.com's main web app (covers routing, CSS/JS chunking, ProseMirror/CodeMirror editors — CodeMirror is explicitly named as "the same library running canvas" — streaming, feature-flagging, and bot defense):

> "And one last notable absence: there's no service worker. Linear precaches about 1,200 assets so the app boots offline. ChatGPT caches nothing beyond standard HTTP. My read is it's deliberate. They deploy constantly, an offline chat app is useless without a model on the other end, and a stale service worker is one of the few bugs that outlive the fix you deploy for it."

Verified — https://performance.dev/chatgpt (dated "Jun 1, 2026" per the article's own byline).

**Caveat**: this statement is about the **top-level `chatgpt.com` origin**. The Canvas/Apps sandbox iframes are served from a **different origin** (`*.oaiusercontent.com` / `<id>.web-sandbox.oaiusercontent.com`), which is architecturally where a service worker (if any existed, e.g. to intercept and rewrite asset requests for framed third-party apps) would most plausibly live. No source — official or reverse-engineered — was found confirming or denying a service worker on that specific sandbox origin. Given the author explicitly went looking for and reported on ChatGPT's caching/offline strategy (finding none) and no other reverse-engineering source mentions one either, the balance of evidence is **no service worker in the main app**; the sandbox-origin question is an open gap rather than a confirmed "no."

---

## 6. Domain inventory (primary-sourced)

OpenAI's own IT-allowlist help doc (current as of Wayback snapshot `20260716001545`, "Updated: yesterday" relative to that capture) lists, among others:

```
*.auth.openai.com     *.chatgpt.com          *.oaistatic.com
*.oaiusercontent.com  *.openai.com           *.oaistatsig.com
android.chat.openai.com   ios.chat.openai.com   desktop.chat.openai.com
```

and separately flags `*.oaiusercontent.com` by name as the domain to unblock specifically for **failed uploads / Canvas-preview-style rendering issues**. Verified — https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps.

This corroborates (but is not itself proof of the exact mechanism for) the community/reverse-engineering claims naming `cdn.oaistatic.com` (general static-asset CDN — CSS, etc., served from ~4 Cloudflare anycast IPs per a malware-sandbox network-trace writeup found in search results, not independently re-verified this session — Inferred/unverified, source was a Joe Sandbox automated-analysis page that returned HTTP 403 to direct fetch) and `web-sandbox.oaiusercontent.com` (per-app/widget sandbox subdomain, Verified for Apps SDK per §1).

---

## Gaps (things this research could not confirm)

- **Exact JS execution pipeline for Canvas's React/HTML preview**: no source (official or unofficial) names a transpiler (Babel standalone or otherwise), a bundler, or confirms/denies use of an in-browser module resolver for "npm packages." The official doc's language ("many npm packages... will work," gated by network-access settings) is consistent with a CDN-fetch resolution scheme but this is not confirmed.
- **Whether Canvas's HTML/React sandbox iframe is literally the same code path as the Apps-SDK `web-sandbox.oaiusercontent.com` double-iframe** — architecturally plausible (same domain family, same "sandbox environment" language) but not stated by any source found.
- **Service worker presence on the `oaiusercontent.com` sandbox origin specifically** (as opposed to the main `chatgpt.com` app, where absence is well evidenced).
- **What Canvas looks like on mobile once shipped** — cannot be observed because, per OpenAI's own current documentation, it has not shipped on iOS/Android as of mid/late July 2026.
- The Joe Sandbox malware-analysis report and the `cdn.oaistatic.com` anycast/IP-count claim could not be directly fetched this session (403) and rest on a search-snippet paraphrase only — flagged Assumed/unverified rather than Verified, and excluded from load-bearing claims above.
- Krasa.ai's account of *why* OpenAI retired Canvas from GPT-5.5 (cross-platform consistency, usage numbers) is single-sourced speculation, not corroborated by an official OpenAI statement of rationale — only the *fact* of retirement is Verified.

---

## Source list

- OpenAI Help Center — "What is the canvas feature in ChatGPT and how do I use it?" (Wayback 2026-07-20): https://help.openai.com/en/articles/9930697-what-is-the-canvas-feature-in-chatgpt-and-how-do-i-use-it
- OpenAI Help Center — "Network recommendations for ChatGPT errors on web and apps" (Wayback 2026-07-16): https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps
- OpenAI Help Center — "ChatGPT — Release Notes" (Wayback 2026-07-23): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- OpenAI Developers — "Build your MCP server – Apps SDK": https://developers.openai.com/apps-sdk/build/mcp-server
- Simon Willison — "ChatGPT Canvas can make API requests now, but it's complicated" (2024-12-10): https://simonwillison.net/2024/Dec/10/chatgpt-canvas/
- Ruben Casas / DEV Community — "I Reverse Engineered ChatGPT Apps Iframe Sandbox": https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3
- Vercel — "Running Next.js in ChatGPT: How to Build ChatGPT Apps": https://vercel.com/blog/running-next-js-inside-chatgpt-a-deep-dive-into-native-app-integration
- performance.dev — "Reverse Engineering ChatGPT Web: How OpenAI Built for a Billion Users" (2026-06-01): https://performance.dev/chatgpt
- Krasa.ai — "OpenAI Drops Canvas From GPT-5.5, Bakes Writing and Coding Into Chat" (secondary, single-source, flagged accordingly): https://www.krasa.ai/news/openai-gpt-5-5-instant-writing-coding-blocks-canvas-removed-may-2026
