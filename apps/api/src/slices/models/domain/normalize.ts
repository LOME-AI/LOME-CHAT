import { MODALITIES, callShapeFamilyFor } from '@hushbox/shared';
import { familyForModelType } from './dispatch.js';
import { usdRateToNanoUsd } from './usd-rate.js';
import type { Modality, ModelDescriptor, ParamSpec as ParameterSpec } from '@hushbox/shared';
import type { CallShapeFamily } from './dispatch.js';
import type { GatewayModelMetadata, GatewayTokenPricing } from './gateway-metadata.js';
import type { ModelOverride } from './overrides.js';
import type { z } from 'zod';

/**
 * Descriptor content: the wire form of `ModelDescriptor` minus the fields
 * stamped at persist time (`version`, `fetchedAt`). Skip-unchanged
 * content-compares exactly this shape — a refresh that changes nothing
 * here writes nothing.
 */
export type DescriptorContent = Omit<z.input<typeof ModelDescriptor>, 'version' | 'fetchedAt'>;

export type NormalizeOutcome =
  | { kind: 'normalized'; family: CallShapeFamily; content: DescriptorContent }
  | { kind: 'excluded'; modelId: string; modelType: string | undefined };

/**
 * Gateway `supported_parameters` names → canonical descriptor ParamSpecs.
 * Data, not per-model code: a gateway name missing here is skipped (the
 * model still works with defaults; `modelOverrides` fills genuine gaps).
 * Canonical names match the SDK call-shape the adapters wire.
 */
const SUPPORTED_PARAMETER_SPECS: Readonly<
  Record<string, { readonly name: string; readonly spec: ParameterSpec }>
> = {
  temperature: {
    name: 'temperature',
    spec: { type: 'number', min: 0, max: 2, wire: 'firstClass' },
  },
  top_p: { name: 'topP', spec: { type: 'number', min: 0, max: 1, wire: 'firstClass' } },
  max_output_tokens: {
    name: 'maxOutputTokens',
    spec: { type: 'integer', min: 1, wire: 'firstClass' },
  },
};

/** Gateway parameter names that signal behaviors rather than call params. */
const BEHAVIOR_PARAMETERS: Readonly<Record<string, string>> = {
  tools: 'tools',
  reasoning: 'reasoning',
};

const MODALITY_SET: ReadonlySet<string> = new Set(MODALITIES);

function knownModalities(values: readonly string[]): Modality[] {
  return values.filter((value): value is Modality => MODALITY_SET.has(value));
}

function seedParameters(supportedParameters: readonly string[]): Record<string, ParameterSpec> {
  const parameters: Record<string, ParameterSpec> = {};
  for (const gatewayName of supportedParameters) {
    const known = SUPPORTED_PARAMETER_SPECS[gatewayName];
    if (known !== undefined) parameters[known.name] = known.spec;
  }
  return parameters;
}

function languageBehaviors(supportedParameters: readonly string[]): string[] {
  const behaviors = ['streaming'];
  for (const gatewayName of supportedParameters) {
    const behavior = BEHAVIOR_PARAMETERS[gatewayName];
    if (behavior !== undefined) behaviors.push(behavior);
  }
  return behaviors;
}

function tokenPricing(pricing: GatewayTokenPricing | undefined): DescriptorContent['pricing'] {
  if (pricing === undefined) return {};
  const entries: [string, string | undefined][] = [
    ['inputPerToken', pricing.input === undefined ? undefined : usdRateToNanoUsd(pricing.input)],
    ['outputPerToken', pricing.output === undefined ? undefined : usdRateToNanoUsd(pricing.output)],
    [
      'cachedInputPerToken',
      pricing.cachedInputTokens === undefined
        ? undefined
        : usdRateToNanoUsd(pricing.cachedInputTokens),
    ],
  ];
  const result: DescriptorContent['pricing'] = {};
  for (const [key, value] of entries) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function inputsFor(model: GatewayModelMetadata): Modality[] {
  const fromArchitecture = knownModalities(model.inputModalities);
  return fromArchitecture.length > 0 ? fromArchitecture : ['text'];
}

/** Image/video/embedding models carry exactly their one output modality so
 * the descriptor→family dispatch map stays total and unambiguous. */
function outputsFor(family: CallShapeFamily, model: GatewayModelMetadata): Modality[] {
  if (family === 'image') return ['image'];
  if (family === 'video') return ['video'];
  if (family === 'embedding') return ['embedding'];
  const fromArchitecture = knownModalities(model.outputModalities);
  return fromArchitecture.length > 0 ? fromArchitecture : ['text'];
}

/**
 * Gateway metadata + the gateway ZDR-provider list + the model's override
 * row → versionless descriptor content. ZDR is fail-closed and
 * model-granular: a serving provider on the gateway's ZDR list AND no
 * documented model-level exclusion. Overrides are data-driven supplements —
 * ParamSpecs and pricing merge over the gateway-derived values.
 */
export function normalizeModel(
  model: GatewayModelMetadata,
  zdrProviders: ReadonlySet<string>,
  override?: ModelOverride
): NormalizeOutcome {
  const family = familyForModelType(model.modelType);
  if (family === undefined) {
    return { kind: 'excluded', modelId: model.id, modelType: model.modelType };
  }
  const providerOnZdrList = model.endpointProviders.some((provider) => zdrProviders.has(provider));
  const zdrReachable = providerOnZdrList && override?.data.zdrExcluded !== true;
  const outputs = outputsFor(family, model);
  const content: DescriptorContent = {
    id: model.id,
    provider: model.provider,
    inputs: inputsFor(model),
    outputs,
    parameters: { ...seedParameters(model.supportedParameters), ...override?.data.parameters },
    // Behaviors key off the canonical family of the FINAL outputs, not the
    // gateway modelType: a language-typed entry with media-only outputs is
    // media-classified by exposure gating and dispatch, so its descriptor
    // must carry media behaviors (none today), never streaming/language.
    behaviors:
      callShapeFamilyFor(outputs) === 'language'
        ? languageBehaviors(model.supportedParameters)
        : [],
    limits: model.contextLength === undefined ? {} : { contextLength: model.contextLength },
    pricing: { ...tokenPricing(model.pricing), ...override?.data.pricing },
    zdrReachable,
  };
  return { kind: 'normalized', family, content };
}
