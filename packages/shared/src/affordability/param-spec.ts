/* eslint-disable unicorn/prevent-abbreviations -- "ParamSpec" is the spec-named contract (gateway `supported_parameters`, catalog ParamSpecs); the name is cited verbatim throughout docs and code */
import { z } from 'zod';

/**
 * The closed parameter-spec shape. Anything a model surface needs
 * beyond this shape goes through the named-constraint registry — the
 * explicit escape hatch — never an ad-hoc key here. Gateway
 * `supported_parameters` seeds names for language models; the OpenRouter
 * image/video catalog supplies full ParamSpecs where that metadata can't.
 */
export const PARAM_TYPES = ['number', 'integer', 'string', 'boolean', 'enum'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** How the param reaches the SDK call: a first-class argument or providerOptions. */
export const PARAM_WIRES = ['firstClass', 'providerOptions'] as const;
export type ParamWire = (typeof PARAM_WIRES)[number];

export const ParamSpec = z.strictObject({
  type: z.enum(PARAM_TYPES),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .optional(),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
  step: z.number().positive().optional(),
  requires: z.array(z.string().min(1)).optional(),
  conflictsWith: z.array(z.string().min(1)).optional(),
  wire: z.enum(PARAM_WIRES).optional(),
});

export type ParamSpec = z.infer<typeof ParamSpec>;

function membershipRefinement(schema: z.ZodType, values: readonly (string | number)[]): z.ZodType {
  return schema.refine((value) => values.includes(value as string | number), {
    message: `Value must be one of: ${values.join(', ')}`,
  });
}

function numericSchema(spec: ParamSpec): z.ZodType {
  let numeric = spec.type === 'integer' ? z.number().int() : z.number();
  if (spec.min !== undefined) numeric = numeric.gte(spec.min);
  if (spec.max !== undefined) numeric = numeric.lte(spec.max);
  return numeric;
}

function baseSchema(name: string, spec: ParamSpec): z.ZodType {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      return numericSchema(spec);
    }
    case 'string': {
      return z.string();
    }
    case 'boolean': {
      return z.boolean();
    }
    case 'enum': {
      if (spec.values === undefined) {
        throw new Error(`Enum param "${name}" must declare values`);
      }
      return membershipRefinement(z.union([z.string(), z.number()]), spec.values);
    }
  }
}

function fieldSchema(name: string, spec: ParamSpec): z.ZodType {
  const schema = baseSchema(name, spec);
  if (spec.type !== 'enum' && spec.values !== undefined) {
    return membershipRefinement(schema, spec.values);
  }
  return schema;
}

function checkRequires(
  name: string,
  requires: readonly string[],
  params: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  for (const prerequisite of requires) {
    if (!(prerequisite in params)) {
      ctx.addIssue({ code: 'custom', message: `"${name}" requires "${prerequisite}"` });
    }
  }
}

function checkConflicts(
  name: string,
  conflictsWith: readonly string[],
  params: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  for (const rival of conflictsWith) {
    if (rival in params) {
      ctx.addIssue({ code: 'custom', message: `"${name}" conflicts with "${rival}"` });
    }
  }
}

function checkCrossField(
  specs: Readonly<Record<string, ParamSpec>>,
  params: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  for (const [name, spec] of Object.entries(specs)) {
    if (!(name in params)) continue;
    checkRequires(name, spec.requires ?? [], params, ctx);
    checkConflicts(name, spec.conflictsWith ?? [], params, ctx);
  }
}

/**
 * ParamSpec→Zod compiler: turns a descriptor's `parameters` record into the
 * runtime schema admission validates request params against — bounds, enum
 * membership, required presence, and the cross-field requires/conflictsWith
 * constraints. Undeclared params are rejected (fail fast at the boundary).
 * `default`, `step`, and `wire` are adapter/UI metadata, not validated here.
 */
export function compileParamSpec(
  specs: Readonly<Record<string, ParamSpec>>
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const schema = fieldSchema(name, spec);
    shape[name] = spec.required === true ? schema : schema.optional();
  }
  return z.strictObject(shape).superRefine((params, ctx) => {
    checkCrossField(specs, params, ctx);
  });
}
