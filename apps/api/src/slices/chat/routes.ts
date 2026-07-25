import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ChatHistoryMessage,
  ERROR_CODES,
  MAX_SELECTED_MODELS,
  ReasoningEffortSelection,
  SMART_MODEL_ID,
  buildTurnSystemPrompt,
  historyCharacterCount,
  imageConfigSchema,
  promptCharacterCount,
  resolveFundingDecision,
  userOnlyMessageSchema,
  videoConfigSchema,
} from '@hushbox/shared';
import { defineSliceManifest, routeClass } from '../../middleware/pipeline-manifest.js';
import { rateLimitByUser } from '../../middleware/rate-limit.js';
import {
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TURN_INPUT,
  LINK_CREDENTIAL_HEADER,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  TRIAL_TURN_HOOKS,
  buildMediaTurnDefinition,
  buildAutoEffortTurnDefinition,
  buildMultiModelTurnDefinition,
  buildSmartModelTurnDefinition,
  broadcastUserMessageNew,
  buildTrialSmartModelTurnDefinition,
  buildTurnDefinition,
  callerUserId,
  canRegenerate,
  consumeChatStreamUserLimit,
  consumeTrialQuota,
  createErrorResponse,
  domainWireCode,
  findAdminDisabledModel,
  findTierLockedModel,
  hashCanonicalJson,
  hashIp,
  idempotencyExempt,
  idempotent,
  listDescriptors,
  mockProviderEnabled,
  parseMockDirectives,
  readIdempotencyKey,
  resolveCallerMember,
  resolveConversationCaller,
  resolveTrialSessionPrincipal,
  resolveTurnContext,
  runMutation,
  saveUserOnlyMessage,
  trialEligibility,
  trialMessageBillableNanoUsd,
  trialReasoningSelection,
} from './domain/index.js';
import type { Context, Env } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type {
  EnvContext,
  ErrorCode,
  MockDirectives,
  ModelDescriptor,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  ChatRouteDeps,
  DomainError,
  DomainErrorCode,
  FundingDecisionInputs,
  RegenerateDecision,
  TurnBudget,
  TurnSender,
} from './domain/index.js';

const STATUS_BY_DOMAIN_CODE = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  timeout: 408,
  unavailable: 503,
} as const satisfies Record<DomainErrorCode, ContentfulStatusCode>;

export const startTurnBodySchema = z
  .object({
    conversationId: z.string().min(1),
    model: z.string().min(1),
    // The output modality of the turn. `text` (the default) is the model+multi-
    // model chat turn; `image`/`video` is a single-model media generation whose
    // `modelCall` produces that modality and carries the config below as params.
    modality: z.enum(['text', 'image', 'video']).default('text'),
    // The multi-model fan-out: an ordered list of models the one prompt is sent
    // to, each producing its own answer as a sibling message. Absent (or a single
    // model) is the single-model turn; two or more selects the fan-out. `model`
    // stays required for the single-model case and single-model clients. Capped at
    // MAX_SELECTED_MODELS (symmetric with /regenerate) — the fan-out width bound.
    models: z.array(z.string().min(1)).min(2).max(MAX_SELECTED_MODELS).optional(),
    // The branch this turn extends. Absent for a linear send; when present the
    // turn chains onto the fork's tip and advances it at settlement.
    forkId: z.uuid().optional(),
    // Opt into server-side web search on the answer: the turn's modelCall carries
    // the web-search tool loop. Requires a tool-capable model (refused at build
    // otherwise). Absent/false is a plain turn.
    webSearchEnabled: z.boolean().optional(),
    // Reasoning effort for a TEXT turn: a canonical ladder label, `auto` (the
    // server picks), or `none` (the explicit hard-off wire). Resolved against
    // the model through the shared reasoning plan at build — an unoffered
    // label, a non-reasoning model, or `none` on a mandatory-reasoning model
    // refuses with 400, never a silent downgrade. Absent = today's turn,
    // unchanged.
    reasoningEffort: ReasoningEffortSelection.optional(),
    // Generation config for a media turn (reused from the conversations schema,
    // with its refinements). `image` may omit it (aspectRatio defaults); `video`
    // must supply it (see the refinement below).
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    // The initiator's message: a client-supplied id (persisted as the turn's user
    // message, idempotent across a re-executed run) and its content (the prompt).
    userMessage: z.object({
      id: z.uuid(),
      content: z.string().min(1),
    }),
    // Prior turns, resent by the client every send (E2E crypto: the server
    // cannot reconstruct them). Deliberately unbounded — no count or length cap.
    history: z.array(ChatHistoryMessage).optional(),
    // The user's custom instructions, decrypted client-side and resent each turn
    // (stored E2E-encrypted, like history) so they reach the model as plaintext.
    // Folded into the base system prompt; bounded to match InferenceRequest.
    customInstructions: z.string().max(5000).optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  });

export const regenerateTurnBodySchema = z
  .object({
    conversationId: z.string().min(1),
    model: z.string().min(1),
    // The regenerated turn's output modality, symmetric with `/chat`: `text`
    // (the default, so existing clients are unchanged) re-runs the text turn;
    // `image`/`video` re-runs a single-model or fan-out media generation over
    // the same anchor (the per-tile media retry). Audio is deferred.
    modality: z.enum(['text', 'image', 'video']).default('text'),
    // The re-run's model list (legacy regenerate shape): a one-element array is
    // a single-model regenerate, two or more fans out. Deliberately asymmetric
    // with the send schema's `.min(2)` — a send rides a single model on the
    // `model` anchor and reserves `models` for fan-out, whereas a regenerate
    // carries its per-tile list explicitly, so the lower bound is one. Absent
    // falls back to the `model` anchor (the Smart Model sentinel, which the
    // handler forbids a `models` list alongside).
    models: z.array(z.string().min(1)).min(1).max(MAX_SELECTED_MODELS).optional(),
    // The anchor USER message this turn re-runs. `action` keeps it (`retry`,
    // swapping the reply) or replaces it (`edit`); `replaceAssistantId` (retry
    // only) deletes just that reply instead of every reply below the anchor.
    targetMessageId: z.uuid(),
    action: z.enum(['retry', 'edit']),
    replaceAssistantId: z.uuid().optional(),
    // The branch the target lives on; absent for a linear conversation.
    forkId: z.uuid().optional(),
    // Opt into server-side web search on the answer: the turn's modelCall carries
    // the web-search tool loop. Requires a tool-capable model (refused at build
    // otherwise). Absent/false is a plain turn. Symmetric with `/chat` so a
    // regenerated search-backed answer can stay a search answer.
    webSearchEnabled: z.boolean().optional(),
    // Reasoning effort for a TEXT regenerate, symmetric with `/chat` (the same
    // resolver validates it): a canonical ladder label, `auto`, or `none`.
    // Refused (400) exactly like a send — never silently downgraded. Absent
    // hashes the pre-feature shape, so an old client's retry never 409s.
    reasoningEffort: ReasoningEffortSelection.optional(),
    // Generation config for a media regenerate (the same shared schemas the
    // send path validates with). `image` may omit it (aspectRatio defaults);
    // `video` must supply it (see the refinement below, mirroring `/chat`).
    imageConfig: imageConfigSchema.optional(),
    videoConfig: videoConfigSchema.optional(),
    // The turn's user message: for `edit`, the replacement (a fresh id + the
    // edited content); for `retry`, the re-sent prompt (content feeds inference).
    userMessage: z.object({
      id: z.uuid(),
      content: z.string().min(1),
    }),
    // Prior turns up to the anchor, resent by the client exactly like a send.
    history: z.array(ChatHistoryMessage).optional(),
    // The user's custom instructions, decrypted client-side and resent each turn;
    // folded into the base system prompt. Bounded to match InferenceRequest.
    customInstructions: z.string().max(5000).optional(),
  })
  .refine((data) => data.modality !== 'video' || data.videoConfig !== undefined, {
    message: 'videoConfig is required when modality is "video"',
    path: ['videoConfig'],
  });

export const stopTurnBodySchema = z.object({
  conversationId: z.string().min(1),
});

const conversationIdParameterSchema = z.object({ conversationId: z.uuid() });

/** The dev-only held-stream release query: the room whose parked stream to free. */
const releaseStreamQuerySchema = z.object({ conversationId: z.string().min(1) });

/** The ConversationRoom DO's `{ released }` reply to the internal release fetch. */
const releaseStreamResponseSchema = z.object({ released: z.boolean() });

/**
 * A minimal structural view of the ConversationRoom DO namespace, declared
 * locally (the `realtime-do.ts` pattern) so this dev-only test hook needs no
 * `@cloudflare/workers-types` ambient globals and no cross-slice import. The env
 * widening (`extends EnvContext`) keeps `Bindings` — which does not declare the
 * namespace — assignable despite the otherwise-weak optional shape.
 */
interface ReleaseStreamRoomNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(input: string, init?: RequestInit): Promise<Response> };
}
interface ReleaseStreamRoomEnv extends EnvContext {
  readonly CONVERSATION_ROOM?: ReleaseStreamRoomNamespace;
}

function randomUuid(): string {
  return crypto.randomUUID();
}

export const trialTurnBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  webSearchEnabled: z.boolean().optional(),
  // Reasoning effort for the trial answer. The route accepts only levels
  // whose shared-plan token cost fits the fixed trial ceiling (G9) — others
  // refuse with the trial's over-cap 402.
  reasoningEffort: ReasoningEffortSelection.optional(),
  // Prior trial turns, client-held (trial persists nothing server-side).
  history: z.array(ChatHistoryMessage).optional(),
  // The user's custom instructions, client-held for a trial send; folded into
  // the base system prompt. Bounded to match InferenceRequest.
  customInstructions: z.string().max(5000).optional(),
});

/**
 * Absent and [] must be indistinguishable everywhere downstream — the body
 * hash (a client upgrade must never cause a spurious 409) and the run body.
 */
function normalizedHistory(history: ChatHistoryMessage[] | undefined): ChatHistoryMessage[] {
  return history ?? [];
}

/**
 * The per-request deterministic-inference directives to put on the run-start
 * body, spread so the field is set ONLY in dev/E2E (where `x-mock-*` headers are
 * honored). In production `mockProviderEnabled` is false, so the headers are
 * never read and the field is never set — the mock is unreachable regardless of
 * what a client sends. The runtime additionally re-gates on env mode, so this is
 * the outer of two independent production-inert guards.
 */
function mockDirectivesBody(c: Context<AppEnv>): { mockDirectives?: MockDirectives } {
  return mockProviderEnabled(c.var.envUtils)
    ? { mockDirectives: parseMockDirectives((name) => c.req.header(name)) }
    : {};
}

/**
 * The run-scoped custom-instructions field for a RunStartBody, present only when
 * the client supplied it. Threaded to the executor as run context, deliberately
 * NOT into the definition — the WorkflowDefinition must stay free of user content
 * so it remains safe to log.
 */
function runScopedInstructions(body: { readonly customInstructions?: string | undefined }): {
  customInstructions?: string;
} {
  return body.customInstructions === undefined
    ? {}
    : { customInstructions: body.customInstructions };
}

/**
 * The characters the model will see — the built system prompt (base preamble
 * + optional custom instructions), every resent history turn, and the current
 * prompt — measured through the ONE shared counter the composer preview uses,
 * so admission and preview price the identical prompt. The date line the
 * builder renders is fixed-width, so the count is clock-independent.
 */
function turnPromptCharacterCount(
  body: { readonly customInstructions?: string | undefined },
  prompt: string,
  history: readonly ChatHistoryMessage[]
): number {
  return promptCharacterCount({
    systemPrompt: buildTurnSystemPrompt({ now: new Date(), ...runScopedInstructions(body) }),
    historyCharacters: historyCharacterCount(history),
    prompt,
  });
}

function respondDomainError(c: Context<AppEnv>, error: DomainError): Response {
  return c.json(createErrorResponse(domainWireCode(error)), STATUS_BY_DOMAIN_CODE[error.code]);
}

/**
 * Maps a non-`allowed` regenerate verdict to its rejection response, or null to
 * proceed to admission. `invalid-replace` (the retry-one target is not a real
 * assistant reply of the anchor) shares the 404 with a missing target; both are
 * authorization gates that keep the settlement's delete from touching an
 * arbitrary message. `fork-required` (409) refuses a no-forkId regenerate once
 * the conversation has forks (the linear sequence-delete would cross branches);
 * `blocked` (403) is the cross-member intervening-message refusal.
 */
function regenerateRejection(c: Context<AppEnv>, decision: RegenerateDecision): Response | null {
  switch (decision) {
    case 'target-missing':
    case 'invalid-replace': {
      return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
    }
    case 'fork-required': {
      return c.json(createErrorResponse(ERROR_CODES.FORK_ID_REQUIRED), 409);
    }
    case 'blocked': {
      return c.json(createErrorResponse(ERROR_CODES.REGENERATION_BLOCKED_BY_OTHER_USER), 403);
    }
    case 'allowed': {
      return null;
    }
  }
}

/**
 * The trial send's MODEL/AFFORDABILITY gate — three pre-run refusals that keep
 * the free trial to cheap text models: a non-text (image/video) model, a
 * premium model (top price quartile, recent release, or an unaffordable minimal
 * exchange), and an actual message whose estimated cost exceeds 1¢. Returns the
 * refusal response, or null to proceed. Runs before the quota INCR (a refusal
 * burns no slot) and before the turn compile (so a non-text model gets
 * MEDIA_TRIAL_BLOCKED, not the compile step's generic 400). An unknown model is
 * absent from the exposed catalog (`target === undefined`): the gate is a no-op
 * and the compile step refuses it as an unknown model.
 */
/** The full send being priced: the prompt plus every resent history turn. */
interface TrialSendMessage {
  readonly prompt: string;
  readonly history: readonly ChatHistoryMessage[];
}

function trialGateRejection(
  c: Context<AppEnv>,
  target: ModelDescriptor | undefined,
  exposedCatalog: readonly ModelDescriptor[],
  message: TrialSendMessage
): Response | null {
  if (target === undefined) return null;
  const verdict = trialEligibility(target, exposedCatalog, Date.now());
  if (!verdict.eligible) {
    return verdict.reason === 'non-text'
      ? c.json(createErrorResponse(ERROR_CODES.MEDIA_TRIAL_BLOCKED), 403)
      : c.json(createErrorResponse(ERROR_CODES.PREMIUM_REQUIRES_ACCOUNT), 403);
  }
  // The actual message priced on a minimum basis (history + prompt tokens + a
  // fixed minimum output allocation), BILLABLE (all-in) cost against the 1¢ cap.
  const cost = trialMessageBillableNanoUsd(target, message.prompt, message.history);
  if (cost.isErr()) return respondDomainError(c, cost.error);
  if (cost.value > TRIAL_MESSAGE_COST_CAP_NANO_USD) {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return null;
}

/**
 * The caller's IP for the trial anti-evasion counter. `cf-connecting-ip` is
 * absent off Cloudflare (local dev, tests); the sentinel shares one counter
 * there, which those environments tolerate.
 */
function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? '0.0.0.0';
}

/**
 * Resolves a reserved rate-limit decision to a refusal response, or null to
 * proceed. Redis down fails closed (503 via the typed `unavailable` error);
 * an over-cap reservation answers RATE_LIMITED (429) with its retry window.
 * Used by the per-user paid limiter.
 */
async function rateLimitRejection(
  c: Context<AppEnv>,
  reserve: ReturnType<typeof consumeChatStreamUserLimit>
): Promise<Response | null> {
  const decision = await reserve;
  if (decision.isErr()) return respondDomainError(c, decision.error);
  if (decision.value.allowed) return null;
  return c.json(
    createErrorResponse(ERROR_CODES.RATE_LIMITED, {
      retryAfterSeconds: decision.value.retryAfterSeconds,
    }),
    429
  );
}

/**
 * The paid send's per-user rate limit for the GUEST send path only: the key
 * is the resolved sender principal (linkId for a guest), which needs the DB
 * resolution the handler already did — the edge enforcer cannot derive it.
 * `/chat` and `/chat/regenerate` enforce the same registry entry via the
 * route-mounted `rateLimitByUser` edge middleware instead.
 */
function chatUserRateLimitRejection(c: Context<AppEnv>, userId: string): Promise<Response | null> {
  return rateLimitRejection(c, consumeChatStreamUserLimit(c.var.redis, userId));
}

/**
 * The HTTP status for each typed run-start refusal. Admission refusals are
 * SYNCHRONOUS HTTP answers (founder ruling), not only run-failed WS events;
 * any refusal code outside this map (a pre-admission run failure surfaced
 * through the same channel) answers 409 like the historical conflict classes.
 */
const RUN_REFUSAL_STATUS: Partial<Record<ErrorCode, ContentfulStatusCode>> = {
  [ERROR_CODES.CONCURRENT_RUN]: 409,
  [ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH]: 409,
  [ERROR_CODES.INSUFFICIENT_ADMISSION]: 402,
  [ERROR_CODES.ADMISSION_UNAVAILABLE]: 503,
  [ERROR_CODES.TRIAL_CAPACITY_REACHED]: 429,
};

/** The realtime port's run-start outcome, as this route observes it structurally. */
type RunStartOutcome = Parameters<
  Parameters<ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>['match']>[0]
>[0];

/**
 * The shared run-start outcome→response mapping: a settled/duplicate key
 * replays the persisted response (never a transport error), a still-live run
 * tells the client to rejoin its stream, a refusal maps to its status, and a
 * fresh run answers the plain `{ runId, deadlineAt }` 201. The trial route
 * overrides only the fresh-run 201 (below) to add `trialSessionId`.
 */
function respondNonStarted(c: Context<AppEnv>, outcome: RunStartOutcome) {
  if ('outcome' in outcome) {
    return outcome.outcome === 'replay'
      ? c.json(outcome.response as Record<string, unknown>, 200)
      : c.json({ outcome: 'attach' as const }, 200);
  }
  return outcome.started
    ? c.json({ runId: outcome.runId, deadlineAt: outcome.deadlineAt }, 201)
    : c.json(createErrorResponse(outcome.code), RUN_REFUSAL_STATUS[outcome.code] ?? 409);
}

/**
 * The paid turn routes' run-start response — the shared contract unchanged: a
 * fresh run handle is `{ runId, deadlineAt }`. The return type is inferred so
 * the response shapes still flow into `AppType`.
 */
function respondRunStart(
  c: Context<AppEnv>,
  started: ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>
) {
  return started.match(
    (outcome) => respondNonStarted(c, outcome),
    (error) => respondDomainError(c, error)
  );
}

/**
 * The trial route's run-start response: the fresh-run 201 additionally carries
 * the minted `trialSessionId` so a tokenless client learns its room and can
 * store it as `x-trial-token` — the WS upgrade then resolves the same room and
 * same-key retries replay/attach. Every other outcome matches the paid contract.
 */
function respondTrialRunStart(
  c: Context<AppEnv>,
  started: ReturnType<ReturnType<ChatRouteDeps['realtime']>['startRun']>,
  trialSessionId: string
) {
  return started.match(
    (outcome) =>
      !('outcome' in outcome) && outcome.started
        ? c.json({ runId: outcome.runId, deadlineAt: outcome.deadlineAt, trialSessionId }, 201)
        : respondNonStarted(c, outcome),
    (error) => respondDomainError(c, error)
  );
}

function rejectInvalid(
  result: { readonly success: boolean },
  c: Context<Env, string>
): Response | undefined {
  return result.success ? undefined : c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
}

/** The turn's output modality (text is the chat turn; image/video are media). */
type TurnModality = 'text' | 'image' | 'video';

/** The client-selection fields the premium-tier gate inspects. */
interface TierGateBody {
  readonly model: string;
  readonly modality?: TurnModality | undefined;
  readonly models?: readonly string[] | undefined;
}

/**
 * The models the paid premium-tier gate judges for a send: the single text
 * model, or the multi-model list. A media (image/video) turn and the
 * Smart-Model sentinel are exempt (media is out of scope for the gate;
 * Smart Model derives its candidates from the affordable set already), so both
 * yield null — no tier check.
 */
function gatedTierModels(body: TierGateBody): readonly string[] | null {
  if (body.modality === 'image' || body.modality === 'video') return null;
  if (body.model === SMART_MODEL_ID) return null;
  return body.models ?? [body.model];
}

/**
 * The paid premium-tier gate — the MODEL_TIER_LOCKED refusal (legacy
 * `enforceTierLock`). It gates only the DIRECT-BILLING path: a caller paying
 * from their own wallet (a solo turn, or a group turn that fell through to
 * self-funding). "Can access premium" is the caller's own purchased-wallet
 * balance being positive (founder ruling); an owner-funded group turn — where
 * the payer wallet belongs to the owner, not the caller — is exempt, as are all
 * media / Smart-Model sends. A selected premium model (the same fresh premium
 * legs the trial gate uses) refuses with 403. Returns the refusal response, or
 * null to proceed. The catalog is read only on the rare gated path (a
 * direct-billing caller who cannot access premium), never on the paid hot path.
 */
async function tierGateRejection(
  c: Context<AppEnv>,
  body: TierGateBody,
  fundingInputs: FundingDecisionInputs
): Promise<Response | null> {
  const models = gatedTierModels(body);
  if (models === null) return null;
  // The baseline (model-agnostic) run of the shared core says who pays and
  // whether the caller can access premium. An owner-funded turn (payer 'owner')
  // is exempt, and a caller who can access premium is unlocked — both short out
  // before the catalog is read, keeping it off the paid hot path.
  const baseline = resolveFundingDecision({ ...fundingInputs, isPremiumModel: false });
  if (baseline.payer !== 'self' || baseline.premiumAllowed) return null;
  const catalog = await listDescriptors({ db: c.var.db, telemetry: c.var.logger });
  if (catalog.isErr()) return respondDomainError(c, catalog.error);
  const anyPremium = findTierLockedModel(models, catalog.value, false, Date.now()) !== undefined;
  // The refusal itself comes from the SAME core, now told the selection's tier.
  const decision = resolveFundingDecision({ ...fundingInputs, isPremiumModel: anyPremium });
  if (decision.payer === 'refuse' && decision.refusalCode === 'MODEL_TIER_LOCKED') {
    return c.json(createErrorResponse(ERROR_CODES.MODEL_TIER_LOCKED), 403);
  }
  return null;
}

/**
 * The admin kill-switch gate (the MODEL_TIER_LOCKED pattern): a disabled model
 * already fails closed downstream — it vanishes from the exposed catalog, so
 * the turn build refuses it as unknown — but that refusal is indistinguishable
 * from a typo'd id. This gate names the specific MODEL_DISABLED refusal for
 * every id the client selects directly (single, multi-model, media). The Smart
 * Model sentinel is not a catalog row and passes through: its candidates are
 * derived from the exposed catalog, which never contains a disabled model.
 */
async function disabledModelRejection(
  c: Context<AppEnv>,
  body: { readonly model: string; readonly models?: readonly string[] | undefined }
): Promise<Response | null> {
  const disabled = await findAdminDisabledModel({ db: c.var.db }, body.models ?? [body.model]);
  if (disabled.isErr()) return respondDomainError(c, disabled.error);
  if (disabled.value === undefined) return null;
  return c.json(createErrorResponse(ERROR_CODES.MODEL_DISABLED), 403);
}

/**
 * The turn definition, or the refusal response — the ONE model-resolution
 * path for every paid entrypoint (send, guest send, regenerate): a non-text `modality`
 * selects the media (image/video) turn over the resolved model list —
 * `body.models` (2–5, one sibling generation per model) when present, else the
 * single `body.model` — carrying its generation config as node params on every
 * node; the SMART_MODEL_ID sentinel selects the composite
 * smartModel turn (candidates derived server-side from the exposed catalog +
 * the paying wallet's balance — an empty affordable set refuses with 402
 * INSUFFICIENT_ADMISSION, the same affordability class admission enforces); a
 * models list of two or more is the multi-model fan-out; otherwise the
 * single-model text turn. Every path validates its model(s) against the exposed
 * catalog inside the build — an unknown, unexposed, non-ZDR, or wrong-modality
 * model fails closed before the run starts.
 */
/** The turn's model list: `body.models` when present (the fan-out), else the single `body.model`. */
function selectedModels(body: {
  readonly model: string;
  readonly models?: readonly string[] | undefined;
}): readonly string[] {
  return body.models ?? [body.model];
}

/**
 * A level or `auto` engages reasoning; absent leaves the turn reasoning-free.
 * `none` is not "engaged" (it never reserves thinking tokens) but is NOT a
 * no-op on text turns: the build wires the explicit hard-off
 * `{ enabled: false }` per reasoning-capable model.
 */
function reasoningEngaged(selection: ReasoningEffortSelection | undefined): boolean {
  return selection !== undefined && selection !== 'none';
}

/** The `reasoningEffort` build option, spread only when the client sent one. */
function reasoningEffortOption(selection: ReasoningEffortSelection | undefined): {
  reasoningEffort?: ReasoningEffortSelection;
} {
  return selection === undefined ? {} : { reasoningEffort: selection };
}

/**
 * An engaged reasoning selection (a level or `auto`) is a TEXT-turn option:
 * media models carry no reasoning object — refused here rather than silently
 * dropped (G3). On the Smart Model sentinel only `auto` is meaningful (the
 * generalized classifier stage classifies both dimensions in its one call);
 * an EXPLICIT level stays refused — the answering model is unknown until the
 * classifier resolves it, so a concrete level cannot be validated against a
 * model (G3 forbids silently downgrading it later). `none` stays legal on
 * both: a media model has no reasoning to turn off (a no-op), and the
 * composite Smart turn stamps the explicit `{ enabled: false }` hard-off
 * wire onto its node params — applied at runtime to whichever
 * reasoning-capable non-mandatory candidate resolves; a mandatory candidate
 * keeps reasoning (it cannot disable, and one candidate cannot refuse the
 * whole server-picked composite).
 */
function engagedReasoningRefusal(
  c: Context<AppEnv>,
  body: {
    readonly model: string;
    readonly modality?: TurnModality | undefined;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  }
): Response | null {
  if (!reasoningEngaged(body.reasoningEffort)) return null;
  if (
    body.modality === 'image' ||
    body.modality === 'video' ||
    (body.model === SMART_MODEL_ID && body.reasoningEffort !== 'auto')
  ) {
    return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
  }
  return null;
}

/**
 * A media turn resolves its model list exactly like the text path —
 * `body.models` (2–5, the fan-out of sibling generations) when present, else
 * the single `body.model` — every model producing the modality and carrying
 * the config as node params (video config is guaranteed present by the
 * schema refinement; image config defaults its aspect ratio, so an absent
 * one is {}).
 */
async function mediaDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: {
    readonly model: string;
    readonly models?: readonly string[] | undefined;
    readonly imageConfig?: Readonly<Record<string, unknown>> | undefined;
    readonly videoConfig?: Readonly<Record<string, unknown>> | undefined;
  },
  modality: 'image' | 'video',
  budget: TurnBudget
): Promise<WorkflowDefinition | Response> {
  const params = (modality === 'video' ? body.videoConfig : body.imageConfig) ?? {};
  const media = await buildMediaTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    selectedModels(body),
    modality,
    { params, budget }
  );
  return media.match(
    (value) => value,
    (error) => respondDomainError(c, error)
  );
}

/**
 * Pinned model + auto: the generalized classifier stage owns the effort
 * choice via a single-candidate smartModel node. `null` = build the regular
 * turn instead — web-search turns never enter here (the composite node
 * carries no tool loop), and a non-eligible model falls back, where `auto`
 * resolves deterministically (the sole real choice) or reasoning-free, with
 * no classifier call, charge, or reserve.
 */
async function pinnedAutoDefinitionOrNull(
  c: Context<AppEnv>,
  model: string,
  budget: TurnBudget
): Promise<WorkflowDefinition | Response | null> {
  const auto = await buildAutoEffortTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    model,
    { budget }
  );
  if (auto.isErr()) return respondDomainError(c, auto.error);
  return auto.value.kind === 'built' ? auto.value.definition : null;
}

/** The paid Smart Model build: `auto` engages the classifier's effort dimension. */
async function smartModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: { readonly reasoningEffort?: ReasoningEffortSelection | undefined },
  turn: { readonly userId: string; readonly budget: TurnBudget }
): Promise<WorkflowDefinition | Response> {
  const build = await buildSmartModelTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger, billing: deps.billing },
    {
      userId: turn.userId,
      now: new Date(),
      budget: turn.budget,
      classifyEffort: body.reasoningEffort === 'auto',
      reasoningOff: body.reasoningEffort === 'none',
    }
  );
  if (build.isErr()) return respondDomainError(c, build.error);
  if (!build.value.buildable) {
    return c.json(createErrorResponse(ERROR_CODES.INSUFFICIENT_ADMISSION), 402);
  }
  return build.value.definition;
}

async function turnDefinitionOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  body: {
    readonly model: string;
    readonly modality?: TurnModality | undefined;
    readonly models?: readonly string[] | undefined;
    readonly webSearchEnabled?: boolean | undefined;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
    readonly imageConfig?: Readonly<Record<string, unknown>> | undefined;
    readonly videoConfig?: Readonly<Record<string, unknown>> | undefined;
  },
  // The caller plus their payer budget — the output-token ceiling input for
  // every text path (single, multi, smart model). Media turns price
  // deterministically per generation and take no token ceiling.
  turn: { readonly userId: string; readonly budget: TurnBudget }
): Promise<WorkflowDefinition | Response> {
  const reasoningRefusal = engagedReasoningRefusal(c, body);
  if (reasoningRefusal !== null) return reasoningRefusal;
  if (body.modality === 'image' || body.modality === 'video') {
    return mediaDefinitionOrRefusal(c, body, body.modality, turn.budget);
  }
  if (body.model === SMART_MODEL_ID) {
    return smartModelDefinitionOrRefusal(c, deps, body, turn);
  }
  const webSearchEnabled = body.webSearchEnabled === true;
  if (body.models === undefined && body.reasoningEffort === 'auto' && !webSearchEnabled) {
    const auto = await pinnedAutoDefinitionOrNull(c, body.model, turn.budget);
    if (auto !== null) return auto;
  }
  const definition = await (body.models === undefined
    ? buildTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, body.model, {
        webSearchEnabled,
        budget: turn.budget,
        ...reasoningEffortOption(body.reasoningEffort),
      })
    : buildMultiModelTurnDefinition({ db: c.var.db, telemetry: c.var.logger }, [...body.models], {
        webSearchEnabled,
        budget: turn.budget,
        ...reasoningEffortOption(body.reasoningEffort),
      }));
  return definition.match(
    (value) => value,
    (error) => respondDomainError(c, error)
  );
}

/**
 * The trial send's turn definition, or the refusal response. The
 * SMART_MODEL_ID sentinel selects the composite smartModel turn under the
 * trial hooks — candidates derived server-side from the trial-eligible
 * catalog subset and the fixed 1¢ per-message ceiling (trial has no wallet,
 * so the ceiling plays the balance's role); an empty eligible set refuses
 * with 402 TRIAL_MESSAGE_TOO_EXPENSIVE, the same refusal class as a concrete
 * over-cap model. Every other model runs the MODEL/AFFORDABILITY gate and the
 * single-model compile. Both paths run BEFORE the quota INCR — a refusal
 * burns no slot.
 */
/**
 * Trial reasoning acceptance (G9): only levels whose shared-plan token cost
 * fits the 1¢ ceiling run; `auto` resolves to a fitting level or reasoning-
 * free. Computed through the same plan + headroom math the build prices with
 * — never a hardcoded level list. An unknown model falls through untouched
 * (the compile refuses it as unknown).
 */
function trialReasoningOrRefusal(
  c: Context<AppEnv>,
  target: ModelDescriptor | undefined,
  budget: TurnBudget,
  requested: ReasoningEffortSelection | undefined
): { readonly response: Response } | { readonly selection: ReasoningEffortSelection | undefined } {
  if (requested === undefined || target === undefined) return { selection: requested };
  const decision = trialReasoningSelection(target, budget, requested);
  if (decision.isErr()) return { response: respondDomainError(c, decision.error) };
  if (!decision.value.accepted) {
    return {
      response: c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402),
    };
  }
  return { selection: decision.value.selection };
}

/**
 * The trial Smart Model build. Only `auto` engages the classifier's effort
 * dimension on the composite turn; an explicit level stays refused — the
 * answering model is unknown until the classifier resolves it (the same seam
 * as the paid path).
 */
async function trialSmartModelDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: {
    readonly prompt: string;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
  },
  history: ChatHistoryMessage[],
  budget: TurnBudget
): Promise<WorkflowDefinition | Response> {
  if (reasoningEngaged(body.reasoningEffort) && body.reasoningEffort !== 'auto') {
    return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
  }
  const build = await buildTrialSmartModelTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    {
      prompt: body.prompt,
      history,
      now: new Date(),
      budget,
      classifyEffort: body.reasoningEffort === 'auto',
      reasoningOff: body.reasoningEffort === 'none',
    }
  );
  if (build.isErr()) return respondDomainError(c, build.error);
  if (!build.value.buildable) {
    return c.json(createErrorResponse(ERROR_CODES.TRIAL_MESSAGE_TOO_EXPENSIVE), 402);
  }
  return build.value.definition;
}

async function trialTurnDefinitionOrRefusal(
  c: Context<AppEnv>,
  body: {
    readonly model: string;
    readonly prompt: string;
    readonly reasoningEffort?: ReasoningEffortSelection | undefined;
    readonly customInstructions?: string | undefined;
  },
  history: ChatHistoryMessage[]
): Promise<WorkflowDefinition | Response> {
  // Trial has no wallet, so the fixed 1¢ per-message cap plays the payer
  // balance's role for the output-token ceiling — the funding mirrors the trial
  // per-message cap (TRIAL_MESSAGE_COST_CAP_NANO_USD). The 'free' kind gives
  // legacy's conservative 2 chars/token input estimate and no cushion.
  const budget: TurnBudget = {
    promptCharacterCount: turnPromptCharacterCount(body, body.prompt, history),
    funding: { kind: 'free', remainingNanoUsd: TRIAL_MESSAGE_COST_CAP_NANO_USD },
  };
  if (body.model === SMART_MODEL_ID) {
    return trialSmartModelDefinitionOrRefusal(c, body, history, budget);
  }
  // The MODEL/AFFORDABILITY gate runs BEFORE the compile: a non-text model is
  // refused as MEDIA_TRIAL_BLOCKED rather than falling through to the compile
  // step's generic unknown-model 400. An unknown model is absent from the
  // exposed catalog, so the gate is a no-op and the compile below refuses it.
  const catalog = await listDescriptors({ db: c.var.db, telemetry: c.var.logger });
  if (catalog.isErr()) return respondDomainError(c, catalog.error);
  const target = catalog.value.find((descriptor) => descriptor.id === body.model);
  // The gate prices the full resent history (its honest cost).
  const gateRejection = trialGateRejection(c, target, catalog.value, {
    prompt: body.prompt,
    history,
  });
  if (gateRejection !== null) return gateRejection;
  const trialReasoning = trialReasoningOrRefusal(c, target, budget, body.reasoningEffort);
  if ('response' in trialReasoning) return trialReasoning.response;
  // A model that cannot build a text turn — unknown, or a non-text
  // (image/video) model — is refused here with a typed 400.
  const definition = await buildTurnDefinition(
    { db: c.var.db, telemetry: c.var.logger },
    body.model,
    {
      hooks: TRIAL_TURN_HOOKS,
      budget,
      ...reasoningEffortOption(trialReasoning.selection),
    }
  );
  return definition.match(
    (value) => value,
    (error) => respondDomainError(c, error)
  );
}

/**
 * The pipeline enforced the header before the handler ran (the chat turn is a
 * `run`-kind mutation whose referee is the conversation DO, so the route
 * requires the key and forwards it as the run key rather than claiming
 * itself). Absence here is a composition defect.
 */
function requiredRunKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  /* v8 ignore next 3 -- the idempotency-key middleware enforces the key on this mutating route before the handler runs; this guard is a defect-only invariant */
  if (key === undefined) {
    throw new Error('chat: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The canonical dedup body for a start turn — only the client-intent fields
 * that identify the run (the server-derived context is bound to the run body,
 * not the hash). Every optional is spread only when meaningfully present so a
 * client upgrade (adding a defaulted field) never causes a spurious 409: an
 * omitted vs `[]` history, a default vs omitted modality, and an omitted vs
 * `false` web-search flag all hash identically.
 */
function startTurnBodyHash(
  body: z.infer<typeof startTurnBodySchema>,
  history: ChatHistoryMessage[]
): Promise<string> {
  return hashCanonicalJson({
    conversationId: body.conversationId,
    model: body.model,
    ...(body.models === undefined ? {} : { models: body.models }),
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {}),
    ...(body.modality === 'text' ? {} : { modality: body.modality }),
    ...(body.imageConfig === undefined ? {} : { imageConfig: body.imageConfig }),
    ...(body.videoConfig === undefined ? {} : { videoConfig: body.videoConfig }),
    // Reasoning effort is client intent that changes the answer — scoped into
    // the dedup like the other optionals; omitted hashes identically to before.
    ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    // Custom instructions are client intent that changes the answer, so they
    // scope the dedup like history — omitted hashes identically to before.
    ...(body.customInstructions === undefined
      ? {}
      : { customInstructions: body.customInstructions }),
    userMessage: body.userMessage,
    history,
  });
}

/** The canonical dedup body for a regenerate turn (`regenerate` scopes the retry/edit intent). */
function regenerateTurnBodyHash(
  body: z.infer<typeof regenerateTurnBodySchema>,
  history: ChatHistoryMessage[],
  regenerateCore: Readonly<Record<string, unknown>>
): Promise<string> {
  return hashCanonicalJson({
    conversationId: body.conversationId,
    model: body.model,
    ...(body.models === undefined ? {} : { models: body.models }),
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(body.webSearchEnabled === true ? { webSearchEnabled: true } : {}),
    // A default `text` modality hashes identically to an omitted one, so an
    // older client's text regenerate never 409s against its own retry.
    ...(body.modality === 'text' ? {} : { modality: body.modality }),
    ...(body.imageConfig === undefined ? {} : { imageConfig: body.imageConfig }),
    ...(body.videoConfig === undefined ? {} : { videoConfig: body.videoConfig }),
    // Reasoning effort is client intent that changes the answer — scoped into
    // the dedup like the other optionals; omitted hashes identically to before.
    ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
    ...(body.customInstructions === undefined
      ? {}
      : { customInstructions: body.customInstructions }),
    userMessage: body.userMessage,
    regenerate: regenerateCore,
    history,
  });
}

/**
 * Resolves and gates the link-guest sender for the public guest-send route,
 * SERVER-SIDE, returning a refusal `Response` or the resolved `TurnSender`.
 * Gates, in order: the presented credential resolves a caller (else 401 — no
 * session and no live link); a guest's credential is bound to THIS conversation
 * (the typed match, else 403); the caller holds an active member row (else 403 —
 * a revoked/departed guest resolves to null); the member is not read-only (else
 * 403). Nothing is trusted from the request body — the guest's
 * linkId/conversationId come from the credential and the member from the active
 * row, so a spoofed body id can never elevate a send.
 */
async function resolveGuestSenderOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  conversationId: string
): Promise<Response | TurnSender> {
  const resolved = await resolveConversationCaller({
    principal: c.var.principal,
    linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
    linkResolution: deps.linkResolution(c.var.db),
  });
  if (resolved.isErr()) return respondDomainError(c, resolved.error);
  const caller = resolved.value;
  if (caller === null) {
    return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
  }
  if (caller.kind === 'linkGuest' && caller.conversationId !== conversationId) {
    return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  }
  const member = await resolveCallerMember(deps.conversations(c.var.db), conversationId, caller);
  if (member.isErr()) return respondDomainError(c, member.error);
  if (member.value === null || member.value.privilege === 'read') {
    return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  }
  return caller.kind === 'user'
    ? { kind: 'user', userId: caller.userId }
    : { kind: 'linkGuest', linkId: caller.linkId };
}

/**
 * The chat turn's HTTP surface. The route resolves the run identity (paying
 * wallet, current epoch), compiles the single-model turn, and hands the run to
 * the conversation DO — the DO owns the referee claim, deadline, streaming, and
 * settlement. No business logic settles here; the handler only composes.
 *
 * The return type is deliberately inferred so the route schema flows into
 * `AppType` (annotating `Hono<AppEnv>` erases it to `BlankSchema`).
 */
export function createChatManifest(deps: ChatRouteDeps) {
  return defineSliceManifest({
    basePath: '/chat',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        // Per-user rate limit before the context read and turn build — the
        // edge enforcer, same key and limits the in-handler check carried.
        rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredRunKey(c);

          // The Smart Model sentinel is a single-model concept: the classifier
          // picks the one answering model, so a multi-model list alongside it
          // is not composable — a plain input-validation refusal.
          if (body.model === SMART_MODEL_ID && body.models !== undefined) {
            return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
          }

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            {
              conversationId: body.conversationId,
              sender: { kind: 'user', userId },
              forkId: body.forkId,
              now: new Date(),
            }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          // The admin kill switch outranks the tier gate: a disabled model is
          // refused as disabled even for a caller with premium access.
          const disabledRejection = await disabledModelRejection(c, body);
          if (disabledRejection !== null) return disabledRejection;

          // The paid premium-tier gate (parallel to the trial gate): a
          // direct-billing caller with no balance cannot select a premium model.
          const tierRejection = await tierGateRejection(
            c,
            body,
            context.value.fundingDecisionInputs
          );
          if (tierRejection !== null) return tierRejection;

          // History always rides the hash normalized — absent and [] must
          // hash identically, so a client upgrade never causes a spurious 409.
          // Normalized BEFORE the build: the same characters feed the
          // output-token ceiling's input estimate.
          const history = normalizedHistory(body.history);
          const budget: TurnBudget = {
            promptCharacterCount: turnPromptCharacterCount(body, body.userMessage.content, history),
            funding: context.value.funding,
          };
          const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget });
          if (definition instanceof Response) return definition;

          const bodyHash = await startTurnBodyHash(body, history);
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.userMessage.content } },
            history,
            userId: context.value.payerUserId,
            senderId: context.value.senderId,
            sender: context.value.sender,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
            userMessage: body.userMessage,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            // Run-scoped client context, never baked into the definition
            // (which stays free of user content, safe to log).
            ...runScopedInstructions(body),
            ...mockDirectivesBody(c),
          };

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody)
          );
        }
      )
      // The link-guest send: the SAME single-run/single-settlement paid pipeline
      // as `POST /` (reused, not a parallel path), reached on a PUBLIC route
      // because the HTTP matrix admits no link-guest principal. It resolves the
      // guest SERVER-SIDE from its `x-link-public-key` credential (never a
      // client-claimed id), then gates on the active member row, its WRITE
      // privilege, and the typed conversation match, before deferring to the same
      // turn-context/startRun path. A guest may fork exactly like a member —
      // `body.forkId` is forwarded and validated downstream. The OWNER funds the
      // turn; the guest is the sender.
      .post(
        '/guest',
        routeClass('public'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const runKey = requiredRunKey(c);

          if (body.model === SMART_MODEL_ID && body.models !== undefined) {
            return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
          }

          // Resolve and gate the guest SERVER-SIDE (credential → active member →
          // WRITE → typed conversation match); nothing is trusted from the body.
          const gated = await resolveGuestSenderOrRefusal(c, deps, body.conversationId);
          if (gated instanceof Response) return gated;
          const sender = gated;

          // Flood protection keyed on the sender principal (linkId for a guest).
          const rateLimited = await chatUserRateLimitRejection(
            c,
            sender.kind === 'user' ? sender.userId : sender.linkId
          );
          if (rateLimited !== null) return rateLimited;

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            {
              conversationId: body.conversationId,
              sender,
              forkId: body.forkId,
              now: new Date(),
            }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          // Same point in the flow as the paid send's gate: after the caller is
          // resolved and gated, before the turn build's generic unknown refusal.
          const disabledRejection = await disabledModelRejection(c, body);
          if (disabledRejection !== null) return disabledRejection;

          const history = normalizedHistory(body.history);
          const budget: TurnBudget = {
            promptCharacterCount: turnPromptCharacterCount(body, body.userMessage.content, history),
            funding: context.value.funding,
          };
          const definition = await turnDefinitionOrRefusal(c, deps, body, {
            userId: context.value.payerUserId,
            budget,
          });
          if (definition instanceof Response) return definition;

          const bodyHash = await startTurnBodyHash(body, history);
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.userMessage.content } },
            history,
            // The OWNER pays (payerUserId); the guest is the sender.
            userId: context.value.payerUserId,
            senderId: context.value.senderId,
            sender: context.value.sender,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
            userMessage: body.userMessage,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            // Run-scoped client context, never baked into the definition
            // (which stays free of user content, safe to log).
            ...runScopedInstructions(body),
            ...mockDirectivesBody(c),
          };

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody)
          );
        }
      )
      // The regenerate/edit turn: the SAME paid pipeline, but the settlement
      // deletes the superseded reply(s) and re-parents the new one. Two extra
      // pre-run gates: the target must belong to the conversation (404), and a
      // group regenerate must not delete across another member's message (403).
      .post(
        '/regenerate',
        routeClass('session'),
        zValidator('json', regenerateTurnBodySchema, rejectInvalid),
        // Per-user rate limit (shared with `/chat`) at the edge, before the
        // context read, the regenerate guard, and the turn build.
        rateLimitByUser(CHAT_STREAM_USER_RATE_LIMIT),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredRunKey(c);

          // Same single-model-sentinel rule as the send and guest routes: the
          // classifier picks the one answering model, so a multi-model list
          // alongside the sentinel is not composable.
          if (body.model === SMART_MODEL_ID && body.models !== undefined) {
            return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
          }

          const context = await resolveTurnContext(
            { conversations: deps.conversations, billing: deps.billing },
            c.var.db,
            {
              conversationId: body.conversationId,
              sender: { kind: 'user', userId },
              forkId: body.forkId,
              now: new Date(),
            }
          );
          if (context.isErr()) return respondDomainError(c, context.error);

          const decision = await canRegenerate(deps.conversations(c.var.db), {
            conversationId: body.conversationId,
            targetMessageId: body.targetMessageId,
            userId,
            forkId: body.forkId,
            replaceAssistantId: body.replaceAssistantId,
          });
          if (decision.isErr()) return respondDomainError(c, decision.error);
          const rejection = regenerateRejection(c, decision.value.decision);
          if (rejection !== null) return rejection;

          // Symmetric with `/chat`: absent `models` is the single-model
          // regenerate (`model` is the anchor); two or more fans out. The
          // re-run prompt + resent history feed the same output-token ceiling.
          // Normalized like the send route: absent and [] hash identically.
          const history = normalizedHistory(body.history);
          const budget: TurnBudget = {
            promptCharacterCount: turnPromptCharacterCount(body, body.userMessage.content, history),
            funding: context.value.funding,
          };
          // The SAME resolver as the send paths — a regenerate resolves media
          // lists, the Smart Model sentinel, multi-model fan-out, and the
          // web-search flag identically.
          const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget });
          if (definition instanceof Response) return definition;

          // The client-intent fields that scope idempotency dedup; the
          // server-derived observed tip is bound to the run body below, NOT the
          // body hash — a retry after the tip legitimately moved must not 409.
          const regenerateCore = {
            action: body.action,
            targetMessageId: body.targetMessageId,
            ...(body.replaceAssistantId === undefined
              ? {}
              : { replaceAssistantId: body.replaceAssistantId }),
          };
          const bodyHash = await regenerateTurnBodyHash(body, history, regenerateCore);
          // Carry the tip the guard validated its deletable tail against so the
          // settlement can assert the fork-row-locked tip still matches it (the
          // fork-tip TOCTOU fence). Only meaningful on a fork regenerate.
          const regenerate = {
            ...regenerateCore,
            ...(body.forkId === undefined
              ? {}
              : { observedForkTipId: decision.value.observedForkTipId }),
          };
          const runStartBody: RunStartBody = {
            mode: 'paid',
            runKey,
            bodyHash,
            definition,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.userMessage.content } },
            history,
            userId: context.value.payerUserId,
            senderId: context.value.senderId,
            sender: context.value.sender,
            walletId: context.value.walletId,
            epochNumber: context.value.epochNumber,
            userMessage: body.userMessage,
            ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
            regenerate,
            // Run-scoped client context, never baked into the definition
            // (which stays free of user content, safe to log).
            ...runScopedInstructions(body),
            ...mockDirectivesBody(c),
          };

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody)
          );
        }
      )
      // The trial turn: the SAME single-model pipeline under the no-persist /
      // no-charge policy. Public (no session) — an authenticated caller is
      // refused; a trial-session principal is resolved from `x-trial-token`,
      // never a cookie. The 5/day dual-identity quota (token + IP) lives here
      // because only the route holds both; the global Sybil budget is enforced
      // by the trial admission hook.
      .post(
        '/trial',
        routeClass('public'),
        zValidator('json', trialTurnBodySchema, rejectInvalid),
        async (c) => {
          if (c.var.principal.kind !== 'none') {
            return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
          }
          const body = c.req.valid('json');
          // Web search is an account feature; trial reserves no budget for the
          // tool cap, so a hand-crafted request enabling it is refused.
          if (body.webSearchEnabled === true) {
            return c.json(createErrorResponse(ERROR_CODES.FEATURE_REQUIRES_AUTH), 403);
          }
          const runKey = requiredRunKey(c);
          const principal = resolveTrialSessionPrincipal({
            credential: c.req.header('x-trial-token') ?? null,
            newId: () => crypto.randomUUID(),
          });
          // The hashed IP is the identity for the 5/day quota; compute it once
          // and reuse it (never double-hash).
          const ipHash = await hashIp(clientIp(c));
          // Before the compile and the quota INCR — a refusal burns no slot.
          const disabledRejection = await disabledModelRejection(c, body);
          if (disabledRejection !== null) return disabledRejection;
          // Normalized like the paid routes: absent and [] hash identically,
          // and the pricing gates see the full resent history (its honest cost).
          const history = normalizedHistory(body.history);
          // Validate, gate, and compile the turn BEFORE consuming a quota slot:
          // a refused request must never burn one.
          const definition = await trialTurnDefinitionOrRefusal(c, body, history);
          if (definition instanceof Response) return definition;

          // Consume one 5/day slot only now that the turn is runnable. The INCR
          // is atomic (Redis) and fails closed. Residual replay edge: the run
          // referee is the conversation DO (startRun), so the route cannot
          // cheaply distinguish a same-key network retry from a first send
          // before this gate — a retry re-increments the slot even though the DO
          // then replays/attaches without executing a second run. Bounded and
          // accepted; splitting claim from check would need a new DO surface.
          const quota = await consumeTrialQuota(c.var.redis, {
            sessionId: principal.sessionId,
            ipHash,
          });
          if (quota.isErr()) return respondDomainError(c, quota.error);
          if (!quota.value.allowed) {
            return c.json(createErrorResponse(ERROR_CODES.TRIAL_LIMIT_REACHED), 429);
          }

          const bodyHash = await hashCanonicalJson({
            model: body.model,
            prompt: body.prompt,
            history,
            // The REQUESTED selection scopes dedup (client intent), not the
            // trial-resolved level — a same-body retry must hash identically.
            ...(body.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: body.reasoningEffort }),
            ...(body.customInstructions === undefined
              ? {}
              : { customInstructions: body.customInstructions }),
          });
          const runStartBody: RunStartBody = {
            mode: 'trial',
            runKey,
            bodyHash,
            definition,
            inputs: { [CHAT_TURN_INPUT]: { kind: 'text', text: body.prompt } },
            history,
            sessionId: principal.sessionId,
            // Run-scoped client context, never baked into the definition
            // (which stays free of user content, safe to log).
            ...runScopedInstructions(body),
            ...mockDirectivesBody(c),
          };
          return respondTrialRunStart(
            c,
            deps.realtime(c.env).startRun(deps.trialRoomName(principal.sessionId), runStartBody),
            principal.sessionId
          );
        }
      )
      // The trial WebSocket upgrade — the trial client's only way to attach to
      // the run streaming server-side (the paid `/:conversationId/websocket` is
      // membership-gated and keyed by a conversationId, neither of which a trial
      // session has). Public: an authenticated caller belongs on the
      // conversation socket and is refused. The room and the principal id are
      // BOTH derived server-side as `trialRoomName(sessionId)`, where `sessionId`
      // comes only from the resolved `x-trial-token`; the client supplies no
      // conversationId or principalId. So the DO addressed (`idFromName`) and the
      // socket's attachment principal are prefix-scoped to this session's own
      // trial room, and the broadcast-time `isTrialRoomSelf` verifier confines
      // delivery there — a trial credential can never upgrade to another trial
      // room or any conversation DO (the `trial:` prefix disjoints the DO
      // namespace). No membership check: a trial session has no membership.
      .get('/trial/websocket', routeClass('public'), async (c) => {
        if (c.var.principal.kind !== 'none') {
          return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
        }
        // WS-upgrade-only query fallback: a browser WebSocket cannot set the
        // `x-trial-token` header, so the client sends `?trialToken=`. The HTTP
        // POST stays header-only — this fallback exists only where headers are
        // physically unavailable.
        const principal = resolveTrialSessionPrincipal({
          credential: c.req.header('x-trial-token') ?? c.req.query('trialToken') ?? null,
          newId: () => crypto.randomUUID(),
        });
        const room = deps.trialRoomName(principal.sessionId);
        const upgraded = await deps
          .realtime(c.env)
          .upgrade(room, { principalId: room, isGuest: false }, c.req.raw.headers);
        return upgraded.match(
          (response) => response,
          (error) => respondDomainError(c, error)
        );
      })
      // Explicit user stop. Plain HTTP by design — a WS-blocked user must still
      // be able to abort a paid run — and membership-gated so no one can stop
      // another conversation's run. The DO settles and bills the partial; a
      // repeat is a no-op (`stopped:false` once the run is gone).
      .post(
        '/stop',
        routeClass('session'),
        zValidator('json', stopTurnBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const member = await deps
            .conversations(c.var.db)
            .members.activeByUser(conversationId, userId);
          if (member.isErr()) return respondDomainError(c, member.error);
          if (member.value === null) {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          const stopped = await deps.realtime(c.env).stopRun(conversationId);
          return stopped.match(
            (didStop) => c.json({ stopped: didStop }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // The dev/E2E held-stream release: forwards to the addressed conversation
      // room DO so an E2E test can free a stream parked by the `holdPrimaryStream`
      // mock directive. `dev-only` 404s in production — the sole production-safety
      // gate for this surface (there is no held stream to release in production
      // regardless, since no production run carries mock directives). A GET (never
      // a mutating turn) so the idempotency-key stage does not apply.
      .get(
        '/mock/release-stream',
        routeClass('dev-only'),
        zValidator('query', releaseStreamQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('query');
          const env: ReleaseStreamRoomEnv = c.env;
          const namespace = env.CONVERSATION_ROOM;
          if (namespace === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          const stub = namespace.get(namespace.idFromName(conversationId));
          const response = await stub.fetch('https://conversation-room/mock/release-stream', {
            method: 'POST',
          });
          if (!response.ok) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          const parsed = releaseStreamResponseSchema.safeParse(await response.json());
          if (!parsed.success) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          return c.json({ released: parsed.data.released }, 200);
        }
      )
      // The runless user-only send (legacy "AI toggle off" group message):
      // Pattern A — one transaction, no run, no charge. The client-supplied
      // messageId is the natural idempotency key (the messages PK arbitrates
      // duplicates), so no Idempotency-Key header is demanded; a resent id
      // answers 409 DUPLICATE_MESSAGE and the client refreshes.
      .post(
        '/:conversationId/message',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', userOnlyMessageSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { messageId, content, forkId } = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const member = await resolveCallerMember(deps.conversations(c.var.db), conversationId, {
            kind: 'user',
            userId,
          });
          if (member.isErr()) return respondDomainError(c, member.error);
          // Write privilege required (legacy parity): a non-member and a
          // read-only member are both refused before anything is written.
          if (member.value === null || member.value.privilege === 'read') {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              saveUserOnlyMessage(
                {
                  db: c.var.db,
                  stores: deps.chatStores,
                  readEpochPublicKey: deps.readEpochPublicKey,
                  newId: randomUuid,
                },
                {
                  conversationId,
                  senderId: userId,
                  messageId,
                  content,
                  ...(forkId !== undefined && { forkId }),
                }
              )
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          const outcome = result.value;
          if (!outcome.saved) {
            return c.json(createErrorResponse(ERROR_CODES.DUPLICATE_MESSAGE), 409);
          }
          // Post-commit, best-effort: the message already committed; a failed
          // broadcast is logged and a client resync recovers.
          const broadcast = await broadcastUserMessageNew(deps.realtime(c.env), {
            conversationId,
            messageId: outcome.messageId,
            senderId: userId,
            sequenceNumber: outcome.sequenceNumber,
          });
          if (broadcast.isErr()) {
            c.var.logger.warn('user message broadcast failed', {
              conversationId,
              errorCode: broadcast.error.code,
            });
          }
          // Post-commit, best-effort push side-band (parity with the AI-turn
          // path, which the runless send historically lacked): absent, non-muted
          // members with a device token get a content-free notification, while
          // members watching live (DO presence), muted members, and the sender
          // are suppressed downstream. Fired via `waitUntil` so it survives the
          // response; a presence-read or push failure can never touch the
          // committed message or this 200 (the capability logs its own code and
          // never throws — and the guard wraps the factory construction too, so a
          // synchronous throw from `createPushSenderFromEnv` on a misconfigured
          // deploy is swallowed, never escaping onto the request path).
          const notifyFactory = deps.notifyNewMessage;
          if (notifyFactory !== undefined) {
            const pushTask = (async () => {
              try {
                const notify = notifyFactory(c.env, c.var.db);
                const presence = await deps.realtime(c.env).presence(conversationId);
                if (presence.isErr()) {
                  c.var.logger.warn('user message push presence unavailable', {
                    conversationId,
                    errorCode: presence.error.code,
                  });
                  return;
                }
                await notify({
                  conversationId,
                  senderUserId: userId,
                  presentUserIds: presence.value,
                });
                // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort push side-band via waitUntil; notify self-reports; nothing escapes onto the request path.
              } catch {
                // Best-effort: `notify` already swallows its own failures; this
                // guards the presence read + scheduling so nothing ever escapes.
              }
            })();
            c.executionCtx.waitUntil(pushTask);
          }
          return c.json(
            {
              messageId: outcome.messageId,
              sequenceNumber: outcome.sequenceNumber,
              epochNumber: outcome.epochNumber,
            },
            200
          );
        }
      ),
  });
}
