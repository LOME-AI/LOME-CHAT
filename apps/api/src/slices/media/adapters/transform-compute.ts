import { errAsync, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { stripImageMetadataEntry } from './transforms/strip-image-metadata.js';
import type { ContentValue, NodePortDeclaration } from '@hushbox/shared';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { MediaTransformEntry, TransformCompute } from '../ports/index.js';

/**
 * TransformCompute implementation #1: in-process dispatch over the shipped
 * entries. A duplicate `(name, version)` is a wiring defect and throws at
 * construction; an unknown transform at execute time is expected input from
 * a definition validated elsewhere and answers on the error channel.
 */

function entryKey(name: string, version: number): string {
  return `${name}@${String(version)}`;
}

export function createInProcessTransformCompute(
  entries: readonly MediaTransformEntry[]
): TransformCompute {
  const registered = new Map<string, MediaTransformEntry>();
  for (const entry of entries) {
    const key = entryKey(entry.name, entry.version);
    if (registered.has(key)) {
      throw new Error(`transform compute: duplicate registration for ${key}`);
    }
    registered.set(key, entry);
  }
  return {
    execute(
      name: string,
      version: number,
      inputs: readonly ContentValue[]
    ): ResultAsync<ContentValue, DomainError> {
      const entry = registered.get(entryKey(name, version));
      if (entry === undefined) {
        return errAsync(validationError('unknown transform'));
      }
      if (inputs.length !== entry.ports.in.length) {
        return errAsync(validationError('transform input arity does not match declared ports'));
      }
      return entry.run(inputs).match(
        (output) => okAsync<ContentValue, DomainError>(output),
        (error) => errAsync<ContentValue, DomainError>(error)
      );
    },
    resolvePorts(name: string, version: number): NodePortDeclaration | undefined {
      return registered.get(entryKey(name, version))?.ports;
    },
  };
}

/** The shipped server-locus media transforms; the workflows node registry consumes this at wiring. */
export function createServerTransformCompute(): TransformCompute {
  return createInProcessTransformCompute([stripImageMetadataEntry]);
}
