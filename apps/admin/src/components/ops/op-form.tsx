import * as React from 'react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { buildOpInput } from '@/lib/op-fields';
import type { OpFieldDescriptor } from '@/lib/op-fields';

interface OpFormProps {
  readonly fields: readonly OpFieldDescriptor[];
  readonly initialValues?: Readonly<Record<string, string>>;
  readonly onSubmit: (input: Record<string, unknown>) => void;
  readonly pending?: boolean;
}

/**
 * The one generic op form: rendered entirely from contract-derived field
 * descriptors. A field this form cannot render is a contract bug (inputs
 * must stay flat), never a reason for a bespoke per-op form.
 */
export function OpForm({
  fields,
  initialValues,
  onSubmit,
  pending,
}: OpFormProps): React.JSX.Element {
  const [values, setValues] = React.useState<Record<string, string>>(() => ({
    ...initialValues,
  }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  function setValue(name: string, value: string): void {
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
      {fields.map((field) => (
        <div key={field.name} className="flex flex-col gap-1">
          <Label htmlFor={`op-field-${field.name}`}>{field.name}</Label>
          {field.control === 'enum' ? (
            <Select
              value={values[field.name] ?? ''}
              onValueChange={(value) => {
                setValue(field.name, value);
              }}
            >
              <SelectTrigger id={`op-field-${field.name}`} className="w-full">
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
          ) : (
            <Input
              id={`op-field-${field.name}`}
              name={field.name}
              type={field.control === 'number' ? 'number' : 'text'}
              autoComplete="off"
              value={values[field.name] ?? ''}
              onChange={(event) => {
                setValue(field.name, event.target.value);
              }}
            />
          )}
          {errors[field.name] === undefined ? null : (
            <p data-testid={TEST_IDS.adminOpFieldError} className="text-destructive text-xs">
              {errors[field.name]}
            </p>
          )}
        </div>
      ))}
      <Button type="submit" disabled={pending === true} className="self-end">
        Preview changes
      </Button>
    </form>
  );
}
