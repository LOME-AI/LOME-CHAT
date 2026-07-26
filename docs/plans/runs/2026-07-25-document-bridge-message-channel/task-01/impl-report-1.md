# T1 — Render bootstrap on the port, plus the shared embed harness

## Objective

Move `apps/sandbox/src/render/bootstrap.ts` onto the frame-minted `MessageChannel` transport, and
rebuild its browser tests so they drive the renderer inside a real sandboxed iframe (opaque origin),
via a shared embed harness T2 can reuse for `python.html`.

## Files changed

| Path                                          | Why                                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/sandbox/src/render/bootstrap.ts`        | Mints the channel, keeps `port1`, transfers `port2` on the one-shot `ready`; window `message` listener removed; `post()` sends on the port. |
| `apps/sandbox/public/render.js`               | Regenerated from source (`pnpm --filter @hushbox/sandbox build:render`).                                                       |
| `apps/sandbox/src/embed-harness.ts`           | New shared test harness: one static origin (sandbox CSP + CORS), an embedder page that captures the transferred port, and the frame-driving primitives. |
| `apps/sandbox/src/render/render.browser.test.ts` | All 22 tests re-expressed through the embedded frame; 4 transport tests added.                                              |
| `apps/sandbox/vitest.config.ts`               | Excludes `src/embed-harness.ts` from coverage, exactly as `python/browser-harness.ts` already is (criterion 4 requires it). Not on the task's file-ownership list — see Deviations. |

## Transport, as shipped

- `startRenderer()` creates `new MessageChannel()`, stores `port1` in the module-scoped
  `embedderPort`, registers the inbound handler with `port1.addEventListener('message', …)` +
  explicit `port1.start()` (the lint rule `unicorn/prefer-add-event-listener` forbids `onmessage`;
  `addEventListener` does not start a port implicitly, so the explicit `start()` is required and is
  called *before* the transfer, so nothing the embedder sends immediately can be dropped).
- The single surviving wildcard is `parent.postMessage(ready, '*', [channel.port2])`.
- `post()` sends every other frame→parent message on `embedderPort` and throws if it is unset
  (fail-fast; unreachable by construction — every sender runs downstream of a port message).
- `neutralizeWebRtc()` still runs immediately before `startRenderer()`; nothing was added above them
  at module scope, so no messaging object exists before neutralization.

## Tests added

| Test (in `render.browser.test.ts`)                                            | Behavior                                                              | Criterion |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------- |
| `transfers a MessagePort with its ready broadcast`                             | The `ready` carries a transferable the embedder receives.              | 1         |
| `keeps its end of the channel off the frame global`                            | No `MessagePort` is reachable from the frame's `globalThis`.           | GC 4      |
| `renders a document from an init delivered only through the transferred port`  | Port-only `init`, from a real opaque-origin embedder, reaches `rendered`. | 6      |
| `ignores an init posted at its window instead of the port`                     | A wildcard `window.postMessage` `init` at the frame is not acted on.   | 7         |

All 22 pre-existing tests kept their names, comments, and assertions; only the transport lines
changed (`page.evaluate(window.postMessage(...))` → `frame.send(...)`, page-level DOM reads →
`frame.probeFrame(...)`, page-level waits → Node-side `frame.waitForMessage(...)`). None weakened,
none deleted.

### The RED observation (criterion 6)

The three new transport tests were written and run against the **pre-change** bootstrap and the
then-committed `public/render.js`. Result: `Tests 3 failed | 22 passed (25)`.

```
FAIL  src/render/render.browser.test.ts > transfers a MessagePort with its ready broadcast
AssertionError: expected false to be true // Object.is equality
- Expected  + Received
- true
+ false
 ❯ src/render/render.browser.test.ts:144:37
    144|       expect(await frame.hasPort()).toBe(true);

FAIL  src/render/render.browser.test.ts > renders a document from an init delivered only through the transferred port
Error: page.evaluate: Error: the frame transferred no port with its ready
 ❯ Object.send src/embed-harness.ts:283:12
 ❯ src/render/render.browser.test.ts:157:19

FAIL  src/render/render.browser.test.ts > ignores an init posted at its window instead of the port
AssertionError: expected true to be false // Object.is equality
- Expected  + Received
- false
+ true
 ❯ src/render/render.browser.test.ts:188:80
    188|       expect((await frame.messages()).some((m) => m.requestId === 'for…
```

Read together these are the bug: the old frame transferred **no port at all**, so the app's only
delivery channel did not exist (test 2 could not even send); and the frame *did* act on a wildcard
`window.postMessage` (test 3 saw `forged-1` messages come back), which is the intake path a document
sharing the realm could forge. The 22 legacy tests stayed green throughout, which is precisely why
they could not see any of this: driving the renderer top-level, `parent === window` and no opaque
origin exists.

After the bootstrap change + rebuild, the mirror image: `Tests 21 failed | 4 passed (25)` — the 3
transport tests plus the WebRTC-constructor probe (the one legacy test that uses no messaging)
passed, and every legacy test that posted at the window failed. Migrating those 22 to the harness
brought the file to 26/26.

### Falsifying the closure-scope probe

`keeps its end of the channel off the frame global` cannot go red against the pre-change bundle (no
port existed), so its power was verified directly: `globalThis.__leakedPort = channel.port1` was
added to the bootstrap, the bundle rebuilt, and the test run:

```
AssertionError: expected [ '__leakedPort' ] to deeply equal []
```

The leak was then reverted and the bundle rebuilt (`grep -c __leakedPort public/render.js` → `0`).

## Self-gate

| Command                                                          | Result                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm --filter @hushbox/sandbox test`                            | pass — 17 files, 157 tests, coverage gate green (100% st/br/fn/ln)  |
| `pnpm exec tsx ../../scripts/with-env.ts vitest run src/render/`  | pass — 5 files, 62 tests                                            |
| `npx turbo typecheck lint --filter=@hushbox/sandbox --force`      | pass — 2 successful, 2 total                                        |
| `pnpm exec eslint src/embed-harness.ts src/render/bootstrap.ts src/render/render.browser.test.ts` (from `apps/sandbox`, after the final edit) | exit 0 |
| `pnpm lint:duplication`                                          | pass — 1.02% duplicated lines, threshold 2%                         |

Test counts, per file:

| File                                | Before | After |
| ------------------------------------- | ------ | ----- |
| `src/render/render.browser.test.ts` | 22     | 26    |
| `src/render/build-bundle.test.ts`   | 4      | 4     |
| package total                       | 153    | 157   |

Bundle drift (criterion 8), `--reporter=verbose`:

```
 ✓ src/render/build-bundle.test.ts > renderer bundle > produces a classic-script IIFE (not an ES module) 375ms
 ✓ src/render/build-bundle.test.ts > renderer bundle > keeps the committed public/render.js in sync with the source 352ms
 ✓ src/render/build-bundle.test.ts > renderer bundle > writeRenderBundle rewrites the committed bundle from source 699ms
 ✓ src/render/build-bundle.test.ts > renderer bundle > embeds no backend env-config registry names, values, or markers 351ms
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

Both drift tests compare with `toBe()` against a fresh `buildRenderBundle()` — byte-exact.

## Acceptance criteria

1. **Met.** `startRenderer()` mints the channel, handles inbound on `port1`, and sends
   `parent.postMessage({ type: 'ready' }, '*', [channel.port2])`.
2. **Met.** The `window` message listener is gone. `parseParentToFrameMessage` still validates every
   inbound message, now on the port. Verified in the built bundle (below).
3. **Met.** `post()` — the sole sender for `loading`, `console`, `rendered`, `error`, including
   `settle()` and the deadline path — writes to `embedderPort`. Only `ready` uses
   `parent.postMessage`.
4. **Met.** `src/embed-harness.ts` serves one origin, embeds the frame with the real
   `sandbox="allow-scripts"` attribute, registers the parent listener before the `<iframe>` element,
   captures the transferred port, and exposes send/observe primitives. Excluded from coverage.
5. **Met.** All 22 existing tests pass through the harness with assertions intact.
6. **Met.** See the RED observation above.
7. **Met.** `ignores an init posted at its window instead of the port`.
8. **Met.** `public/render.js` regenerated; both drift tests byte-exact.

### Verification against the built bundle, not the source

Grepping the committed `public/render.js` (540,313 bytes) for every messaging site:

```
addEventListener(  →  4 sites
  'o.port1.addEventListener("message",()='          settleTick's internal scheduler channel
  'globalThis.addEventListener("error",…'           uncaught-error capture
  'globalThis.addEventListener("unhandledrej…'      rejection capture
  '$d=e.port1,e.port1.addEventListener("message",n=>'   the bridge port
postMessage(  →  3 sites
  '…bootstrap did not run");$d.postMessage(e)'      post(), on the module-local port
  'o.port1.start(),o.port2.postMessage(null)'       settleTick's scheduler channel
  'let t={type:"ready"};parent.postMessage(t,"*",[e.port2])'   the one wildcard
tail: '…parent.postMessage(t,"*",[e.port2])}Ig();XS();})();'
```

`Ig()` is `neutralizeWebRtc`, `XS()` is `startRenderer` — the ordering constraint holds in the
shipped artifact. No `window`/`globalThis` `message` listener survives. The port lives in `$d`, a
variable inside the `(()=>{…})()` IIFE, and the runtime probe
(`Object.getOwnPropertyNames(globalThis).filter(k => globalThis[k] instanceof MessagePort)`) run
inside the real frame returns `[]` — with the falsification above proving that probe is not vacuous.

## Interfaces produced — shared embed harness

Exported surface of `apps/sandbox/src/embed-harness.ts`, verbatim:

```ts
export interface BridgeLike {
  readonly type?: string;
  readonly requestId?: string;
  readonly stream?: string;
  readonly text?: string;
  readonly phase?: string;
  readonly code?: string;
  readonly message?: string;
  readonly outputs?: readonly { type?: string; data?: string }[];
}

export type ExtraRoute = (
  pathname: string,
  origin: string
) => { readonly contentType: string; readonly body: string } | undefined;

export interface SandboxOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startSandboxOrigin(extraRoute?: ExtraRoute): Promise<SandboxOrigin>;

export function launchBrowser(): Promise<Browser>;

export interface EmbedOptions {
  readonly framePath: string;
  readonly beforeLoad?: ((page: Page) => Promise<void>) | undefined;
  readonly readyTimeoutMs?: number;
}

export interface EmbeddedFrame {
  readonly pageErrors: string[];
  readonly page: Page;
  send(message: unknown): Promise<void>;
  postToFrameWindow(message: unknown): Promise<void>;
  hasPort(): Promise<boolean>;
  messages(): Promise<BridgeLike[]>;
  waitForMessage(
    predicate: (message: BridgeLike) => boolean,
    timeoutMs?: number
  ): Promise<BridgeLike[]>;
  probeFrame<T>(pageFunction: () => T): Promise<T>;
  close(): Promise<void>;
}

export async function openEmbeddedFrame(
  browser: Browser,
  origin: string,
  options: EmbedOptions
): Promise<EmbeddedFrame>;
```

Notes for T2:

- Nothing is render-specific. `framePath` selects the page; `/python.html` works unchanged.
- `startSandboxOrigin()` serves the committed `public/` tree with the production `SANDBOX_CSP` and
  wildcard CORS — the same two properties `python/browser-harness.ts` provides today, so
  `startPythonSandbox` can delegate to it. Its `extraRoute` hook covers synthetic routes
  (`/config.js`, module stubs); the PyPI fixtures stay on `page.route` via `beforeLoad`.
- The origin is `http://localhost:<ephemeral>`, **not** `127.0.0.1`. This is required, not cosmetic:
  the sandbox CSP's `frame-ancestors` admits `http://localhost:*` and nothing else on loopback, so a
  `127.0.0.1` embedder is refused by the very policy the tests exist to run under. (The server binds
  `127.0.0.1`; only the URL uses the `localhost` name.)
- Every wait polls from Node rather than `page.waitForFunction`, so a test that mocks the page clock
  (`page.clock.install()` via `beforeLoad`) does not deadlock. T2's mocked-clock `timed_out` test
  needs this.
- `probeFrame` evaluates inside the *frame's* realm. The embedder cannot reach the frame's document
  (opaque origin), so every DOM/global assertion must go through it, not `page.evaluate`.
- `postToFrameWindow` exists only so a test can prove the frame ignores the forgery path. No product
  code may take it.

## Deviations

1. **Edited `apps/sandbox/vitest.config.ts`, which is not on the task's file-ownership list.**
   Criterion 4 requires the harness be "excluded from coverage the way `python/browser-harness.ts`
   already is", and that exclusion list lives only in `vitest.config.ts`. The edit is one added line
   plus a comment word-change. T2's ownership does not include this file, so there is no conflict.
2. **The bridge port uses `addEventListener` + explicit `start()`, not `onmessage`.** The repo's
   `unicorn/prefer-add-event-listener` rule rejects `onmessage`. Functionally identical here because
   `start()` is called in the same turn, before `port2` is transferred.

## Concerns and limitations

1. **Transient duplication with `python/browser-harness.ts`.** jscpd reports four clone pairs
   between `embed-harness.ts` and `python/browser-harness.ts` (`BridgeLike`, the static server body,
   `launchBrowser`). Repo-wide duplication is 1.02% against a 2% threshold, so the gate passes, but
   this is a real "One Implementation, Shared" violation that only T2 can resolve — it owns
   `browser-harness.ts` and is required to route python through this harness. If T2 does not
   delegate, the duplication is permanent and should be treated as a defect.
2. **`'self'` in the sandbox CSP does match the frame's URL origin in Chromium**, despite the frame's
   origin being opaque. This was an open risk before running: the in-test module stub is served from
   the harness origin and is covered only by `script-src 'self'`. The React-imports-an-npm-package
   test passes inside the embedded frame, so Chromium resolves `'self'` from the response URL, not
   the opaque origin. Verified empirically only, and only in Chromium; production does not depend on
   it (esm.sh is listed explicitly).
3. **The embedder page is served without the sandbox CSP**, deliberately: it stands in for the app
   origin, and the sandbox CSP pins `frame-src 'none'`, so a page carrying it could embed nothing.
   Stated so an auditor does not read it as an oversight.
4. **`pageErrors` is exposed but unasserted in these tests.** Several render tests intentionally
   produce uncaught frame errors. Whether Playwright's `page.on('pageerror')` reports sub-frame
   errors was not measured here; T2's python specs assert this stays empty and should confirm it.
5. The renderer page is no longer exercised top-level anywhere. That is the point of the change, but
   it means `render.html` loaded outside an iframe is untested — `parent === window`, so the frame
   would transfer a port to itself and no one would hold it. Not a product path.

## Confidence

**High.** The transport change is small and its RED was observed against the shipped artifact for
the exact reason the bug describes; every constraint (single wildcard, no window listener, closure
scoping, neutralize-first ordering) was verified by grepping the built bundle rather than the
source; all scoped checks are green and the bundle drift tests are byte-exact. The one thing I could
not close inside this task's ownership is the harness duplication T2 must collapse.
