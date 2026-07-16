import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { ScrollArea, ScrollBar } from './scroll-area';

describe('ScrollArea', () => {
  it('renders children', () => {
    render(
      <ScrollArea>
        <div>Scrollable content</div>
      </ScrollArea>
    );
    expect(screen.getByText('Scrollable content')).toBeInTheDocument();
  });

  it('has data-slot attribute', () => {
    render(
      <ScrollArea data-testid="scroll-area">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('scroll-area')).toHaveAttribute('data-slot', 'scroll-area');
  });

  it('applies custom className', () => {
    render(
      <ScrollArea className="custom-class" data-testid="scroll-area">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('scroll-area')).toHaveClass('custom-class');
  });

  it('renders with fixed height for scrolling', () => {
    render(
      <ScrollArea className="h-48" data-testid="scroll-area">
        <div style={{ height: '500px' }}>Tall content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('scroll-area')).toHaveClass('h-48');
  });

  it('renders viewport with data-slot', () => {
    render(
      <ScrollArea>
        <div>Content</div>
      </ScrollArea>
    );
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).toBeInTheDocument();
  });

  it('has relative positioning', () => {
    render(
      <ScrollArea data-testid="scroll-area">
        <div>Content</div>
      </ScrollArea>
    );
    expect(screen.getByTestId('scroll-area')).toHaveClass('relative');
  });

  it('viewport contains children', () => {
    render(
      <ScrollArea>
        <div data-testid="child">Child content</div>
      </ScrollArea>
    );
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport).toContainElement(screen.getByTestId('child'));
  });

  it('exposes viewport element via viewportRef', () => {
    const viewportRef = React.createRef<HTMLDivElement>();
    render(
      <ScrollArea viewportRef={viewportRef}>
        <div>Content</div>
      </ScrollArea>
    );
    expect(viewportRef.current).toBeInstanceOf(HTMLDivElement);
    expect(viewportRef.current).toHaveAttribute('data-slot', 'scroll-area-viewport');
  });

  it('calls onScroll when viewport is scrolled', () => {
    const handleScroll = vi.fn();
    render(
      <ScrollArea onScroll={handleScroll}>
        <div style={{ height: '500px' }}>Tall content</div>
      </ScrollArea>
    );
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    if (!viewport) throw new Error('Viewport not found');
    fireEvent.scroll(viewport);
    expect(handleScroll).toHaveBeenCalledTimes(1);
  });

  it('passes scroll event to onScroll callback', () => {
    const handleScroll = vi.fn();
    render(
      <ScrollArea onScroll={handleScroll}>
        <div style={{ height: '500px' }}>Tall content</div>
      </ScrollArea>
    );
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    if (!viewport) throw new Error('Viewport not found');
    fireEvent.scroll(viewport);
    expect(handleScroll).toHaveBeenCalledWith(expect.objectContaining({ type: 'scroll' }));
  });

  it('renders a horizontal scrollbar when orientation is horizontal', () => {
    render(
      <ScrollArea type="always">
        <div>Content</div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    );
    const scrollbar = document.querySelector(
      '[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]'
    );
    expect(scrollbar).not.toBeNull();
    expect(scrollbar).toHaveClass('flex-col');
  });
});
