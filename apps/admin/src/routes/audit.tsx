import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PlaceholderScreen } from '@/components/shell/placeholder-screen';

function Screen(): React.JSX.Element {
  return <PlaceholderScreen title="Audit trail" />;
}

export const Route = createFileRoute('/audit')({
  component: Screen,
});
