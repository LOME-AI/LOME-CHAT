import { useState } from 'react';
import { Button, Input } from '@hushbox/ui';
import type { SitemapResponse, SitemapTarget } from '../app/api';
import type { JSX } from 'react';

interface UrlBarProps {
  value: string;
  onChange: (value: string) => void;
  onAnalyze: (url: string) => void;
  sitemap: SitemapResponse | null;
  sitemapError: string | null;
}

/** A reachable `web` target with an empty sitemap (SPA): user types a path. */
function findWebSpaTarget(sitemap: SitemapResponse | null): SitemapTarget | null {
  const web = sitemap?.targets.find((target) => target.label === 'web');
  if (web && web.unreachable === undefined && web.urls.length === 0) {
    return web;
  }
  return null;
}

function WebPathField({
  origin,
  onAnalyze,
}: Readonly<{ origin: string; onAnalyze: (url: string) => void }>): JSX.Element {
  const [path, setPath] = useState('/');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAnalyze(new URL(path, origin).toString());
      }}
      className="flex items-center gap-2"
    >
      <span className="text-muted-foreground text-xs">web (SPA, no sitemap):</span>
      <span className="text-foreground font-mono text-xs">{origin}</span>
      <Input
        aria-label="Path on the web origin"
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
        }}
        className="h-8 w-40 font-mono text-xs"
      />
      <Button type="submit" size="sm" variant="secondary">
        Go
      </Button>
    </form>
  );
}

/** URL input + sitemap-driven page picker. The primary way pages enter the view. */
export function UrlBar({
  value,
  onChange,
  onAnalyze,
  sitemap,
  sitemapError,
}: Readonly<UrlBarProps>): JSX.Element {
  const webSpa = findWebSpaTarget(sitemap);

  return (
    <div className="flex flex-wrap items-end gap-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          if (trimmed.length > 0) {
            onAnalyze(trimmed);
          }
        }}
        className="flex flex-1 items-center gap-2"
      >
        <Input
          aria-label="Page URL"
          placeholder="https://example.com/page"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="min-w-64 flex-1 font-mono text-sm"
        />
        <Button type="submit">Analyze</Button>
      </form>

      <div className="flex flex-col gap-1">
        <label htmlFor="page-picker" className="text-muted-foreground text-xs">
          Pick a local page
        </label>
        <select
          id="page-picker"
          className="border-input bg-background text-foreground h-9 rounded-md border px-2 text-sm"
          value=""
          onChange={(event) => {
            const url = event.target.value;
            if (url.length > 0) {
              onChange(url);
              onAnalyze(url);
            }
          }}
        >
          <option value="">Select a page…</option>
          {sitemap?.targets.map((target) => (
            <optgroup
              key={target.label}
              label={
                target.unreachable === true
                  ? `${target.label} (unreachable: ${target.origin})`
                  : `${target.label} (${target.origin})`
              }
            >
              {target.urls.map((url) => (
                <option key={url} value={url}>
                  {url}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {sitemapError === null ? null : (
          <p className="text-error text-xs">Sitemap unavailable: {sitemapError}</p>
        )}
      </div>

      {webSpa === null ? null : <WebPathField origin={webSpa.origin} onAnalyze={onAnalyze} />}
    </div>
  );
}
