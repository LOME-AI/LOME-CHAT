import * as React from 'react';
import { CipherWall } from '@hushbox/ui';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import type { ThemeColors } from '@hushbox/ui';

/**
 * Social profile banner for X and Bluesky (1500x500, 3:1). Captured to PNG by
 * `scripts/generate-assets.ts`. The left thesis (warm-paper field + signature
 * cipher backdrop, the privacy headliner, the newcomer subline) sits beside the
 * real `/welcome` demo, embedded frozen at mobile ratio so a newcomer sees an
 * actual HushBox chat. All copy stays inside the centered safe zone and clear
 * of the avatar corner (lower-left) and the X follow button (lower-right).
 */

const HEADLINE = 'Privacy is a human right.';
const SUBLINE = 'One interface. Every feature. Private.';
const SITE_URL = 'hushbox.ai';

/** The starter conversation the demo freezes on: it answers "What is HushBox?". */
const DEMO_CONVERSATION = 'demo-welcome';

/** Faint phrases baked into the frozen CipherWall backdrop. */
const BANNER_MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Every Model One Place',
  'Private By Construction',
  'Your Words Stay Yours',
];

/**
 * CipherWall renders to a canvas and needs literal colors (it cannot read CSS
 * variables). These mirror the light/dark brand tokens in
 * packages/config/tailwind/index.css and must stay in sync with them.
 */
const CIPHER_THEME: Record<'light' | 'dark', ThemeColors> = {
  light: {
    background: '#faf9f6',
    foreground: '#1a1a1a',
    foregroundMuted: '#525252',
    brandRed: '#ec4755',
  },
  dark: {
    background: '#1a1816',
    foreground: '#f2f1ef',
    foregroundMuted: '#9a9894',
    brandRed: '#ec4755',
  },
};

interface SocialBannerProps {
  variant: 'light' | 'dark';
}

export function SocialBanner({ variant }: Readonly<SocialBannerProps>): React.JSX.Element {
  const [ready, setReady] = React.useState(false);

  // The embedded demo posts `hb-demo-ready` once it has painted its first frame
  // (see demo/bootstrap.tsx). The generator waits on the ready marker below so
  // it never screenshots a half-painted iframe.
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string } | null;
      if (data?.type === 'hb-demo-ready') setReady(true);
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  const demoSource = `/demo?frozen=1&convo=${DEMO_CONVERSATION}&scroll=top&theme=${variant}`;

  return (
    <div
      data-testid={TEST_ID_BUILDERS.socialBanner(variant)}
      className={`bg-background relative overflow-hidden ${variant === 'dark' ? 'dark' : ''}`}
      style={{ width: '100vw', height: '100vh' }}
    >
      <div className="absolute inset-0">
        <CipherWall
          frozen
          messages={[...BANNER_MESSAGES]}
          themeOverride={CIPHER_THEME[variant]}
          cipherOpacity={0.4}
          messageRowOffset={0}
          messageColOffset={5}
        />
      </div>

      <div className="relative flex h-full items-center gap-12 py-9 pr-28 pl-20">
        {/*
         * Each line sits on its own backing (the `aria-hidden` span behind it): an
         * opaque, blurred rounded box with uniform inset around the words, so the
         * cipher is held off at an even distance and the edge feathers softly.
         */}
        <div className="flex flex-1 translate-x-12 -translate-y-6 flex-col items-start gap-4">
          <div className="relative w-fit">
            <span aria-hidden className="bg-background absolute -inset-5 rounded-3xl blur-md" />
            <div
              data-testid={TEST_IDS.socialBannerWordmark}
              className="relative z-10 flex items-baseline gap-2.5 font-serif"
            >
              <span className="text-3xl font-bold tracking-tight">
                <span className="text-foreground">Hush</span>
                <span className="text-brand-red">Box</span>
              </span>
              <span className="text-muted-foreground text-xl">- An AI chat interface</span>
            </div>
          </div>
          <div className="relative w-fit">
            <span aria-hidden className="bg-background absolute -inset-5 rounded-3xl blur-md" />
            <h1
              data-testid={TEST_IDS.socialBannerHeadline}
              className="text-foreground relative z-10 font-serif text-6xl leading-[1.05] font-bold text-balance"
            >
              {HEADLINE}
            </h1>
          </div>
          <div className="relative w-fit">
            <span aria-hidden className="bg-background absolute -inset-5 rounded-3xl blur-md" />
            <p
              data-testid={TEST_IDS.socialBannerSubline}
              className="text-muted-foreground relative z-10 font-serif text-2xl"
            >
              {SUBLINE}
            </p>
          </div>
        </div>

        <div className="border-border bg-card flex h-[94%] w-[376px] shrink-0 -translate-x-6 flex-col overflow-hidden rounded-2xl border shadow-2xl">
          <div className="border-border bg-background-subtle flex items-center gap-1.5 border-b px-4 py-2.5">
            <span className="bg-foreground/20 h-2.5 w-2.5 rounded-full" />
            <span className="bg-foreground/20 h-2.5 w-2.5 rounded-full" />
            <span className="bg-foreground/20 h-2.5 w-2.5 rounded-full" />
            <span
              data-testid={TEST_IDS.socialBannerUrl}
              className="text-muted-foreground ml-2 font-mono text-sm"
            >
              {SITE_URL}
            </span>
          </div>
          <div
            data-testid={TEST_IDS.socialBannerPreview}
            className="bg-background relative min-h-0 flex-1"
          >
            <iframe
              src={demoSource}
              title="HushBox demo"
              className="absolute inset-0 h-full w-full border-0"
            />
          </div>
        </div>
      </div>

      {ready && <div data-testid={TEST_IDS.socialBannerReady} hidden />}
    </div>
  );
}
