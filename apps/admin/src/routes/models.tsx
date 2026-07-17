import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ModelsScreen } from '@/components/models/models-screen';

function Screen(): React.JSX.Element {
  return <ModelsScreen />;
}

export const Route = createFileRoute('/models')({
  component: Screen,
});
