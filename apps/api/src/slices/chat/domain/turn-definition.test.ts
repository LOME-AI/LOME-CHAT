import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { MAX_SEARCH_TOOL_CALLS } from '@hushbox/shared';
import { WEB_SEARCH_TOOL_NAME } from '../../models/index.js';
import {
  assertModelProducesModality,
  assertModelsWebSearchCapable,
  assertWebSearchCapable,
  buildMediaTurn,
  buildMultiModelTurn,
  buildSingleModelTurn,
  createTurnCompileRegistries,
} from './turn-definition.js';
import { CHAT_TURN_NODE_ID } from './constants.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor } from '@hushbox/shared';

function descriptorFor(id: string, behaviors: string[] = []): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors,
    limits: { contextLength: 1000 },
    pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const KNOWN_MODELS = new Set(['answer-model', 'model-a', 'model-b', 'model-c']);
const resolver: ModelPricingResolver = (id) =>
  KNOWN_MODELS.has(id) ? descriptorFor(id) : undefined;

/** A text→media descriptor: the model consumes text and produces one media modality. */
function mediaDescriptorFor(id: string, output: 'image' | 'video'): ModelDescriptor {
  return { ...descriptorFor(id), inputs: ['text'], outputs: [output] };
}

const MEDIA_MODELS: Record<string, 'image' | 'video'> = {
  'image-model': 'image',
  'video-model': 'video',
};
const mediaResolver: ModelPricingResolver = (id) =>
  id in MEDIA_MODELS ? mediaDescriptorFor(id, MEDIA_MODELS[id]!) : undefined;

describe('buildSingleModelTurn', () => {
  it('compiles a one-node text turn for a known model', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({ model: 'answer-model', nodes, constraints });
    const definition = result._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    expect(definition.nodes.map((node) => node.id)).toContain(CHAT_TURN_NODE_ID);
  });

  it('refuses an unknown model with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({ model: 'nope', nodes, constraints });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('gives the answer node the web-search tool and step ceiling when enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSingleModelTurn({
      model: 'answer-model',
      nodes,
      constraints,
      webSearchEnabled: true,
    });
    const answer = result
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall' && node.id === CHAT_TURN_NODE_ID);
    expect(answer?.type === 'modelCall' && answer.tools).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(MAX_SEARCH_TOOL_CALLS);
  });

  it('leaves the answer node tool-free when web search is not enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const answer = buildSingleModelTurn({ model: 'answer-model', nodes, constraints })
      ._unsafeUnwrap()
      .nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.tools).toEqual([]);
    expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(1);
  });
});

describe('assertModelProducesModality', () => {
  it('is ok when the model is unknown (absent descriptor) — compile refuses it later', () => {
    expect(assertModelProducesModality(undefined, 'image').isOk()).toBe(true);
  });

  it('is ok when the model produces exactly the requested modality', () => {
    expect(assertModelProducesModality(mediaDescriptorFor('m', 'video'), 'video').isOk()).toBe(
      true
    );
  });

  it('refuses a text model for a media modality with a validation error', () => {
    expect(assertModelProducesModality(descriptorFor('m'), 'image')._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });

  it('refuses a media model producing a different modality', () => {
    expect(
      assertModelProducesModality(mediaDescriptorFor('m', 'image'), 'video')._unsafeUnwrapErr().code
    ).toBe('validation');
  });

  it('refuses a multi-output model (needs exactly one output)', () => {
    const multi: ModelDescriptor = { ...descriptorFor('m'), outputs: ['text', 'image'] };
    expect(assertModelProducesModality(multi, 'image')._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('buildMediaTurn', () => {
  it('compiles a one-node image turn for a text→image model, carrying its params', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'image-model',
      modality: 'image',
      params: { aspectRatio: '1:1' },
      nodes,
      constraints,
    });
    const definition = result._unsafeUnwrap();
    // A media turn is deadline-classed 'media', not 'text'.
    expect(definition.deadlineClass).toBe('media');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.model).toBe('image-model');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ aspectRatio: '1:1' });
  });

  it('compiles a one-node video turn for a text→video model, carrying its params', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'video-model',
      modality: 'video',
      params: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      nodes,
      constraints,
    });
    const answer = result._unsafeUnwrap().nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      aspectRatio: '16:9',
      durationSeconds: 6,
      resolution: '720p',
    });
  });

  it('refuses a media turn whose model is unknown with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    const result = buildMediaTurn({
      model: 'nope',
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a media turn whose model produces the wrong modality (a text model for image)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(mediaResolver);
    // 'answer-model' is a text→text model, absent from the media resolver, so an
    // image turn over it fails the build closed.
    const result = buildMediaTurn({
      model: 'answer-model',
      modality: 'image',
      params: {},
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('assertWebSearchCapable', () => {
  it('is ok when web search is disabled regardless of the model', () => {
    expect(assertWebSearchCapable(descriptorFor('m'), false).isOk()).toBe(true);
  });

  it('is ok for a tool-capable model when enabled', () => {
    expect(assertWebSearchCapable(descriptorFor('m', ['tools']), true).isOk()).toBe(true);
  });

  it('is ok when the model is unknown (absent descriptor) — compile refuses it later', () => {
    expect(assertWebSearchCapable(undefined, true).isOk()).toBe(true);
  });

  it('refuses a tool-incapable model with a validation error when enabled', () => {
    expect(assertWebSearchCapable(descriptorFor('m'), true)._unsafeUnwrapErr().code).toBe(
      'validation'
    );
  });
});

describe('assertModelsWebSearchCapable', () => {
  const resolve: ModelPricingResolver = (id) =>
    id === 'capable' ? descriptorFor(id, ['tools']) : descriptorFor(id);

  it('is ok when disabled regardless of the models', () => {
    expect(assertModelsWebSearchCapable(['incapable'], resolve, false).isOk()).toBe(true);
  });

  it('is ok when every model is tool-capable', () => {
    expect(assertModelsWebSearchCapable(['capable', 'capable'], resolve, true).isOk()).toBe(true);
  });

  it('refuses when any model is tool-incapable', () => {
    expect(
      assertModelsWebSearchCapable(['capable', 'incapable'], resolve, true)._unsafeUnwrapErr().code
    ).toBe('validation');
  });
});

describe('buildMultiModelTurn', () => {
  it('compiles one optional skip-on-error sibling node per selected model, in order', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildMultiModelTurn({
      models: ['model-a', 'model-b', 'model-c'],
      nodes,
      constraints,
    });
    const definition = result._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    // One modelCall node per model, each carrying its model id, all optional and
    // skip-on-error so one model's failure never fails the run.
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings).toHaveLength(3);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
    expect(siblings.map((node) => node.model)).toEqual(['model-a', 'model-b', 'model-c']);
    // Distinct node ids — each sibling is its own charge key / assistant message.
    expect(new Set(siblings.map((node) => node.id)).size).toBe(3);
  });

  it('refuses when any selected model is unknown or unexposed', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildMultiModelTurn({ models: ['model-a', 'nope'], nodes, constraints });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('gives every sibling the web-search tool and step ceiling when enabled', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const siblings = buildMultiModelTurn({
      models: ['model-a', 'model-b'],
      nodes,
      constraints,
      webSearchEnabled: true,
    })
      ._unsafeUnwrap()
      .nodes.filter((node) => node.type === 'modelCall');
    for (const sibling of siblings) {
      expect(sibling.tools).toEqual([WEB_SEARCH_TOOL_NAME]);
      expect(sibling.maxSteps).toBe(MAX_SEARCH_TOOL_CALLS);
    }
  });
});
