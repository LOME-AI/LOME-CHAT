import { deriveNodeSchemas } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import type { NodePortDeclaration, SchemaNameRegistry } from '@hushbox/shared';
import type { Result } from '../../../lib/result/index.js';
import type { NodeRunError } from '../engine/execution-registry.js';

/**
 * The runtime input type check every capability execution runs before it
 * touches a port: the resolved input tuple is re-validated against the node's
 * declared input ports via `zodFor` — the same derivation the compiler used.
 * This closes the dual-type-system gap where a value passes graph-compile and
 * explodes inside the port; a mismatch is an ordinary node failure (no spend
 * observed), never a defect.
 */
export function validateNodeInput(
  ports: NodePortDeclaration,
  schemas: SchemaNameRegistry,
  input: readonly unknown[]
): Result<readonly unknown[], NodeRunError> {
  return deriveNodeSchemas(ports, schemas).input.safeParse(input).success ? ok(input) : err({});
}
