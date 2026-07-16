import * as React from 'react';

interface PlaceholderScreenProps {
  readonly title: string;
}

/** Stand-in for a screen that is not yet implemented — navigation target only. */
export function PlaceholderScreen({ title }: Readonly<PlaceholderScreenProps>): React.JSX.Element {
  return (
    <section className="p-4">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-muted-foreground mt-1 text-sm">Not built yet.</p>
    </section>
  );
}
