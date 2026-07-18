import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'banner.css');
const css = readFileSync(cssPath, 'utf8');

describe('banner.css structural guarantees', () => {
  it('keeps the reduced-motion marquee exemption inside the accessibility cascade layer', () => {
    // The global animation kill (accessibility/styles/motion.css) is imported
    // with layer(accessibility). `!important` inverts cascade-layer priority, so
    // an UNLAYERED !important exemption loses to the layered kill no matter its
    // specificity. The exemption only wins from inside the same layer, where
    // specificity decides.
    const layerBlock = /@layer accessibility\s*{[^]*?html\.reduced-motion[^]*?\.hb-track[^]*?}/;
    expect(css).toMatch(layerBlock);
  });

  it('scopes the focus-pause to the sr-link list, never the whole banner', () => {
    // A banner-wide :focus-within freezes the track while the Play button holds
    // focus after a click, so pressing Play could not resume until focus left
    // the banner. Only a focused `.hb-sr-link` chip (stationary text read
    // against motion) may pause; button focus must never freeze the marquee.
    // Comments are stripped so prose mentioning the banned selector can't trip
    // the negative assertions.
    const rules = css.replaceAll(/\/\*[^]*?\*\//g, '');
    expect(rules).toMatch(/\.hb-banner:has\(\.hb-sr-list :focus-within\)[^{]*\.hb-track/);
    expect(rules).not.toMatch(/\.hb-banner:focus-within/);
    expect(rules).not.toMatch(/\.hb-vp\[data-mode='scroll'\]:focus-within/);
  });

  it('keeps the explicit paused state as an independent pause condition', () => {
    // `data-paused` mirrors the control's aria-pressed (the source of truth for
    // the explicit toggle); it must pause on its own selector so focus changes
    // can never un-pause an explicitly paused banner.
    expect(css).toMatch(/\.hb-banner\[data-paused='true'\][^{]*\.hb-track/);
  });

  it('loops by a computed px content period, never a track percentage', () => {
    // A -50% keyframe only seams correctly for exactly two copies; the px var
    // makes the wrap land on an identical frame for any copy count.
    const marqueeKeyframes = /@keyframes hb-marquee\s*{[^]*?}\s*}/.exec(css)?.[0] ?? '';
    expect(marqueeKeyframes).toMatch(/calc\(-1 \* var\(--hb-loop-distance/);
    expect(marqueeKeyframes).not.toMatch(/-50%/);
  });

  it('separates messages with the widened 7.5rem side margins', () => {
    const separatorRule = /\.hb-sep\s*{[^}]*}/.exec(css)?.[0] ?? '';
    expect(separatorRule).toMatch(/margin:\s*0 7\.5rem/);
  });

  it('colors the warning icon with the plain warning token (founder-accepted contrast exception)', () => {
    const warningRule =
      /\.hb-msg\[data-variant='warning'\] \.hb-ico\s*{[^}]*}/.exec(css)?.[0] ?? '';
    expect(warningRule).toMatch(/color:\s*var\(--color-warning\)/);
    expect(warningRule).not.toMatch(/color-mix/);
  });

  it('does not color the marquee link with raw brand red (fails AA on the banner background)', () => {
    const linkRule = /\.hb-link\s*{[^}]*}/.exec(css)?.[0] ?? '';
    expect(linkRule).not.toMatch(/(?<![\w-])color:\s*var\(--color-brand-red\)/);
    expect(linkRule).toMatch(/(?<![\w-])color:\s*var\(--color-foreground\)/);
  });
});
