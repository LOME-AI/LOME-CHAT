import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { SignupModal } from './signup-modal';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

describe('SignupModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders modal content when open', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId(TEST_IDS.signupModal)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<SignupModal open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByTestId(TEST_IDS.signupModal)).not.toBeInTheDocument();
  });

  it('displays heading about premium models', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    const modal = screen.getByTestId(TEST_IDS.signupModal);
    expect(within(modal).getByRole('heading')).toHaveTextContent(/premium/i);
  });

  it('displays description about signing up', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/sign up for free to access/i)).toBeInTheDocument();
  });

  it('renders Sign Up button', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /sign up/i })).toBeInTheDocument();
  });

  it('renders Maybe Later button', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /maybe later/i })).toBeInTheDocument();
  });

  it('navigates to signup page when Sign Up is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /sign up/i }));

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/signup' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes modal when Maybe Later is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /maybe later/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('closes modal on Escape key', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<SignupModal open={true} onOpenChange={onOpenChange} />);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('includes model name in message when modelName is provided', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} modelName="GPT-4 Turbo" />);

    expect(screen.getByText(/GPT-4 Turbo/)).toBeInTheDocument();
  });

  it('shows generic message when modelName is not provided', () => {
    render(<SignupModal open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText(/access premium models including/i)).toBeInTheDocument();
  });

  describe('multi-model variant', () => {
    it('renders the multi-model modal with its own title and message', () => {
      render(<SignupModal open={true} onOpenChange={vi.fn()} variant="multi-model" />);

      const modal = screen.getByTestId(TEST_IDS.multiModelSignupModal);
      expect(within(modal).getByRole('heading')).toHaveTextContent(/compare multiple models/i);
      expect(
        screen.getByText(/send your message to multiple ai models at once/i)
      ).toBeInTheDocument();
    });
  });
});
