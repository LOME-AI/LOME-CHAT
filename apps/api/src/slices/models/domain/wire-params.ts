import { compileParamSpec } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import type { InputPart, ModelDescriptor } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';

/**
 * Wire-ready request params, split by how each one reaches the SDK call:
 * first-class call settings versus the providerOptions bag. The split is
 * declared per-spec in the descriptor (`wire`), so adapters stay free of
 * per-model knowledge.
 */
export interface WireParams {
  readonly firstClass: Record<string, unknown>;
  readonly providerOptions: Record<string, unknown>;
}

/**
 * Validates caller params against the descriptor's ParamSpec records via
 * the shared ParamSpec→Zod compiler (bounds, enum membership, required
 * presence, cross-field constraints; undeclared params reject), then maps
 * the validated values onto their wire targets. A spec without a `wire`
 * declaration rides first-class.
 */
export function compileWireParams(
  descriptor: ModelDescriptor,
  params: Record<string, unknown>
): Result<WireParams, DomainError> {
  const parsed = compileParamSpec(descriptor.parameters).safeParse(params);
  if (!parsed.success) {
    return err(validationError('request params failed the model parameter contract', parsed.error));
  }
  const firstClass: Record<string, unknown> = {};
  const providerOptions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    const spec = descriptor.parameters[name];
    if (spec?.wire === 'providerOptions') {
      providerOptions[name] = value;
    } else {
      firstClass[name] = value;
    }
  }
  return ok({ firstClass, providerOptions });
}

/**
 * Media input resolution at the admission boundary: every input part's
 * modality must be one the descriptor accepts. Byte resolution of media
 * refs is the engine's ValueStore seam — the domain only rules on
 * acceptability, before any money moves.
 */
export function resolveMediaInputs(
  descriptor: ModelDescriptor,
  inputs: readonly InputPart[]
): Result<readonly InputPart[], DomainError> {
  const supported: ReadonlySet<string> = new Set(descriptor.inputs);
  for (const part of inputs) {
    if (!supported.has(part.modality)) {
      return err(validationError(`model does not accept ${part.modality} inputs`));
    }
  }
  return ok(inputs);
}
