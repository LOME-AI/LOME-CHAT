import { describe, it, expect, afterEach } from 'vitest';
import {
  installComposerCues,
  DEMO_COMPOSER_PLACEHOLDER,
  MODALITY_SWITCH_SELECTOR,
  MODALITY_SWITCH_LABELS,
} from './composer-cues';

afterEach(() => {
  document.head.innerHTML = '';
});

describe('installComposerCues', () => {
  it('injects a stylesheet that overrides the placeholder and dims modality icons', () => {
    const uninstall = installComposerCues();

    const style = document.head.querySelector<HTMLStyleElement>(
      'style[data-testid="demo-composer-cues"]'
    );
    expect(style).not.toBeNull();
    const css = style?.textContent ?? '';
    // Placeholder copy is rendered via a ::after on the animated-placeholder overlay.
    expect(css).toContain(DEMO_COMPOSER_PLACEHOLDER);
    expect(css).toContain('[data-testid="animated-placeholder"]::after');
    // The real animated text is hidden so only the demo copy shows.
    expect(css).toContain('[data-testid="animated-placeholder"] [data-testid="typing-animation"]');
    // LegacyModality-switch icons are dimmed to read as locked (exact labels, not a
    // prefix that would also catch the header's "Switch to dark mode" toggle).
    expect(css).toContain(MODALITY_SWITCH_SELECTOR);
    expect(MODALITY_SWITCH_SELECTOR).toContain('[aria-label="Switch to image generation"]');
    expect(MODALITY_SWITCH_LABELS).not.toContain('Switch to dark mode');

    uninstall();
  });

  it('removes the stylesheet when disposed', () => {
    const uninstall = installComposerCues();
    uninstall();
    expect(document.head.querySelector('style[data-testid="demo-composer-cues"]')).toBeNull();
  });
});
