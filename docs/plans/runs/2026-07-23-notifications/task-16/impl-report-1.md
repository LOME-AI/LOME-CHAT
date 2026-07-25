# Task 16 — Read-cursor client write + sound toggle — impl report 1

## Objective

(a) Advance `lastReadSeq` from the client so dismiss-on-read-elsewhere stops being inert
end to end; (b) expose the opt-in arrival chime in the Notifications settings card,
through the store's existing `setSoundEnabled` (which performs the autoplay unlock).

## Files changed

| File                                                       | Why                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web/src/hooks/notifications/use-read-cursor.ts` (new) | `useAdvanceReadCursor(conversationId)` — the one client writer of the read cursor        |
| `apps/web/src/hooks/notifications/use-read-cursor.test.tsx` (new) | 10 tests: the write, its guards, its failure arm, and the dismissal it makes live |
| `apps/web/src/components/chat/page/authenticated-chat-page.tsx` | Calls the hook beside the clear-on-view hook — the conversation-on-screen seam      |
| `apps/web/src/components/chat/page/authenticated-chat-page.test.tsx` | One wiring test + the hook mock it needs                                     |
| `apps/web/src/components/settings/notifications-card.tsx`  | `SoundSetting` — an "On this device" fieldset with the Sound switch                     |
| `apps/web/src/components/settings/notifications-card.test.tsx` | 6 sound tests + a mock of the sound module (no Web Audio in the test DOM)           |

### The seam chosen for the cursor write

`AuthenticatedChatPage` already holds the "this conversation is on screen" fact and
already mounts `useClearConversationNotifications(conversationId)` there; the new hook
sits on the next line. No new realtime surface, no polling loop, no new query: the
sequence comes from the conversation list (`nextSequence - 1`), which is the same list
`useClearReadElsewhere` reads `lastReadSeq` back from — so both halves of the feature
agree on what "fully read" means (`isFullyRead` compares against `nextSequence - 1` too).

Anti-spam, three layers:

1. The effect depends on the two **numbers**, not on the list object, so a refetch that
   returns identical data — or any re-render — re-runs nothing.
2. A conversation whose recorded cursor already covers the newest message is never
   written (`newestSeq <= recordedSeq` returns). This is also what stops the
   invalidate → refetch → effect cycle after a successful write.
3. Nothing else calls the route.

Best-effort (G2): the write goes through `mutate` (never `mutateAsync`), so a rejection
is contained by the mutation and never reaches the view; the failure arm is pinned by a
test. Retries are the app-wide `shouldRetryMutation` policy (network/no-response only) —
safe here because the server write is `GREATEST(lastReadSeq, $new)`.

### The sound toggle

`SoundSetting` reads `soundEnabled` and calls `setSoundEnabled` straight from
`useNotificationActivityStore`. The unlock (`primeNotificationSound`) is **not**
re-implemented — it stays inside the store's setter, which is what makes the switch click
itself the autoplay-lifting gesture. The row renders outside the preferences query body
(it is a device setting, not account state, so it must not disappear while the account
prefs load or fail, and must not be disabled by an unrelated pending PUT). Default is
off — the store's own default; this task adds no new default.

## Tests added

`use-read-cursor.test.tsx` (10):

- `acknowledges the newest message of the conversation being read` — PATCH carries
  `{ param: { conversationId }, json: { lastReadSeq: 4 } }` for `nextSequence: 5`.
- `acknowledges once while the conversation stays open` — three extra renders, **one**
  call. (Not-per-frame proof, by call count.)
- `stops acknowledging once the refreshed list echoes the cursor back` — the post-write
  refetch does not re-trigger the write (loop proof, by call count).
- `acknowledges again once a newer message arrives` — `nextSequence: 9` → a second call
  with `8`.
- `leaves an already acknowledged conversation alone` — recorded cursor at the tip, no call.
- `acknowledges nothing while no conversation is open`.
- `acknowledges nothing for a conversation the reader has no membership of` — absent from
  the list ⇒ no write (this is also the link-guest arm: the list query is session-gated).
- `refreshes read state once the cursor has advanced` — invalidates `chatKeys.conversations()`.
- `never surfaces a failed acknowledgement` — a rejecting write neither throws out of the
  render nor invalidates.
- `stops a conversation notifying once reading it has advanced the cursor` — the live
  demonstration, below.

Every negative assertion runs after an `act`-wrapped macrotask flush (`settle()`), so it
cannot pass merely because the write had not landed yet.

`authenticated-chat-page.test.tsx` (1): `acknowledges the reader for the conversation on
screen` — the page hands `'conv-456'` to the hook.

`notifications-card.test.tsx` (6): `leaves the chime off until it is asked for`;
`turns the chime on` (store state **and** the rendered switch); `unlocks audio as the
chime goes on` (`primeNotificationSound` once — the store path); `turns the chime back
off` (and no unlock on the way down); `keeps the chime switch usable from the keyboard`
(focus + Space); `offers the chime while account settings are still loading`.

### The read-elsewhere demonstration (evidence item)

`dismissal on read elsewhere › stops a conversation notifying once reading it has advanced
the cursor` renders `useAdvanceReadCursor` **and** the real `useClearReadElsewhere`
together. Before the write, `clearDelivered` is not called (the conversation is not fully
read). The write fires with the acknowledged sequence; the refreshed list then carries
`lastReadSeq: 4`, and the real clearing hook dismisses that conversation's delivered
notifications. Both hooks are the real modules; what the test stands in for is the
network hop (`fetchJson` and the list query are mocked, per this suite's established
idiom) — so the linkage proven is cursor-write → refreshed read state → dismissal, not
the server's own `GREATEST` (which Task 05 pins over real Postgres).

## TDD record

- `use-read-cursor.test.tsx` was written first and failed on module resolution
  (`Failed to resolve import "@/hooks/notifications/use-read-cursor"`), then passed.
- **Mutation check on the guard**: weakening `newestSeq <= recordedSeq` to `<` failed
  exactly two tests (`leaves an already acknowledged conversation alone`, `stops
  acknowledging once the refreshed list echoes the cursor back`) and nothing else;
  reverted from a byte-for-byte backup. An earlier version of those two tests did *not*
  fail under that mutation — they asserted synchronously, before the write could land.
  That is why `settle()` exists; the mutation check was re-run after adding it.
- The page wiring test failed first with `expected "vi.fn()" to be called with arguments:
  [ 'conv-456' ] / Number of calls: 0`.
- The six card tests failed first with `Unable to find role="switch" and name "Sound"`.
- **Mutation check on the toggle**: replacing `onCheckedChange={setSoundEnabled}` with a
  direct `useNotificationActivityStore.setState({ soundEnabled: checked })` failed exactly
  one test — `unlocks audio as the chime goes on` — proving that test pins the
  One-Implementation requirement (the unlock must go through the store's setter).
  Reverted from backup.

## Self-gate

All three gates were re-run after the last edit (and re-verified a second time later, with
exit codes captured rather than inferred from a pipe):

| Command                                                            | Result |
| ------------------------------------------------------------------ | ------ |
| `npx turbo lint --filter=@hushbox/web --force`, after the last edit | **pass — exit 0** (`Tasks: 1 successful`; ran `eslint .` from `apps/web`, so Prettier-as-lint is covered package-wide) |
| `npx turbo typecheck --filter=@hushbox/web --force`                 | **pass — exit 0** (`Tasks: 1 successful`) |
| `npx turbo test --filter=@hushbox/web --force` (full suite + per-file coverage gate) | **393/393 test files pass**; one coverage ERROR, on another workstream's file — attributed below |
| isolated coverage, owned files                                      | **100 / 100 / 100 / 100** on both `use-read-cursor.ts` and `notifications-card.tsx` |

Owned-file coverage rows straight out of the full-suite table (not an isolated run):

```
...ead-cursor.ts  |  100 |  100 |  100 |  100 |
...ions-card.tsx  |  100 |  100 |  100 |  100 |
...n-clearing.ts  |  100 |  100 |  100 |  100 |
```

Isolated confirmation (run from `apps/web` once no other vitest process was on the box):

```
npx tsx ../../scripts/with-env.ts npx vitest run --coverage \
  --coverage.reporter=json-summary \
  --coverage.include='src/hooks/notifications/use-read-cursor.ts' \
  --coverage.include='src/components/settings/notifications-card.tsx' \
  src/hooks/notifications/use-read-cursor.test.tsx \
  src/components/settings/notifications-card.test.tsx

src/components/settings/notifications-card.tsx  {statements:100, branches:100, functions:100, lines:100}
src/hooks/notifications/use-read-cursor.ts      {statements:100, branches:100, functions:100, lines:100}
```

### Attributed reds (all other workstreams — nothing of theirs was touched)

1. **`markdown-renderer.tsx` branches 75%** — the single coverage ERROR in the final full
   run. Not mine: `git status` on this task's paths lists only the six files above, and
   nothing of mine imports it. Its **test** file was rewritten at 22:39 by a concurrent
   agent (source file untouched since 18:18). Re-measured in isolation as the caveat
   requires: `markdown-renderer.tsx` → statements 96.87, **branches 100**, functions 100,
   lines 96.55 — it passes the gate on its own, so the merged full-suite number reflects
   another workstream's in-flight state, not a real regression, and certainly not this
   task's.
2. **`payment-modal.test.tsx` — 7 failures, one earlier run only.** Cause was
   `Error: VITE_HELCIM_JS_TOKEN is not configured`: a concurrent agent regenerated
   `.env.development` at 22:52, inside that run's 22:46→22:55 window. Re-run afterwards
   alongside all three of this task's suites: **4 files / 148 tests pass, exit 0**. The
   subsequent full run reproduced no such failure (393/393 files pass). Env churn during
   a run was confirmed again by md5-summing `.env.development` before and after the final
   run — it changed mid-run.
3. **Coverage `.tmp` collision (earlier run).** One run failed the gate with 60 ERROR
   lines across 18 files, none of them mine, while all 393 files / 6407 tests passed;
   `ps` during that run showed a second `vitest run --coverage --maxWorkers=24` started by
   another agent six seconds earlier. The documented collision — no file of any workstream
   was modified in response.

## Acceptance criteria (checked literally)

1. **"Viewing a conversation advances `lastReadSeq` via the typed client; tested
   (including that it does not fire redundantly on every frame/render)."** — **met**.
   The page seam is pinned by `acknowledges the reader for the conversation on screen`;
   the write itself by `acknowledges the newest message of the conversation being read`
   (typed client — `client.conversations[':conversationId'].read.$patch`, which typechecks
   against the real route); the redundancy bound by two call-count tests
   (`acknowledges once while the conversation stays open`, `stops acknowledging once the
   refreshed list echoes the cursor back`).
2. **"Foreground read-elsewhere clearing now has live data — demonstrate the cursor
   advances in a test rather than asserting the route in isolation."** — **met**, with the
   scope stated above: the demonstration runs the real `useAdvanceReadCursor` and the real
   `useClearReadElsewhere` in one render and ends in `clearDelivered([conversationId])`;
   the network hop is mocked, the two hooks are not.
3. **"Sound toggle renders in the Notifications card, round-trips, and enabling it unlocks
   audio via the store's existing path (do not duplicate that logic — G3)."** — **met**.
   Renders (`leaves the chime off until it is asked for`), round-trips both ways
   (`turns the chime on` / `turns the chime back off`, asserting store state *and* the
   rendered switch), unlocks through the store (`unlocks audio as the chime goes on`, with
   the mutation check above proving the assertion bites). The card contains no audio code:
   its only sound import is `useNotificationActivityStore`.
4. **"Accessibility per G8; G11 no plan/task-ID labels; owned-file coverage ≥95%."** —
   **met**. The switch reuses the card's `SwitchRow` (`Label htmlFor` + `aria-labelledby` +
   `aria-describedby`), sits in a `fieldset`/`legend` group ("On this device"), is keyboard
   operable (Space, pinned by test), uses Tailwind tokens only — no inline styles. Sound is
   opt-in, default off, and never the sole signal (the badge and the `aria-live` announcer
   already carry the same event). No run/task identifiers appear in any changed file
   (`grep -nE "T[0-9]{2}|G[0-9]{1,2}\b|task-[0-9]|spike"` over the six files is clean of
   such labels). Coverage: 100% on both owned files.

## Deviations, with reasons

1. **The acknowledged sequence comes from the conversation list, not from the rendered
   message array.** The display `Message` type carries no `sequenceNumber` (it is dropped
   in the decrypt bridge), so the list's `nextSequence` is the only sequence the client
   holds — and it is the same number the dismissal path compares against, which keeps one
   definition of "fully read" instead of two.
2. **The write is not gated on the tab being focused.** `isAwayFromApp()` was considered
   and rejected: the conversation list is only refreshed on foreground return, after the
   reader's own sends, and on membership changes — so a backgrounded tab has no fresh
   `nextSequence` to acknowledge in the first place, and adding a focus listener would buy
   nothing but code. If the list ever starts refreshing on every incoming message, this
   decision needs revisiting (a hidden tab would then acknowledge unseen messages).
3. **`onSuccess` invalidates the conversation list** rather than patching the cache. It
   matches the `useMuteConversation` / `usePinConversation` idiom in this repo, and it is
   what makes the refreshed cursor real rather than assumed. The cost is one list refetch
   per advance; the guard in the hook means it cannot cycle.
4. **The page-level wiring test mocks the hook** rather than running it. That suite mocks
   `@tanstack/react-query` down to `useQueryClient` and mocks `@/hooks/chat/chat`, so the
   real hook cannot run there; the fact worth pinning at that level is which conversation
   the page hands over, and the hook's own suite covers the rest.
5. **The sound row renders outside the preferences body.** It is device state, so it stays
   visible (and enabled) while the account query is loading or has failed — pinned by
   `offers the chime while account settings are still loading`.

## Concerns and limitations

- **Cross-device dismissal is eventual, and the delay is the list's refresh cadence.**
  Reading a conversation acknowledges the tip the list knew about; messages that arrive
  while the reader sits in the conversation are acknowledged on the next list refresh
  (their own send, a foreground return, or a membership change), not the instant they
  render. That matches the "no push-to-dismiss" design, but it is not instantaneous.
- **A failed write is not retried within the same view.** The app's mutation retry covers
  network failures only; a 4xx (e.g. membership revoked mid-view) leaves the cursor where
  it was until a newer message arrives. Best-effort by design (G2), stated here because it
  means a single unlucky write can leave one device's notification standing.
- **The chime is unverifiable in the test DOM.** As in the store's own suite, the tests pin
  the call into `primeNotificationSound`, not the browser's autoplay decision.
- **The card now mixes account state with one device setting.** The "On this device"
  legend is the only thing distinguishing them; if more device-local settings appear, that
  section is where they belong.

## Confidence

**High.** Both halves are pinned by tests that were seen failing first and by targeted
mutation checks that proved the key assertions bite; package-wide lint, typecheck, and the
full web suite are green after the last edit, and both owned files measure 100% coverage in
isolation. The one judgement call worth an auditor's eye is deviation 2 (no focus gate),
which is stated with the condition that would invalidate it.
