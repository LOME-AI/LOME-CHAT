import {
  asEpochPublicKey,
  encryptContentEnvelope,
  generateContentKey,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import { mediaObjectKey } from '../../media/index.js';
import { StorageUnavailableError } from '../../workflows/index.js';
import { ASSISTANT_SENDER_ID } from './settlement.js';
import { MEDIA_TURN_MIME_TYPES } from './turn-definition.js';
import type { MediaTurnModality } from './turn-definition.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { Storage } from '../../media/index.js';
import type { DomainErrorCode } from '../../../lib/errors/index.js';
import type { ContentKey, WrappedSecret } from '@hushbox/crypto';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type {
  FilePartMapper,
  FilePartMediaEvents,
  MediaPersistPlan,
  WorkflowDefinition,
} from '@hushbox/shared';

/**
 * The media turn's pre-minted persistence identities and the per-node
 * file-part mappers that encrypt + store generated media to R2 DURING
 * streaming, under the final `media/{conversationId}/{messageId}/{contentItemId}`
 * key — media cannot wait for settlement to name its content. The content KEY
 * lives only inside these closures; plans carry only the epoch-wrapped form.
 *
 * A retried run mints FRESH identities (the key-row referee replays `succeeded`
 * without re-executing; an expired-lease retry is a new execution), so an
 * orphaned object from a killed run is never re-addressed — the min-age R2 GC
 * reclaims it.
 */

/** The slice of a media `modelCall` node the mint needs: its charge key and params. */
export interface MediaPersistNode {
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * The media-turn detection signal: `deadlineClass === 'media'`. In the chat
 * runtime `buildMediaTurn` is the ONLY producer of media-classed definitions
 * (text and Smart Model turns are `text`-classed), and its nodes are exactly
 * the 1–5 media `modelCall` siblings — so the media nodes of a media-classed
 * definition are all of its `modelCall` nodes. A text-classed definition
 * yields nothing, keeping the text path untouched.
 */
export function mediaCallNodes(definition: WorkflowDefinition): readonly MediaPersistNode[] {
  if (definition.deadlineClass !== 'media') return [];
  return definition.nodes
    .filter((node) => node.type === 'modelCall')
    .map((node) => ({ id: node.id, params: node.params }));
}

export interface MediaPersistDeps {
  readonly storage: Storage;
  /** Handle the epoch read runs on (the pre-run read is outside any transaction). */
  readonly db: DbWriter;
  readonly readEpochPublicKey: EpochPublicKeyReader;
  readonly newId: () => string;
}

export interface MediaPersistIdentity {
  readonly conversationId: string;
  readonly epochNumber: number;
}

export interface MediaPersistRun {
  /**
   * Node id → plan, the SAME instance the settlement identity carries as
   * `mediaPlans` — filled by `mint()`, so it must complete before the run
   * starts (and therefore before settlement can ever read it).
   */
  readonly plans: ReadonlyMap<string, MediaPersistPlan>;
  /** Pre-mints every node's persistence identity; must resolve before executor.start. */
  readonly mint: () => Promise<void>;
  /** Resolves the mapper bound to one node's plan; undefined for an unplanned node. */
  readonly mapFilePartFor: (nodeKey: string) => FilePartMapper | undefined;
  /**
   * The put barrier: resolves when every initiated storage put landed, rejects
   * with the first failure. Settlement awaits it before entering the fenced
   * transaction, so a lost ciphertext fails the run instead of committing a
   * content row that points at a missing object (saved ⟺ billed holds — an
   * involuntary failure bills nothing).
   */
  readonly flushPuts: () => Promise<void>;
}

/** Closure-only per-node state; the raw content key never leaves this module. */
interface MintedNode {
  readonly node: MediaPersistNode;
  readonly plan: MediaPersistPlan;
  readonly contentKey: ContentKey;
  readonly wrappedContentKey: WrappedSecret;
}

/**
 * Which modality a generated file's mime belongs to, per the media turn's
 * declared allowlist. `MEDIA_TURN_MIME_TYPES` governs — the same set the media
 * turn's produce tag declares — and the two modality sets are disjoint, so the
 * derivation is unambiguous; the R2 adapter re-validates the mime at `put`.
 * A mime outside the allowlist is a defect: the provider returned a file the
 * turn never declared, and it must never be encrypted or stored.
 */
function modalityForMime(mimeType: string): MediaTurnModality {
  for (const modality of Object.keys(MEDIA_TURN_MIME_TYPES) as MediaTurnModality[]) {
    if (MEDIA_TURN_MIME_TYPES[modality].includes(mimeType)) return modality;
  }
  throw new Error(
    `chat media persist: generated file mime "${mimeType}" is outside the media turn allowlist`
  );
}

/**
 * Best-effort dims from the node's declared request params (renderer
 * placeholder hints). Emits only STRING hints — settlement's numeric
 * width/height/durationMs extraction therefore persists null dims today,
 * deliberately: the columns are an optional hint, not a promise.
 */
function mediaMetadata(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const aspectRatio = params['aspectRatio'];
  const resolution = params['resolution'];
  return {
    ...(typeof aspectRatio === 'string' ? { aspectRatio } : {}),
    ...(typeof resolution === 'string' ? { resolution } : {}),
  };
}

export function createMediaPersistRun(
  deps: MediaPersistDeps,
  identity: MediaPersistIdentity,
  nodes: readonly MediaPersistNode[]
): MediaPersistRun {
  const plans = new Map<string, MediaPersistPlan>();
  const minted = new Map<string, MintedNode>();
  const pendingPuts: Promise<void>[] = [];
  let putFailure: Error | undefined;
  let mintOnce: Promise<void> | undefined;

  const mint = async (): Promise<void> => {
    const publicKeyBytes = await deps.readEpochPublicKey(
      deps.db,
      identity.conversationId,
      identity.epochNumber
    );
    if (publicKeyBytes === null) {
      throw new Error(
        `chat media persist: epoch public key missing for epoch ${String(identity.epochNumber)}`
      );
    }
    const epochPublicKey = asEpochPublicKey(publicKeyBytes);
    for (const node of nodes) {
      const contentKey = generateContentKey();
      const wrappedContentKey = wrapContentKeyToEpoch(epochPublicKey, contentKey);
      const plan: MediaPersistPlan = {
        assistantMessageId: deps.newId(),
        contentItemId: deps.newId(),
        epochNumber: identity.epochNumber,
        wrappedContentKey,
      };
      plans.set(node.id, plan);
      minted.set(node.id, { node, plan, contentKey, wrappedContentKey });
    }
  };

  /**
   * The typed error a failed ciphertext put surfaces at the flush barrier. An
   * availability-class storage failure (`unavailable`/`timeout` from the
   * adapter's Result channel) is an infra outage, not an engine defect: it
   * throws the typed StorageUnavailableError so the engine reroutes the run to
   * UNAVAILABLE and never captures it to Sentry. Any other code (e.g. a
   * validation-class rejection) stays a plain Error — a genuine defect the
   * engine surfaces as INTERNAL.
   */
  const putFailureFor = (key: string, code: DomainErrorCode): Error => {
    const message = `chat media persist: storage put failed for "${key}" (${code})`;
    return code === 'unavailable' || code === 'timeout'
      ? new StorageUnavailableError(message)
      : new Error(message);
  };

  const trackPut = (key: string, bytes: Uint8Array, mediaMimeType: string): void => {
    // Recorded, never rejected in-flight: the mapper contract is synchronous,
    // so the failure surfaces at the flush barrier (and defensively on the
    // next mapper call) instead of as an unhandled rejection.
    const settled = (async (): Promise<void> => {
      const result = await deps.storage.put(key, bytes, {
        contentType: 'application/octet-stream',
        mediaMimeType,
      });
      if (result.isErr()) {
        putFailure ??= putFailureFor(key, result.error.code);
      }
    })();
    pendingPuts.push(settled);
  };

  const mapperFor = (entry: MintedNode): FilePartMapper => {
    return (part, index): FilePartMediaEvents => {
      if (putFailure !== undefined) throw putFailure;
      if (index > 0) {
        // Legacy never produced >1 file per call and the node accumulator
        // silently last-wins — a provider violating that must kill the run
        // loudly, never silently drop a paid artifact.
        throw new Error(
          `chat media persist: provider emitted more than one file for node "${entry.node.id}"`
        );
      }
      const modality = modalityForMime(part.mediaType);
      const { conversationId } = identity;
      const { assistantMessageId, contentItemId, epochNumber } = entry.plan;
      const ciphertext = encryptContentEnvelope(
        entry.contentKey,
        entry.wrappedContentKey,
        {
          conversationId,
          messageId: assistantMessageId,
          contentItemId,
          position: 0,
          epochNumber,
          // The nil-uuid assistant sentinel, never the initiating user: the
          // initiator's id is scrubbed on account deletion, which would make
          // the artifact undecryptable for co-members.
          senderId: ASSISTANT_SENDER_ID,
        },
        part.data
      );
      const key = mediaObjectKey({
        conversationId,
        messageId: assistantMessageId,
        objectId: contentItemId,
      });
      trackPut(key, ciphertext, part.mediaType);
      return [
        { kind: 'media-start', index, modality, mimeType: part.mediaType },
        {
          kind: 'media-done',
          index,
          value: {
            ref: key,
            mimeType: part.mediaType,
            modality,
            // Ciphertext length, never plaintext: it becomes
            // content_items.sizeBytes and drives the storage fee.
            byteLength: ciphertext.length,
            metadata: mediaMetadata(entry.node.params),
          },
        },
      ];
    };
  };

  return {
    plans,
    mint: (): Promise<void> => (mintOnce ??= mint()),
    mapFilePartFor: (nodeKey): FilePartMapper | undefined => {
      const entry = minted.get(nodeKey);
      return entry === undefined ? undefined : mapperFor(entry);
    },
    flushPuts: async (): Promise<void> => {
      await Promise.all(pendingPuts);
      if (putFailure !== undefined) throw putFailure;
    },
  };
}
