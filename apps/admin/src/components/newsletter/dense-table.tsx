import * as React from 'react';

export interface DenseTableHeader {
  readonly label: string;
  readonly srOnly?: boolean;
}

/**
 * The screen's dense-table chrome: header styling plus the wide-table rule —
 * the table scrolls in its own container so the page never scrolls sideways.
 */
export function DenseTable({
  testId,
  headers,
  children,
}: Readonly<{
  testId: string;
  headers: readonly DenseTableHeader[];
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table data-testid={testId} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            {headers.map((header) => (
              <th key={header.label} className="py-1 pr-2 font-medium">
                {header.srOnly === true ? (
                  <span className="sr-only">{header.label}</span>
                ) : (
                  header.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
