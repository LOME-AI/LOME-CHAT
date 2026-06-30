import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { mediaGenerations } from '../schema/media-generations';

type MediaGeneration = typeof mediaGenerations.$inferSelect;

const IMAGE_MODELS = ['google/imagen-4', 'black-forest-labs/flux-1.1-pro'];
const VIDEO_MODELS = ['google/veo-3.1', 'bytedance/seedance-1-5-pro'];
const AUDIO_MODELS = ['openai/tts-1', 'elevenlabs/eleven-turbo'];

export const mediaGenerationFactory = Factory.define<MediaGeneration>(({ params }) => {
  const mediaType =
    params.mediaType ?? faker.helpers.arrayElement(['image', 'video', 'audio'] as const);

  let model: string;
  let imageCount: number | null = null;
  let durationMs: number | null = null;
  let resolution: string | null = null;

  if (mediaType === 'image') {
    model = faker.helpers.arrayElement(IMAGE_MODELS);
    imageCount = 1;
  } else if (mediaType === 'video') {
    model = faker.helpers.arrayElement(VIDEO_MODELS);
    durationMs = faker.number.int({ min: 1000, max: 8000 });
    resolution = faker.helpers.arrayElement(['720p', '1080p']);
  } else {
    model = faker.helpers.arrayElement(AUDIO_MODELS);
    durationMs = faker.number.int({ min: 1000, max: 60_000 });
  }

  const provider = model.split('/')[0] ?? 'unknown';

  return {
    id: crypto.randomUUID(),
    usageRecordId: crypto.randomUUID(),
    model,
    provider,
    mediaType,
    imageCount,
    durationMs,
    resolution,
  };
});
