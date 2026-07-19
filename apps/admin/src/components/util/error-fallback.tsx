import * as React from 'react';
import { Button } from '@hushbox/ui';
import type { ErrorComponentProps } from '@tanstack/react-router';

interface ErrorFallbackProps {
  readonly title: string;
  readonly detail?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
}

/**
 * The admin console's last-resort readable state. Renders plain text with no
 * provider dependencies so it degrades gracefully even when a provider or the
 * shell itself is what threw — the whole point is that it never blanks.
 */
export function ErrorFallback({ title, detail, onRetry }: ErrorFallbackProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="text-foreground flex h-dvh flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <h1 className="text-lg font-semibold">{title}</h1>
      {detail === undefined ? null : (
        <p className="text-muted-foreground max-w-md font-mono text-xs break-words">{detail}</p>
      )}
      {onRetry === undefined ? null : <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/**
 * Router `defaultErrorComponent`: catches an uncaught throw inside any routed
 * component (TanStack's per-route CatchBoundary) and shows the message with the
 * router's own reset wired to retry.
 */
export function RouteErrorComponent({
  error,
  reset,
}: Readonly<ErrorComponentProps>): React.JSX.Element {
  return <ErrorFallback title="Something went wrong" detail={error.message} onRetry={reset} />;
}

/** Router `defaultNotFoundComponent`: an unknown route lands here, not a blank page. */
export function NotFoundFallback(): React.JSX.Element {
  return (
    <ErrorFallback
      title="Page not found"
      detail="This screen does not exist. Press ⌘K to jump to any user, op, or screen."
    />
  );
}
