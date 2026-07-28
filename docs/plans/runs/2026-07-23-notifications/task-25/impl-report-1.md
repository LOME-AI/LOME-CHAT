# Task 25 — impl report 1

## Objective

Make smuggled content unrepresentable in `PushMessage`: replace the free-form `title`/`body`
strings and the untyped `data` record with the shared generic payload, and have every
transport derive its copy from the category through `NOTIFICATION_COPY` — the same lookup the
service worker already performs. The generic-payload law stops depending on one caller being
correct and starts depending on there being no parameter to smuggle through.

## The type, before and after

**Before** (`ports/push-sender.ts`):

```ts
export interface PushMessage {
  readonly recipients: readonly PushRecipient[];
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly collapseKey?: string;
}
```

**After:**

```ts
export interface PushMessage {
  readonly recipients: readonly PushRecipient[];
  /**
   * The generic wire payload — a category and the conversation it points at,
   * and nothing else. There is deliberately no title, body, or free-form field
   * on this message: each transport looks the words up in the shared copy table
   * from the category, exactly as the service worker does at display time, so a
   * caller has no parameter through which user-generated text could reach a
   * push service. The generic-payload law holds by construction here, not by
   * every call site remembering it.
   */
  readonly payload: PushEventPayload;
  readonly collapseKey?: string; // doc comment amended, see below
}
```

`PushEventPayload` is the existing `packages/shared` type behind `pushEventPayloadSchema`
(`{ category, conversationId }`). The plan's preferred shape was taken as written — no reason
to split it into sibling fields surfaced.

`collapseKey`'s doc comment lost one clause that the type change falsified. It said "Absent
when the message is not conversation-scoped"; a message with no conversation no longer exists,
so it now reads "Absent only on a message that has not passed through the composite yet — every
production send does, because the composite is the sole construction site." Nothing else in
Task 24's audited comment was touched.

## Files changed

| File | Why |
| --- | --- |
| `ports/push-sender.ts` | The type change itself: `title`/`body`/`data` → `payload` |
| `adapters/push-fcm.ts` | Derives `notification` from `notificationCopyForCategory`; builds `data` from the typed payload; the tag reads `payload.conversationId` |
| `adapters/push-webpush.ts` | Encodes the typed payload; the `safeParse` + `validationError` branch deleted |
| `adapters/push-composite.ts` | Derives the alias from `payload.conversationId`; the no-conversation early return deleted |
| `domain/notify-event.ts` | Stops rendering copy; passes the payload only. Two doc comments corrected — this layer no longer handles text |
| `platform/dev/routes.ts` | The `/dev/push` viewer resolves the words it displays from the category through the same shared table |
| `adapters/push-fcm.test.ts` | Fixture retyped; two tests added (copy per category, anti-smuggling); one deleted (see below) |
| `adapters/push-webpush.test.ts` | Fixture retyped; validation test deleted, decrypt-and-compare anti-smuggling test added |
| `adapters/push-composite.test.ts` | Fixture retyped; one test deleted |
| `adapters/push-mock.test.ts` | Fixture retyped (type-only) |
| `adapters/push-sender-factory.test.ts` | Fixtures retyped (type-only) |
| `adapters/push-fcm-live.integration.test.ts` | Send call retyped (explicit scope grant) |
| `domain/notify-event.test.ts` | Copy assertions removed — they moved down to the FCM adapter |
| `platform/dev/routes.integration.test.ts` | Sends retyped; the conversation-less test replaced (see below) |
| `adapters/push-notify.integration.test.ts` | Reads `message.payload` instead of `message.data` (type-only) |

`adapters/push-mock.ts` and `adapters/push-sender-factory.ts` needed **no** change — both are
pass-throughs over the whole message and were already payload-agnostic.

## Byte-identical proof

Asserted nothing; captured both wires before and after.

A throwaway probe (`wire-parity-probe.test.ts`, added, run twice, then deleted — it is not in
the final tree) drove both real adapters over all three categories with a capturing `fetchImpl`,
and wrote the captured wire to a JSON file. Between the two runs **only the message-construction
helper changed** — from `{recipients, title, body, data, collapseKey}` to
`{recipients, payload, collapseKey}`. Everything else in the probe, including the fixed
conversation id and collapse alias, was identical.

```
$ diff /tmp/wire-before.json /tmp/wire-after.json
IDENTICAL: byte-for-byte, all 6 records
```

**FCM** — the recorded artifact is the exact `JSON.stringify` body string handed to `fetch`, one
per recipient per category (6 bodies). Sample (`message`, first recipient), identical in both files:

```json
{"message":{"token":"tok-a","notification":{"title":"New message","body":"You have a new message."},"data":{"category":"message","conversationId":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"},"android":{"collapse_key":"LP8HoKvhpgV7wlyNkKm5FzNGj9H6Rs3q","notification":{"tag":"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60"}},"apns":{"headers":{"apns-collapse-id":"LP8HoKvhpgV7wlyNkKm5FzNGj9H6Rs3q"}}}}
```

This is a string comparison, so key **order** is proven too, not just key set. The construction
order in the adapter was preserved deliberately for that reason.

**Web Push** — the ciphertext itself cannot be byte-identical and must not be: RFC 8291 mandates
a fresh 16-octet salt and a fresh ephemeral P-256 key per message, so two encryptions of the same
plaintext differ even across two runs of the *same* code. What is comparable is everything the
ciphertext encodes plus every field around it, so the probe decrypted each body with the
independent RFC 8291 receiver in `webpush/__tests__/rfc8291-decryptor.ts` (Task 19's oracle, read
only) and recorded the plaintext. Identical in both files, all three categories:

```json
"webpush:message": {
  "url": "https://push.example/aaa",
  "headerKeys": ["Authorization","Content-Encoding","Content-Type","TTL","Topic"],
  "ttl": "86400",
  "topic": "LP8HoKvhpgV7wlyNkKm5FzNGj9H6Rs3q",
  "contentEncoding": "aes128gcm",
  "encryptedBodyLength": 181,
  "decryptedPlaintext": "{\"category\":\"message\",\"conversationId\":\"018f4e2a-1c3b-7d4e-9f0a-1b2c3d4e5f60\"}"
}
```

`encryptedBodyLength` matching (181 / 187 / 184 for the three categories, both runs) is the
independent check that the plaintext length is unchanged; `decryptedPlaintext` matching as a
string proves the bytes and their order. The `Authorization` header carries a fresh VAPID JWT
(`exp` moves), so only its presence is comparable — it is not derived from the message.

Why the plaintext could not have drifted: it was `JSON.stringify(zodParsed)` where zod emits
schema-declaration order (`category`, `conversationId`); it is now an object literal written in
that same order. Both produce the same string, which the capture confirms empirically rather
than by argument.

## The deleted validation branch, and why it is unreachable

Deleted from `push-webpush.ts`:

```ts
      const parsed = pushEventPayloadSchema.safeParse(message.data);
      if (!parsed.success) {
        return errAsync(
          validationError('web push requires a generic {category, conversationId} payload')
        );
      }
      const payload = new TextEncoder().encode(JSON.stringify(parsed.data));
```

It guarded a shape: that `message.data` — an optional `Record<string, string>` a caller could
omit or fill freely — actually held the two generic fields. `payload` is now a required
`PushEventPayload`, so a caller cannot omit it, cannot give it a non-conforming category, and
cannot leave the conversation id out. Every failure mode the guard could report is now a
compile error. It is unreachable, not merely unlikely: there is no runtime value of type
`PushMessage` for which `safeParse` would have failed on the two declared fields.

**The one residual hole it left, closed structurally instead.** TypeScript's excess-property
check only fires on object literals assigned directly. A caller can write
`const p = { category, conversationId, preview: text }` and pass `p` as `payload` — it satisfies
the interface, extra property and all. So neither adapter serializes the payload object
wholesale; both project the two declared fields by name:

```ts
const data = {
  category: message.payload.category,
  conversationId: message.payload.conversationId,
};
```

Two tests pin this, one per transport, and both were verified RED first: with the projection
temporarily reverted to `JSON.stringify(message.payload)`, the FCM assertion failed with
`"preview":"the actual message text"` present in the request body, and the Web Push assertion
failed with `preview` present in the **decrypted** ciphertext.

## The live-send proof (`push-fcm-live.integration.test.ts`)

The only change is the send call:

```diff
       const result = await sender.send({
         recipients: [{ platform: 'android', userId: crypto.randomUUID(), token: FABRICATED_TOKEN }],
-        title: 'HushBox',
-        body: 'Send-path verification.',
+        payload: { category: 'message', conversationId: crypto.randomUUID() },
       });
```

Its three properties are intact and were checked individually:

1. **Real two-leg call** — `capturingFetch` still wraps the platform `fetch` and delegates to it
   for both legs; `validateOnly: true` is unchanged; `expectOAuthAccepted` and `expectFcmVerdict`
   are untouched, including the `status !== 401` falsifier and the `collectFcmErrorCodes` check
   against Google's real error body.
2. **Clean skip without credentials** — `HAS_CREDENTIALS`, `deriveFcmLiveGate`, and the
   `describe.skipIf(!shouldRun)` gate are untouched; the four gate unit tests still run and pass
   locally (4 passed, 1 skipped, identical to baseline).
3. **Evidence row last** — `recordServiceEvidence` remains the final statement in the test body,
   after every assertion.

What reaches Google changes only in that the body is now *more* like production's: it carries the
fixed `New message` copy and a `data` block instead of the ad-hoc `HushBox` / `Send-path
verification.` strings. `validate_only: true` still keeps it off devices.

## Tests added / deleted

**Added**

| Test | Behavior | Criterion |
| --- | --- | --- |
| `push-fcm.test.ts` — "renders the fixed \<category\> copy from the shared table" (×3, one per category) | The FCM `notification` block equals `NOTIFICATION_COPY[category]` | Every adapter derives copy from the shared table |
| `push-fcm.test.ts` — "sends nothing a payload object smuggles alongside the two generic fields" | An excess property on a structurally-typed payload never reaches the FCM request body | `PushMessage` has no free-form text field |
| `push-webpush.test.ts` — "encrypts the two generic fields and nothing a payload object smuggles alongside them" | Decrypts the real ciphertext and asserts the plaintext is exactly the two fields | Replaces the deleted validation guard, at a stronger level |

**Deleted** — each because the type change made its scenario unrepresentable, not because its
assertion was inconvenient:

| Test | Why it cannot exist |
| --- | --- |
| `push-webpush.test.ts` — "rejects a message missing the generic payload" | The plan mandates deleting the branch it covered |
| `push-fcm.test.ts` — "omits the notification tag when the message carries no conversation id" | `payload.conversationId` is required, so the tag is never absent |
| `push-composite.test.ts` — "omits the collapse key when the message is not conversation-scoped" | Every message is conversation-scoped, so the composite always derives an alias |

**Replaced** — `routes.integration.test.ts` "reports a conversation-less send as having no
category, tag or payload" became "renders the fixed copy the category resolves to, which the
message never carries". Same subject (the viewer's rendering of a send), and the new form pins
something the old one could not: that the viewer's title/body come from the shared table rather
than from the message. A conversation-less send is unrepresentable, so the old scenario could not
be kept.

**Weakened assertion moved, not dropped** — `notify-event.test.ts` asserted the outgoing
`title`/`body` equalled `NOTIFICATION_COPY.runCompletion.*`. The domain no longer produces text,
so those two lines are gone from there; the equivalent assertion now lives in `push-fcm.test.ts`
against the actual FCM request body, where it is strictly stronger (it pins what reaches Google,
not what an internal struct held). Its test name changed from "sends to an eligible member with
per-category copy and generic data" to "sends the generic payload to an eligible member", since
copy is no longer this layer's concern.

## Test counts, per push suite

| Suite | Before | After |
| --- | --- | --- |
| `push-fcm.test.ts` | 25 | 28 |
| `push-webpush.test.ts` | 9 | 9 |
| `push-composite.test.ts` | 7 | 6 |
| `push-mock.test.ts` | 4 | 4 |
| `push-sender-factory.test.ts` | 10 | 10 |
| `notify-event.test.ts` | 10 | 10 |
| `push-fcm-live.integration.test.ts` | 4 passed, 1 skipped | 4 passed, 1 skipped |
| `notify-event.integration` + `push-notify.integration` + `notifications/routes.integration` | 36 | 36 |
| `platform/dev/routes.integration.test.ts` | 68 | 68 (one test replaced by one test) |

Net: 105 → 107 in the seven unit/live suites.

## Grep — no `title:`/`body:` on any `PushMessage` construction

Every non-`dist` file mentioning `PushMessage`, scanned for a `title:` or `body:` property:

```
$ for f in $(grep -rl "PushMessage" apps packages e2e scripts | grep -v node_modules | grep -v /dist/ | grep -v .wrangler); do ... grep -n "^\s*title:\|^\s*body:" "$f"; done
--- apps/api/src/slices/notifications/adapters/push-webpush.test.ts
53:  body: Uint8Array;                       # the capturing-fetch record type
68:      body: init?.body as Uint8Array;     # reading a captured HTTP body
--- apps/api/src/slices/notifications/adapters/push-fcm.ts
98:    body: `grant_type=...`                # the OAuth token-exchange HTTP body
263:          body: JSON.stringify(body),    # the FCM send HTTP body
--- e2e/notifications/push-harness.ts
276:      title: notification.title,         # reading a *displayed* browser notification
277:      body: notification.body,
```

No hit is a `PushMessage` construction. The only place either word is produced anywhere in the
push path is `push-fcm.ts:242`, `notification: { title: copy.title, body: copy.body }`, where
`copy` came from `notificationCopyForCategory` — i.e. from `NOTIFICATION_COPY`.

## Self-gate

| Command | Result |
| --- | --- |
| `npx eslint <all 15 owned files>` (from `apps/api`, after the last edit) | **pass** — `EXIT=0` |
| `npx tsc --noEmit -p tsconfig.json` (from `apps/api`) | **pass** — clean |
| `npx turbo lint typecheck --filter=@hushbox/api --force` | **pass** — `Tasks: 2 successful, 2 total` |
| `pnpm test:api` | **fail** — two failures, both attributed below |
| Whole notifications slice + `/dev/push` + `push-notify` under one vitest run | **458 passed, 1 skipped, 7 failed** — the 7 are `template-html.test.ts` (below) |
| `pnpm test:watch` on each of the 7 push unit/live suites | **pass** — counts in the table above |
| `pnpm test:watch` on the 4 notifications/dev integration suites | **pass** — 36 + 68 |

### Coverage on owned files

`pnpm test:api` never reached threshold evaluation (see the ENOENT below), so coverage was
taken directly over the notifications + dev-routes suites (`--coverage.reporter=json-summary`):

| File | Lines | Branches | Functions |
| --- | --- | --- | --- |
| `ports/push-sender.ts` | 100 | 100 | 100 |
| `adapters/push-fcm.ts` | 100 | 100 | 100 |
| `adapters/push-webpush.ts` | 100 | 100 | 100 |
| `adapters/push-composite.ts` | 100 | 100 | 100 |
| `adapters/push-mock.ts` | 100 | 100 | 100 |
| `adapters/push-sender-factory.ts` | 100 | 100 | 100 |
| `domain/notify-event.ts` | 100 | 100 | 100 |
| `platform/dev/routes.ts` | 98.6 | 94.1 | 99.0 |

`platform/dev/routes.ts`'s only uncovered lines in that run are **378–379**, nowhere near the
`/dev/push` handler I edited (~740–765), and this file is also exercised by every suite that
boots the app — so a subset run understates it. My edit removed two `??` branches and added
none.

### Failures in `pnpm test:api`, both out of my ownership

1. **`domain/templates/template-html.test.ts` — 7 failed.** Email-template HTML snapshot
   mismatches (`welcome`, `password-changed`, `two-factor-*`, `account-locked`,
   `account-deleted`, `chargeback-lock`), plus 9 obsolete snapshots. This is the known-red the
   brief names (founder's commit `a0a0f4c6`). Evidence it is not mine: the file and its
   snapshot are clean in `git status` (I changed nothing under `domain/templates/`), the
   failures are email copy with no push code in the path, and they reproduce when that file is
   run alone.
2. **`Error: ENOENT … apps/api/coverage/.tmp/coverage-462.json`** at
   `V8CoverageProvider.readCoverageFiles`. This aborts the run during coverage aggregation —
   which is why the log shows many suites as "(0 test)": they were killed mid-flight, not
   failing. It is the documented Vitest coverage-tmp defect, unrelated to any file here, and it
   is what prevented the per-file gate from being evaluated.

A third red appeared and then disappeared during the session: `@hushbox/api#lint` failed once on
a `prettier/prettier` error in `src/slices/workflows/engine/interpreter.ts` — a workflows-slice
file I never opened, whose mtime (18:25) is thirteen minutes after my last edit (18:12), i.e.
another agent editing this checkout concurrently. A re-run minutes later was green (`2
successful, 2 total`), so it fixed itself on their side. Recorded for honesty, not action.

## Acceptance criteria

| Criterion | Verdict | Evidence |
| --- | --- | --- |
| `PushMessage` has no free-form text field; grep proves no `title:`/`body:` on any construction outside `NOTIFICATION_COPY` | **met** | Type quoted above; grep output above |
| Every adapter derives copy from the shared table; copy exists in exactly one place | **met** | `push-fcm.ts` calls `notificationCopyForCategory`; `push-webpush.ts` sends no text at all (the SW derives); the `/dev/push` viewer resolves from the same function. `NOTIFICATION_COPY` is the only definition |
| `push-webpush.ts`'s now-unreachable payload validation deleted, not left in place | **met** | Branch quoted above; import of `pushEventPayloadSchema`/`validationError` removed |
| Behavior byte-identical on the wire — proven, not asserted | **met** | `diff` of a before/after capture over all 3 categories, both transports: identical. FCM compared as the literal request-body string; Web Push compared as decrypted plaintext + headers + body length, the ciphertext being non-deterministic by RFC 8291 design |
| Existing tests updated only where the type change forces it; no assertion's meaning changed | **met, with disclosure** | Three tests deleted and one replaced because their scenarios became unrepresentable; one assertion pair moved from the domain to the adapter. Detailed above — no assertion was weakened to pass |
| `pnpm test:api` push suites green; `/dev/push` viewer still renders | **met** | All 11 push/notifications suites green individually and together (458 passed in one run); the viewer's own integration tests (4) pass and now assert the rendered copy. `pnpm test:api` as a whole is red on two pre-existing, non-push failures documented above |

## Deviations

- **Three tests deleted and one replaced.** The brief's NEEDS_CONTEXT trigger is a test whose
  *intent* must change. My reading is that these are the type change forcing itself: making the
  payload required removes the "no conversation" branch from the composite, the FCM tag, and the
  dev viewer simultaneously, and a test cannot pin a branch that no longer compiles. No surviving
  assertion changed meaning, and nothing was weakened. Flagging it because it is a judgment call
  at the edge of that trigger, and because it lowers `push-composite`'s count by one.
- **Two tests added beyond the literal criteria** (the anti-smuggling pair). They cover the one
  hole the deleted `safeParse` would still have left — structural typing admitting excess
  properties — which is the difference between "unrepresentable" and "unrepresentable in an
  object literal". Both were verified RED against the unprojected implementation.

## Concerns and limitations

- **Unchanged, and worth restating:** this closes server-side smuggling of *rendered text*. It
  does not change what metadata reaches Google. `data.conversationId` and the raw Android
  notification `tag` still carry the raw id, deliberately, and the FCM adapter's comment still
  carries that reasoning.
- `pushEventPayloadSchema` now has no runtime caller inside `apps/api` (the service worker still
  parses with it, which is where an untrusted boundary actually is). It is still the source of
  `PushEventPayload`, so it is not dead — but a `knip`-style unused check reasoning only about
  value imports could notice the change.
- The `/dev/push` viewer's `tag` field is still `collapseKey ?? null`. The composite always
  stamps it, so in practice it is never null; the `?? null` remains because `collapseKey` is
  still optional on the type, and removing the optionality was not in scope.

## Confidence

**high** — the wire claim is an empirical diff of captured payloads, not an argument; both
anti-smuggling tests were watched fail against a deliberately unprojected implementation before
being made to pass; and the full type-error list from `tsc` was used to enumerate consumers
rather than grep, so no call site was missed.
