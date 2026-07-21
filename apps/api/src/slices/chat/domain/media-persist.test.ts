import { describe, expect, it, vi } from 'vitest';
import { generateEpochKeyPair } from '@hushbox/crypto';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { StorageUnavailableError } from '../../workflows/index.js';
import { createMediaPersistRun, mediaCallNodes } from './media-persist.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID } from './constants.js';
import type { MediaPersistDeps, MediaPersistNode } from './media-persist.js';
import type { Storage } from '../../media/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';

const CONVERSATION_ID = crypto.randomUUID();
const EPOCH_NUMBER = 3;
const EPOCH_KEYS = generateEpochKeyPair();

/** The envelope's fixed overhead: version byte + XChaCha nonce + Poly1305 tag. */
const ENVELOPE_OVERHEAD_BYTES = 1 + 24 + 16;

function neverCalled(name: string): () => never {
  return () => {
    throw new Error(`${name} must not be called by the media persist run`);
  };
}

interface PutCall {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly options: { contentType: string; mediaMimeType?: string };
}

function fakeStorage(
  puts: PutCall[],
  outcome: 'ok' | 'fail' = 'ok',
  failCode: 'unavailable' | 'timeout' | 'validation' = 'unavailable'
): Storage {
  return {
    put: (key: string, bytes: Uint8Array, options: PutCall['options']) => {
      puts.push({ key, bytes, options });
      return outcome === 'ok'
        ? okAsync()
        : errAsync({ code: failCode, message: 'storage put failed' });
    },
    head: neverCalled('head'),
    delete: neverCalled('delete'),
    list: neverCalled('list'),
    presignGet: neverCalled('presignGet'),
  } as unknown as Storage;
}

function persistDeps(storage: Storage): MediaPersistDeps {
  return {
    storage,
    db: {} as MediaPersistDeps['db'],
    readEpochPublicKey: vi.fn(() => Promise.resolve(EPOCH_KEYS.publicKey as Uint8Array)),
    newId: () => crypto.randomUUID(),
  };
}

const IDENTITY = { conversationId: CONVERSATION_ID, epochNumber: EPOCH_NUMBER };

const IMAGE_NODE: MediaPersistNode = {
  id: CHAT_TURN_NODE_ID,
  params: { aspectRatio: '16:9' },
};

async function mintedRun(deps: MediaPersistDeps, nodes: readonly MediaPersistNode[]) {
  const run = createMediaPersistRun(deps, IDENTITY, nodes);
  await run.mint();
  return run;
}

function mediaDefinition(nodes: unknown[]): WorkflowDefinition {
  return {
    version: 1,
    deadlineClass: 'media',
    hooks: CHAT_TURN_HOOKS,
    nodes,
    edges: [],
  } as unknown as WorkflowDefinition;
}

const MODEL_CALL_NODE = {
  id: CHAT_TURN_NODE_ID,
  type: 'modelCall',
  model: 'x/img',
  params: { aspectRatio: '1:1' },
};

describe('mediaCallNodes (media-turn detection)', () => {
  it('returns the modelCall nodes of a media-classed definition', () => {
    const second = { ...MODEL_CALL_NODE, id: 'answer1' };
    const nodes = mediaCallNodes(mediaDefinition([MODEL_CALL_NODE, second]));
    expect(nodes.map((node) => node.id)).toEqual([CHAT_TURN_NODE_ID, 'answer1']);
    expect(nodes[0]?.params).toEqual({ aspectRatio: '1:1' });
  });

  it('returns nothing for a text-classed definition even when it has modelCall nodes', () => {
    const definition = {
      ...mediaDefinition([MODEL_CALL_NODE]),
      deadlineClass: 'text',
    } as unknown as WorkflowDefinition;
    expect(mediaCallNodes(definition)).toEqual([]);
  });

  it('ignores non-modelCall nodes inside a media definition', () => {
    const transform = { id: 't', type: 'transform', transform: 'x' };
    const nodes = mediaCallNodes(mediaDefinition([transform, MODEL_CALL_NODE]));
    expect(nodes.map((node) => node.id)).toEqual([CHAT_TURN_NODE_ID]);
  });
});

describe('createMediaPersistRun mint', () => {
  it('mints one plan per node with distinct pre-minted identities', async () => {
    const deps = persistDeps(fakeStorage([]));
    const run = await mintedRun(deps, [
      { id: 'answer0', params: {} },
      { id: 'answer1', params: {} },
    ]);
    const first = run.plans.get('answer0');
    const second = run.plans.get('answer1');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.assistantMessageId).not.toBe(second?.assistantMessageId);
    expect(first?.contentItemId).not.toBe(second?.contentItemId);
    expect(first?.epochNumber).toBe(EPOCH_NUMBER);
    expect(first?.wrappedContentKey.length).toBeGreaterThan(0);
    expect(first?.wrappedContentKey).not.toEqual(second?.wrappedContentKey);
  });

  it('reads the epoch public key once for the run', async () => {
    const deps = persistDeps(fakeStorage([]));
    await mintedRun(deps, [
      { id: 'a', params: {} },
      { id: 'b', params: {} },
    ]);
    expect(deps.readEpochPublicKey).toHaveBeenCalledTimes(1);
    expect(deps.readEpochPublicKey).toHaveBeenCalledWith(deps.db, CONVERSATION_ID, EPOCH_NUMBER);
  });

  it('rejects when the epoch public key is absent', async () => {
    const deps = {
      ...persistDeps(fakeStorage([])),
      readEpochPublicKey: () => Promise.resolve(null),
    };
    const run = createMediaPersistRun(deps, IDENTITY, [IMAGE_NODE]);
    await expect(run.mint()).rejects.toThrow(/epoch public key/);
  });

  it('never exposes the content key on the plan', async () => {
    const deps = persistDeps(fakeStorage([]));
    const run = await mintedRun(deps, [IMAGE_NODE]);
    const plan = run.plans.get(CHAT_TURN_NODE_ID);
    expect(Object.keys(plan ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'assistantMessageId',
      'contentItemId',
      'epochNumber',
      'wrappedContentKey',
    ]);
  });
});

describe('mapFilePartFor', () => {
  it('returns undefined for a node without a plan', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([])), [IMAGE_NODE]);
    expect(run.mapFilePartFor('unknown-node')).toBeUndefined();
  });

  it('encrypts and stores under the exact media/{conv}/{msg}/{item} key with the plaintext mime', async () => {
    const puts: PutCall[] = [];
    const run = await mintedRun(persistDeps(fakeStorage(puts)), [IMAGE_NODE]);
    const mapper = run.mapFilePartFor(CHAT_TURN_NODE_ID);
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

    const [start, done] = mapper!({ mediaType: 'image/png', data: plaintext }, 0);
    await run.flushPuts();

    const plan = run.plans.get(CHAT_TURN_NODE_ID)!;
    const expectedKey = `media/${CONVERSATION_ID}/${plan.assistantMessageId}/${plan.contentItemId}`;
    expect(puts).toHaveLength(1);
    expect(puts[0]?.key).toBe(expectedKey);
    expect(puts[0]?.options).toEqual({
      contentType: 'application/octet-stream',
      mediaMimeType: 'image/png',
    });

    expect(start).toEqual({
      kind: 'media-start',
      index: 0,
      modality: 'image',
      mimeType: 'image/png',
    });
    expect(done.kind).toBe('media-done');
    expect(done.value.ref).toBe(expectedKey);
    expect(done.value.mimeType).toBe('image/png');
    expect(done.value.modality).toBe('image');
    // Ciphertext length, never plaintext: sizeBytes and the storage fee bill
    // the stored bytes.
    expect(done.value.byteLength).toBe(puts[0]?.bytes.length);
    expect(done.value.byteLength).toBe(plaintext.length + ENVELOPE_OVERHEAD_BYTES);
    expect(done.value.byteLength).not.toBe(plaintext.length);
  });

  it('derives video modality from a video mime', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([])), [IMAGE_NODE]);
    const [start] = run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'video/mp4', data: new Uint8Array([9]) },
      0
    );
    expect(start).toMatchObject({ modality: 'video', mimeType: 'video/mp4' });
  });

  it('carries best-effort dims from the node params as metadata', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([])), [
      { id: 'v0', params: { resolution: '720p', durationSeconds: 5 } },
    ]);
    const [, done] = run.mapFilePartFor('v0')!(
      { mediaType: 'video/mp4', data: new Uint8Array([9]) },
      0
    );
    expect(done.value.metadata).toEqual({ resolution: '720p' });
  });

  it('carries empty metadata when the node params declare no dims', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([])), [{ id: 'v0', params: {} }]);
    const [, done] = run.mapFilePartFor('v0')!(
      { mediaType: 'image/webp', data: new Uint8Array([9]) },
      0
    );
    expect(done.value.metadata).toEqual({});
  });

  it('gives sibling nodes distinct storage keys and mappers', async () => {
    const puts: PutCall[] = [];
    const run = await mintedRun(persistDeps(fakeStorage(puts)), [
      { id: 'answer0', params: {} },
      { id: 'answer1', params: {} },
    ]);
    run.mapFilePartFor('answer0')!({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0);
    run.mapFilePartFor('answer1')!({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0);
    await run.flushPuts();
    expect(puts).toHaveLength(2);
    expect(puts[0]?.key).not.toBe(puts[1]?.key);
  });

  it('throws a defect on a second file (index > 0) without attempting the put', async () => {
    const puts: PutCall[] = [];
    const run = await mintedRun(persistDeps(fakeStorage(puts)), [IMAGE_NODE]);
    const mapper = run.mapFilePartFor(CHAT_TURN_NODE_ID)!;
    expect(() => mapper({ mediaType: 'image/png', data: new Uint8Array([1]) }, 1)).toThrow(
      /more than one file/
    );
    expect(puts).toHaveLength(0);
  });

  it('throws on a mime outside the media-turn allowlist before any put', async () => {
    const puts: PutCall[] = [];
    const run = await mintedRun(persistDeps(fakeStorage(puts)), [IMAGE_NODE]);
    const mapper = run.mapFilePartFor(CHAT_TURN_NODE_ID)!;
    expect(() => mapper({ mediaType: 'application/pdf', data: new Uint8Array([1]) }, 0)).toThrow(
      /allowlist/
    );
    expect(puts).toHaveLength(0);
  });
});

describe('flushPuts (put-failure propagation)', () => {
  it('rejects with the storage failure so the run settles nothing', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([], 'fail')), [IMAGE_NODE]);
    run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'image/png', data: new Uint8Array([1]) },
      0
    );
    await expect(run.flushPuts()).rejects.toThrow(/storage put failed/);
  });

  it('surfaces a recorded put failure synchronously on the next mapper call', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([], 'fail')), [
      { id: 'answer0', params: {} },
      { id: 'answer1', params: {} },
    ]);
    run.mapFilePartFor('answer0')!({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0);
    await expect(run.flushPuts()).rejects.toThrow(/storage put failed/);
    expect(() =>
      run.mapFilePartFor('answer1')!({ mediaType: 'image/png', data: new Uint8Array([1]) }, 0)
    ).toThrow(/storage put failed/);
  });

  it('resolves once every initiated put landed', async () => {
    const puts: PutCall[] = [];
    const run = await mintedRun(persistDeps(fakeStorage(puts)), [IMAGE_NODE]);
    run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'image/png', data: new Uint8Array([1]) },
      0
    );
    await expect(run.flushPuts()).resolves.toBeUndefined();
  });

  it('rejects an availability put failure as a typed StorageUnavailableError', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([], 'fail', 'unavailable')), [IMAGE_NODE]);
    run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'image/png', data: new Uint8Array([1]) },
      0
    );
    await expect(run.flushPuts()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('rejects a timeout put failure as a typed StorageUnavailableError', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([], 'fail', 'timeout')), [IMAGE_NODE]);
    run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'image/png', data: new Uint8Array([1]) },
      0
    );
    await expect(run.flushPuts()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('rejects a non-availability put failure as a plain defect error, never StorageUnavailableError', async () => {
    const run = await mintedRun(persistDeps(fakeStorage([], 'fail', 'validation')), [IMAGE_NODE]);
    run.mapFilePartFor(CHAT_TURN_NODE_ID)!(
      { mediaType: 'image/png', data: new Uint8Array([1]) },
      0
    );
    const error_ = await run.flushPuts().catch((error_: unknown): unknown => error_);
    expect(error_).toBeInstanceOf(Error);
    expect(error_).not.toBeInstanceOf(StorageUnavailableError);
  });
});

describe('mint idempotence', () => {
  it('mints once across repeated mint calls (one epoch read, stable plans)', async () => {
    const deps = persistDeps(fakeStorage([]));
    const run = createMediaPersistRun(deps, IDENTITY, [IMAGE_NODE]);
    await run.mint();
    const first = run.plans.get(CHAT_TURN_NODE_ID);
    await run.mint();
    expect(deps.readEpochPublicKey).toHaveBeenCalledTimes(1);
    expect(run.plans.get(CHAT_TURN_NODE_ID)).toBe(first);
  });
});
