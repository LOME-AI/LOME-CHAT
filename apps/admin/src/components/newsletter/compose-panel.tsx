import * as React from 'react';
import { Button, Input, Label, Textarea } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { PreviewPane } from './preview-pane.js';

/** A datetime-local value read as UTC (the picker is labeled UTC), as the
 * schedule op's `z.iso.datetime()` input expects. Date-parsed rather than
 * suffix-concatenated: browsers may emit minutes- or seconds-precision
 * values, and both must normalize to a full ISO instant. */
export function toUtcIso(local: string): string {
  return new Date(`${local}Z`).toISOString();
}

/** Current UTC minute for the picker's `min` — scheduling is future-only. */
function nowUtcMinute(): string {
  return new Date().toISOString().slice(0, 16);
}

function Field({
  id,
  label,
  children,
}: Readonly<{ id: string; label: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * The compose scratchpad: draft fields plus the live dispatch-path preview.
 * It mutates nothing itself — Schedule and Send-test hand the draft to the
 * OpModal (form → preview diff → execute → undo) as caller-seeded prefill,
 * so both mutations run only through the app's one interaction signature.
 */
export function ComposePanel(): React.JSX.Element {
  const runOp = useRunOp();
  const [subject, setSubject] = React.useState('');
  const [bodyMarkdown, setBodyMarkdown] = React.useState('');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [reason, setReason] = React.useState('');

  const draftComplete = subject.trim() !== '' && bodyMarkdown.trim() !== '';

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-3">
        <Field id="newsletter-subject" label="Subject">
          <Input
            id="newsletter-subject"
            data-testid={TEST_IDS.adminNewsletterSubject}
            autoComplete="off"
            value={subject}
            onChange={(event) => {
              setSubject(event.target.value);
            }}
          />
        </Field>
        <Field id="newsletter-body" label="Body (markdown)">
          <Textarea
            id="newsletter-body"
            data-testid={TEST_IDS.adminNewsletterBody}
            rows={10}
            className="font-mono text-xs"
            value={bodyMarkdown}
            onChange={(event) => {
              setBodyMarkdown(event.target.value);
            }}
          />
        </Field>
        <Field id="newsletter-scheduled-at" label="Send at (UTC)">
          <Input
            id="newsletter-scheduled-at"
            data-testid={TEST_IDS.adminNewsletterScheduledAt}
            type="datetime-local"
            min={nowUtcMinute()}
            value={scheduledAt}
            onChange={(event) => {
              setScheduledAt(event.target.value);
            }}
          />
        </Field>
        <Field id="newsletter-reason" label="Reason">
          <Input
            id="newsletter-reason"
            data-testid={TEST_IDS.adminNewsletterReason}
            autoComplete="off"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid={TEST_IDS.adminNewsletterSchedule}
            size="sm"
            disabled={!draftComplete || scheduledAt === ''}
            onClick={() => {
              runOp({
                opName: 'newsletter.schedule',
                initialValues: {
                  subject,
                  bodyMarkdown,
                  scheduledAt: toUtcIso(scheduledAt),
                  reason,
                },
              });
            }}
          >
            Schedule…
          </Button>
          <Button
            data-testid={TEST_IDS.adminNewsletterTestSend}
            size="sm"
            variant="outline"
            disabled={!draftComplete}
            onClick={() => {
              runOp({
                opName: 'newsletter.testSend',
                initialValues: { subject, bodyMarkdown, reason },
              });
            }}
          >
            Send test to me…
          </Button>
        </div>
      </div>
      <PreviewPane subject={subject} bodyMarkdown={bodyMarkdown} />
    </div>
  );
}
