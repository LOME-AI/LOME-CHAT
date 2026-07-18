import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { NewsletterScreen } from '@/components/newsletter/newsletter-screen';

function Screen(): React.JSX.Element {
  return <NewsletterScreen />;
}

export const Route = createFileRoute('/newsletter')({
  component: Screen,
});
