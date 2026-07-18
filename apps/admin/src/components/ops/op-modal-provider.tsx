import * as React from 'react';
import { useOps } from '@/hooks/use-ops';
import { toFormValues } from '@/lib/op-fields';
import { prefillOp } from '@/lib/op-run';
import { OpModal } from './op-modal.js';
import type { OpFlowStart } from './op-modal.js';
import type { OpFormValues } from '@/lib/op-fields';

type RunOp = (flow: OpFlowStart) => void;

const OpModalContext = React.createContext<RunOp | undefined>(undefined);

/** Starts an OpModal flow from anywhere (palette, ops catalog, screens). */
export function useRunOp(): RunOp {
  const runOp = React.useContext(OpModalContext);
  if (runOp === undefined) {
    throw new Error('useRunOp requires an OpModalProvider ancestor');
  }
  return runOp;
}

/** A settled prefill probe for one flow id; null while a probe is in flight. */
interface PrefillState {
  readonly id: number;
  /** Form values to seed, or null when the flow opens blank/caller-seeded. */
  readonly values: OpFormValues | null;
}

/**
 * Hosts the single OpModal instance. The catalog query stays idle until the
 * first flow starts, so mounting the provider costs no request.
 *
 * Every unseeded flow start fires a blind prefill probe; the modal stays
 * unrendered (the same held state as the catalog load) until the probe
 * settles, so a late result can never clobber typing. Caller-seeded flows —
 * screens passing initialValues, and Undo/back-to-form which restart INSIDE
 * OpModal — never probe: provided values always take precedence.
 */
export function OpModalProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [flow, setFlow] = React.useState<{ id: number; start: OpFlowStart } | null>(null);
  const [prefill, setPrefill] = React.useState<PrefillState | null>(null);
  const nextFlowId = React.useRef(0);
  const ops = useOps({ enabled: flow !== null });
  const runOp = React.useCallback<RunOp>((next) => {
    // A fresh id per runOp: OpModal seeds its state from `start` at mount
    // only, so the key remounts it fresh when a flow starts over an open one.
    nextFlowId.current += 1;
    const id = nextFlowId.current;
    setFlow({ id, start: next });
    if (next.initialValues !== undefined) {
      setPrefill({ id, values: null });
      return;
    }
    setPrefill(null);
    void (async (): Promise<void> => {
      const input = await prefillOp(next.opName);
      // A result for a superseded flow is discarded — the id gate keeps a
      // slow probe from seeding (or re-holding) a newer flow.
      setPrefill((current) =>
        id === nextFlowId.current
          ? { id, values: input === null ? null : toFormValues(input) }
          : current
      );
    })();
  }, []);

  return (
    <OpModalContext value={runOp}>
      {children}
      {flow !== null && ops.data !== undefined && prefill?.id === flow.id ? (
        <OpModal
          key={flow.id}
          ops={ops.data.ops}
          start={
            prefill.values === null ? flow.start : { ...flow.start, initialValues: prefill.values }
          }
          onClose={() => {
            setFlow(null);
          }}
        />
      ) : null}
    </OpModalContext>
  );
}
