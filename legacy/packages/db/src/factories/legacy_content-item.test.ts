import { describe, it, expect } from 'vitest';

import {
  contentItemFactory,
  aiTextContentItemFactory,
  imageContentItemFactory,
  audioContentItemFactory,
  videoContentItemFactory,
} from './legacy_content-item';

describe('contentItemFactory', () => {
  it('builds a user-authored text content item by default', () => {
    const item = contentItemFactory.build();

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.messageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(item.contentType).toBe('text');
    expect(item.position).toBe(0);
    expect(item.encryptedBlob).toBeInstanceOf(Uint8Array);
    expect(item.storageKey).toBeNull();
    expect(item.mimeType).toBeNull();
    expect(item.sizeBytes).toBeNull();
    expect(item.width).toBeNull();
    expect(item.height).toBeNull();
    expect(item.durationMs).toBeNull();
    expect(item.modelName).toBeNull();
    expect(item.cost).toBeNull();
    expect(item.isSmartModel).toBe(false);
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  it('allows overriding position and messageId', () => {
    const messageId = crypto.randomUUID();
    const item = contentItemFactory.build({ messageId, position: 3 });
    expect(item.messageId).toBe(messageId);
    expect(item.position).toBe(3);
  });

  it('builds a list of items with unique ids', () => {
    const items = contentItemFactory.buildList(3);
    const ids = new Set(items.map((index) => index.id));
    expect(ids.size).toBe(3);
  });
});

describe('aiTextContentItemFactory', () => {
  it('populates model_name and cost for an AI-authored text item', () => {
    const item = aiTextContentItemFactory.build();

    expect(item.contentType).toBe('text');
    expect(item.encryptedBlob).toBeInstanceOf(Uint8Array);
    expect(item.storageKey).toBeNull();
    expect(item.modelName).toEqual(expect.any(String));
    expect(item.cost).toEqual(expect.any(String));
  });
});

describe('imageContentItemFactory', () => {
  it('builds an image content item with required media fields', () => {
    const item = imageContentItemFactory.build();

    expect(item.contentType).toBe('image');
    expect(item.encryptedBlob).toBeNull();
    expect(item.storageKey).toEqual(expect.any(String));
    expect(item.mimeType).toBe('image/png');
    expect(item.sizeBytes).toEqual(expect.any(Number));
    expect(item.width).toBe(1024);
    expect(item.height).toBe(1024);
    expect(item.durationMs).toBeNull();
    expect(item.modelName).toEqual(expect.any(String));
    expect(item.cost).toEqual(expect.any(String));
  });
});

describe('audioContentItemFactory', () => {
  it('builds an audio content item with duration_ms and no dimensions', () => {
    const item = audioContentItemFactory.build();

    expect(item.contentType).toBe('audio');
    expect(item.encryptedBlob).toBeNull();
    expect(item.storageKey).toEqual(expect.any(String));
    expect(item.mimeType).toBe('audio/mpeg');
    expect(item.sizeBytes).toEqual(expect.any(Number));
    expect(item.width).toBeNull();
    expect(item.height).toBeNull();
    expect(item.durationMs).toEqual(expect.any(Number));
  });
});

describe('videoContentItemFactory', () => {
  it('builds a video content item with dimensions and duration_ms', () => {
    const item = videoContentItemFactory.build();

    expect(item.contentType).toBe('video');
    expect(item.encryptedBlob).toBeNull();
    expect(item.storageKey).toEqual(expect.any(String));
    expect(item.mimeType).toBe('video/mp4');
    expect(item.sizeBytes).toEqual(expect.any(Number));
    expect(item.width).toBe(1920);
    expect(item.height).toBe(1080);
    expect(item.durationMs).toEqual(expect.any(Number));
  });
});
