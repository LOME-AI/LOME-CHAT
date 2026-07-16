import * as React from 'react';
import { useOps } from '@/hooks/use-ops';
import { OpModal } from './op-modal.js';
import type { OpFlowStart } from './op-modal.js';

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

/**
 * Hosts the single OpModal instance. The catalog query stays idle until the
 * first flow starts, so mounting the provider costs no request.
 */
export function OpModalProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [flow, setFlow] = React.useState<{ id: number; start: OpFlowStart } | null>(null);
  const nextFlowId = React.useRef(0);
  const ops = useOps({ enabled: flow !== null });
  const runOp = React.useCallback<RunOp>((next) => {
    // A fresh id per runOp: OpModal seeds its state from `start` at mount
    // only, so the key remounts it fresh when a flow starts over an open one.
    nextFlowId.current += 1;
    setFlow({ id: nextFlowId.current, start: next });
  }, []);

  return (
    <OpModalContext value={runOp}>
      {children}
      {flow !== null && ops.data !== undefined ? (
        <OpModal
          key={flow.id}
          ops={ops.data.ops}
          start={flow.start}
          onClose={() => {
            setFlow(null);
          }}
        />
      ) : null}
    </OpModalContext>
  );
}
