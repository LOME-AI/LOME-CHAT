import { WORKFLOW_INPUT_NODE_ID } from '../compile/conventions.js';
import { portRef } from './ports.js';
import type { TypeTag } from '@hushbox/shared';
import type { Port } from './ports.js';

export interface WorkflowInputsHandle<D extends Readonly<Record<string, TypeTag>>> {
  /** What buildWorkflow hands the compiler as the declared workflow inputs. */
  readonly declarations: D;
  /** A typed producer port per declared input. */
  readonly ports: { readonly [K in keyof D]: Port<D[K]> };
}

/** Declares the workflow's named inputs once; ports and declarations stay in sync. */
export function workflowInputs<const D extends Readonly<Record<string, TypeTag>>>(
  declarations: D
): WorkflowInputsHandle<D> {
  const ports = Object.fromEntries(
    Object.entries(declarations).map(([name, tag]) => [
      name,
      { ref: portRef(WORKFLOW_INPUT_NODE_ID, name), tag },
    ])
    // The mapped-type shape cannot be expressed through Object.fromEntries;
    // the entries are constructed per-key from D, so the assertion is sound.
  ) as { [K in keyof D]: Port<D[K]> };
  return { declarations, ports };
}
