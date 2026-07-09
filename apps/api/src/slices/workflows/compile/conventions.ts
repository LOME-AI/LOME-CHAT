import type { Node } from '@hushbox/shared';

/**
 * Wiring conventions the compiler, builder, and engine share. The shared
 * workflow contract reserves only the 'end' sentinel; the 'input' source
 * node and the port-id conventions below are defined here, inside the slice.
 */

/** Reserved source node: workflow inputs are ports on this pseudo-node. */
export const WORKFLOW_INPUT_NODE_ID = 'input';

/** The single data-input port of modelCall/transform/branch/loop/smartModel nodes. */
export const SINGLE_INPUT_PORT_ID = 'in';

/** The collection-input port of a fanOut node. */
export const FAN_OUT_OVER_PORT_ID = 'over';

/**
 * Virtual per-branch output of a fanOut node, consumable only by its body —
 * tag = element of the list fed into 'over'. Makes the body's implicit feed
 * an explicit edge, so port-completeness checking stays uniform.
 */
export const FAN_OUT_ELEMENT_PORT_ID = 'element';

/** Virtual iteration-state output of a loop node, consumable only by its body. */
export const LOOP_STATE_PORT_ID = 'state';

/** Positional input ports for fanIn ('in0'…) and subWorkflow nodes. */
export function positionalInputPortId(index: number): string {
  return `in${String(index)}`;
}

/** The virtual out-port id a node type reserves, if any. */
export function reservedOutPortId(node: Node): string | undefined {
  if (node.type === 'fanOut') return FAN_OUT_ELEMENT_PORT_ID;
  if (node.type === 'loop') return LOOP_STATE_PORT_ID;
  return undefined;
}
