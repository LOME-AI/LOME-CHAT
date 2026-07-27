import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import { AccessibilityPanel } from '@hushbox/ui/accessibility/panel';
import { PageHeader } from '@/components/shared/page-header';
import { PageBody } from '@/components/shared/page-body';
import { ThemeToggle } from '@/components/shared/theme-toggle';

function AccessibilityRoute(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Accessibility" right={<ThemeToggle />} />
      <PageBody testId={TEST_IDS.accessibilityContent}>
        <AccessibilityPanel />
      </PageBody>
    </div>
  );
}

export const Route = createFileRoute('/_app/accessibility')({
  component: AccessibilityRoute,
});
