import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';

interface PanelFrameProps {
  readonly title: string;
  readonly loading?: boolean | undefined;
  /** Server-side panel error code — the panel failed on its own. */
  readonly error?: string | undefined;
  readonly children?: React.ReactNode;
}

/**
 * One Customer-360 panel: loads and fails independently (per-panel skeleton
 * and inline error), so one broken panel never blanks the page.
 */
function PanelBody({
  loading,
  error,
  children,
}: Omit<PanelFrameProps, 'title'>): React.JSX.Element {
  if (loading === true) {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        <div className="bg-muted h-3 w-3/4 animate-pulse rounded" />
        <div className="bg-muted h-3 w-1/2 animate-pulse rounded" />
      </div>
    );
  }
  if (error !== undefined) {
    return (
      <p data-testid={TEST_IDS.adminPanelError} className="text-destructive text-sm">
        Failed to load <span className="font-mono text-xs">{error}</span>
      </p>
    );
  }
  return <>{children}</>;
}

export function PanelFrame({
  title,
  loading,
  error,
  children,
}: PanelFrameProps): React.JSX.Element {
  return (
    <section className="border-border bg-card rounded-md border p-3">
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold uppercase">{title}</h2>
      <PanelBody loading={loading} error={error}>
        {children}
      </PanelBody>
    </section>
  );
}
