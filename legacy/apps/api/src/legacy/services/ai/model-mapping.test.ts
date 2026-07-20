import { describe, it, expect } from 'vitest';
import { applyFees } from '@hushbox/shared';
import { rawModelToModelInfo } from './model-mapping.js';
import type { RawModel } from '@hushbox/shared/models';

function textModel(overrides: Partial<RawModel> = {}): RawModel {
  return {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    description: 'Fast model',
    modality: 'text',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    supported_parameters: [],
    created: 0,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...overrides,
  };
}

describe('rawModelToModelInfo', () => {
  describe('provider extraction', () => {
    it('uses the id prefix before the first slash', () => {
      const info = rawModelToModelInfo(textModel({ id: 'anthropic/claude-sonnet-4.6' }));
      expect(info.provider).toBe('anthropic');
    });

    it('returns the full id when there is no slash', () => {
      const info = rawModelToModelInfo(textModel({ id: 'no-slash-id' }));
      expect(info.provider).toBe('no-slash-id');
    });

    it('falls back to "unknown" when the id is empty', () => {
      const info = rawModelToModelInfo(textModel({ id: '' }));
      expect(info.provider).toBe('unknown');
    });
  });

  describe('text pricing', () => {
    it('returns webSearchPerCall when web_search is set', () => {
      const info = rawModelToModelInfo(
        textModel({ pricing: { prompt: '0.000003', completion: '0.000015', web_search: '0.005' } })
      );
      if (info.pricing.kind !== 'token') throw new Error('expected token pricing');
      expect(info.pricing.webSearchPerCall).toBeCloseTo(0.005, 6);
    });

    it('omits webSearchPerCall when web_search is undefined', () => {
      const info = rawModelToModelInfo(textModel());
      if (info.pricing.kind !== 'token') throw new Error('expected token pricing');
      expect(info.pricing.webSearchPerCall).toBeUndefined();
    });
  });

  describe('image pricing', () => {
    function imageModel(overrides: Partial<RawModel['pricing']> = {}): RawModel {
      return textModel({
        id: 'google/imagen-4',
        modality: 'image',
        context_length: 0,
        pricing: { prompt: '0', completion: '0', ...overrides },
        architecture: { input_modalities: ['image'], output_modalities: ['image'] },
      });
    }

    it('parses per_image when present and bakes in fees', () => {
      const info = rawModelToModelInfo(imageModel({ per_image: '0.04' }));
      if (info.pricing.kind !== 'image') throw new Error('expected image pricing');
      expect(info.pricing.perImage).toBeCloseTo(applyFees(0.04), 15);
    });

    it('returns perImage = 0 when per_image is undefined', () => {
      const info = rawModelToModelInfo(imageModel());
      if (info.pricing.kind !== 'image') throw new Error('expected image pricing');
      expect(info.pricing.perImage).toBe(0);
    });
  });

  describe('video pricing', () => {
    function videoModel(overrides: Partial<RawModel['pricing']> = {}): RawModel {
      return textModel({
        id: 'google/veo-3.1',
        modality: 'video',
        context_length: 0,
        pricing: { prompt: '0', completion: '0', ...overrides },
        architecture: { input_modalities: ['video'], output_modalities: ['video'] },
      });
    }

    it('maps per_second_by_resolution entries to numeric fee-inclusive values', () => {
      const info = rawModelToModelInfo(
        videoModel({ per_second_by_resolution: { '720p': '0.1', '1080p': '0.15' } })
      );
      if (info.pricing.kind !== 'video') throw new Error('expected video pricing');
      expect(info.pricing.perSecondByResolution['720p']).toBeCloseTo(applyFees(0.1), 15);
      expect(info.pricing.perSecondByResolution['1080p']).toBeCloseTo(applyFees(0.15), 15);
    });

    it('returns an empty resolution map when per_second_by_resolution is undefined', () => {
      const info = rawModelToModelInfo(videoModel());
      if (info.pricing.kind !== 'video') throw new Error('expected video pricing');
      expect(info.pricing.perSecondByResolution).toEqual({});
    });
  });

  describe('audio pricing', () => {
    it('hardcodes perSecond to 0 regardless of raw per_second', () => {
      // The mapper deliberately does not read per_second; the gateway fetcher
      // doesn't extract audio pricing yet. Asserting both shapes pins the
      // contract: callers needing real audio prices override on ModelInfo.
      const withPrice = rawModelToModelInfo(
        textModel({
          id: 'openai/tts-1',
          modality: 'audio',
          context_length: 0,
          pricing: { prompt: '0', completion: '0', per_second: '0.015' },
          architecture: { input_modalities: ['audio'], output_modalities: ['audio'] },
        })
      );
      if (withPrice.pricing.kind !== 'audio') throw new Error('expected audio pricing');
      expect(withPrice.pricing.perSecond).toBe(0);
    });
  });

  describe('unknown modality', () => {
    it('throws via assertNever when a rogue modality slips past type checking', () => {
      const rogue = textModel({ modality: 'rogue' as 'text' });
      expect(() => rawModelToModelInfo(rogue)).toThrow(/exhaustiveness|never|rogue/i);
    });
  });
});
