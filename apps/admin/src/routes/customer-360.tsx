import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Customer360Screen } from '@/components/customer-360/customer-360-screen';

function Screen(): React.JSX.Element {
  const { q } = Route.useSearch();
  return <Customer360Screen q={q} />;
}

export const Route = createFileRoute('/customer-360')({
  // `q` is the go-to-user payload (email or user id) from the palette and
  // the dashboard search.
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search['q'] === 'string' ? { q: search['q'] } : {},
  component: Screen,
});
