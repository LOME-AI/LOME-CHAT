import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScrollReveal } from './scroll-reveal';

describe('ScrollReveal', () => {
  it('renders children', () => {
    render(<ScrollReveal>Reveal me</ScrollReveal>);
    expect(screen.getByText('Reveal me')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-slot', 'scroll-reveal');
  });

  it('applies custom className', () => {
    render(
      <ScrollReveal className="custom-class" data-testid="reveal">
        Content
      </ScrollReveal>
    );
    expect(screen.getByTestId('reveal')).toHaveClass('custom-class');
  });

  it('applies animation class based on animation prop', () => {
    render(
      <ScrollReveal animation="fade-up" data-testid="reveal">
        Content
      </ScrollReveal>
    );
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-animation', 'fade-up');
  });

  it('defaults to fade-up animation', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    expect(screen.getByTestId('reveal')).toHaveAttribute('data-animation', 'fade-up');
  });

  it('applies delay as CSS variable', () => {
    render(
      <ScrollReveal delay={200} data-testid="reveal">
        Content
      </ScrollReveal>
    );
    const el = screen.getByTestId('reveal');
    expect(el.style.getPropertyValue('--reveal-delay')).toBe('200ms');
  });

  it('omits the delay CSS variable when no delay is given', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    expect(screen.getByTestId('reveal').style.getPropertyValue('--reveal-delay')).toBe('');
  });
});

describe('ScrollReveal intersection behaviour', () => {
  let observeMock: ReturnType<typeof vi.fn>;
  let unobserveMock: ReturnType<typeof vi.fn>;
  let disconnectMock: ReturnType<typeof vi.fn>;
  let observerCallback: IntersectionObserverCallback;

  beforeEach(() => {
    observeMock = vi.fn();
    unobserveMock = vi.fn();
    disconnectMock = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(function MockIntersectionObserver(callback: IntersectionObserverCallback) {
        observerCallback = callback;
        return { observe: observeMock, unobserve: unobserveMock, disconnect: disconnectMock };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('flips data-visible to true and stops observing once the element intersects', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    const el = screen.getByTestId('reveal');
    expect(el).toHaveAttribute('data-visible', 'false');

    act(() => {
      observerCallback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(el.dataset.visible).toBe('true');
    expect(unobserveMock).toHaveBeenCalledWith(el);
  });

  it('leaves data-visible false while the element is not intersecting', () => {
    render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);

    act(() => {
      observerCallback(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByTestId('reveal')).toHaveAttribute('data-visible', 'false');
    expect(unobserveMock).not.toHaveBeenCalled();
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<ScrollReveal data-testid="reveal">Content</ScrollReveal>);
    unmount();
    expect(disconnectMock).toHaveBeenCalled();
  });
});
