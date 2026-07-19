import * as React from 'react';
import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { Customer360Screen } from '@/components/customer-360/customer-360-screen';

// `q` is the go-to-user payload (email or user id) from the palette and the
// dashboard search. A non-string value (a hand-edited URL) is dropped rather
// than coerced, so the screen falls back to its empty state.
const qSchema = z.string();

function Screen(): React.JSX.Element {
  const { q } = Route.useSearch();
  return <Customer360Screen q={q} />;
}

export const Route = createFileRoute('/customer-360')({
  validateSearch: (search: Record<string, unknown>): { q?: string } => {
    const parsed = qSchema.safeParse(search['q']);
    return parsed.success ? { q: parsed.data } : {};
  },
  component: Screen,
});
