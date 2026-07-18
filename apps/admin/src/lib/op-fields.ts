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
  readonly control: 'text' | 'number' | 'enum' | 'boolean' | 'group';
  readonly options?: readonly string[];
  /** Wire-side field schema, when the shared contract is known. */
  readonly schema?: z.ZodType;
  /** Sub-field descriptors of a repeatable group's row object. */
  readonly fields?: readonly OpFieldDescriptor[];
}

/** One repeatable-group row as the form holds it (raw scalar values). */
export type OpGroupRowValue = Readonly<Record<string, string | boolean | undefined>>;

/** A form field's raw value: scalar controls or a group's row list. */
export type OpFieldValue = string | boolean | readonly OpGroupRowValue[];

export type OpFormValues = Record<string, OpFieldValue>;

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
  if (inner instanceof z.ZodBoolean) {
    return { name, required, control: 'boolean', schema };
  }
  if (inner instanceof z.ZodArray) {
    const element = unwrap(inner.def.element as z.ZodType).inner;
    if (element instanceof z.ZodObject) {
      // A repeatable group — the contract constructor already guarantees the
      // element's sub-fields are flat scalars (see shared admin contract.ts).
      const shape = element.shape as Record<string, z.ZodType>;
      return {
        name,
        required,
        control: 'group',
        schema,
        fields: Object.entries(shape).map(([subName, subSchema]) =>
          describeField(subName, subSchema)
        ),
      };
    }
  }
  return { name, required, control: 'text', schema };
}

/** The error-map key shared by `buildOpInput` and the form's row rendering. */
export function groupErrorKey(fieldName: string, rowIndex: number, subName: string): string {
  return `${fieldName}.${String(rowIndex)}.${subName}`;
}

/**
 * Rewrites a group's row-scoped error keys through an index mapping so
 * displayed errors follow their rows when the form reorders, prepends, or
 * deletes rows. Mapping a row to `undefined` drops its keys (a deleted row's
 * errors). Group-level keys (the bare field name) and other fields pass
 * through.
 */
export function remapGroupRowErrors(
  errors: Readonly<Record<string, string>>,
  fieldName: string,
  mapRowIndex: (rowIndex: number) => number | undefined
): Record<string, string> {
  const rowKeyPrefix = `${fieldName}.`;
  return Object.fromEntries(
    Object.entries(errors).flatMap(([key, message]): [string, string][] => {
      if (!key.startsWith(rowKeyPrefix)) {
        return [[key, message]];
      }
      const [rowIndex, ...subParts] = key.slice(rowKeyPrefix.length).split('.');
      const mapped = mapRowIndex(Number(rowIndex));
      if (mapped === undefined) {
        return [];
      }
      return [[groupErrorKey(fieldName, mapped, subParts.join('.')), message]];
    })
  );
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

function validateAgainstSchema(schema: z.ZodType | undefined, candidate: unknown): FieldOutcome {
  if (schema !== undefined) {
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      return { kind: 'error', message: parsed.error.issues[0]?.message ?? 'Enter a valid value.' };
    }
  }
  return { kind: 'value', value: candidate };
}

function processScalarField(
  field: OpFieldDescriptor,
  raw: string | boolean | undefined
): FieldOutcome {
  if (field.control === 'boolean') {
    // An untouched switch means false for a required boolean; an optional one
    // is only sent once the user has toggled it.
    if (raw === undefined && !field.required) {
      return { kind: 'omit' };
    }
    return validateAgainstSchema(field.schema, raw === true);
  }
  const text = typeof raw === 'string' ? raw : '';
  if (text.trim() === '') {
    return field.required
      ? { kind: 'error', message: 'This field is required.' }
      : { kind: 'omit' };
  }
  const candidate: unknown = field.control === 'number' ? Number(text) : text;
  return validateAgainstSchema(field.schema, candidate);
}

/** Empty means untouched: blank/undefined scalars, or a switch left off. */
function isRowValueEmpty(value: string | boolean | undefined): boolean {
  return (
    value === undefined || value === false || (typeof value === 'string' && value.trim() === '')
  );
}

/** True when every sub-field of a group row is untouched — such rows are
 * ignored at submit and the form keeps exactly one as the trailing blank. */
export function isGroupRowEmpty(field: OpFieldDescriptor, row: OpGroupRowValue): boolean {
  return (field.fields ?? []).every((sub) => isRowValueEmpty(row[sub.name]));
}

/** A stored group value as its row list; anything else means untouched. */
export function groupRows(value: OpFieldValue | undefined): readonly OpGroupRowValue[] {
  return typeof value === 'object' ? value : [];
}

function processGroupRow(
  field: OpFieldDescriptor,
  rawRow: OpGroupRowValue,
  index: number,
  errors: Record<string, string>
): { readonly row: Record<string, unknown>; readonly hadErrors: boolean } {
  const row: Record<string, unknown> = {};
  let hadErrors = false;
  for (const sub of field.fields ?? []) {
    const outcome = processScalarField(sub, rawRow[sub.name]);
    if (outcome.kind === 'value') {
      row[sub.name] = outcome.value;
    } else if (outcome.kind === 'error') {
      errors[groupErrorKey(field.name, index, sub.name)] = outcome.message;
      hadErrors = true;
    }
  }
  return { row, hadErrors };
}

function processGroupField(
  field: OpFieldDescriptor,
  rawRows: readonly OpGroupRowValue[],
  errors: Record<string, string>
): FieldOutcome {
  const rows: Record<string, unknown>[] = [];
  let rowErrors = false;
  for (const [index, rawRow] of rawRows.entries()) {
    if (isGroupRowEmpty(field, rawRow)) {
      continue; // A fully empty row (the trailing blank one included) is ignored.
    }
    const { row, hadErrors } = processGroupRow(field, rawRow, index, errors);
    rowErrors = rowErrors || hadErrors;
    rows.push(row);
  }
  if (rowErrors) {
    return { kind: 'omit' };
  }
  if (rows.length === 0 && !field.required) {
    return { kind: 'omit' };
  }
  // Array-level constraints (e.g. a row-count cap) surface on the group field.
  return validateAgainstSchema(field.schema, rows);
}

function processField(
  field: OpFieldDescriptor,
  raw: OpFieldValue | undefined,
  errors: Record<string, string>
): FieldOutcome {
  if (field.control === 'group') {
    return processGroupField(field, groupRows(raw), errors);
  }
  return processScalarField(field, typeof raw === 'object' ? undefined : raw);
}

/** Validates raw form values against the contract and builds the wire input. */
export function buildOpInput(
  fields: readonly OpFieldDescriptor[],
  values: Readonly<OpFormValues>
): OpInputBuildResult {
  const input: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const outcome = processField(field, values[field.name], errors);
    if (outcome.kind === 'value') {
      input[field.name] = outcome.value;
    } else if (outcome.kind === 'error') {
      errors[field.name] = outcome.message;
    }
  }
  return { input, errors };
}

function toGroupRow(row: unknown): OpGroupRowValue {
  if (typeof row !== 'object' || row === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, sub]) => [
      key,
      typeof sub === 'boolean' ? sub : String(sub),
    ])
  );
}

function toFormValue(value: unknown): OpFieldValue {
  let converted: OpFieldValue;
  if (typeof value === 'boolean') {
    converted = value;
  } else if (Array.isArray(value)) {
    converted = value.map((row) => toGroupRow(row));
  } else {
    converted = String(value);
  }
  return converted;
}

/**
 * Converts a wire-shape input (a submitted body or an op's inverseInput)
 * back into raw form values — booleans and group rows survive the round
 * trip instead of collapsing through `String(value)`.
 */
export function toFormValues(input: Readonly<Record<string, unknown>>): OpFormValues {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, toFormValue(value)]));
}
