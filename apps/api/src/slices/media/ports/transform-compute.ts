import type { ContentValue, NodePortDeclaration } from '@hushbox/shared';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * The TransformCompute port (ARCHITECTURE.md infra edge). Implementation #1
 * is the in-process server adapter — the server transforms the plaintext it
 * transiently holds; there are no client-locus transforms. A heavy-compute
 * backend (containers) plugs in behind this same seam later.
 *
 * The registry entry contract is `(name, version, in/out TypeTags)`: the
 * workflows node registry resolves a `transform` node's ports through
 * `resolvePorts` and the engine re-validates values against `zodFor` of the
 * declared tags — entries never hand-write a parallel schema.
 */

export interface MediaTransformEntry {
  readonly name: string;
  readonly version: number;
  readonly ports: NodePortDeclaration;
  /**
   * Inputs arrive materialized (the engine resolves refs into in-memory
   * values before dispatch — mid-flow content never rests anywhere).
   * Implementations are pure and deterministic.
   */
  run(inputs: readonly ContentValue[]): Result<ContentValue, DomainError>;
}

export interface TransformCompute {
  execute(
    name: string,
    version: number,
    inputs: readonly ContentValue[]
  ): ResultAsync<ContentValue, DomainError>;
  /** Declared ports for a registered transform; undefined when unknown. */
  resolvePorts(name: string, version: number): NodePortDeclaration | undefined;
}
