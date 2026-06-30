import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { contentItems } from '../schema/content-items';

type ContentItem = typeof contentItems.$inferSelect;

const MEDIA_MODELS = ['google/imagen-4', 'google/veo-3.1', 'anthropic/claude-sonnet-4.6'];

/**
 * Base factory — defaults to a user-authored text content item. Use the
 * content-type traits below for media items.
 */
export const contentItemFactory = Factory.define<ContentItem>(() => ({
  id: crypto.randomUUID(),
  messageId: crypto.randomUUID(),
  contentType: 'text',
  position: 0,
  encryptedBlob: placeholderBytes(128),
  storageKey: null,
  mimeType: null,
  sizeBytes: null,
  width: null,
  height: null,
  durationMs: null,
  modelName: null,
  cost: null,
  isSmartModel: false,
  createdAt: faker.date.recent(),
}));

/**
 * An AI-authored text content item: model_name and cost populated alongside
 * the inline encrypted_blob.
 */
export const aiTextContentItemFactory = contentItemFactory.params({
  modelName: faker.helpers.arrayElement(MEDIA_MODELS),
  cost: faker.number.float({ min: 0.0001, max: 0.05 }).toFixed(8),
});

export const imageContentItemFactory = contentItemFactory.params({
  contentType: 'image',
  encryptedBlob: null,
  storageKey: `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}.enc`,
  mimeType: 'image/png',
  sizeBytes: faker.number.int({ min: 50_000, max: 5_000_000 }),
  width: 1024,
  height: 1024,
  durationMs: null,
  modelName: 'google/imagen-4',
  cost: faker.number.float({ min: 0.001, max: 0.1 }).toFixed(8),
});

export const audioContentItemFactory = contentItemFactory.params({
  contentType: 'audio',
  encryptedBlob: null,
  storageKey: `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}.enc`,
  mimeType: 'audio/mpeg',
  sizeBytes: faker.number.int({ min: 10_000, max: 1_000_000 }),
  width: null,
  height: null,
  durationMs: faker.number.int({ min: 1000, max: 60_000 }),
  modelName: 'openai/tts-1',
  cost: faker.number.float({ min: 0.001, max: 0.05 }).toFixed(8),
});

export const videoContentItemFactory = contentItemFactory.params({
  contentType: 'video',
  encryptedBlob: null,
  storageKey: `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}.enc`,
  mimeType: 'video/mp4',
  sizeBytes: faker.number.int({ min: 500_000, max: 50_000_000 }),
  width: 1920,
  height: 1080,
  durationMs: faker.number.int({ min: 1000, max: 8000 }),
  modelName: 'google/veo-3.1',
  cost: faker.number.float({ min: 0.05, max: 1 }).toFixed(8),
});
