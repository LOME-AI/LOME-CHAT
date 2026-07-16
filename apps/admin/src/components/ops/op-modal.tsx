import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
} from '@hushbox/ui';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { ApiError } from '@/lib/api-client';
import { describeOpFields } from '@/lib/op-fields';
import { executeOp, previewOp } from '@/lib/op-run';
import { DiffList } from './diff-list.js';
import { OpForm } from './op-form.js';
import type { AdminOpExecuteResult, AdminOpPreviewResult, AdminOpWire } from '@hushbox/shared';

/** Where an OpModal flow starts: the op plus optional prefill/undo linkage. */
export interface OpFlowStart {
  readonly opName: string;
  readonly initialValues?: Readonly<Record<string, string>>;
  /** Audit row id this flow undoes (set when the flow runs an inverse op). */
  readonly undoes?: string;
}

interface OpModalProps {
  readonly ops: readonly AdminOpWire[];
  readonly start: OpFlowStart;
  readonly onClose: () => void;
}

type Step = 'form' | 'preview' | 'result';

function ErrorNotice({ error }: Readonly<{ error: unknown }>): React.JSX.Element {
  const code = error instanceof ApiError ? error.message : 'INTERNAL';
  return (
    <p data-testid={TEST_IDS.adminOpError} role="alert" className="text-destructive text-sm">
      {friendlyErrorMessage(code)} <span className="font-mono text-xs">{code}</span>
    </p>
  );
}

/** The execute button states the previewed consequence, never "Confirm". */
function executeLabelFor(title: string, data: AdminOpPreviewResult | undefined): string {
  const count = data?.effects.length ?? 0;
  return `${title} (${String(count)} ${count === 1 ? 'change' : 'changes'})`;
}

/** The inverse flow Undo starts, or null when the op has nothing to undo. */
function undoFlowFor(
  contract: AdminOpWire | undefined,
  result: AdminOpExecuteResult
): OpFlowStart | null {
  if (contract?.inverse == null || result.inverseInput === null) {
    return null;
  }
  return {
    opName: contract.inverse,
    initialValues: Object.fromEntries(
      Object.entries(result.inverseInput).map(([key, value]) => [key, String(value)])
    ),
    undoes: result.auditId,
  };
}

interface PreviewStepProps {
  readonly pending: boolean;
  readonly error: unknown;
  readonly data: AdminOpPreviewResult | undefined;
  readonly executeLabel: string;
  readonly executePending: boolean;
  readonly onBack: () => void;
  readonly onExecute: () => void;
}

function PreviewStep(props: Readonly<PreviewStepProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {props.pending ? <p className="text-muted-foreground text-sm">Previewing changes…</p> : null}
      {props.error == null ? null : <ErrorNotice error={props.error} />}
      {props.data === undefined ? null : <DiffList effects={props.data.effects} />}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={props.onBack}>
          Back to form
        </Button>
        {props.data === undefined ? null : (
          <Button
            data-testid={TEST_IDS.adminOpExecute}
            onClick={props.onExecute}
            disabled={props.executePending}
          >
            {props.executeLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

interface ResultStepProps {
  readonly result: AdminOpExecuteResult;
  readonly undoFlow: OpFlowStart | null;
  readonly onUndo: (flow: OpFlowStart) => void;
  readonly onClose: () => void;
}

function ResultStep({ result, undoFlow, onUndo, onClose }: ResultStepProps): React.JSX.Element {
  return (
    <div data-testid={TEST_IDS.adminOpResult} className="flex flex-col gap-3">
      <p className="text-sm">Executed. Audit row:</p>
      <p className="flex items-center gap-1">
        <span data-testid={TEST_IDS.adminOpAuditId} className="font-mono text-xs break-all">
          {result.auditId}
        </span>
        <IconButton
          data-testid={TEST_IDS.adminOpCopyAudit}
          aria-label="Copy audit row id"
          onClick={() => {
            void navigator.clipboard.writeText(result.auditId);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </IconButton>
      </p>
      <div className="flex justify-end gap-2">
        {undoFlow === null ? null : (
          <Button
            data-testid={TEST_IDS.adminOpUndo}
            variant="outline"
            onClick={() => {
              onUndo(undoFlow);
            }}
          >
            Undo
          </Button>
        )}
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

/**
 * The app's one interaction signature: form, preview diff, execute/result
 * with Undo. Every mutation flows through this modal; there are no bespoke
 * confirm dialogs. The Idempotency-Key is minted once per form submission
 * and reused across retries of that submission.
 */
export function OpModal({ ops, start, onClose }: OpModalProps): React.JSX.Element {
  const [flow, setFlow] = React.useState<OpFlowStart>(start);
  const [step, setStep] = React.useState<Step>('form');
  const [input, setInput] = React.useState<Record<string, unknown>>({});
  // Raw form values survive a Back-to-form round trip after a blocked preview.
  const [formValues, setFormValues] = React.useState<Record<string, string>>(() => ({
    ...start.initialValues,
  }));
  const idempotencyKey = React.useRef<string>('');

  const contract = ops.find((op) => op.name === flow.opName);
  const title = contract?.title ?? flow.opName;
  const fields = describeOpFields(flow.opName, contract?.fields ?? []);

  const preview = useMutation<AdminOpPreviewResult, unknown, Record<string, unknown>>({
    mutationFn: (submitted) => previewOp(flow.opName, submitted),
  });
  const execute = useMutation<AdminOpExecuteResult, unknown>({
    mutationFn: () =>
      executeOp({
        name: flow.opName,
        input,
        idempotencyKey: idempotencyKey.current,
        ...(flow.undoes === undefined ? {} : { undoes: flow.undoes }),
      }),
  });

  function startFlow(next: OpFlowStart): void {
    setFlow(next);
    setStep('form');
    setInput({});
    setFormValues({ ...next.initialValues });
    preview.reset();
    execute.reset();
  }

  function handleFormSubmit(submitted: Record<string, unknown>): void {
    // One key per form submission: retries of this submission replay it; a
    // fresh submission (including Undo's inverse flow) mints a new key.
    idempotencyKey.current = crypto.randomUUID();
    setInput(submitted);
    setFormValues(
      Object.fromEntries(Object.entries(submitted).map(([key, value]) => [key, String(value)]))
    );
    setStep('preview');
    preview.mutate(submitted);
  }

  function handleBackToForm(): void {
    setStep('form');
    preview.reset();
    execute.reset();
  }

  function handleExecute(): void {
    execute.mutate(undefined, {
      onSuccess: () => {
        setStep('result');
      },
    });
  }

  return (
    // Always open while mounted and there is no trigger, so Radix only ever
    // reports close attempts — onOpenChange(false).
    <Dialog
      open
      onOpenChange={() => {
        onClose();
      }}
    >
      <DialogContent data-testid={TEST_IDS.adminOpModal}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="font-mono text-xs">{flow.opName}</DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <OpForm
            fields={fields}
            initialValues={formValues}
            onSubmit={handleFormSubmit}
            pending={preview.isPending}
          />
        ) : null}

        {step === 'preview' ? (
          <PreviewStep
            pending={preview.isPending}
            error={preview.error ?? execute.error}
            data={preview.data}
            executeLabel={executeLabelFor(title, preview.data)}
            executePending={execute.isPending}
            onBack={handleBackToForm}
            onExecute={handleExecute}
          />
        ) : null}

        {step === 'result' && execute.data !== undefined ? (
          <ResultStep
            result={execute.data}
            undoFlow={undoFlowFor(contract, execute.data)}
            onUndo={startFlow}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
