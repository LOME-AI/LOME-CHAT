import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SqlPanelScreen } from '@/components/sql/sql-panel-screen';

function Screen(): React.JSX.Element {
  return <SqlPanelScreen />;
}

export const Route = createFileRoute('/sql')({
  component: Screen,
});
