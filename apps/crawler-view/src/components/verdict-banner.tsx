import { cn } from '@hushbox/ui/lib/utils';
import { AUDIENCES, type Audience, type Finding } from '../engine';
import { AUDIENCE_LABEL, VERDICT_META, worstVerdict } from '../app/verdict-utilities';
import { VerdictPill } from './verdict-pill';
import type { JSX } from 'react';

interface VerdictBannerProps {
  verdict: Record<Audience, Finding[]>;
}

function BotList({ bots }: Readonly<{ bots: string[] }>): JSX.Element | null {
  if (bots.length === 0) {
    return null;
  }
  return (
    <ul className="mt-1 flex flex-wrap gap-1">
      {bots.map((bot) => (
        <li
          key={bot}
          className="bg-background-subtle text-muted-foreground rounded border px-1.5 py-0.5 font-mono text-[11px]"
        >
          {bot}
        </li>
      ))}
    </ul>
  );
}

function AudienceColumn({
  audience,
  findings,
}: Readonly<{ audience: Audience; findings: Finding[] }>): JSX.Element {
  const level = worstVerdict(findings);
  const meta = VERDICT_META[level];
  return (
    <section
      aria-label={`${AUDIENCE_LABEL[audience]}: ${meta.label}`}
      className={cn('rounded-lg border p-3', meta.surface)}
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-foreground text-sm font-semibold">{AUDIENCE_LABEL[audience]}</h3>
        <VerdictPill level={level} />
      </header>
      <ol className="mt-2 flex flex-col gap-2">
        {findings.map((finding, index) => (
          <li
            key={`${finding.level}-${String(index)}`}
            className="border-t pt-2 first:border-t-0 first:pt-0"
          >
            <p className="flex items-start gap-1.5 text-sm">
              <span
                aria-hidden
                className={cn('mt-0.5 font-semibold', VERDICT_META[finding.level].text)}
              >
                {VERDICT_META[finding.level].symbol}
              </span>
              <span className="text-foreground">{finding.message}</span>
            </p>
            <BotList bots={finding.bots} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The signature verdict: three audiences side by side, each showing its worst
 * level and the exact findings (message + affected bots). This is the clearest
 * thing on the page.
 */
export function VerdictBanner({ verdict }: Readonly<VerdictBannerProps>): JSX.Element {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {AUDIENCES.map((audience) => (
        <AudienceColumn key={audience} audience={audience} findings={verdict[audience]} />
      ))}
    </div>
  );
}
