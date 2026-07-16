import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { ApiError } from '@/lib/api-client';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import { useCustomer360 } from '@/hooks/use-customer-360';
import { AuditActionsTable } from '@/components/audit/audit-actions-table';
import { UserSearch } from '@/components/dashboard/user-search';
import { CopyableId } from '@/components/util/copyable-id';
import { NanoUsdAmount } from '@/components/util/nano-usd-amount';
import { PanelFrame } from '@/components/util/panel-frame';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { C360Header } from './c360-header.js';
import type {
  Customer360ConversationsPanel,
  Customer360MoneyPanel,
  Customer360Panel,
  Customer360UsagePanel,
  Customer360View,
  AdminJobRowWire,
} from '@hushbox/shared';

/** Compact UTC minute precision, matching the audit feed. */
function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

/** A server-shaped panel: its own data or its own inline error. */
function ServerPanel<T>({
  title,
  panel,
  render,
}: Readonly<{
  title: string;
  panel: Customer360Panel<T>;
  render: (data: T) => React.ReactNode;
}>): React.JSX.Element {
  if (!panel.ok) {
    return <PanelFrame title={title} error={panel.error} />;
  }
  return <PanelFrame title={title}>{render(panel.data)}</PanelFrame>;
}

const NUMERIC_CELL = 'py-1 pl-2 text-right';

function MoneyPanelContent({ data }: Readonly<{ data: Customer360MoneyPanel }>): React.JSX.Element {
  const { balance, recentLedger } = data;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-muted-foreground text-xs uppercase">Purchased</dt>
          <dd>
            <NanoUsdAmount wire={balance.purchasedNanoUsd} className="text-sm" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs uppercase">Free</dt>
          <dd>
            <NanoUsdAmount wire={balance.freeNanoUsd} className="text-sm" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs uppercase">
            Allowance {balance.allowance.day}
          </dt>
          <dd className="text-sm">
            <NanoUsdAmount wire={balance.allowance.spentNanoUsd} className="text-sm" /> of{' '}
            <NanoUsdAmount wire={balance.allowance.limitNanoUsd} className="text-sm" /> spent
          </dd>
        </div>
      </dl>
      {recentLedger.length === 0 ? (
        <p className="text-muted-foreground text-sm">No ledger entries in the last 90 days.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-muted-foreground border-border border-b text-xs uppercase">
              <th className="py-1 pr-2 font-medium">When</th>
              <th className="py-1 pr-2 font-medium">Kind</th>
              <th className="py-1 pl-2 text-right font-medium">Amount</th>
              <th className="py-1 pl-2 text-right font-medium">Balance after</th>
            </tr>
          </thead>
          <tbody>
            {recentLedger.map((row, index) => (
              <tr key={`${row.createdAt}-${String(index)}`} className="border-border border-b">
                <td className="py-1 pr-2 font-mono text-xs whitespace-nowrap">
                  {formatTime(row.createdAt)}
                </td>
                <td className="py-1 pr-2 font-mono text-xs">{row.kind}</td>
                <td className={NUMERIC_CELL}>
                  <NanoUsdAmount wire={row.amountNanoUsd} />
                </td>
                <td className={NUMERIC_CELL}>
                  <NanoUsdAmount wire={row.balanceAfterNanoUsd} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UsagePanelContent({ data }: Readonly<{ data: Customer360UsagePanel }>): React.JSX.Element {
  if (data.models.length === 0) {
    return <p className="text-muted-foreground text-sm">No usage recorded.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-muted-foreground border-border border-b text-xs uppercase">
          <th className="py-1 pr-2 font-medium">Model</th>
          <th className="py-1 pl-2 text-right font-medium">Total</th>
          <th className="py-1 pl-2 text-right font-medium">Records</th>
          <th className="py-1 pl-2 text-right font-medium">Estimated</th>
        </tr>
      </thead>
      <tbody>
        {data.models.map((row) => (
          <tr key={row.modelId} className="border-border border-b">
            <td className="py-1 pr-2 font-mono text-xs">{row.modelId}</td>
            <td className={NUMERIC_CELL}>
              <NanoUsdAmount wire={row.totalNanoUsd} />
            </td>
            <td className={`${NUMERIC_CELL} font-mono text-xs tabular-nums`}>{row.recordCount}</td>
            <td className={`${NUMERIC_CELL} font-mono text-xs tabular-nums`}>
              {row.estimatedCount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConversationsPanelContent({
  data,
}: Readonly<{ data: Customer360ConversationsPanel }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <dl className="grid grid-cols-2 gap-2">
        <div>
          <dt className="text-muted-foreground text-xs uppercase">Owned</dt>
          <dd className="font-mono tabular-nums">{data.owned}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs uppercase">Active memberships</dt>
          <dd className="font-mono tabular-nums">{data.activeMemberships}</dd>
        </div>
      </dl>
      <p className="text-muted-foreground text-xs">
        Conversation content is ciphertext and cannot be shown here.
      </p>
    </div>
  );
}

function JobsPanelContent({
  data,
}: Readonly<{ data: { jobs: readonly AdminJobRowWire[] } }>): React.JSX.Element {
  if (data.jobs.length === 0) {
    return <p className="text-muted-foreground text-sm">No jobs touching this user.</p>;
  }
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="text-muted-foreground border-border border-b text-xs uppercase">
          <th className="py-1 pr-2 font-medium">Job</th>
          <th className="py-1 pr-2 font-medium">Status</th>
          <th className="py-1 pl-2 text-right font-medium">Failures</th>
        </tr>
      </thead>
      <tbody>
        {data.jobs.map((job) => (
          <tr key={job.id} className="border-border border-b align-top">
            <td className="py-1 pr-2">
              <div className="flex flex-col">
                <span className="font-mono text-xs">{job.type}</span>
                <CopyableId value={job.id} label="job id" />
              </div>
            </td>
            <td className="py-1 pr-2 font-mono text-xs">
              {job.status}
              {job.discarded ? ' (discarded)' : ''}
            </td>
            <td className={`${NUMERIC_CELL} font-mono text-xs tabular-nums`}>{job.failures}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IdentityPanelContent({
  user,
}: Readonly<{ user: Customer360View['user'] }>): React.JSX.Element {
  const facts: readonly (readonly [string, string])[] = [
    ['Username', user.username],
    ['Email verified', user.emailVerified ? 'yes' : 'no'],
    ['TOTP enabled', user.totpEnabled ? 'yes' : 'no'],
    ['Recovery phrase acknowledged', user.hasAcknowledgedPhrase ? 'yes' : 'no'],
  ];
  return (
    <dl className="flex flex-col gap-1 text-sm">
      {facts.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-2">
          <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
          <dd className="font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LoadingPanels(): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.adminC360Panels}
      className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]"
    >
      <div className="flex flex-col gap-4">
        <PanelFrame title="Money" loading />
        <PanelFrame title="Usage" loading />
        <PanelFrame title="Conversations" loading />
        <PanelFrame title="Admin history" loading />
      </div>
      <div className="flex flex-col gap-4">
        <PanelFrame title="Identity" loading />
        <PanelFrame title="Jobs" loading />
      </div>
    </div>
  );
}

function LoadedView({ view }: Readonly<{ view: Customer360View }>): React.JSX.Element {
  const { panels } = view;
  return (
    <>
      <C360Header user={view.user} money={panels.money} />
      <div
        data-testid={TEST_IDS.adminC360Panels}
        className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]"
      >
        <div className="flex flex-col gap-4">
          <ServerPanel
            title="Money"
            panel={panels.money}
            render={(data) => <MoneyPanelContent data={data} />}
          />
          <ServerPanel
            title="Usage"
            panel={panels.usage}
            render={(data) => <UsagePanelContent data={data} />}
          />
          <ServerPanel
            title="Conversations"
            panel={panels.conversations}
            render={(data) => <ConversationsPanelContent data={data} />}
          />
          <ServerPanel
            title="Admin history"
            panel={panels.adminHistory}
            render={(data) => <AuditActionsTable rows={data.actions} />}
          />
        </div>
        <div className="flex flex-col gap-4">
          <PanelFrame title="Identity">
            <IdentityPanelContent user={view.user} />
          </PanelFrame>
          <ServerPanel
            title="Jobs"
            panel={panels.jobs}
            render={(data) => <JobsPanelContent data={data} />}
          />
        </div>
      </div>
    </>
  );
}

/**
 * Customer 360: one query per lookup; panels are server-shaped Panel values
 * that loaded or failed independently, rendered with per-panel errors so one
 * broken panel never blanks the page. A miss (unknown email or id) is an
 * empty state carrying the searched term, not an error toast.
 */
function ScreenBody({
  q,
  query,
}: Readonly<{
  q: string | undefined;
  query: ReturnType<typeof useCustomer360>;
}>): React.JSX.Element {
  if (q === undefined || q.trim() === '') {
    return (
      <p data-testid={TEST_IDS.adminC360Empty} className="text-muted-foreground text-sm">
        Search for a user by email or user id to open their 360 view.
      </p>
    );
  }
  if (query.isPending) {
    return <LoadingPanels />;
  }
  if (query.isError) {
    const retryAfter = retryAfterSecondsOf(query.error);
    if (retryAfter !== null) {
      return (
        <RateLimitedNotice
          retryAfterSeconds={retryAfter}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <p data-testid={TEST_IDS.adminC360Miss} className="text-muted-foreground text-sm">
          No user matches <span className="font-mono">{q}</span>. Check the email or id and search
          again.
        </p>
      );
    }
    return <p className="text-destructive text-sm">Failed to load the Customer 360 view.</p>;
  }
  return <LoadedView view={query.data} />;
}

export function Customer360Screen({ q }: Readonly<{ q?: string | undefined }>): React.JSX.Element {
  const query = useCustomer360(q);
  return (
    <section className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Customer 360</h1>
        <UserSearch />
      </div>
      <ScreenBody q={q} query={query} />
    </section>
  );
}
