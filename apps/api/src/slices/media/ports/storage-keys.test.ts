import { describe, expect, it } from 'vitest';
import {
  INPUTS_PREFIX,
  INPUTS_STAGING_TTL_SECONDS,
  MEDIA_PREFIX,
  STAGING_REF_METADATA_KEY,
  STAGING_RUN_ID_METADATA_KEY,
  mediaObjectKey,
  parseStagingInputKey,
  stagingInputKey,
  stagingInputMetadata,
  validateStagingBinding,
} from './storage-keys.js';

const CONVERSATION_ID = '0190b56a-7d3e-7aaa-bbbb-0123456789ab';
const MESSAGE_ID = '0190b56a-7d3e-7ccc-bbbb-0123456789ab';
const OBJECT_ID = '0190b56a-7d3e-7ddd-bbbb-0123456789ab';
const RUN_ID = '0190b56a-7d3e-7eee-bbbb-0123456789ab';

describe('mediaObjectKey', () => {
  it('builds media/{conversationId}/{messageId}/{objectId} from uuids', () => {
    const key = mediaObjectKey({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      objectId: OBJECT_ID,
    });
    expect(key).toBe(`${MEDIA_PREFIX}${CONVERSATION_ID}/${MESSAGE_ID}/${OBJECT_ID}`);
  });

  it.each(['conversationId', 'messageId', 'objectId'] as const)(
    'throws when %s is not a uuid',
    (field) => {
      const location = {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        objectId: OBJECT_ID,
        [field]: 'not-a-uuid',
      };
      expect(() => mediaObjectKey(location)).toThrow(/uuid/);
    }
  );

  it('rejects a sha256-like hex digest as a key segment', () => {
    expect(() =>
      mediaObjectKey({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        objectId: 'a'.repeat(64),
      })
    ).toThrow(/uuid/);
  });
});

describe('stagingInputKey', () => {
  it('builds inputs/{runId}/{objectId} from uuids', () => {
    const key = stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID });
    expect(key).toBe(`${INPUTS_PREFIX}${RUN_ID}/${OBJECT_ID}`);
  });

  it.each(['runId', 'objectId'] as const)('throws when %s is not a uuid', (field) => {
    const location = { runId: RUN_ID, objectId: OBJECT_ID, [field]: 'not-a-uuid' };
    expect(() => stagingInputKey(location)).toThrow(/uuid/);
  });
});

describe('parseStagingInputKey', () => {
  it('round-trips a key built by stagingInputKey', () => {
    const key = stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID });
    expect(parseStagingInputKey(key)).toEqual({ runId: RUN_ID, objectId: OBJECT_ID });
  });

  it('returns null for a media-class key', () => {
    const key = mediaObjectKey({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      objectId: OBJECT_ID,
    });
    expect(parseStagingInputKey(key)).toBeNull();
  });

  it('returns null when a segment is not a uuid', () => {
    expect(parseStagingInputKey(`${INPUTS_PREFIX}not-a-uuid/${OBJECT_ID}`)).toBeNull();
  });

  it('returns null when the key has extra segments', () => {
    expect(parseStagingInputKey(`${INPUTS_PREFIX}${RUN_ID}/${OBJECT_ID}/extra`)).toBeNull();
  });
});

describe('stagingInputMetadata', () => {
  it('binds the runId under the run-id metadata key', () => {
    const metadata = stagingInputMetadata({ runId: RUN_ID, objectId: OBJECT_ID });
    expect(metadata[STAGING_RUN_ID_METADATA_KEY]).toBe(RUN_ID);
  });

  it('binds the full staging key under the ref metadata key', () => {
    const metadata = stagingInputMetadata({ runId: RUN_ID, objectId: OBJECT_ID });
    expect(metadata[STAGING_REF_METADATA_KEY]).toBe(
      stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID })
    );
  });
});

describe('validateStagingBinding', () => {
  const stagingKey = stagingInputKey({ runId: RUN_ID, objectId: OBJECT_ID });
  const binding = stagingInputMetadata({ runId: RUN_ID, objectId: OBJECT_ID });

  it('returns null for a non-staging key without metadata', () => {
    const mediaKey = mediaObjectKey({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      objectId: OBJECT_ID,
    });
    expect(validateStagingBinding(mediaKey)).toBeNull();
  });

  it('returns null when the staging metadata matches the key', () => {
    expect(validateStagingBinding(stagingKey, binding)).toBeNull();
  });

  it('returns a validation error when metadata is missing', () => {
    expect(validateStagingBinding(stagingKey)?.code).toBe('validation');
  });

  it('returns a validation error when the bound runId mismatches the key', () => {
    const metadata = { ...binding, [STAGING_RUN_ID_METADATA_KEY]: OBJECT_ID };
    expect(validateStagingBinding(stagingKey, metadata)?.code).toBe('validation');
  });

  it('returns a validation error when the bound ref mismatches the key', () => {
    const metadata = { ...binding, [STAGING_REF_METADATA_KEY]: 'inputs/other' };
    expect(validateStagingBinding(stagingKey, metadata)?.code).toBe('validation');
  });

  it('returns a validation error for a malformed inputs/ key', () => {
    expect(validateStagingBinding(`${INPUTS_PREFIX}not-a-uuid/x`, binding)?.code).toBe(
      'validation'
    );
  });
});

describe('INPUTS_STAGING_TTL_SECONDS', () => {
  it('exceeds the max flow deadline plus GC margin', () => {
    // GC never deletes an object younger than max-flow-deadline (~15 min)
    // + margin; the staging TTL must not undercut a live media run.
    const maxFlowDeadlineSeconds = 15 * 60;
    const gcMarginSeconds = 5 * 60;
    expect(INPUTS_STAGING_TTL_SECONDS).toBeGreaterThanOrEqual(
      maxFlowDeadlineSeconds + gcMarginSeconds
    );
  });
});
