import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({ useEnablePrompt: vi.fn() }));

import { NotificationEnablePrompt } from '@/components/notifications/enable-prompt';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';

const mockedUseEnablePrompt = vi.mocked(useEnablePrompt);
const enable = vi.fn();
const dismiss = vi.fn();

function setPromptState(overrides: { isVisible?: boolean; isEnabling?: boolean } = {}): void {
  mockedUseEnablePrompt.mockReturnValue({
    isVisible: overrides.isVisible ?? true,
    isEnabling: overrides.isEnabling ?? false,
    enable,
    dismiss,
  });
}

describe('NotificationEnablePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPromptState();
  });

  it('renders nothing when the offer is suppressed', () => {
    setPromptState({ isVisible: false });

    const { container } = render(<NotificationEnablePrompt />);

    expect(container).toBeEmptyDOMElement();
  });

  it('announces itself politely instead of trapping focus', () => {
    render(<NotificationEnablePrompt />);

    const region = screen.getByRole('status');
    expect(region).toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
  });

  it('says what notifications carry and where to change them', () => {
    render(<NotificationEnablePrompt />);

    const region = screen.getByRole('status');
    expect(region).toHaveTextContent(/never includes message content/i);
    expect(region).toHaveTextContent(/Settings/);
  });

  it('titles the offer so a narrow column still says what it is', () => {
    render(<NotificationEnablePrompt />);

    expect(screen.getByRole('heading', { name: 'Turn on notifications' })).toBeInTheDocument();
  });

  it('stacks the offer as a column instead of splitting it across a wide row', () => {
    render(<NotificationEnablePrompt />);

    const region = screen.getByRole('status');
    expect(region).toHaveClass('flex-col');
    expect(region.className).not.toContain('flex-row');
  });

  it('offers both actions as keyboard-reachable buttons', async () => {
    const user = userEvent.setup();
    render(<NotificationEnablePrompt />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Enable' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Later' })).toHaveFocus();
  });

  it('asks the platform when the user enables', async () => {
    const user = userEvent.setup();
    render(<NotificationEnablePrompt />);

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    expect(enable).toHaveBeenCalledTimes(1);
  });

  it('dismisses the offer when the user picks later', async () => {
    const user = userEvent.setup();
    render(<NotificationEnablePrompt />);

    await user.click(screen.getByRole('button', { name: 'Later' }));

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('disables the enable action while the platform is answering', () => {
    setPromptState({ isEnabling: true });

    render(<NotificationEnablePrompt />);

    expect(screen.getByRole('button', { name: 'Enable' })).toBeDisabled();
  });
});
