import * as React from 'react';
import { Badge, Button, Textarea } from '@hushbox/ui';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { useSqlPanel } from '@/hooks/use-sql-panel';
import { ApiError } from '@/lib/api-client';
import { RateLimitedNotice } from '@/components/util/rate-limited-notice';
import { retryAfterSecondsOf } from '@/lib/rate-limited';
import type { SqlPanelResultWire } from '@hushbox/shared';

/** One executed query snapshot — the text as run, never the live editor. */
interface HistoryEntry {
  readonly text: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}

const HISTORY_LIMIT = 25;

/** Column order: union of row keys, first-seen (SELECT pages share a shape,
 * but SHOW/EXPLAIN-style reads may not). */
function columnsOf(rows: readonly Record<string, unknown>[]): readonly string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/** The panel is SELECT-only server-side; anything else is a guaranteed
 * rejection, so the panel explains itself instead of echoing a bare code. */
function isSelectStatement(queryText: string): boolean {
  return /^select\b/i.test(queryText.trim());
}

/** The server's error body, verbatim — codes only by design, so showing the
 * raw body is safe and tells the operator exactly what the API said. */
function SqlErrorPanel({
  error,
  queryText,
}: Readonly<{ error: unknown; queryText: string }>): React.JSX.Element {
  const code = error instanceof ApiError ? error.message : 'INTERNAL';
  const body = error instanceof ApiError && error.body !== undefined ? error.body : { code };
  return (
    <div
      data-testid={TEST_IDS.adminSqlError}
      role="alert"
      className="border-destructive/50 flex flex-col gap-1 rounded-md border p-3"
    >
      {isSelectStatement(queryText) ? (
        <>
          <p className="text-destructive text-sm">The query failed: {friendlyErrorMessage(code)}</p>
          <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(body, null, 2)}</pre>
        </>
      ) : (
        <p className="text-destructive text-sm">
          This panel runs SELECT statements only: the write-proof role rejects everything else.
        </p>
      )}
    </div>
  );
}

/** A 429 gets the countdown notice; any other failure the verbatim panel. */
function SqlRunFeedback({
  error,
  queryText,
  onRetry,
}: Readonly<{ error: unknown; queryText: string; onRetry: () => void }>): React.JSX.Element | null {
  if (error === null) {
    return null;
  }
  const retryAfter = retryAfterSecondsOf(error);
  if (retryAfter !== null) {
    return <RateLimitedNotice retryAfterSeconds={retryAfter} resetKey={error} onRetry={onRetry} />;
  }
  return <SqlErrorPanel error={error} queryText={queryText} />;
}

function ResultsGrid({ result }: Readonly<{ result: SqlPanelResultWire }>): React.JSX.Element {
  const columns = columnsOf(result.rows);
  return (
    <div className="flex flex-col gap-2">
      <p
        data-testid={TEST_IDS.adminSqlStatus}
        className="text-muted-foreground flex items-center gap-2 text-xs"
      >
        <span className="font-mono tabular-nums">{result.rowCount} rows</span>
        {result.truncated ? (
          <Badge
            data-testid={TEST_IDS.adminSqlTruncated}
            variant="outline"
            className="text-destructive"
          >
            Truncated to the first {result.rowCount} rows
          </Badge>
        ) : null}
      </p>
      {result.rows.length === 0 ? null : (
        <div className="border-border max-h-96 overflow-auto rounded-md border">
          <table data-testid={TEST_IDS.adminSqlResults} className="w-full text-left text-sm">
            <thead className="bg-card sticky top-0">
              <tr className="text-muted-foreground border-border border-b text-xs uppercase">
                {columns.map((column) => (
                  <th key={column} className="px-2 py-1 font-medium whitespace-nowrap">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index} className="border-border border-b">
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="max-w-96 truncate px-2 py-1 font-mono text-xs tabular-nums"
                    >
                      {formatCell(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QueryHistory({
  entries,
  onRestore,
}: Readonly<{
  entries: readonly HistoryEntry[];
  onRestore: (text: string) => void;
}>): React.JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }
  return (
    <div data-testid={TEST_IDS.adminSqlHistory}>
      <h2 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">History</h2>
      <ol className="flex flex-col gap-1">
        {entries.map((entry, index) => (
          <li key={`${entry.text}-${String(index)}`}>
            <button
              type="button"
              data-testid={TEST_IDS.adminSqlHistoryItem}
              className="hover:bg-accent flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left"
              onClick={() => {
                onRestore(entry.text);
              }}
            >
              <span className="truncate font-mono text-xs">{entry.text}</span>
              <span className="text-muted-foreground ml-auto font-mono text-xs whitespace-nowrap tabular-nums">
                {entry.rowCount} rows{entry.truncated ? ' (truncated)' : ''}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Most-recent-first, deduped by exact text, capped. */
function pushHistory(
  current: readonly HistoryEntry[],
  entry: HistoryEntry
): readonly HistoryEntry[] {
  const rest = current.filter((item) => item.text !== entry.text);
  return [entry, ...rest].slice(0, HISTORY_LIMIT);
}

const RUN_SHORTCUT = 'Cmd+Enter or Ctrl+Enter';

/**
 * The SELECT-only SQL panel: psql-grade reads over a structurally write-proof
 * role. Results are server-capped; errors are codes-only bodies rendered in
 * place (never a toast, so a failed query stays diagnosable).
 */
export function SqlPanelScreen(): React.JSX.Element {
  const [text, setText] = React.useState('');
  const [result, setResult] = React.useState<SqlPanelResultWire | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  /* The text as run — error copy keys off the submitted query, never the
     live editor (which may have changed since). */
  const [submitted, setSubmitted] = React.useState('');
  const [history, setHistory] = React.useState<readonly HistoryEntry[]>([]);
  const panel = useSqlPanel();
  const { mutate } = panel;

  const run = React.useCallback(
    (queryText: string) => {
      const trimmed = queryText.trim();
      if (trimmed === '') {
        return;
      }
      setSubmitted(trimmed);
      mutate(trimmed, {
        onSuccess: (page) => {
          setResult(page);
          setError(null);
          const entry = { text: trimmed, rowCount: page.rowCount, truncated: page.truncated };
          setHistory((current) => pushHistory(current, entry));
        },
        onError: (cause) => {
          // Drop the previous grid too: stale rows rendered beneath a fresh
          // error read as the failing query's result.
          setResult(null);
          setError(cause);
        },
      });
    },
    [mutate]
  );

  return (
    <section className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[1.2rem] font-bold">SQL panel</h1>
        <Badge data-testid={TEST_IDS.adminSqlBadge} variant="outline">
          Read-only
        </Badge>
      </div>
      <p className="text-muted-foreground text-sm">
        Runs as the SELECT-only role with a server-side row cap and a 5 second statement timeout.
        Every query is audited.
      </p>
      <Textarea
        data-testid={TEST_IDS.adminSqlEditor}
        value={text}
        rows={6}
        spellCheck={false}
        aria-label="SQL query"
        placeholder="SELECT type, status, failures FROM jobs ORDER BY created_at DESC"
        className="font-mono text-xs"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            run(text);
          }
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          data-testid={TEST_IDS.adminSqlRun}
          size="sm"
          title={`Runs the query (${RUN_SHORTCUT})`}
          disabled={panel.isPending}
          onClick={() => {
            run(text);
          }}
        >
          Run
        </Button>
        <span className="text-muted-foreground font-mono text-xs">{RUN_SHORTCUT}</span>
      </div>

      <SqlRunFeedback
        error={error}
        queryText={submitted}
        onRetry={() => {
          run(text);
        }}
      />

      {result === null && error === null ? (
        <p className="text-muted-foreground text-sm">
          No query run yet. Results appear here; pages are capped server-side, and the truncation
          chip tells you when a result was cut.
        </p>
      ) : null}
      {result === null ? null : <ResultsGrid result={result} />}

      <QueryHistory entries={history} onRestore={setText} />
    </section>
  );
}
