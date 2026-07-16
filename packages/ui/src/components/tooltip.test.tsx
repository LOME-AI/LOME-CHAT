import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip';

describe('Tooltip', () => {
  it('renders trigger element', () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByText('Hover me')).toBeInTheDocument();
  });

  it('trigger has data-slot attribute', () => {
    render(
      <Tooltip>
        <TooltipTrigger data-testid="trigger">Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tooltip-trigger');
  });

  it('renders as button by default', () => {
    render(
      <Tooltip>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders open tooltip when defaultOpen is true', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('applies custom className to content', () => {
    render(
      <Tooltip defaultOpen>
        <TooltipTrigger>Hover me</TooltipTrigger>
        <TooltipContent className="custom-class" data-testid="content">
          Tooltip text
        </TooltipContent>
      </Tooltip>
    );
    expect(screen.getByTestId('content')).toHaveClass('custom-class');
  });
});

describe('TooltipProvider', () => {
  it('renders children', () => {
    render(
      <TooltipProvider>
        <div>Child content</div>
      </TooltipProvider>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('accepts custom delayDuration', () => {
    render(
      <TooltipProvider delayDuration={500}>
        <Tooltip>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipContent>Content</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
    expect(screen.getByText('Hover')).toBeInTheDocument();
  });
});

describe('Tooltip (touch mode)', () => {
  const originalMatchMedia = globalThis.matchMedia;

  const enableTouchMode = (): void => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('opens tooltip on trigger click', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    expect(screen.queryByTestId('content')).not.toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));

    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('closes tooltip on second trigger click (toggle)', async () => {
    enableTouchMode();
    const user = userEvent.setup();

    render(
      <Tooltip>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Tap me'));
    expect(screen.getByTestId('content')).toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));
    expect(screen.queryByTestId('content')).not.toBeInTheDocument();
  });

  it('preserves data-slot attribute on trigger in touch mode', () => {
    enableTouchMode();

    render(
      <Tooltip>
        <TooltipTrigger data-testid="trigger">Tap me</TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    expect(screen.getByTestId('trigger')).toHaveAttribute('data-slot', 'tooltip-trigger');
  });

  it('fires child onClick alongside tooltip toggle with asChild', async () => {
    enableTouchMode();
    const user = userEvent.setup();
    const childOnClick = vi.fn();

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={childOnClick}>Action</button>
        </TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    await user.click(screen.getByText('Action'));

    expect(childOnClick).toHaveBeenCalledOnce();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('renders trigger correctly with asChild span', () => {
    enableTouchMode();

    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-testid="badge">Icon</span>
        </TooltipTrigger>
        <TooltipContent>Badge info</TooltipContent>
      </Tooltip>
    );

    expect(screen.getByTestId('badge')).toBeInTheDocument();
    expect(screen.getByTestId('badge').tagName).toBe('SPAN');
  });

  it('respects a controlled open prop and reports changes in touch mode', async () => {
    enableTouchMode();
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <Tooltip open={true} onOpenChange={onOpenChange}>
        <TooltipTrigger>Tap me</TooltipTrigger>
        <TooltipContent data-testid="content">Tooltip text</TooltipContent>
      </Tooltip>
    );

    // Controlled open=true shows content without any interaction.
    expect(screen.getByTestId('content')).toBeInTheDocument();

    await user.click(screen.getByText('Tap me'));
    // Toggling asks the controller to close; internal state is not used.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('forwards pointer-leave and blur events to caller handlers in touch mode', () => {
    enableTouchMode();
    const onPointerLeave = vi.fn();
    const onBlur = vi.fn();
    const onPointerMove = vi.fn();

    render(
      <Tooltip>
        <TooltipTrigger
          onPointerLeave={onPointerLeave}
          onBlur={onBlur}
          onPointerMove={onPointerMove}
        >
          Tap me
        </TooltipTrigger>
        <TooltipContent>Tooltip text</TooltipContent>
      </Tooltip>
    );

    const trigger = screen.getByText('Tap me');
    fireEvent.pointerMove(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.blur(trigger);

    expect(onPointerMove).toHaveBeenCalledOnce();
    expect(onPointerLeave).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
  });
});
