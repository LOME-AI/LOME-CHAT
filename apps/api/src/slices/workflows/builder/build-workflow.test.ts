import { describe, expect, it } from 'vitest';
import {
  END_NODE_ID,
  jsonTag,
  listTag,
  mediaTag,
  optionalTag,
  PolicyHooks,
  textTag,
} from '@hushbox/shared';
import {
  CLASSIFICATION_SCHEMA_NAME as CLASSIFICATION,
  makeFakeConstraints,
  makeFakeNodeRegistry,
  PNG,
} from '../compile/registry-fakes.js';
import { buildWorkflow } from './build-workflow.js';
import { branch } from './branch.js';
import { fanIn } from './fan-in.js';
import { fanOut } from './fan-out.js';
import { loop } from './loop.js';
import { modelCall } from './model-call.js';
import { smartModel } from './smart-model.js';
import { subWorkflow } from './sub-workflow.js';
import { transform } from './transform.js';
import { workflowInputs } from './workflow-inputs.js';
import type { MediaTag, TextTag } from '@hushbox/shared';
import type { BuildRegistries } from './build-workflow.js';

const HOOKS = PolicyHooks.parse({ admission: 'chatAdmission', settlement: 'chatSettlement' });

function registries(): BuildRegistries {
  return { nodes: makeFakeNodeRegistry(), constraints: makeFakeConstraints() };
}

describe('buildWorkflow — flagship shapes', () => {
  it('builds and compiles the three-node classify→branch→answer shape', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const classify = modelCall({
      id: 'classify',
      model: 'classifier-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: jsonTag(CLASSIFICATION),
      optional: true,
    });
    const answer = modelCall({
      id: 'answer',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    const route = branch({
      id: 'route',
      predicate: 'routeByLabel',
      accepts: optionalTag(jsonTag(CLASSIFICATION)),
      in: classify.out,
      cases: { simple: answer },
      else: answer,
    });
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [classify, route, answer],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.order).toEqual(['classify', 'route', 'answer']);
    expect(compiled.nodes.get('classify')?.out).toEqual(optionalTag(jsonTag(CLASSIFICATION)));
  });

  it('builds and compiles the data-driven fanOut with a tuple-typed fanIn', () => {
    const inputs = workflowInputs({
      images: listTag(mediaTag('image', [PNG])),
      prompt: textTag(),
    });
    const spread = fanOut<MediaTag, TextTag>({
      id: 'spread',
      over: inputs.ports.images,
      maxWidth: 4,
      body: (element) =>
        modelCall({
          id: 'describe',
          model: 'vision-model',
          accepts: mediaTag('image', [PNG]),
          in: element,
          produces: textTag(),
          optional: true,
        }),
    });
    const combine = fanIn({
      id: 'combine',
      reducer: 'captionsWithPrompt',
      accepts: [listTag(optionalTag(textTag())), textTag()],
      ins: [spread.out, inputs.ports.prompt],
      produces: textTag(),
    });
    const final = modelCall({
      id: 'final',
      model: 'answer-model',
      accepts: textTag(),
      in: combine.out,
      produces: textTag(),
    });
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [spread, combine, final],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.order).toEqual(['spread', 'describe', 'combine', 'final']);
    expect(compiled.nodes.get('spread')?.out).toEqual(listTag(optionalTag(textTag())));
    expect(compiled.nodes.has('describe')).toBe(true);
  });
});

describe('buildWorkflow — node construction', () => {
  it('applies version, out-port, and params defaults', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const answer = modelCall({
      id: 'answer',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    expect(answer.node).toMatchObject({
      version: 1,
      out: 'out',
      params: {},
      optional: false,
      onError: 'fail',
    });
  });

  it('passes a declared reasoning level through to the node, never into params', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const answer = modelCall({
      id: 'answer',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
      params: { maxOutputTokens: 100 },
      reasoningEffort: 'high',
    });
    expect(answer.node).toMatchObject({ reasoningEffort: 'high' });
    expect(answer.node.type === 'modelCall' && answer.node.params).toEqual({
      maxOutputTokens: 100,
    });
  });

  it('passes declared maxSteps and onError through to the node', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const agent = modelCall({
      id: 'agent',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
      maxSteps: 4,
      onError: 'skip',
    });
    expect(agent.node).toMatchObject({ maxSteps: 4, onError: 'skip' });
  });

  it('collects a non-optional fanOut body as plain list elements', () => {
    const inputs = workflowInputs({ images: listTag(mediaTag('image', [PNG])) });
    const spread = fanOut<MediaTag, TextTag>({
      id: 'spread',
      over: inputs.ports.images,
      maxWidth: 2,
      body: (element) =>
        modelCall({
          id: 'describe',
          model: 'vision-model',
          accepts: mediaTag('image', [PNG]),
          in: element,
          produces: textTag(),
        }),
    });
    expect(spread.out.tag).toEqual(listTag(textTag()));
  });

  it('builds a smartModel node as a text→text producer with its candidate list', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const smart = smartModel({
      id: 'answer',
      classifierModelId: 'answer-model',
      candidates: [{ id: 'answer-model', description: 'cheap' }, { id: 'hard-model' }],
      params: { temperature: 0.3 },
      accepts: textTag(),
      in: inputs.ports.prompt,
    });
    expect(smart.node).toMatchObject({
      type: 'smartModel',
      classifierModelId: 'answer-model',
      params: { temperature: 0.3 },
    });
    expect(smart.out.tag).toEqual(textTag());
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [smart],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.order).toEqual(['answer']);
    expect(compiled.nodes.get('answer')?.out).toEqual(textTag());
  });

  it('carries a declared classify dimension set onto the smartModel node', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const smart = smartModel({
      id: 'answer',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'pinned-model' }],
      classify: { model: false, effort: true },
      accepts: textTag(),
      in: inputs.ports.prompt,
    });
    expect(smart.node).toMatchObject({
      type: 'smartModel',
      classify: { model: false, effort: true },
    });
  });

  it('builds a transform node wired through the single input port', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const echo = transform({
      id: 'echo',
      transform: 'echo',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [echo],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.nodes.get('echo')?.inputs.get('in')).toEqual({
      from: { node: 'input', port: 'prompt' },
      tag: textTag(),
    });
  });

  it('builds a loop whose body re-enters the state channel', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const refine = loop({
      id: 'refine',
      until: 'textDone',
      maxIterations: 3,
      initial: inputs.ports.prompt,
      body: (state) =>
        transform({
          id: 'step',
          transform: 'echo',
          accepts: textTag(),
          in: state,
          produces: textTag(),
        }),
    });
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [refine],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.order).toEqual(['refine', 'step']);
    expect(compiled.nodes.get('refine')?.out).toEqual(textTag());
  });

  it('builds a subWorkflow with positional inputs', () => {
    const inputs = workflowInputs({ prompt: textTag(), context: textTag() });
    const sub = subWorkflow({
      id: 'sub',
      ref: 'summarize',
      ins: [inputs.ports.prompt, inputs.ports.context],
      produces: textTag(),
    });
    const compiled = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [sub],
      registries: registries(),
    })._unsafeUnwrap();
    expect(compiled.nodes.get('sub')?.inputs.get('in1')).toEqual({
      from: { node: 'input', port: 'context' },
      tag: textTag(),
    });
  });

  it('lets branch targets name the end sentinel', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const answer = modelCall({
      id: 'answer',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    const route = branch({
      id: 'route',
      predicate: 'textDone',
      accepts: textTag(),
      in: inputs.ports.prompt,
      cases: { done: END_NODE_ID },
      else: answer,
    });
    const result = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [route, answer],
      registries: registries(),
    });
    expect(result.isOk()).toBe(true);
  });
});

describe('buildWorkflow — rejection at build()', () => {
  it('rejects a type-incompatible edge the claimed tags hid', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const see = modelCall({
      id: 'see',
      model: 'vision-model',
      // The claim lies: the registry declares a media input.
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    const errors = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [see],
      registries: registries(),
    })._unsafeUnwrapErr();
    expect(errors.map((error) => error.code)).toEqual(['type_mismatch']);
  });

  it('rejects a handle listed twice as duplicate_node_id', () => {
    const inputs = workflowInputs({ prompt: textTag() });
    const answer = modelCall({
      id: 'answer',
      model: 'answer-model',
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
    });
    const errors = buildWorkflow({
      deadlineClass: 'text',
      hooks: HOOKS,
      inputs,
      nodes: [answer, answer],
      registries: registries(),
    })._unsafeUnwrapErr();
    expect(errors.map((error) => error.code)).toEqual(['duplicate_node_id']);
  });
});

describe('builder — type-level wiring', () => {
  it('rejects kind-incompatible connections in the type system', () => {
    const inputs = workflowInputs({ prompt: textTag(), images: listTag(mediaTag('image', [PNG])) });

    const bad = modelCall({
      id: 'bad',
      model: 'vision-model',
      accepts: mediaTag('image', [PNG]),
      // @ts-expect-error -- a text producer cannot feed a media-accepting consumer
      in: inputs.ports.prompt,
      produces: textTag(),
    });

    const goodList = inputs.ports.images;
    const fed = fanIn({
      id: 'fed',
      reducer: 'captionsWithPrompt',
      accepts: [listTag(optionalTag(textTag())), textTag()],
      // @ts-expect-error -- positional ports must match the reducer tuple kinds
      ins: [inputs.ports.prompt, goodList],
      produces: textTag(),
    });

    const looped = loop({
      id: 'looped',
      until: 'textDone',
      maxIterations: 2,
      initial: inputs.ports.prompt,
      body: (state) =>
        // @ts-expect-error -- the body must produce a text-kind state, not json
        modelCall({
          id: 'step',
          model: 'classifier-model',
          accepts: textTag(),
          in: state,
          produces: jsonTag(CLASSIFICATION),
        }),
    });

    expect([bad.node.type, fed.node.type, looped.node.type]).toEqual([
      'modelCall',
      'fanIn',
      'loop',
    ]);
  });
});
