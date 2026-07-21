/**
 * Chat streaming over the run protocol: HTTP starts/stops the run (typed
 * client, `Idempotency-Key` per logical turn), the conversation WebSocket
 * carries the streamed output (`stream` frames demuxed per model tile by
 * `stream-start`). Replaces the legacy SSE transport wholesale — the run
 * orchestration itself lives in `@/lib/chat-run` (pure, tested without React);
 * this hook binds it to the typed client, the shared sockets, run ownership,
 * TTS, and the streaming-activity stores.
 */
import { useState, useCallback, useRef } from 'react';
import { retryOnTransientStatus, SMART_MODEL_ID } from '@hushbox/shared';
import { shouldRetryMutation } from '@/lib/retry';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { client } from '@/lib/api-client';
import { getLinkGuestAuth } from '@/lib/link-guest-auth';
import { getTrialToken, TRIAL_TOKEN_KEY } from '@/lib/trial-token';
import { executeChatRun } from '@/lib/chat-run';
import { ChatRequestError } from '@/lib/chat-request-error';
import {
  acquireConversationSocket,
  releaseConversationSocket,
  acquireTrialSocket,
  releaseTrialSocket,
} from '@/lib/conversation-socket-registry';
import {
  markPendingLocalRun,
  resolvePendingLocalRun,
  clearPendingLocalRun,
  releaseLocalRun,
} from '@/lib/run-ownership';
import { startChatTtsStream } from '@/lib/chat-tts-stream';
import type {
  ChatRunCallbacks,
  ChatRunResult,
  ChatRunTile,
  RunStartResponse,
  RunTransportSocket,
} from '@/lib/chat-run';
import type { ChatModality, ImageConfig, VideoConfig, AudioConfig } from '@hushbox/shared';

export { ChatRequestError } from '@/lib/chat-request-error';

export type StreamMode = 'authenticated' | 'trial';

/** History entry accepted by the run routes (system prompts never ride history). */
interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Caller-supplied inference context entry (legacy shape; system entries are dropped). */
export interface InferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AuthenticatedStreamRequest {
  conversationId: string;
  modality?: ChatModality;
  models: string[];
  userMessage: {
    id: string;
    content: string;
  };
  messagesForInference: InferenceMessage[];
  /** Legacy caller field; funding is resolved server-side and never sent. */
  fundingSource: string;
  webSearchEnabled?: boolean;
  /** Legacy caller field; the run routes carry no instructions today. */
  customInstructions?: string;
  forkId?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  /** Legacy caller field; audio turns are not part of the run protocol. */
  audioConfig?: AudioConfig;
}

interface TrialStreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TrialStreamRequest {
  messages: TrialStreamMessage[];
  model: string;
  webSearchEnabled?: boolean;
}

export interface RegenerateStreamRequest {
  conversationId: string;
  targetMessageId: string;
  action: 'retry' | 'edit';
  replaceAssistantId?: string;
  modality?: ChatModality;
  models: string[];
  userMessage: {
    id: string;
    content: string;
  };
  messagesForInference: InferenceMessage[];
  fundingSource: string;
  forkId?: string;
  webSearchEnabled?: boolean;
  customInstructions?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  audioConfig?: AudioConfig;
}

export type StreamRequest = AuthenticatedStreamRequest | TrialStreamRequest;

export interface ModelResult {
  modelId: string;
  assistantMessageId: string;
  errorCode?: string;
}

export interface StreamResult {
  userMessageId: string;
  models: ModelResult[];
  outcome: 'succeeded' | 'stopped' | 'replayed';
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  userMessageId: string;
  models: StartModelEntry[];
}

export interface ModelDoneData {
  modelId: string;
  assistantMessageId: string;
}

export interface ModelErrorData {
  modelId: string;
  assistantMessageId: string;
  code: string;
}

export interface ModelMediaStartData {
  assistantMessageId: string;
  mediaType: 'image' | 'audio' | 'video';
  mimeType: string;
}

export interface StreamOptions {
  /** The run was accepted — tiles exist; fires once per logical turn. */
  onStart?: (data: StartEventData) => void;
  onToken?: (token: string, assistantMessageId: string) => void;
  onReasoningToken?: (token: string, assistantMessageId: string) => void;
  /**
   * The stream's `stream-start` label. For a Smart Model tile this is the
   * classifier-resolved model id (replaces the legacy `stage:done` event).
   */
  onModelResolved?: (assistantMessageId: string, modelId: string) => void;
  /** A same-key re-execution began after a transport loss: reset tile content. */
  onRestart?: (assistantMessageIds: string[]) => void;
  onModelDone?: (data: ModelDoneData) => void;
  onModelError?: (data: ModelErrorData) => void;
  onModelMediaStart?: (data: ModelMediaStartData) => void;
  /**
   * Synthetic per-node video generation progress. The wire never says 100 —
   * `onModelMediaDone` (or the run's terminal frames) is completion.
   */
  onModelMediaProgress?: (data: { assistantMessageId: string; percent: number }) => void;
  onModelMediaDone?: (data: { assistantMessageId: string }) => void;
  onRunStarted?: (runId: string) => void;
  /** Every tile reached a terminal stream event — tokens stopped flowing. */
  onAllModelsComplete?: () => void;
  /** The run reached its terminal state (settled server-side). */
  onAllStreamsSettled?: () => void;
}

/**
 * A run that terminated without settling content: an involuntary kill
 * (deadline, engine failure) bills nothing — surface "turn failed, not
 * billed" UX keyed on `code`.
 */
export class ChatRunFailedError extends Error {
  constructor(
    public readonly code: string,
    public readonly notBilled = true
  ) {
    super(code);
    this.name = 'ChatRunFailedError';
  }
}

export interface ChatStreamHook {
  isStreaming: boolean;
  startStream: (request: StreamRequest, options?: StreamOptions) => Promise<StreamResult>;
  startRegenerateStream: (
    request: RegenerateStreamRequest,
    options?: StreamOptions
  ) => Promise<StreamResult>;
  /** Explicit user stop — plain HTTP; the server settles + bills the partial. */
  stopRun: (conversationId: string) => Promise<boolean>;
}

/** Wall-clock budget for transparently re-issuing a run POST severed before any response. */
const POST_RETRY_BUDGET_MS = 10_000;

type MediaEventType = 'image' | 'audio' | 'video';

function isMediaEventType(value: string): value is MediaEventType {
  return value === 'image' || value === 'audio' || value === 'video';
}

function extractErrorBody(data: unknown): { code: string; details?: Record<string, unknown> } {
  if (typeof data === 'object' && data !== null && 'code' in data) {
    const { code } = data as { code: unknown };
    const details =
      'details' in data
        ? ((data as { details?: Record<string, unknown> }).details ?? undefined)
        : undefined;
    if (typeof code === 'string') return { code, ...(details === undefined ? {} : { details }) };
  }
  return { code: 'INTERNAL' };
}

/**
 * Maps a run-start Response onto the transport outcome union. 201 = fresh run
 * (watch the WS); 200 `{outcome:'attach'}` = same-key run still live (rejoin);
 * any other 200 = replay of the settled run (treat terminal, refetch).
 */
async function parseRunStartResponse(
  response: Response
): Promise<RunStartResponse & { trialSessionId?: string }> {
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const { code, details } = extractErrorBody(data);
    throw new ChatRequestError(code, details, response.status);
  }
  if (response.status === 201) {
    const body = data as { runId: string; deadlineAt: number; trialSessionId?: string };
    return {
      kind: 'started',
      runId: body.runId,
      deadlineAt: body.deadlineAt,
      ...(body.trialSessionId === undefined ? {} : { trialSessionId: body.trialSessionId }),
    };
  }
  if (typeof data === 'object' && data !== null && 'outcome' in data) {
    const { outcome } = data as { outcome: unknown };
    if (outcome === 'attach') return { kind: 'attach' };
  }
  return { kind: 'replay' };
}

function postWithTransportRetry(send: () => Promise<Response>): Promise<Response> {
  // Re-issue the POST only if the transport itself dropped before any
  // response (a no-response `TypeError` — the same `shouldRetryMutation`
  // rule the app's TanStack mutations use). The Idempotency-Key makes the
  // repeat safe either way; a status-bearing response is never retried here.
  return retryOnTransientStatus(send, () => 200, {
    timeoutMs: POST_RETRY_BUDGET_MS,
    isRetryableError: (error) => shouldRetryMutation(0, error),
  });
}

/**
 * Drops the trailing current-turn user message (it rides `userMessage`, not
 * `history`), strips system entries (instructions are not part of the run
 * body), and drops empty contents (the schema requires min(1)).
 */
function toHistory(
  messages: readonly InferenceMessage[],
  currentUserContent: string
): HistoryMessage[] {
  const entries = [...messages];
  const last = entries.at(-1);
  if (last?.role === 'user' && last.content === currentUserContent) {
    entries.pop();
  }
  return entries.filter(
    (m): m is HistoryMessage =>
      (m.role === 'user' || m.role === 'assistant') && m.content.length > 0
  );
}

/** The turn's output modality on the wire (audio never ships on the run routes). */
function wireModality(modality: ChatModality | undefined): 'text' | 'image' | 'video' {
  return modality === 'image' || modality === 'video' ? modality : 'text';
}

interface TurnWireBody {
  conversationId: string;
  model: string;
  modality: 'text' | 'image' | 'video';
  models?: string[];
  forkId?: string;
  webSearchEnabled?: boolean;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  userMessage: { id: string; content: string };
  history?: HistoryMessage[];
}

function buildTurnBody(request: AuthenticatedStreamRequest): TurnWireBody {
  const primary = request.models[0];
  if (primary === undefined) throw new ChatRequestError('VALIDATION');
  return {
    conversationId: request.conversationId,
    model: primary,
    modality: wireModality(request.modality),
    ...(request.models.length >= 2 ? { models: request.models } : {}),
    ...(request.forkId === undefined ? {} : { forkId: request.forkId }),
    ...(request.webSearchEnabled === undefined
      ? {}
      : { webSearchEnabled: request.webSearchEnabled }),
    ...(request.imageConfig === undefined ? {} : { imageConfig: request.imageConfig }),
    ...(request.videoConfig === undefined ? {} : { videoConfig: request.videoConfig }),
    userMessage: request.userMessage,
    history: toHistory(request.messagesForInference, request.userMessage.content),
  };
}

/**
 * Tiles are pre-allocated client-side in the user's selected order (assistant
 * ids are unknown until settlement, so tiles carry optimistic uuids and the
 * post-run refetch reconciles). A Smart Model send is one tile whose label
 * resolves via `stream-start`.
 */
function buildTiles(models: readonly string[]): ChatRunTile[] {
  const selection = models[0] === SMART_MODEL_ID ? [SMART_MODEL_ID] : models;
  return selection.map((modelId) => ({
    modelId,
    assistantMessageId: crypto.randomUUID(),
  }));
}

interface TtsFeederLike {
  feed: (token: string) => void;
  end: () => void;
}

function wireCallbacks(
  options: StreamOptions | undefined,
  primaryAssistantId: string,
  ttsFeeder: TtsFeederLike | null
): ChatRunCallbacks {
  return {
    onRunStarted: options?.onRunStarted,
    onModelResolved: options?.onModelResolved,
    onRestart: options?.onRestart,
    onToken: (token, assistantMessageId) => {
      options?.onToken?.(token, assistantMessageId);
      if (ttsFeeder !== null && assistantMessageId === primaryAssistantId) {
        ttsFeeder.feed(token);
      }
    },
    onReasoningToken: options?.onReasoningToken,
    onModelDone: options?.onModelDone,
    onModelError: options?.onModelError,
    onMediaStart: (data) => {
      if (!isMediaEventType(data.mediaType)) return;
      options?.onModelMediaStart?.({
        assistantMessageId: data.assistantMessageId,
        mediaType: data.mediaType,
        mimeType: data.mimeType,
      });
    },
    onMediaProgress: options?.onModelMediaProgress,
    onMediaDone: options?.onModelMediaDone,
    onAllModelsComplete: options?.onAllModelsComplete,
  };
}

function toStreamResult(result: ChatRunResult, userMessageId: string): StreamResult {
  if (result.outcome === 'replayed') {
    return { userMessageId, models: [], outcome: 'replayed' };
  }
  if (result.outcome === 'failed' || result.outcome === 'deadline') {
    throw new ChatRunFailedError(
      result.outcome === 'deadline' ? 'CHAT_STREAM_FAILED' : result.code
    );
  }
  return { userMessageId, models: result.models, outcome: result.outcome };
}

/** Persist the server-confirmed trial session id (first send mints it client-side). */
function storeTrialSessionId(trialSessionId: string | undefined): void {
  if (trialSessionId !== undefined) {
    localStorage.setItem(TRIAL_TOKEN_KEY, trialSessionId);
  }
}

export function useChatStream(mode: StreamMode): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);
  // Counts in-flight turns. A counter (not a boolean) keeps the flag correct
  // if a settling turn's cleanup runs while a newer one is already active.
  const processingCountRef = useRef(0);
  const releaseProcessing = useCallback((): void => {
    processingCountRef.current = Math.max(0, processingCountRef.current - 1);
    setIsStreaming(processingCountRef.current > 0);
  }, []);

  const runAuthenticated = useCallback(
    async (run: {
      conversationId: string;
      tiles: ChatRunTile[];
      userMessageId: string;
      postRun: () => Promise<RunStartResponse>;
      options?: StreamOptions | undefined;
    }): Promise<StreamResult> => {
      const { conversationId, tiles, userMessageId, postRun, options } = run;
      const socket = acquireConversationSocket(conversationId);
      const primaryTile = tiles[0];
      const ttsFeeder = await startChatTtsStream({
        messageId: () => primaryTile?.assistantMessageId ?? null,
      });
      try {
        const result = await executeChatRun({
          socket: socket as RunTransportSocket,
          postRun,
          tiles,
          callbacks: wireCallbacks(options, primaryTile?.assistantMessageId ?? '', ttsFeeder),
        });
        return toStreamResult(result, userMessageId);
      } finally {
        ttsFeeder?.end();
        releaseConversationSocket(conversationId);
      }
    },
    []
  );

  const runTurn = useCallback(
    async (
      request: AuthenticatedStreamRequest | RegenerateStreamRequest,
      options: StreamOptions | undefined,
      post: (key: string) => Promise<Response>
    ): Promise<StreamResult> => {
      const idempotencyKey = crypto.randomUUID();
      const tiles = buildTiles(request.models);
      const conversationId = request.conversationId;
      let startFired = false;
      // Boxed: flips inside the postRun closure across awaits, which
      // control-flow narrowing cannot see.
      const ownership = { resolved: false };
      const localRunIds = new Set<string>();

      markPendingLocalRun(conversationId);
      const postRun = async (): Promise<RunStartResponse> => {
        const response = await parseRunStartResponse(
          await postWithTransportRetry(() => post(idempotencyKey))
        );
        if (response.kind === 'started') {
          resolvePendingLocalRun(conversationId, response.runId);
          ownership.resolved = true;
          localRunIds.add(response.runId);
        }
        if (response.kind !== 'replay' && !startFired) {
          startFired = true;
          options?.onStart?.({
            userMessageId: request.userMessage.id,
            models: tiles.map((tile) => ({
              modelId: tile.modelId,
              assistantMessageId: tile.assistantMessageId,
            })),
          });
        }
        return response;
      };

      try {
        return await runAuthenticated({
          conversationId,
          tiles,
          userMessageId: request.userMessage.id,
          postRun,
          options,
        });
      } finally {
        if (!ownership.resolved) clearPendingLocalRun(conversationId);
        for (const runId of localRunIds) releaseLocalRun(conversationId, runId);
        options?.onAllStreamsSettled?.();
      }
    },
    [runAuthenticated]
  );

  const runTrial = useCallback(
    async (request: TrialStreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      const idempotencyKey = crypto.randomUUID();
      const trialToken = getTrialToken();
      const lastMessage = request.messages.at(-1);
      if (lastMessage?.role !== 'user') {
        throw new ChatRequestError('VALIDATION');
      }
      const history = request.messages
        .slice(0, -1)
        .filter((m) => m.content.length > 0)
        .map((m) => ({ role: m.role, content: m.content }));
      const tiles = buildTiles([request.model]);
      let startFired = false;

      const postRun = async (): Promise<RunStartResponse> => {
        const send = (): Promise<Response> =>
          client.chat.trial.$post(
            {
              json: {
                model: request.model,
                prompt: lastMessage.content,
                ...(request.webSearchEnabled === undefined
                  ? {}
                  : { webSearchEnabled: request.webSearchEnabled }),
                ...(history.length > 0 ? { history } : {}),
              },
            },
            {
              headers: {
                'Idempotency-Key': idempotencyKey,
                'x-trial-token': trialToken,
              },
            }
          );
        const response = await parseRunStartResponse(await postWithTransportRetry(send));
        if (response.kind === 'started') {
          storeTrialSessionId(response.trialSessionId);
        }
        if (response.kind !== 'replay' && !startFired) {
          startFired = true;
          options?.onStart?.({
            userMessageId: '',
            models: tiles.map((tile) => ({
              modelId: tile.modelId,
              assistantMessageId: tile.assistantMessageId,
            })),
          });
        }
        return response;
      };

      const socket = acquireTrialSocket(trialToken);
      const ttsFeeder = await startChatTtsStream({
        messageId: () => tiles[0]?.assistantMessageId ?? null,
      });
      try {
        const result = await executeChatRun({
          socket: socket as RunTransportSocket,
          postRun,
          tiles,
          callbacks: wireCallbacks(options, tiles[0]?.assistantMessageId ?? '', ttsFeeder),
        });
        return toStreamResult(result, '');
      } finally {
        ttsFeeder?.end();
        releaseTrialSocket(trialToken);
        options?.onAllStreamsSettled?.();
      }
    },
    []
  );

  const track = useCallback(
    async (work: () => Promise<StreamResult>): Promise<StreamResult> => {
      processingCountRef.current += 1;
      setIsStreaming(true);
      useStreamingActivityStore.getState().startStream();
      try {
        return await work();
      } finally {
        releaseProcessing();
        // endStream() is deliberately NOT called here: the caller ends the
        // activity window after its post-stream work (query invalidations)
        // completes, preventing a settled-signal baton drop.
      }
    },
    [releaseProcessing]
  );

  const startStream = useCallback(
    (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      if (mode === 'trial') {
        return track(() => runTrial(request as TrialStreamRequest, options));
      }
      const authenticated = request as AuthenticatedStreamRequest;
      return track(() =>
        runTurn(authenticated, options, (key) => {
          const body = buildTurnBody(authenticated);
          const headers = { 'Idempotency-Key': key };
          return getLinkGuestAuth()
            ? client.chat.guest.$post({ json: body }, { headers })
            : client.chat.$post({ json: body }, { headers });
        })
      );
    },
    [mode, track, runTurn, runTrial]
  );

  const startRegenerateStream = useCallback(
    (request: RegenerateStreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      return track(() =>
        runTurn(request, options, (key) => {
          const primary = request.models[0];
          if (primary === undefined) throw new ChatRequestError('VALIDATION');
          return client.chat.regenerate.$post(
            {
              json: {
                conversationId: request.conversationId,
                model: primary,
                modality: wireModality(request.modality),
                // Legacy regenerate shape: the per-tile list rides `models`
                // explicitly (one element or more) so retry-one and retry-all
                // are distinguished only by `replaceAssistantId`. The Smart
                // Model sentinel is the exception — the server forbids a
                // `models` list alongside it (the classifier resolves the one
                // answering model), so the sentinel rides only `model`.
                ...(primary === SMART_MODEL_ID ? {} : { models: request.models }),
                ...(request.imageConfig === undefined ? {} : { imageConfig: request.imageConfig }),
                ...(request.videoConfig === undefined ? {} : { videoConfig: request.videoConfig }),
                targetMessageId: request.targetMessageId,
                action: request.action,
                ...(request.replaceAssistantId === undefined
                  ? {}
                  : { replaceAssistantId: request.replaceAssistantId }),
                ...(request.forkId === undefined ? {} : { forkId: request.forkId }),
                userMessage: request.userMessage,
                history: toHistory(request.messagesForInference, request.userMessage.content),
              },
            },
            { headers: { 'Idempotency-Key': key } }
          );
        })
      );
    },
    [track, runTurn]
  );

  const stopRun = useCallback(async (conversationId: string): Promise<boolean> => {
    const response = await client.chat.stop.$post(
      { json: { conversationId } },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    );
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { code, details } = extractErrorBody(data);
      throw new ChatRequestError(code, details, response.status);
    }
    return typeof data === 'object' && data !== null && 'stopped' in data
      ? Boolean((data as { stopped: unknown }).stopped)
      : false;
  }, []);

  return { isStreaming, startStream, startRegenerateStream, stopRun };
}
