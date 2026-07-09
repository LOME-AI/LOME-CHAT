import { describe, expect, it } from 'vitest';
import {
  DEADLINE_CLASS_MS,
  DEADLINE_CLASSES,
  Node,
  NODE_TYPES,
  PolicyHooks,
  WorkflowDefinition,
} from './workflow.js';

const base = { id: 'n1', version: 1, out: 'out' };

describe('NODE_TYPES', () => {
  it('is the closed v1 node set', () => {
    expect(NODE_TYPES).toEqual([
      'modelCall',
      'transform',
      'fanOut',
      'fanIn',
      'branch',
      'loop',
      'subWorkflow',
      'smartModel',
    ]);
  });
});

describe('Node', () => {
  it('applies the base-field defaults (optional=false, onError=fail, maxSteps=1)', () => {
    const node = Node.parse({
      ...base,
      type: 'modelCall',
      model: 'openai/gpt-5',
      params: {},
      in: { node: 'input', port: 'out' },
    });
    expect(node).toMatchObject({ optional: false, onError: 'fail' });
    expect(node.type === 'modelCall' && node.maxSteps).toBe(1);
  });

  it('parses a transform node', () => {
    const node = {
      ...base,
      type: 'transform',
      transform: 'jpeg→avif',
      in: { node: 'n0', port: 'out' },
    };
    expect(Node.parse(node)).toMatchObject({ type: 'transform', transform: 'jpeg→avif' });
  });

  it('parses a fanOut node with a declared max width', () => {
    const node = {
      ...base,
      type: 'fanOut',
      over: { node: 'n0', port: 'out' },
      body: 'n2',
      maxWidth: 4,
    };
    expect(Node.parse(node)).toMatchObject({ type: 'fanOut', maxWidth: 4 });
  });

  it('parses a fanIn node naming a registered reducer', () => {
    const node = {
      ...base,
      type: 'fanIn',
      reducer: 'imagesPlusPrompt',
      ins: [{ node: 'n2', port: 'out' }],
    };
    expect(Node.parse(node)).toMatchObject({ type: 'fanIn', reducer: 'imagesPlusPrompt' });
  });

  it("parses an N-way branch with the 'end' sentinel as a target", () => {
    const node = {
      ...base,
      type: 'branch',
      predicate: 'routeChoice',
      cases: { cheap: 'n2', smart: 'n3' },
      else: 'end',
    };
    expect(Node.parse(node)).toMatchObject({ type: 'branch', else: 'end' });
  });

  it('parses a loop node with a declared max iterations', () => {
    const node = { ...base, type: 'loop', body: 'n2', until: 'isDone', maxIterations: 3 };
    expect(Node.parse(node)).toMatchObject({ type: 'loop', maxIterations: 3 });
  });

  it('parses a subWorkflow node', () => {
    const node = { ...base, type: 'subWorkflow', ref: 'summarize@2' };
    expect(Node.parse(node)).toMatchObject({ type: 'subWorkflow', ref: 'summarize@2' });
  });

  it('parses a smartModel node (classifier + candidate list, params defaulting empty)', () => {
    const node = Node.parse({
      ...base,
      type: 'smartModel',
      classifierModelId: 'cheap/model',
      candidates: [{ id: 'cheap/model', description: 'Fast and cheap.' }, { id: 'mid/model' }],
      in: { node: 'input', port: 'prompt' },
    });
    expect(node).toMatchObject({
      type: 'smartModel',
      classifierModelId: 'cheap/model',
      params: {},
    });
    expect(node.type === 'smartModel' && node.candidates[1]?.description).toBeUndefined();
  });

  it('rejects a smartModel node with an empty candidate list', () => {
    const node = {
      ...base,
      type: 'smartModel',
      classifierModelId: 'cheap/model',
      candidates: [],
      in: { node: 'input', port: 'prompt' },
    };
    expect(Node.safeParse(node).success).toBe(false);
  });

  it('rejects an unknown node type', () => {
    expect(Node.safeParse({ ...base, type: 'webhook' }).success).toBe(false);
  });

  it.each([
    [
      'fanOut maxWidth',
      { ...base, type: 'fanOut', over: { node: 'n0', port: 'out' }, body: 'n2', maxWidth: 0 },
    ],
    ['loop maxIterations', { ...base, type: 'loop', body: 'n2', until: 'p', maxIterations: 0 }],
    [
      'modelCall maxSteps',
      {
        ...base,
        type: 'modelCall',
        model: 'm',
        params: {},
        in: { node: 'n0', port: 'out' },
        maxSteps: 0,
      },
    ],
  ])('rejects a zero declared ceiling: %s (admission prices the ceiling)', (_label, node) => {
    expect(Node.safeParse(node).success).toBe(false);
  });
});

describe('DEADLINE_CLASSES', () => {
  it('declares the two run-control classes with their wall-clock budgets', () => {
    expect(DEADLINE_CLASSES).toEqual(['text', 'media']);
    expect(DEADLINE_CLASS_MS.text).toBe(5 * 60 * 1000);
    expect(DEADLINE_CLASS_MS.media).toBe(15 * 60 * 1000);
  });
});

describe('PolicyHooks', () => {
  it('parses typed admission/settlement hook names', () => {
    expect(PolicyHooks.parse({ admission: 'chatBalanceHold', settlement: 'saveChatTurn' })).toEqual(
      { admission: 'chatBalanceHold', settlement: 'saveChatTurn' }
    );
  });

  it('rejects a missing settlement hook (every definition declares both)', () => {
    expect(PolicyHooks.safeParse({ admission: 'chatBalanceHold' }).success).toBe(false);
  });
});

describe('WorkflowDefinition', () => {
  const smartModel = {
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chatBalanceHold', settlement: 'saveChatTurn' },
    nodes: [
      {
        id: 'classify',
        version: 1,
        out: 'out',
        optional: true,
        type: 'modelCall',
        model: 'cheap/classifier',
        params: {},
        in: { node: 'input', port: 'out' },
      },
      {
        id: 'route',
        version: 1,
        out: 'out',
        type: 'branch',
        predicate: 'routeChoice',
        cases: { smart: 'answer' },
        else: 'answer',
      },
      {
        id: 'answer',
        version: 1,
        out: 'out',
        type: 'modelCall',
        model: 'openai/gpt-5',
        params: {},
        in: { node: 'input', port: 'out' },
      },
    ],
    edges: [
      { from: { node: 'classify', port: 'out' }, to: { node: 'route', port: 'in' } },
      { from: { node: 'route', port: 'out' }, to: { node: 'answer', port: 'in' } },
    ],
  };

  it('parses a 3-node Smart Model-style definition (classify → branch → answer)', () => {
    const parsed = WorkflowDefinition.parse(smartModel);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.deadlineClass).toBe('text');
  });

  it('rejects an unknown deadline class', () => {
    expect(WorkflowDefinition.safeParse({ ...smartModel, deadlineClass: 'forever' }).success).toBe(
      false
    );
  });

  it('rejects a definition without policy hooks', () => {
    // eslint-disable-next-line sonarjs/no-unused-vars -- rest-spread requires naming the omitted key
    const { hooks: _hooks, ...rest } = smartModel;
    expect(WorkflowDefinition.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-integer definition version (deployed definitions fork, never mutate)', () => {
    expect(WorkflowDefinition.safeParse({ ...smartModel, version: 1.5 }).success).toBe(false);
  });
});
