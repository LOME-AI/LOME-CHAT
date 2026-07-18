import type { JSX } from 'react';

export function IdleState(): JSX.Element {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="text-foreground text-sm font-medium">Analyze a page</p>
      <p className="text-sm">
        Enter a URL or pick a page above to see exactly what a no-JavaScript crawler receives.
      </p>
    </div>
  );
}

export function LoadingState({ url }: Readonly<{ url: string }>): JSX.Element {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-foreground text-sm font-medium">Analyzing…</p>
      <p className="max-w-md truncate font-mono text-xs">{url}</p>
    </div>
  );
}

export function ErrorState({
  code,
  message,
}: Readonly<{ code: string; message: string }>): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        role="alert"
        className="bg-error/10 border-error/40 text-error max-w-lg rounded-lg border p-4"
      >
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden>✗</span>
          <span>Analysis failed</span>
          <span className="bg-background-subtle text-foreground rounded border px-1.5 py-0.5 font-mono text-xs">
            {code}
          </span>
        </p>
        <p className="text-foreground mt-2 text-sm">{message}</p>
      </div>
    </div>
  );
}
