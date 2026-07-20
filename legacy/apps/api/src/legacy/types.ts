import type { Redis } from '@upstash/redis';
import type { Database } from '@hushbox/db';
import type { EnvUtilities, Platform } from '@hushbox/shared';
import type { AIClient } from './services/ai/index.js';
import type { HelcimClient } from './services/helcim/index.js';
import type { MediaStorage } from './services/storage/index.js';
import type { SessionData } from './lib/session.js';

/** Minimal Durable Object namespace binding (avoids leaking @cloudflare/workers-types globally) */
interface DONamespaceBinding {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(request: Request): Promise<Response> };
}

/**
 * Minimal R2 bucket binding (avoids leaking @cloudflare/workers-types globally).
 * Matches the shape of Cloudflare's Workers R2 binding for put/get/delete.
 */
export interface R2BucketBinding {
  get(key: string): Promise<{
    body: ReadableStream;
    httpMetadata?: { contentType?: string };
    size: number;
  } | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface Bindings {
  DATABASE_URL: string;
  APP_VERSION: string;
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
  RESEND_API_KEY?: string;
  AI_GATEWAY_API_KEY?: string;
  PUBLIC_MODELS_URL?: string;
  HELCIM_API_TOKEN?: string;
  HELCIM_WEBHOOK_VERIFIER?: string;
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FRONTEND_URL?: string;
  FRONTEND_PREVIEW_URL?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  OPAQUE_MASTER_SECRET?: string;
  IRON_SESSION_SECRET?: string;
  /** R2 S3 API endpoint — full read/write scope, used by aws4fetch for all storage operations. */
  R2_S3_ENDPOINT?: string;
  /** R2 S3 API access key id — full read/write scope, used by aws4fetch for all storage operations. */
  R2_ACCESS_KEY_ID?: string;
  /** R2 S3 API secret access key — full read/write scope, used by aws4fetch for all storage operations. */
  R2_SECRET_ACCESS_KEY?: string;
  /** R2 bucket name for media. Used by the aws4fetch S3 client for all operations. */
  R2_BUCKET_MEDIA?: string;
  CONVERSATION_ROOM?: DONamespaceBinding;
  APP_BUILDS?: R2BucketBinding;
}

export interface Variables {
  platform: Platform;
  db: Database;
  redis: Redis;
  aiClient: AIClient;
  mediaStorage: MediaStorage;
  helcim: HelcimClient;
  envUtils: EnvUtilities;
  user: {
    id: string;
    email: string | null;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
    publicKey: Uint8Array;
  } | null;
  members: Map<string, { id: string; privilege: string; visibleFromEpoch: number }>;
  callerId: string;
  conversationOwnerId: string;
  linkGuest: { linkId: string; publicKey: Uint8Array } | null;
  /**
   * Authenticated caller for the `/api/media/:id/download-url` route.
   * Set by `requireMediaCaller()`. Tagged union: session users carry their
   * `userId` (used for the conversation_members.user_id JOIN), link guests
   * carry their `linkId` (used for the conversation_members.link_id JOIN).
   * Both kinds carry the public key keyed in `epoch_members` for the
   * epoch-gating check.
   */
  mediaCaller:
    | { kind: 'user'; userId: string; publicKey: Uint8Array }
    | { kind: 'link'; linkId: string; publicKey: Uint8Array };
  session: SessionData | null;
  sessionData: SessionData | null;
}

export interface AppEnv {
  Bindings: Bindings;
  Variables: Variables;
}
