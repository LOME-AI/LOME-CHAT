import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LinkPreviewPanel } from './link-preview-panel';
import type { OpenGraphInfo } from '../engine';

function openGraph(overrides: Partial<OpenGraphInfo>): OpenGraphInfo {
  return {
    title: 'A Title',
    description: 'A description.',
    type: 'article',
    url: 'https://example.com/',
    siteName: 'Example',
    image: 'https://example.com/og.png',
    imageStatus: { checked: true, reachable: true, status: 200 },
    ...overrides,
  };
}

describe('LinkPreviewPanel', () => {
  it('shows an explicit broken-image state when the og:image is unreachable', () => {
    render(
      <LinkPreviewPanel
        openGraph={openGraph({ imageStatus: { checked: true, reachable: false, status: 404 } })}
      />
    );

    expect(screen.getByText(/Image unreachable/i)).toBeInTheDocument();
    expect(screen.getByText(/status 404/i)).toBeInTheDocument();
  });

  it('falls back to explicit placeholders when og fields are missing', () => {
    render(
      <LinkPreviewPanel openGraph={openGraph({ title: null, description: null, image: null })} />
    );

    expect(screen.getByText('(no og:title)')).toBeInTheDocument();
    expect(screen.getByText('No og:image')).toBeInTheDocument();
  });
});
