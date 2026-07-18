import { Tabs, TabsList, TabsTrigger, TabsContent } from '@hushbox/ui';
import { cn } from '@hushbox/ui/lib/utils';
import { getPersona, type CrawlView, type JsonLdBlock, type PersonaRobotsResult } from '../engine';
import { AUDIENCE_LABEL } from '../app/verdict-utilities';
import { CrawlerFrame } from './crawler-frame';
import type { JSX, ReactNode } from 'react';

interface SignalTabsProps {
  view: CrawlView;
}

function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>): JSX.Element {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-2 border-t py-1.5 text-sm first:border-t-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Value({ value }: Readonly<{ value: string | null }>): JSX.Element {
  return value === null || value.length === 0 ? (
    <span className="text-muted-foreground italic">not set</span>
  ) : (
    <span>{value}</span>
  );
}

function AllowChip({ allowed }: Readonly<{ allowed: boolean }>): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold',
        allowed
          ? 'bg-success/10 border-success/40 text-success'
          : 'bg-error/10 border-error/40 text-error'
      )}
    >
      <span aria-hidden>{allowed ? '✓' : '✗'}</span>
      {allowed ? 'ALLOWED' : 'BLOCKED'}
    </span>
  );
}

function MetaTab({ view }: Readonly<SignalTabsProps>): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <dl>
        <Row label="Title">
          <Value value={view.head.title} />
        </Row>
        <Row label="Meta description">
          <Value value={view.head.metaDescription} />
        </Row>
        <Row label="Canonical">
          <span className="flex flex-wrap items-center gap-2">
            <Value value={view.head.canonical} />
            {view.head.canonicalIsCrossOrigin ? (
              <span className="bg-warning/10 border-warning/40 text-warning rounded border px-1.5 py-0.5 text-xs font-semibold">
                cross-origin
              </span>
            ) : null}
          </span>
        </Row>
        <Row label="Robots meta">
          <span className="font-mono text-xs">
            index={String(view.head.robotsMeta.index)}, follow={String(view.head.robotsMeta.follow)}
            {view.head.robotsMeta.raw === null ? '' : ` (${view.head.robotsMeta.raw})`}
          </span>
        </Row>
        <Row label="Viewport">
          <Value value={view.head.viewport} />
        </Row>
        <Row label="hreflang">
          {view.head.hreflang.length === 0 ? (
            <span className="text-muted-foreground italic">none</span>
          ) : (
            <ul className="flex flex-col gap-0.5 font-mono text-xs">
              {view.head.hreflang.map((entry) => (
                <li key={`${entry.lang}-${entry.href}`}>
                  {entry.lang}: {entry.href}
                </li>
              ))}
            </ul>
          )}
        </Row>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="text-muted-foreground text-xs font-medium uppercase">
          Structured data (JSON-LD)
        </h3>
        {view.jsonLd.length === 0 ? (
          <p className="text-muted-foreground text-sm">No JSON-LD blocks found.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.jsonLd.map((block, index) => (
              <JsonLdItem key={index} block={block} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function JsonLdItem({ block }: Readonly<{ block: JsonLdBlock }>): JSX.Element {
  return (
    <li className="rounded-lg border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 text-xs font-semibold',
            block.parsed
              ? 'bg-success/10 border-success/40 text-success'
              : 'bg-error/10 border-error/40 text-error'
          )}
        >
          <span aria-hidden>{block.parsed ? '✓' : '✗'}</span> {block.parsed ? 'parsed' : 'invalid'}
        </span>
        {block.types.map((type) => (
          <span
            key={type}
            className="bg-background-subtle rounded border px-1.5 py-0.5 font-mono text-xs"
          >
            {type}
          </span>
        ))}
      </div>
      {block.errors.length > 0 ? (
        <ul className="text-error mt-1 list-inside list-disc text-xs">
          {block.errors.map((error, index) => (
            <li key={index}>{error}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function personaLabel(result: PersonaRobotsResult): { label: string; category: string } {
  try {
    const persona = getPersona(result.personaId);
    return { label: persona.label, category: AUDIENCE_LABEL[persona.category] };
  } catch {
    return { label: result.personaId, category: '' };
  }
}

function RobotsTab({ view }: Readonly<SignalTabsProps>): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <dl>
        <Row label="robots.txt fetched">
          <span>{view.robots.fetched ? 'yes' : 'no'}</span>
        </Row>
        <Row label="Sitemap checked">
          <span>{view.sitemap.checked ? 'yes' : 'no'}</span>
        </Row>
        <Row label="Sitemap found">
          <span>{view.sitemap.found ? 'yes' : 'no'}</span>
        </Row>
        <Row label="URL listed in sitemap">
          <span>{view.sitemap.urlListed ? 'yes' : 'no'}</span>
        </Row>
        <Row label="X-Robots-Tag">
          <Value value={view.http.xRobotsTag} />
        </Row>
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="text-muted-foreground py-1.5 pr-4 font-medium">Persona</th>
              <th className="text-muted-foreground py-1.5 pr-4 font-medium">Audience</th>
              <th className="text-muted-foreground py-1.5 pr-4 font-medium">Status</th>
              <th className="text-muted-foreground py-1.5 font-medium">Matched rule</th>
            </tr>
          </thead>
          <tbody>
            {view.robots.perPersona.map((result) => {
              const meta = personaLabel(result);
              return (
                <tr key={result.personaId} className="border-b">
                  <td className="py-1.5 pr-4 font-mono text-xs">{meta.label}</td>
                  <td className="text-muted-foreground py-1.5 pr-4">{meta.category}</td>
                  <td className="py-1.5 pr-4">
                    <AllowChip allowed={result.allowed} />
                  </td>
                  <td className="text-muted-foreground py-1.5 font-mono text-xs">
                    {result.matchedRule ?? 'none'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HttpTab({ view }: Readonly<SignalTabsProps>): JSX.Element {
  return (
    <dl>
      <Row label="Status">
        <span className={cn('font-semibold', view.http.ok ? 'text-success' : 'text-error')}>
          {view.http.status} {view.http.ok ? '(ok)' : '(not ok)'}
        </span>
      </Row>
      <Row label="Final URL">
        <span className="font-mono text-xs">{view.http.finalUrl}</span>
      </Row>
      <Row label="Content-Type">
        <Value value={view.http.contentType} />
      </Row>
      <Row label="X-Robots-Tag">
        <Value value={view.http.xRobotsTag} />
      </Row>
      <Row label="Redirect chain">
        {view.http.redirectChain.length === 0 ? (
          <span className="text-muted-foreground italic">none</span>
        ) : (
          <ol className="flex flex-col gap-0.5 font-mono text-xs">
            {view.http.redirectChain.map((hop, index) => (
              <li key={index}>
                {hop.status}: {hop.from} {'->'} {hop.to}
              </li>
            ))}
          </ol>
        )}
      </Row>
    </dl>
  );
}

/** The raw signals, grouped into tabs behind the verdict and consumption panels. */
export function SignalTabs({ view }: Readonly<SignalTabsProps>): JSX.Element {
  return (
    <Tabs defaultValue="meta" className="w-full">
      <TabsList>
        <TabsTrigger value="meta">Meta &amp; structured data</TabsTrigger>
        <TabsTrigger value="robots">Robots &amp; sitemap</TabsTrigger>
        <TabsTrigger value="crawler">Crawler view</TabsTrigger>
        <TabsTrigger value="http">HTTP</TabsTrigger>
      </TabsList>
      <TabsContent value="meta" className="pt-2">
        <MetaTab view={view} />
      </TabsContent>
      <TabsContent value="robots" className="pt-2">
        <RobotsTab view={view} />
      </TabsContent>
      <TabsContent value="crawler" className="pt-2">
        <CrawlerFrame content={view.content} />
      </TabsContent>
      <TabsContent value="http" className="pt-2">
        <HttpTab view={view} />
      </TabsContent>
    </Tabs>
  );
}
