import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Badge, Button } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useOps } from '@/hooks/use-ops';
import { useRunOp } from '@/components/ops/op-modal-provider';
import type { AdminOpGuardrailsWire, AdminOpWire } from '@hushbox/shared';

function guardrailSummary(guardrails: AdminOpGuardrailsWire | undefined): string {
  const parts = Object.entries(guardrails ?? {}).map(([key, value]) => `${key} ${String(value)}`);
  return parts.length === 0 ? 'none' : parts.join(', ');
}

function OpRow({ op }: Readonly<{ op: AdminOpWire }>): React.JSX.Element {
  const runOp = useRunOp();
  return (
    <tr className="border-border border-b">
      <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">{op.name}</td>
      <td className="py-1.5 pr-3">{op.title}</td>
      <td className="py-1.5 pr-3">
        <Badge variant="outline">{op.kind}</Badge>
      </td>
      <td className="py-1.5 pr-3">
        <Badge variant="secondary">{op.effectClass}</Badge>
      </td>
      <td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">{op.inverse ?? 'none'}</td>
      <td className="text-muted-foreground py-1.5 pr-3 font-mono text-xs">
        {guardrailSummary(op.guardrails)}
      </td>
      <td className="py-1.5">
        <Button
          data-testid={TEST_IDS.adminOpsRun}
          size="sm"
          variant="outline"
          onClick={() => {
            runOp({ opName: op.name });
          }}
        >
          Run
        </Button>
      </td>
    </tr>
  );
}

// New registered ops appear here with zero UI work: the table renders
// whatever GET /admin/ops returns.
function Screen(): React.JSX.Element {
  const { data, isPending, isError } = useOps();

  if (isPending) {
    return <p className="text-muted-foreground p-4 text-sm">Loading…</p>;
  }
  if (isError) {
    return <p className="text-destructive p-4 text-sm">Failed to load the op catalog.</p>;
  }

  return (
    <section className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Ops catalog</h1>
      <table data-testid={TEST_IDS.adminOpsTable} className="w-full text-left text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-xs uppercase">
            <th className="py-1 pr-3 font-medium">Op</th>
            <th className="py-1 pr-3 font-medium">Title</th>
            <th className="py-1 pr-3 font-medium">Kind</th>
            <th className="py-1 pr-3 font-medium">Effect</th>
            <th className="py-1 pr-3 font-medium">Inverse</th>
            <th className="py-1 pr-3 font-medium">Guardrails</th>
            <th className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.ops.map((op) => (
            <OpRow key={op.name} op={op} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

export const Route = createFileRoute('/ops')({
  component: Screen,
});
