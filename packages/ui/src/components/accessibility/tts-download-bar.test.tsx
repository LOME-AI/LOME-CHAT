import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TtsDownloadBar } from './tts-download-bar';

const { reducedMotionRef } = vi.hoisted(() => ({ reducedMotionRef: { value: false } }));

vi.mock('../../hooks/use-reduced-motion', () => ({
  useReducedMotion: (): boolean => reducedMotionRef.value,
}));

function fillOf(status: HTMLElement): HTMLElement {
  const fill = status.querySelector<HTMLElement>('[style*="width"]');
  if (fill === null) throw new Error('fill element not found');
  return fill;
}

describe('TtsDownloadBar', () => {
  beforeEach(() => {
    reducedMotionRef.value = false;
  });

  it('renders a role="status" region named by the label', () => {
    render(<TtsDownloadBar percent={40} label="Read-aloud model download" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-label')).toBe('Read-aloud model download');
  });

  it('drives the fill width from the (rounded) percent', () => {
    render(<TtsDownloadBar percent={37.6} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('status')).style.width).toBe('38%');
  });

  it('clamps a percent above 100 to a full fill', () => {
    render(<TtsDownloadBar percent={150} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('status')).style.width).toBe('100%');
  });

  it('clamps a negative percent to an empty fill', () => {
    render(<TtsDownloadBar percent={-20} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('status')).style.width).toBe('0%');
  });

  it('hides the label/percent header by default', () => {
    render(<TtsDownloadBar percent={38} label="Read-aloud model download" />);
    expect(screen.queryByText('Read-aloud model download')).toBeNull();
    expect(screen.queryByText('38%')).toBeNull();
  });

  it('shows the label and percent header when showLabel is set', () => {
    render(<TtsDownloadBar percent={38} label="Preparing the voice" showLabel />);
    expect(screen.getByText('Preparing the voice')).not.toBeNull();
    expect(screen.getByText('38%')).not.toBeNull();
  });

  it('animates the fill when motion is allowed', () => {
    reducedMotionRef.value = false;
    render(<TtsDownloadBar percent={50} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('status')).className).toContain('transition-all');
  });

  it('drops the fill animation under reduced motion', () => {
    reducedMotionRef.value = true;
    render(<TtsDownloadBar percent={50} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('status')).className).not.toContain('transition-all');
  });

  it('renders no border stroke and no background box on the container', () => {
    render(<TtsDownloadBar percent={50} label="Preparing the voice" showLabel />);
    const status = screen.getByRole('status');
    expect(status.className).not.toMatch(/\bborder\b/);
    expect(status.className).not.toMatch(/\bbg-/);
  });
});
