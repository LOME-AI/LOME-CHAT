/** Content modality — shared across AIClient and model discovery. */
export type ChatModality = 'text' | 'image' | 'audio' | 'video';

/**
 * Raw model data sourced from the AI Gateway's unauthenticated public
 * `/v1/models` endpoint. Single source of truth for the catalog — production
 * and tests both read from the same path. Schema parsing happens at the
 * boundary in `fetch.ts`; shape drift fails loudly rather than silently
 * emitting `undefined`.
 */
export interface RawModel {
  id: string;
  name: string;
  description: string;
  modality: ChatModality;
  context_length: number;
  pricing: {
    /** Per-input-token USD from `/config`. "0" for non-language models. */
    prompt: string;
    /** Per-output-token USD from `/config`. "0" for non-language models. */
    completion: string;
    /** Per-web-search-call USD from `/config`. Set only when provider charges separately. */
    web_search?: string;
    /** Flat per-image USD from `/v1/models` pricing.image. Absent for image models that use variable pricing. */
    per_image?: string;
    /**
     * Per-second USD by resolution, from `/v1/models` pricing.video_duration_pricing.
     * Prefers the audio:true entry per resolution (HushBox always requests audio when supported).
     * Absent for video models that use per-token pricing.
     */
    per_second_by_resolution?: Record<string, string>;
    /**
     * Flat per-second USD for audio (TTS) models, from `/v1/models` pricing.
     * Audio is single-price (no per-resolution split). Absent for audio models
     * that use variable or token-based pricing.
     */
    per_second?: string;
  };
  supported_parameters: string[];
  created: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
}

/** Result of processing models */
export interface ProcessedModels {
  models: import('../schemas/api/models.js').Model[];
  premiumIds: string[];
}
