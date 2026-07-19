import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OverlayContent } from './overlay-content';

describe('OverlayContent', () => {
  it('renders children', () => {
    render(
      <OverlayContent>
        <p>Child content</p>
      </OverlayContent>
    );

    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('has flex column layout with gap-4', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/flex/);
    expect(el.className).toMatch(/flex-col/);
    expect(el.className).toMatch(/gap-4/);
  });

  it('has standard wrapper classes', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/bg-background/);
    expect(el.className).toMatch(/rounded-lg/);
    expect(el.className).toMatch(/border/);
    expect(el.className).toMatch(/p-6/);
    expect(el.className).toMatch(/shadow-lg/);
    expect(el.className).toMatch(/w-\[90vw\]/);
  });

  it('defaults to max-w-md size', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-md/);
  });

  it('applies sm size variant', () => {
    render(
      <OverlayContent size="sm" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-sm/);
  });

  it('applies lg size variant', () => {
    render(
      <OverlayContent size="lg" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-lg/);
  });

  it('applies xl size variant', () => {
    render(
      <OverlayContent size="xl" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-xl/);
  });

  it('applies full size variant', () => {
    render(
      <OverlayContent size="full" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('content').className).toMatch(/max-w-4xl/);
  });

  it('caps its own height and scrolls internally so actions stay reachable', () => {
    render(
      <OverlayContent data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(el).toHaveClass('overflow-y-auto');
  });

  it('merges className override', () => {
    render(
      <OverlayContent className="w-[75vw]" data-testid="content">
        <p>Child</p>
      </OverlayContent>
    );

    const el = screen.getByTestId('content');
    expect(el.className).toMatch(/w-\[75vw\]/);
  });

  it('passes data-testid through', () => {
    render(
      <OverlayContent data-testid="my-overlay">
        <p>Child</p>
      </OverlayContent>
    );

    expect(screen.getByTestId('my-overlay')).toBeInTheDocument();
  });
});
