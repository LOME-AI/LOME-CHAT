import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { JobsScreen } from '@/components/jobs/jobs-screen';

function Screen(): React.JSX.Element {
  return <JobsScreen />;
}

export const Route = createFileRoute('/jobs')({
  component: Screen,
});
