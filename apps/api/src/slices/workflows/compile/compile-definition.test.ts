import { describe, expect, it } from 'vitest';
import { jsonTag, listTag, mediaTag, optionalTag, textTag } from '@hushbox/shared';
import { compileDefinition } from './compile-definition.js';
import {
  CLASSIFICATION_SCHEMA_NAME as CLASSIFICATION,
  makeFakeCompileContext as makeContext,
  PNG,
} from './registry-fakes.js';
import type { CompileContext } from './context.js';
import type { CompileError } from './errors.js';

const HOOKS = { admission: 'chatAdmission', settlement: 'chatSettlement' };

function definitionWith(nodes: readonly unknown[], edges: readonly unknown[]): unknown {
  return { version: 1, deadlineClass: 'text', hooks: HOOKS, nodes, edges };
}

function edge(fromNode: string, fromPort: string, toNode: string, toPort: string): unknown {
  return { from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

function answerNode(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'modelCall',
    version: 1,
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
    out: 'out',
    ...overrides,
  };
}

function errorsOf(definition: unknown, context: CompileContext = makeContext()): CompileError[] {
  return compileDefinition(definition, context)._unsafeUnwrapErr();
}

function codesOf(definition: unknown, context: CompileContext = makeContext()): string[] {
  return errorsOf(definition, context).map((error) => error.code);
}

const SINGLE_ANSWER = definitionWith(
  [answerNode('answer')],
  [edge('input', 'prompt', 'answer', 'in')]
);

function smartModelNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    type: 'smartModel',
    version: 1,
    classifierModelId: 'answer-model',
    candidates: [{ id: 'answer-model', description: 'cheap' }, { id: 'hard-model' }],
    in: { node: 'input', port: 'prompt' },
    out: 'out',
    ...overrides,
  };
}

const SINGLE_SMART = definitionWith(
  [smartModelNode('answer')],
  [edge('input', 'prompt', 'answer', 'in')]
);

describe('compileDefinition — smartModel', () => {
  it('compiles a smartModel node as a single-text-input text producer', () => {
    const compiled = compileDefinition(SINGLE_SMART, makeContext())._unsafeUnwrap();
    expect(compiled.nodes.get('answer')?.out).toEqual(textTag());
    expect(compiled.order).toEqual(['answer']);
  });

  it('rejects a smartModel naming an unknown candidate with node_config_unresolved', () => {
    const definition = definitionWith(
      [smartModelNode('answer', { candidates: [{ id: 'answer-model' }, { id: 'ghost-model' }] })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['node_config_unresolved']);
  });

  it('rejects a smartModel naming an unknown classifier with node_config_unresolved', () => {
    const definition = definitionWith(
      [smartModelNode('answer', { classifierModelId: 'ghost-model' })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['node_config_unresolved']);
  });

  it('rejects a dangling smartModel (type, version) with unknown_node_version', () => {
    const definition = definitionWith(
      [smartModelNode('answer', { version: 2 })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_version']);
  });

  it('rejects a type-mismatched feed into a smartModel with type_mismatch', () => {
    const definition = definitionWith(
      [
        {
          id: 'cap',
          type: 'transform',
          version: 1,
          transform: 'split',
          in: { node: 'input', port: 'prompt' },
          out: 'out',
        },
        smartModelNode('answer', { in: { node: 'cap', port: 'out' } }),
      ],
      [edge('input', 'prompt', 'cap', 'in'), edge('cap', 'out', 'answer', 'in')]
    );
    expect(codesOf(definition)).toContain('type_mismatch');
  });
});

describe('compileDefinition — definition parsing', () => {
  it('rejects a non-object definition with invalid_definition', () => {
    expect(codesOf(null)).toEqual(['invalid_definition']);
  });

  it('rejects a malformed node with invalid_definition', () => {
    const definition = definitionWith([{ id: 'x', type: 'modelCall' }], []);
    expect(codesOf(definition)).toEqual(['invalid_definition']);
  });

  it('applies node field defaults while parsing', () => {
    const compiled = compileDefinition(SINGLE_ANSWER, makeContext())._unsafeUnwrap();
    const node = compiled.definition.nodes[0];
    expect(node).toMatchObject({ optional: false, onError: 'fail' });
  });
});

describe('compileDefinition — workflow input declarations', () => {
  it('rejects a forged bare-json input tag with invalid_type_tag', () => {
    const context = makeContext({
      workflowInputs: { prompt: { kind: 'json', schemaName: '' } },
    });
    expect(codesOf(SINGLE_ANSWER, context)).toContain('invalid_type_tag');
  });

  it('rejects a dangling json schema name in an input tag with unknown_schema_name', () => {
    const context = makeContext({ workflowInputs: { prompt: jsonTag('ghost') } });
    expect(codesOf(SINGLE_ANSWER, context)).toContain('unknown_schema_name');
  });

  it('rejects an edge from an undeclared workflow input with unknown_workflow_input', () => {
    const definition = definitionWith(
      [answerNode('answer')],
      [edge('input', 'missing', 'answer', 'in')]
    );
    expect(codesOf(definition)).toContain('unknown_workflow_input');
  });
});

describe('compileDefinition — node identity', () => {
  it("rejects a node using the reserved id 'input'", () => {
    const definition = definitionWith(
      [answerNode('input')],
      [edge('input', 'prompt', 'input', 'in')]
    );
    expect(codesOf(definition)).toEqual(['reserved_node_id']);
  });

  it("rejects a node using the reserved id 'end'", () => {
    const definition = definitionWith([answerNode('end')], [edge('input', 'prompt', 'end', 'in')]);
    expect(codesOf(definition)).toEqual(['reserved_node_id']);
  });

  it('rejects duplicate node ids', () => {
    const definition = definitionWith(
      [answerNode('answer'), answerNode('answer')],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['duplicate_node_id']);
  });

  it("rejects a fanOut whose out port shadows its reserved 'element' port", () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'see',
          maxWidth: 2,
          out: 'element',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
      ],
      [edge('input', 'images', 'spread', 'over'), edge('spread', 'element', 'see', 'in')]
    );
    const context = makeContext({ workflowInputs: { images: listTag(mediaTag('image', [PNG])) } });
    expect(codesOf(definition, context)).toEqual(['reserved_port_id']);
  });

  it("rejects a loop whose out port shadows its reserved 'state' port", () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 3,
          out: 'state',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'refine', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    expect(codesOf(definition)).toEqual(['reserved_port_id']);
  });

  it('rejects definitions over the node-count ceiling with node_count_exceeded', () => {
    const context = makeContext({
      limits: { maxNodes: 1, maxFanOutWidth: 6, maxLoopIterations: 32, maxModelCallSteps: 16 },
    });
    const definition = definitionWith(
      [answerNode('one'), answerNode('two')],
      [edge('input', 'prompt', 'one', 'in'), edge('input', 'prompt', 'two', 'in')]
    );
    expect(codesOf(definition, context)).toEqual(['node_count_exceeded']);
  });
});

describe('compileDefinition — registry resolution', () => {
  it('rejects a dangling (type, version) with unknown_node_version', () => {
    const definition = definitionWith(
      [answerNode('answer', { version: 2 })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_version']);
  });

  it('rejects an unresolvable model config with node_config_unresolved', () => {
    const definition = definitionWith(
      [answerNode('answer', { model: 'no-such-model' })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['node_config_unresolved']);
  });

  it('rejects a single-input node whose registration declares two ports with node_config_unresolved', () => {
    const definition = definitionWith(
      [answerNode('answer', { model: 'two-port-model' })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['node_config_unresolved']);
  });

  it('skips port checks on a subWorkflow whose ref does not resolve', () => {
    const definition = definitionWith(
      [{ id: 'sub', type: 'subWorkflow', version: 1, ref: 'no-such-workflow', out: 'out' }],
      [edge('input', 'prompt', 'sub', 'in0')]
    );
    expect(codesOf(definition)).toEqual(['node_config_unresolved']);
  });

  it('rejects a registry-declared dangling json schema with unknown_schema_name', () => {
    const definition = definitionWith(
      [answerNode('answer', { model: 'ghost-schema-model' })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_schema_name']);
  });

  it('rejects a registry-declared forged bare-json tag with invalid_type_tag', () => {
    const definition = definitionWith(
      [answerNode('answer', { model: 'forged-tag-model' })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['invalid_type_tag']);
  });

  it('rejects an unregistered branch predicate with unknown_predicate', () => {
    const definition = definitionWith(
      [
        answerNode('answer'),
        {
          id: 'route',
          type: 'branch',
          version: 1,
          predicate: 'no-such-predicate',
          cases: {},
          else: 'end',
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'answer', 'in'), edge('input', 'prompt', 'route', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_predicate']);
  });

  it('rejects an unregistered loop until-predicate with unknown_predicate', () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'no-such-predicate',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'refine', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_predicate']);
  });

  it('rejects an unregistered fanIn reducer with unknown_reducer', () => {
    const definition = definitionWith(
      [
        answerNode('answer'),
        {
          id: 'merge',
          type: 'fanIn',
          version: 1,
          reducer: 'no-such-reducer',
          ins: [{ node: 'answer', port: 'out' }],
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'answer', 'in'), edge('answer', 'out', 'merge', 'in0')]
    );
    expect(codesOf(definition)).toEqual(['unknown_reducer']);
  });

  it('rejects a fanIn whose ins count differs from the reducer tuple with reducer_arity_mismatch', () => {
    const definition = definitionWith(
      [
        answerNode('answer'),
        {
          id: 'merge',
          type: 'fanIn',
          version: 1,
          reducer: 'captionsWithPrompt',
          ins: [{ node: 'answer', port: 'out' }],
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'answer', 'in'), edge('answer', 'out', 'merge', 'in0')]
    );
    expect(codesOf(definition)).toEqual(['reducer_arity_mismatch']);
  });
});

describe('compileDefinition — declared ceilings', () => {
  it('rejects modelCall maxSteps above the ceiling with model_steps_exceeded', () => {
    const definition = definitionWith(
      [answerNode('answer', { maxSteps: 17 })],
      [edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['model_steps_exceeded']);
  });

  it('rejects fanOut maxWidth above the ceiling with fan_out_width_exceeded', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'see',
          maxWidth: 7,
          out: 'out',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
      ],
      [edge('input', 'images', 'spread', 'over'), edge('spread', 'element', 'see', 'in')]
    );
    const context = makeContext({ workflowInputs: { images: listTag(mediaTag('image', [PNG])) } });
    expect(codesOf(definition, context)).toEqual(['fan_out_width_exceeded']);
  });

  it('rejects loop maxIterations above the ceiling with loop_iterations_exceeded', () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 33,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'refine', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    expect(codesOf(definition)).toEqual(['loop_iterations_exceeded']);
  });
});

describe('compileDefinition — structural references', () => {
  it('rejects a fanOut body that names no node with unknown_node_ref', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'missing',
          maxWidth: 2,
          out: 'out',
        },
        {
          id: 'sink',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'spread', port: 'out' },
          out: 'out',
        },
      ],
      [edge('input', 'images', 'spread', 'over'), edge('spread', 'out', 'sink', 'in')]
    );
    const context = makeContext({ workflowInputs: { images: listTag(mediaTag('image', [PNG])) } });
    expect(codesOf(definition, context)).toEqual(['unknown_node_ref']);
  });

  it('rejects a branch case target that names no node with unknown_node_ref', () => {
    const definition = definitionWith(
      [
        {
          id: 'route',
          type: 'branch',
          version: 1,
          predicate: 'textDone',
          cases: { yes: 'missing' },
          else: 'end',
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'route', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_ref']);
  });

  it("accepts branch targets pointing at the 'end' sentinel", () => {
    const definition = definitionWith(
      [
        {
          id: 'route',
          type: 'branch',
          version: 1,
          predicate: 'textDone',
          cases: { yes: 'end' },
          else: 'end',
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'route', 'in')]
    );
    const result = compileDefinition(definition, makeContext());
    expect(result.isOk()).toBe(true);
  });
});

describe('compileDefinition — wiring', () => {
  it('rejects an edge into a missing node with unknown_node_ref', () => {
    const definition = definitionWith(
      [answerNode('answer')],
      [edge('input', 'prompt', 'answer', 'in'), edge('answer', 'out', 'missing', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_ref']);
  });

  it("rejects an edge targeting the 'end' sentinel with unknown_node_ref", () => {
    const definition = definitionWith(
      [answerNode('answer')],
      [edge('input', 'prompt', 'answer', 'in'), edge('answer', 'out', 'end', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_ref']);
  });

  it('rejects an edge from a missing producer node with unknown_node_ref', () => {
    const definition = definitionWith(
      [answerNode('answer', { in: { node: 'missing', port: 'out' } })],
      [edge('missing', 'out', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_node_ref']);
  });

  it('rejects an edge into an undeclared consumer port with unknown_port', () => {
    const definition = definitionWith(
      [answerNode('answer')],
      [edge('input', 'prompt', 'answer', 'in'), edge('input', 'prompt', 'answer', 'sidedoor')]
    );
    expect(codesOf(definition)).toEqual(['unknown_port']);
  });

  it("rejects an edge from a port that is not the producer's out port with unknown_port", () => {
    const definition = definitionWith(
      [answerNode('first'), answerNode('second', { in: { node: 'first', port: 'sidedoor' } })],
      [edge('input', 'prompt', 'first', 'in'), edge('first', 'sidedoor', 'second', 'in')]
    );
    expect(codesOf(definition)).toEqual(['unknown_port']);
  });

  it("rejects consuming a fanOut 'element' port outside its body with unknown_port", () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'see',
          maxWidth: 2,
          out: 'out',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
        {
          id: 'peek',
          type: 'transform',
          version: 1,
          transform: 'caption',
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
      ],
      [
        edge('input', 'images', 'spread', 'over'),
        edge('spread', 'element', 'see', 'in'),
        edge('spread', 'element', 'peek', 'in'),
      ]
    );
    const context = makeContext({ workflowInputs: { images: listTag(mediaTag('image', [PNG])) } });
    expect(codesOf(definition, context)).toEqual(['unknown_port']);
  });

  it("rejects consuming a loop 'state' port outside its body with unknown_port", () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
        {
          id: 'peek',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [
        edge('input', 'prompt', 'refine', 'in'),
        edge('refine', 'state', 'step', 'in'),
        edge('refine', 'state', 'peek', 'in'),
      ]
    );
    expect(codesOf(definition)).toEqual(['unknown_port']);
  });

  it('rejects feeding one input port twice with duplicate_input_edge', () => {
    const definition = definitionWith(
      [answerNode('answer')],
      [edge('input', 'prompt', 'answer', 'in'), edge('input', 'prompt', 'answer', 'in')]
    );
    expect(codesOf(definition)).toEqual(['duplicate_input_edge']);
  });

  it('rejects an unfed required input with missing_input', () => {
    const definition = definitionWith([answerNode('answer')], []);
    expect(codesOf(definition)).toEqual(['missing_input']);
  });

  it('skips collection and state type checks when over and in are unfed', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'see',
          maxWidth: 2,
          out: 'out',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('spread', 'element', 'see', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    const context = makeContext({ workflowInputs: { images: listTag(mediaTag('image', [PNG])) } });
    expect(codesOf(definition, context)).toEqual(['missing_input', 'missing_input']);
  });

  it('rejects an embedded input ref that disagrees with the feeding edge using port_ref_mismatch', () => {
    const definition = definitionWith(
      [answerNode('first'), answerNode('second', { in: { node: 'first', port: 'out' } })],
      [edge('input', 'prompt', 'first', 'in'), edge('input', 'prompt', 'second', 'in')]
    );
    expect(codesOf(definition)).toEqual(['port_ref_mismatch']);
  });
});

describe('compileDefinition — cycles', () => {
  it('rejects mutually-feeding nodes with cycle_detected', () => {
    const definition = definitionWith(
      [
        {
          id: 'a',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'b', port: 'out' },
          out: 'out',
        },
        {
          id: 'b',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'a', port: 'out' },
          out: 'out',
        },
      ],
      [edge('b', 'out', 'a', 'in'), edge('a', 'out', 'b', 'in')]
    );
    expect(codesOf(definition)).toEqual(['cycle_detected']);
  });

  it('rejects a typed-channel cycle through a fanOut-fed loop state with cycle_detected', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'texts' },
          body: 'refine',
          maxWidth: 2,
          out: 'out',
        },
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [
        edge('input', 'texts', 'spread', 'over'),
        edge('spread', 'out', 'refine', 'in'),
        edge('refine', 'state', 'step', 'in'),
      ]
    );
    const context = makeContext({ workflowInputs: { texts: listTag(textTag()) } });
    expect(codesOf(definition, context)).toEqual(['cycle_detected']);
  });
});

describe('compileDefinition — typed edges', () => {
  it('rejects a type-incompatible edge with type_mismatch', () => {
    const definition = definitionWith(
      [
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'input', port: 'prompt' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'see', 'in')]
    );
    const errors = errorsOf(definition);
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'type_mismatch',
        edge: { from: { node: 'input', port: 'prompt' }, to: { node: 'see', port: 'in' } },
      }),
    ]);
  });

  it('rejects a non-list collection feeding fanOut.over with fan_out_over_not_list', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'prompt' },
          body: 'see',
          maxWidth: 2,
          out: 'out',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'spread', 'over'), edge('spread', 'element', 'see', 'in')]
    );
    expect(codesOf(definition)).toEqual(['fan_out_over_not_list']);
  });

  it('rejects a loop body whose output cannot re-enter the state with body_type_mismatch', () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'textDone',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'modelCall',
          version: 1,
          model: 'classifier-model',
          params: {},
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'refine', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    expect(codesOf(definition)).toEqual(['body_type_mismatch']);
  });

  it('rejects a loop until-predicate that cannot accept the state with type_mismatch', () => {
    const definition = definitionWith(
      [
        {
          id: 'refine',
          type: 'loop',
          version: 1,
          body: 'step',
          until: 'labelDone',
          maxIterations: 3,
          out: 'out',
        },
        {
          id: 'step',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'refine', port: 'state' },
          out: 'out',
        },
      ],
      [edge('input', 'prompt', 'refine', 'in'), edge('refine', 'state', 'step', 'in')]
    );
    expect(codesOf(definition)).toEqual(['type_mismatch']);
  });
});

describe('compileDefinition — flagship shapes', () => {
  it('compiles the three-node classify→branch→answer shape', () => {
    const definition = definitionWith(
      [
        {
          id: 'classify',
          type: 'modelCall',
          version: 1,
          model: 'classifier-model',
          params: {},
          in: { node: 'input', port: 'prompt' },
          out: 'out',
          optional: true,
        },
        {
          id: 'route',
          type: 'branch',
          version: 1,
          predicate: 'routeByLabel',
          cases: { simple: 'answer' },
          else: 'answer',
          out: 'out',
        },
        answerNode('answer'),
      ],
      [
        edge('input', 'prompt', 'classify', 'in'),
        edge('classify', 'out', 'route', 'in'),
        edge('input', 'prompt', 'answer', 'in'),
      ]
    );
    const compiled = compileDefinition(definition, makeContext())._unsafeUnwrap();
    expect(compiled.order).toEqual(['classify', 'route', 'answer']);
    expect(compiled.nodes.get('classify')?.out).toEqual(optionalTag(jsonTag(CLASSIFICATION)));
    expect(compiled.nodes.get('answer')?.out).toEqual(textTag());
  });

  it('compiles the data-driven fanOut with a tuple-typed fanIn (N images + text → one input)', () => {
    const definition = definitionWith(
      [
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'describe',
          maxWidth: 4,
          out: 'out',
        },
        {
          id: 'describe',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
          optional: true,
        },
        {
          id: 'combine',
          type: 'fanIn',
          version: 1,
          reducer: 'captionsWithPrompt',
          ins: [
            { node: 'spread', port: 'out' },
            { node: 'input', port: 'prompt' },
          ],
          out: 'out',
        },
        {
          id: 'final',
          type: 'modelCall',
          version: 1,
          model: 'answer-model',
          params: {},
          in: { node: 'combine', port: 'out' },
          out: 'out',
        },
      ],
      [
        edge('input', 'images', 'spread', 'over'),
        edge('spread', 'element', 'describe', 'in'),
        edge('spread', 'out', 'combine', 'in0'),
        edge('input', 'prompt', 'combine', 'in1'),
        edge('combine', 'out', 'final', 'in'),
      ]
    );
    const context = makeContext({
      workflowInputs: { images: listTag(mediaTag('image', [PNG])), prompt: textTag() },
    });
    const compiled = compileDefinition(definition, context)._unsafeUnwrap();
    expect(compiled.nodes.get('spread')?.out).toEqual(listTag(optionalTag(textTag())));
    expect(compiled.nodes.get('combine')?.out).toEqual(textTag());
    expect(compiled.order).toEqual(['spread', 'describe', 'combine', 'final']);
  });
});

describe('compileDefinition — flagship shapes (diamond)', () => {
  it('compiles a diamond joined by a tuple fanIn', () => {
    const definition = definitionWith(
      [
        {
          id: 'seed',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'input', port: 'prompt' },
          out: 'out',
        },
        {
          id: 'left',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'seed', port: 'out' },
          out: 'out',
        },
        {
          id: 'right',
          type: 'transform',
          version: 1,
          transform: 'echo',
          in: { node: 'seed', port: 'out' },
          out: 'out',
        },
        {
          id: 'join',
          type: 'fanIn',
          version: 1,
          reducer: 'pairJoin',
          ins: [
            { node: 'left', port: 'out' },
            { node: 'right', port: 'out' },
          ],
          out: 'out',
        },
      ],
      [
        edge('input', 'prompt', 'seed', 'in'),
        edge('seed', 'out', 'left', 'in'),
        edge('seed', 'out', 'right', 'in'),
        edge('left', 'out', 'join', 'in0'),
        edge('right', 'out', 'join', 'in1'),
      ]
    );
    const compiled = compileDefinition(definition, makeContext())._unsafeUnwrap();
    expect(compiled.order).toEqual(['seed', 'left', 'right', 'join']);
    expect(compiled.nodes.get('join')?.out).toEqual(textTag());
  });
});

describe('compileDefinition — compiled artifact', () => {
  it('echoes the declared workflow inputs', () => {
    const compiled = compileDefinition(SINGLE_ANSWER, makeContext())._unsafeUnwrap();
    expect(compiled.workflowInputs).toEqual({ prompt: textTag() });
  });

  it('records each fed input port with its producer ref and channel tag', () => {
    const compiled = compileDefinition(SINGLE_ANSWER, makeContext())._unsafeUnwrap();
    const inputs = compiled.nodes.get('answer')?.inputs;
    expect(inputs?.get('in')).toEqual({
      from: { node: 'input', port: 'prompt' },
      tag: textTag(),
    });
  });
});

describe('compileDefinition — deterministic errors', () => {
  it('reports multiple defects as a stable, ordered code list', () => {
    const definition = definitionWith(
      [
        answerNode('bad', { model: 'no-such-model', in: { node: 'input', port: 'prompt' } }),
        {
          id: 'spread',
          type: 'fanOut',
          version: 1,
          over: { node: 'input', port: 'images' },
          body: 'see',
          maxWidth: 7,
          out: 'out',
        },
        {
          id: 'see',
          type: 'modelCall',
          version: 1,
          model: 'vision-model',
          params: {},
          in: { node: 'spread', port: 'element' },
          out: 'out',
        },
      ],
      [edge('input', 'images', 'spread', 'over'), edge('spread', 'element', 'see', 'in')]
    );
    const context = makeContext({
      workflowInputs: { images: listTag(mediaTag('image', [PNG])), prompt: textTag() },
    });
    const first = codesOf(definition, context);
    const second = codesOf(definition, context);
    expect(first).toEqual(['node_config_unresolved', 'fan_out_width_exceeded', 'missing_input']);
    expect(second).toEqual(first);
  });

  it('attaches the offending nodeId to node-scoped errors', () => {
    const definition = definitionWith(
      [answerNode('bad', { model: 'no-such-model' })],
      [edge('input', 'prompt', 'bad', 'in')]
    );
    const errors = errorsOf(definition);
    expect(errors[0]).toMatchObject({ code: 'node_config_unresolved', nodeId: 'bad' });
  });
});
