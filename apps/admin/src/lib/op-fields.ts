import { z } from 'zod';
import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import type { AnyAdminOpContract } from '@hushbox/shared';

/**
 * One renderable form field derived from a shared op contract's flat Zod
 * input. The generic <OpForm> renders exactly these — there are no bespoke
 * per-op forms (apps/admin/CLAUDE.md).
 */
export interface OpFieldDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly control: 'text' | 'number' | 'enum';
  readonly options?: readonly string[];
  /** Wire-side field schema, when the shared contract is known. */
  readonly schema?: z.ZodType;
}

/** Wrappers whose `def.innerType` is the schema they decorate. */
const VALUE_WRAPPERS = [z.ZodOptional, z.ZodNullable, z.ZodDefault, z.ZodReadonly] as const;

function unwrap(schema: z.ZodType): { readonly inner: z.ZodType; readonly required: boolean } {
  let current: z.ZodType = schema;
  let required = true;
  while (VALUE_WRAPPERS.some((wrapper) => current instanceof wrapper)) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      required = false;
    }
    current = (current.def as unknown as { innerType: z.ZodType }).innerType;
  }
  return { inner: current, required };
}

/** Exported for direct tests of field shapes no current contract uses. */
export function describeField(name: string, schema: z.ZodType): OpFieldDescriptor {
  const { inner, required } = unwrap(schema);
  if (inner instanceof z.ZodEnum) {
    return {
      name,
      required,
      control: 'enum',
      options: inner.options.map(String),
      schema,
    };
  }
  if (inner instanceof z.ZodNumber) {
    return { name, required, control: 'number', schema };
  }
  return { name, required, control: 'text', schema };
}

/** `reason` renders last in every op form regardless of contract order. */
function reasonLast(fields: readonly OpFieldDescriptor[]): readonly OpFieldDescriptor[] {
  const reason = fields.filter((field) => field.name === 'reason');
  return [...fields.filter((field) => field.name !== 'reason'), ...reason];
}

/**
 * Field descriptors for an op: derived from the shared contract's Zod input
 * when the op name is known, else from the wire catalog's field-name list
 * (required text inputs — server-side validation still applies).
 */
export function describeOpFields(
  opName: string,
  wireFields: readonly string[]
): readonly OpFieldDescriptor[] {
  const contract = (ADMIN_OP_CONTRACTS as Record<string, AnyAdminOpContract | undefined>)[opName];
  if (contract === undefined) {
    return reasonLast(wireFields.map((name) => ({ name, required: true, control: 'text' })));
  }
  const shape = contract.input.shape as Record<string, z.ZodType>;
  return reasonLast(Object.entries(shape).map(([name, schema]) => describeField(name, schema)));
}

export interface OpInputBuildResult {
  /** Wire-shape input (raw strings/numbers — the server parses). */
  readonly input: Record<string, unknown>;
  /** Per-field messages; empty when the input is submittable. */
  readonly errors: Record<string, string>;
}

type FieldOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'omit' };

function processField(field: OpFieldDescriptor, raw: string): FieldOutcome {
  if (raw.trim() === '') {
    return field.required
      ? { kind: 'error', message: 'This field is required.' }
      : { kind: 'omit' };
  }
  const candidate: unknown = field.control === 'number' ? Number(raw) : raw;
  if (field.schema !== undefined) {
    const parsed = field.schema.safeParse(candidate);
    if (!parsed.success) {
      return { kind: 'error', message: parsed.error.issues[0]?.message ?? 'Enter a valid value.' };
    }
  }
  return { kind: 'value', value: candidate };
}

/** Validates raw form values against the contract and builds the wire input. */
export function buildOpInput(
  fields: readonly OpFieldDescriptor[],
  values: Readonly<Record<string, string>>
): OpInputBuildResult {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const outcome = processField(field, values[field.name] ?? '');
    if (outcome.kind === 'value') {
      input[field.name] = outcome.value;
    } else if (outcome.kind === 'error') {
      errors[field.name] = outcome.message;
    }
  }
  return { input, errors };
}
