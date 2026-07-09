import { describe, expect, it } from 'vitest';
import { Node, mediaTag, textTag } from '@hushbox/shared';
import { createServerTransformCompute } from '../../media/index.js';
import { MODEL_CALL_IMPL_VERSION, SMART_MODEL_IMPL_VERSION } from './live-execution-registry.js';
import { createModelResolver } from './model-resolver.js';
import { createNodeRegistry } from './node-registry.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ValueNode } from '../compile/context.js';

const STRIP_TRANSFORM = 'strip-image-metadata';
const STRIP_MIMES = ['image/jpeg', 'image/png'] as const;

function descriptorWith(
  id: string,
  inputs: readonly Modality[],
  outputs: readonly Modality[]
): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: [...inputs],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const KNOWN_DESCRIPTORS: Readonly<Record<string, ModelDescriptor>> = {
  'answer-model': descriptorWith('answer-model', ['text'], ['text']),
  'hard-model': descriptorWith('hard-model', ['text'], ['text']),
  'image-model': descriptorWith('image-model', ['text'], ['image']),
};

const pricingResolver: ModelPricingResolver = (id) => KNOWN_DESCRIPTORS[id];

function makeRegistry(): ReturnType<typeof createNodeRegistry> {
  return createNodeRegistry({
    models: createModelResolver(pricingResolver),
    compute: createServerTransformCompute(),
  });
}

/** Parses raw shape into the value-node variant resolveValuePorts accepts. */
function valueNode(raw: unknown): ValueNode {
  const node = Node.parse(raw);
  if (
    node.type === 'modelCall' ||
    node.type === 'transform' ||
    node.type === 'subWorkflow' ||
    node.type === 'smartModel'
  ) {
    return node;
  }
  throw new Error('test fixture is not a value node');
}

describe('createNodeRegistry hasNode', () => {
  it('pins modelCall to its implementation version', () => {
    const registry = makeRegistry();
    expect(registry.hasNode('modelCall', MODEL_CALL_IMPL_VERSION)).toBe(true);
    expect(registry.hasNode('modelCall', MODEL_CALL_IMPL_VERSION + 1)).toBe(false);
  });

  it('pins each control-flow node to the interpreter version', () => {
    const registry = makeRegistry();
    for (const type of ['fanOut', 'fanIn', 'branch', 'loop'] as const) {
      expect(registry.hasNode(type, 1)).toBe(true);
      expect(registry.hasNode(type, 2)).toBe(false);
    }
  });

  it('accepts any declared version for transform and subWorkflow — the (name, version) pin is the config gate', () => {
    const registry = makeRegistry();
    expect(registry.hasNode('transform', 1)).toBe(true);
    expect(registry.hasNode('transform', 7)).toBe(true);
    expect(registry.hasNode('subWorkflow', 1)).toBe(true);
    expect(registry.hasNode('subWorkflow', 9)).toBe(true);
  });
});

describe('createNodeRegistry resolveValuePorts', () => {
  it('resolves a modelCall to its model binding ports', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'modelCall',
      id: 'm',
      version: MODEL_CALL_IMPL_VERSION,
      out: 'out',
      model: 'answer-model',
      params: {},
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toEqual({ in: [textTag()], out: textTag() });
  });

  it('fails closed on a modelCall whose model is unknown', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'modelCall',
      id: 'm',
      version: MODEL_CALL_IMPL_VERSION,
      out: 'out',
      model: 'ghost',
      params: {},
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });

  it('resolves a transform through the media compute registry', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'transform',
      id: 't',
      version: 1,
      out: 'out',
      transform: STRIP_TRANSFORM,
      in: { node: 'input', port: 'img' },
    });
    expect(registry.resolveValuePorts(node)).toEqual({
      in: [mediaTag('image', [...STRIP_MIMES])],
      out: mediaTag('image', [...STRIP_MIMES]),
    });
  });

  it('fails closed on an unknown transform', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'transform',
      id: 't',
      version: 1,
      out: 'out',
      transform: 'ghost',
      in: { node: 'input', port: 'img' },
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });

  it('pins smartModel to its implementation version', () => {
    const registry = makeRegistry();
    expect(registry.hasNode('smartModel', SMART_MODEL_IMPL_VERSION)).toBe(true);
    expect(registry.hasNode('smartModel', SMART_MODEL_IMPL_VERSION + 1)).toBe(false);
  });

  it('resolves a smartModel of text candidates to text ports', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'smartModel',
      id: 's',
      version: SMART_MODEL_IMPL_VERSION,
      out: 'out',
      classifierModelId: 'answer-model',
      candidates: [{ id: 'answer-model' }, { id: 'hard-model' }],
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toEqual({ in: [textTag()], out: textTag() });
  });

  it('fails closed on a smartModel naming an unknown candidate', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'smartModel',
      id: 's',
      version: SMART_MODEL_IMPL_VERSION,
      out: 'out',
      classifierModelId: 'answer-model',
      candidates: [{ id: 'answer-model' }, { id: 'ghost' }],
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });

  it('fails closed on a smartModel naming an unknown classifier', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'smartModel',
      id: 's',
      version: SMART_MODEL_IMPL_VERSION,
      out: 'out',
      classifierModelId: 'ghost',
      candidates: [{ id: 'answer-model' }],
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });

  it('fails closed on a smartModel with a non-text candidate (text→text only)', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'smartModel',
      id: 's',
      version: SMART_MODEL_IMPL_VERSION,
      out: 'out',
      classifierModelId: 'answer-model',
      candidates: [{ id: 'answer-model' }, { id: 'image-model' }],
      in: { node: 'input', port: 'prompt' },
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });

  it('defers subWorkflow — no sub-workflow catalog yet, so it never resolves', () => {
    const registry = makeRegistry();
    const node = valueNode({
      type: 'subWorkflow',
      id: 's',
      version: 1,
      out: 'out',
      ref: 'anything',
    });
    expect(registry.resolveValuePorts(node)).toBeUndefined();
  });
});
