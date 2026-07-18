import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { friendlyErrorMessage } from '@hushbox/shared';
import { CustomInstructionsModal } from './custom-instructions-modal';

const { mockGetState, mockEncryptMessageForStorage, mockGetPublicKeyFromPrivate, mockFetchJson } =
  vi.hoisted(() => ({
    mockGetState: vi.fn(),
    mockEncryptMessageForStorage: vi.fn(() => new Uint8Array([1, 2, 3])),
    mockGetPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
    mockFetchJson: vi.fn(),
  }));

vi.mock('@/lib/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mockGetState()),
    { getState: mockGetState }
  ),
}));

vi.mock('@hushbox/crypto', () => ({
  encryptTextForEpoch: (...args: unknown[]) =>
    (mockEncryptMessageForStorage as (...a: unknown[]) => unknown)(...args),
  getPublicKeyFromPrivate: (...args: unknown[]) =>
    (mockGetPublicKeyFromPrivate as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    account: {
      instructions: {
        $put: vi.fn(() => Promise.resolve(new Response())),
        $delete: vi.fn(() => Promise.resolve(new Response())),
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/shared')>()),
  toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
  legacyFriendlyErrorMessage: (code: string) => `Error: ${code}`,
}));

describe('CustomInstructionsModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({
      customInstructions: null,
      privateKey: new Uint8Array([99, 100, 101]),
      setCustomInstructions: vi.fn(),
    });
    mockFetchJson.mockResolvedValue({ success: true });
  });

  describe('rendering', () => {
    it('renders nothing when open is false', () => {
      render(<CustomInstructionsModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Custom Instructions')).toBeNull();
    });

    it('renders modal title and description when open', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByText('Custom Instructions')).toBeTruthy();
      expect(screen.getByText(/included in every conversation/i)).toBeTruthy();
    });

    it('renders a textarea', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toBeTruthy();
    });

    it('renders character counter showing 0 / 5,000 when empty', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByText('0 / 5,000')).toBeTruthy();
    });

    it('loads existing custom instructions from auth store', () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Be concise',
        privateKey: new Uint8Array([99, 100, 101]),
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveValue('Be concise');
      expect(screen.getByText('10 / 5,000')).toBeTruthy();
    });

    it('renders Save and Cancel buttons', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
    });
  });

  describe('character limit', () => {
    it('updates character count as user types', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Hello');

      expect(screen.getByText('5 / 5,000')).toBeTruthy();
    });

    it('does not block typing past the limit with a native maxLength', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).not.toHaveAttribute('maxLength');
    });

    it('shows the truncation notice when the value exceeds the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } });

      expect(screen.getByText('Only the first 5,000 characters will be used.')).toBeInTheDocument();
    });
  });

  describe('save flow', () => {
    it('encrypts and saves instructions on submit', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
          new Uint8Array([10, 20, 30]),
          'Be helpful'
        );
      });

      expect(mockFetchJson).toHaveBeenCalled();
    });

    it('calls onSuccess and updates auth store on successful save', async () => {
      const mockSetCustomInstructions = vi.fn();
      mockGetState.mockReturnValue({
        customInstructions: null,
        privateKey: new Uint8Array([99, 100, 101]),
        setCustomInstructions: mockSetCustomInstructions,
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });

      expect(mockSetCustomInstructions).toHaveBeenCalledWith('Be helpful');
    });

    it('saves null when textarea is empty (clears instructions)', async () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Old instructions',
        privateKey: new Uint8Array([99, 100, 101]),
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.clear(textarea);

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalled();
      });

      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });

    it('encrypts only the first 5000 characters when the value is over the limit', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5005) } });

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
          new Uint8Array([10, 20, 30]),
          'x'.repeat(5000)
        );
      });
    });

    it('shows error message on save failure', async () => {
      mockFetchJson.mockRejectedValue({ code: 'INTERNAL' });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to save/i)).toBeTruthy();
      });
    });

    it('shows an error when the account private key is unavailable', async () => {
      // Non-empty instructions but no private key: exercises the `if (!privateKey)` guard.
      mockGetState.mockReturnValue({
        customInstructions: null,
        privateKey: null,
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE'))
        ).toBeInTheDocument();
      });
      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });
  });

  describe('state reset', () => {
    it('resets textarea to stored value when modal reopens', () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Stored value',
        privateKey: new Uint8Array([99, 100, 101]),
        setCustomInstructions: vi.fn(),
      });

      const { rerender } = render(<CustomInstructionsModal {...defaultProps} open={false} />);

      rerender(<CustomInstructionsModal {...defaultProps} open={true} />);

      expect(screen.getByRole('textbox')).toHaveValue('Stored value');
    });
  });
});
