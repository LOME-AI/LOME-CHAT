import { describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { RawModel } from '@hushbox/shared/models';
import type { AppEnv } from '../types.js';
import type { AIClient } from '../services/ai/index.js';
import { getProcessedCatalog } from './processed-catalog.js';

function rawText(id: string, prompt = '0.0001', completion = '0.0004'): RawModel {
  return {
    id,
    name: id,
    description: 'text',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt, completion },
    supported_parameters: [],
    created: Math.floor((Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  };
}

function makeContext(rawModels: RawModel[]): {
  c: Context<AppEnv>;
  listRawModelsSpy: ReturnType<typeof vi.fn>;
} {
  const listRawModelsSpy = vi.fn().mockResolvedValue(rawModels);
  const aiClient = { listRawModels: listRawModelsSpy } as unknown as AIClient;
  const c = { var: { aiClient } } as unknown as Context<AppEnv>;
  return { c, listRawModelsSpy };
}

describe('getProcessedCatalog', () => {
  it('returns the processed catalog from the AI client', async () => {
    const { c } = makeContext([rawText('openai/gpt-5-nano')]);
    const result = await getProcessedCatalog(c);
    expect(result.models.find((m) => m.id === 'openai/gpt-5-nano')).toBeDefined();
    expect(Array.isArray(result.premiumIds)).toBe(true);
  });

  it('memoizes within a single context — second call does NOT refetch', async () => {
    const { c, listRawModelsSpy } = makeContext([rawText('openai/gpt-5-nano')]);
    await getProcessedCatalog(c);
    await getProcessedCatalog(c);
    await getProcessedCatalog(c);
    expect(listRawModelsSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the same Promise instance on subsequent calls', () => {
    const { c } = makeContext([rawText('openai/gpt-5-nano')]);
    const first = getProcessedCatalog(c);
    const second = getProcessedCatalog(c);
    expect(first).toBe(second);
  });

  it('does not share memoization across contexts', async () => {
    const a = makeContext([rawText('openai/gpt-5-nano')]);
    const b = makeContext([rawText('anthropic/claude-haiku-4.5')]);
    await getProcessedCatalog(a.c);
    await getProcessedCatalog(b.c);
    expect(a.listRawModelsSpy).toHaveBeenCalledTimes(1);
    expect(b.listRawModelsSpy).toHaveBeenCalledTimes(1);
  });

  it('caches rejections — second call surfaces the same error without re-hitting the client', async () => {
    const error = new Error('upstream gateway 503');
    const listRawModelsSpy = vi.fn().mockRejectedValue(error);
    const aiClient = { listRawModels: listRawModelsSpy } as unknown as AIClient;
    const c = { var: { aiClient } } as unknown as Context<AppEnv>;
    await expect(getProcessedCatalog(c)).rejects.toBe(error);
    await expect(getProcessedCatalog(c)).rejects.toBe(error);
    expect(listRawModelsSpy).toHaveBeenCalledTimes(1);
  });
});
