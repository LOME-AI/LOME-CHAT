import * as React from 'react';
import { ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import {
  Button,
  IconButton,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import {
  buildOpInput,
  groupErrorKey,
  groupRows,
  isGroupRowEmpty,
  remapGroupRowErrors,
} from '@/lib/op-fields';
import type {
  OpFieldDescriptor,
  OpFieldValue,
  OpFormValues,
  OpGroupRowValue,
} from '@/lib/op-fields';

interface OpFormProps {
  readonly fields: readonly OpFieldDescriptor[];
  readonly initialValues?: Readonly<OpFormValues>;
  readonly onSubmit: (input: Record<string, unknown>) => void;
  readonly pending?: boolean;
}

/** Narrows a stored form value to what a scalar widget can hold. */
function scalarValue(value: OpFieldValue | undefined): string | boolean | undefined {
  return typeof value === 'object' ? undefined : value;
}

function FieldError({
  message,
}: Readonly<{ message: string | undefined }>): React.JSX.Element | null {
  if (message === undefined) {
    return null;
  }
  return (
    <p data-testid={TEST_IDS.adminOpFieldError} className="text-destructive text-xs">
      {message}
    </p>
  );
}

interface ScalarControlProps {
  readonly field: OpFieldDescriptor;
  readonly id: string;
  readonly value: string | boolean | undefined;
  readonly onChange: (value: string | boolean) => void;
}

/** One widget per scalar control kind, shared by top-level and group rows. */
function ScalarControl({ field, id, value, onChange }: ScalarControlProps): React.JSX.Element {
  if (field.control === 'enum') {
    return (
      <Select
        value={typeof value === 'string' ? value : ''}
        onValueChange={(next) => {
          onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Select a value" />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.control === 'boolean') {
    return (
      <Switch
        id={id}
        data-testid={TEST_ID_BUILDERS.adminOpBooleanToggle(field.name)}
        checked={value === true}
        onCheckedChange={(checked) => {
          onChange(checked);
        }}
      />
    );
  }
  return (
    <Input
      id={id}
      name={field.name}
      type={field.control === 'number' ? 'number' : 'text'}
      autoComplete="off"
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}

interface GroupFieldProps {
  readonly field: OpFieldDescriptor;
  readonly value: OpFieldValue | undefined;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (
    rows: readonly OpGroupRowValue[],
    mapRowIndex?: (rowIndex: number) => number | undefined
  ) => void;
}

/**
 * Repeatable group rows with exactly one trailing empty row: typing into it
 * grows the list, and only non-trailing rows are deletable, reorderable, or
 * displaced by a prepend. Fully empty rows are dropped at submit by
 * `buildOpInput`. Reorders, prepends, and deletes pass an index mapping so
 * the form can remap displayed row errors to follow their rows (a deleted
 * row maps to `undefined`, dropping its errors).
 */
function GroupField({ field, value, errors, onChange }: GroupFieldProps): React.JSX.Element {
  const stored = groupRows(value);
  const last = stored.at(-1);
  const rows: readonly OpGroupRowValue[] =
    last !== undefined && isGroupRowEmpty(field, last) ? stored : [...stored, {}];

  // Set by prepend so the render carrying the new empty row moves focus into
  // its first control; cleared before focusing so it fires exactly once.
  const focusFirstRowRef = React.useRef(false);
  React.useEffect(() => {
    if (focusFirstRowRef.current) {
      focusFirstRowRef.current = false;
      const firstSub = (field.fields ?? [])[0];
      if (firstSub !== undefined) {
        document
          .querySelector<HTMLElement>(`[id="op-field-${field.name}-0-${firstSub.name}"]`)
          ?.focus();
      }
    }
  });

  function setRowValue(index: number, subName: string, subValue: string | boolean): void {
    onChange(
      rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [subName]: subValue } : row))
    );
  }

  function removeRow(index: number): void {
    onChange(
      rows.filter((_, rowIndex) => rowIndex !== index),
      (rowIndex) => {
        if (rowIndex === index) {
          return; // The deleted row's errors die with it.
        }
        return rowIndex > index ? rowIndex - 1 : rowIndex;
      }
    );
  }

  /** Swaps the adjacent full rows at `first` and `first + 1` (slice-built to
   * keep the swap total under noUncheckedIndexedAccess — no index fallbacks). */
  function swapAdjacentRows(first: number): void {
    const second = first + 1;
    const reordered = [
      ...rows.slice(0, first),
      ...rows.slice(second, second + 1),
      ...rows.slice(first, second),
      ...rows.slice(second + 1),
    ];
    onChange(reordered, (rowIndex) => {
      if (rowIndex === first) {
        return second;
      }
      if (rowIndex === second) {
        return first;
      }
      return rowIndex;
    });
  }

  function prependRow(): void {
    focusFirstRowRef.current = true;
    onChange([{}, ...rows], (rowIndex) => rowIndex + 1);
  }

  return (
    <div
      data-testid={TEST_ID_BUILDERS.adminOpGroup(field.name)}
      className="flex flex-col gap-2"
      role="group"
      aria-label={field.name}
    >
      <Label asChild>
        <span>{field.name}</span>
      </Label>
      <div>
        <IconButton
          type="button"
          data-testid={TEST_ID_BUILDERS.adminOpGroupPrepend(field.name)}
          aria-label={`Add ${field.name} row at the front`}
          onClick={() => {
            prependRow();
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {rows.map((row, index) => {
        const isTrailingEmptyRow = index === rows.length - 1;
        return (
          <div
            // Rows have no stable identity beyond position; index keys are
            // safe because edits and deletes rebuild the whole list.
            key={index}
            data-testid={TEST_ID_BUILDERS.adminOpGroupRow(field.name, index)}
            className="border-border flex items-start gap-2 rounded-md border p-2"
          >
            <div className="flex grow flex-wrap gap-2">
              {(field.fields ?? []).map((sub) => {
                const id = `op-field-${field.name}-${String(index)}-${sub.name}`;
                return (
                  <div key={sub.name} className="flex min-w-32 grow flex-col gap-1">
                    <Label htmlFor={id}>{sub.name}</Label>
                    <ScalarControl
                      field={sub}
                      id={id}
                      value={row[sub.name]}
                      onChange={(subValue) => {
                        setRowValue(index, sub.name, subValue);
                      }}
                    />
                    <FieldError message={errors[groupErrorKey(field.name, index, sub.name)]} />
                  </div>
                );
              })}
            </div>
            {isTrailingEmptyRow ? null : (
              // Compact vertical action cluster: delete on top, then the
              // stacked up/down move pair — narrower than a horizontal row.
              <div className="flex flex-col gap-1">
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowDelete(field.name, index)}
                  aria-label={`Remove ${field.name} row ${String(index + 1)}`}
                  onClick={() => {
                    removeRow(index);
                  }}
                >
                  <Minus className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowMoveUp(field.name, index)}
                  aria-label={`Move ${field.name} row ${String(index + 1)} up`}
                  disabled={index === 0}
                  onClick={() => {
                    swapAdjacentRows(index - 1);
                  }}
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  type="button"
                  data-testid={TEST_ID_BUILDERS.adminOpGroupRowMoveDown(field.name, index)}
                  aria-label={`Move ${field.name} row ${String(index + 1)} down`}
                  // The trailing empty row is always last, so the last filled
                  // row sits just above it and must never swap into that slot.
                  disabled={index === rows.length - 2}
                  onClick={() => {
                    swapAdjacentRows(index);
                  }}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            )}
          </div>
        );
      })}
      <FieldError message={errors[field.name]} />
    </div>
  );
}

/**
 * The one generic op form: rendered entirely from contract-derived field
 * descriptors. A field this form cannot render is a contract bug (inputs
 * must stay flat, repeatable groups aside), never a reason for a bespoke
 * per-op form.
 */
export function OpForm({
  fields,
  initialValues,
  onSubmit,
  pending,
}: OpFormProps): React.JSX.Element {
  const [values, setValues] = React.useState<OpFormValues>(() => ({
    ...initialValues,
  }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function setValue(name: string, value: OpFieldValue): void {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function handleSubmit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    const built = buildOpInput(fields, values);
    setErrors(built.errors);
    if (Object.keys(built.errors).length === 0) {
      onSubmit(built.input);
    }
  }

  return (
    <form
      data-testid={TEST_IDS.adminOpForm}
      noValidate
      onSubmit={handleSubmit}
      className="flex flex-col gap-3"
    >
      {fields.map((field) =>
        field.control === 'group' ? (
          <GroupField
            key={field.name}
            field={field}
            value={values[field.name]}
            errors={errors}
            onChange={(rows, mapRowIndex) => {
              setValue(field.name, rows);
              // Remap rather than clear: submit-time row errors keep pointing
              // at the row that produced them across reorders, prepends, and
              // deletes (a deleted row's errors are dropped).
              if (mapRowIndex !== undefined) {
                setErrors((current) => remapGroupRowErrors(current, field.name, mapRowIndex));
              }
            }}
          />
        ) : (
          <div key={field.name} className="flex flex-col gap-1">
            <Label htmlFor={`op-field-${field.name}`}>{field.name}</Label>
            <ScalarControl
              field={field}
              id={`op-field-${field.name}`}
              value={scalarValue(values[field.name])}
              onChange={(value) => {
                setValue(field.name, value);
              }}
            />
            <FieldError message={errors[field.name]} />
          </div>
        )
      )}
      <Button type="submit" disabled={pending === true} className="self-end">
        Preview changes
      </Button>
    </form>
  );
}
