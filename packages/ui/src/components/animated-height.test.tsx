import type * as React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from './accessibility/store';
import { AnimatedHeight } from './animated-height';

interface MockMotionDivProps extends React.HTMLAttributes<HTMLDivElement> {
  initial?: unknown;
  animate?: unknown;
  exit?: unknown;
  transition?: unknown;
}

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MotionDiv = React.forwardRef<HTMLDivElement, MockMotionDivProps>(
    ({ children, initial, animate, exit, transition, ...rest }, ref) => (
      <div
        ref={ref}
        data-motion="true"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-exit={JSON.stringify(exit)}
        data-transition={JSON.stringify(transition)}
        {...rest}
      >
        {children}
      </div>
    )
  );
  MotionDiv.displayName = 'MotionDivMock';
  const AnimatePresence = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <>{children}</>
  );
  AnimatePresence.displayName = 'AnimatePresenceMock';
  return {
    AnimatePresence,
    motion: { div: MotionDiv },
  };
});

describe('AnimatedHeight', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    // A contaminated VITE_E2E from a prior e2e run would otherwise force reduced
    // motion and mask the animated-path assertions.
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    useA11yStore.getState().reset();
    vi.unstubAllEnvs();
  });

  it('animates children through a motion.div when motion is not reduced', () => {
    render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );

    const wrapper = screen.getByTestId('child').closest<HTMLElement>('[data-motion="true"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute('data-animated', 'true');
    expect(wrapper).toHaveClass('overflow-hidden');
    expect(wrapper?.dataset['initial']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
    expect(wrapper?.dataset['animate']).toBe(JSON.stringify({ height: 'auto', opacity: 1 }));
    expect(wrapper?.dataset['exit']).toBe(JSON.stringify({ height: 0, opacity: 0 }));
    expect(wrapper?.dataset['transition']).toBe(
      JSON.stringify({ duration: 0.2, ease: 'easeInOut' })
    );
  });

  it('renders children instantly with no tween when motion is reduced', () => {
    useA11yStore.getState().update({ stopAnimations: true });
    render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByTestId('child').closest('[data-motion="true"]')).toBeNull();
    const wrapper = screen.getByTestId('child').parentElement;
    expect(wrapper).toHaveAttribute('data-animated', 'false');
  });

  it('renders nothing when children is null and motion is not reduced', () => {
    const { container } = render(<AnimatedHeight>{null}</AnimatedHeight>);

    expect(container.querySelector('[data-testid="child"]')).toBeNull();
    expect(container.querySelector('[data-motion="true"]')).toBeNull();
  });

  it('removes children when toggled from present to absent', () => {
    const { rerender, container } = render(
      <AnimatedHeight>
        <span data-testid="child">visible</span>
      </AnimatedHeight>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();

    rerender(<AnimatedHeight>{null}</AnimatedHeight>);
    expect(container.querySelector('[data-testid="child"]')).toBeNull();
  });
});
