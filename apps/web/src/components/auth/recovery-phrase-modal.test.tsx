import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { RecoveryPhraseModal } from './recovery-phrase-modal';
import { urlFromFetchInput } from '@/test-utils/fetch-mock';

const mockRecoveryWrappedPrivateKey = new Uint8Array([10, 20, 30, 40, 50]);
const mockRegenerateRecoveryPhrase = vi.fn().mockResolvedValue({
  recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
  recoveryWrappedPrivateKey: mockRecoveryWrappedPrivateKey,
});
const mockToBase64 = vi
  .fn()
  .mockImplementation((data: Uint8Array) => btoa(String.fromCodePoint(...data)));

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: (...args: unknown[]) => mockRegenerateRecoveryPhrase(...args),
  toBase64: (...args: unknown[]) => mockToBase64(...args),
}));

const mockPrivateKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
vi.mock('@/lib/auth', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ privateKey: mockPrivateKey })),
  },
}));

vi.mock('@/lib/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
}));

const mockClipboardWrite = vi.fn().mockImplementation(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', {
  value: {
    writeText: mockClipboardWrite,
  },
  writable: true,
  configurable: true,
});

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: vi.fn(() => false),
  };
});

async function fillVerificationInputs(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const labels = screen.getAllByText(/word #\d+/i);
  const inputs = screen.getAllByRole('textbox');
  const words = [
    'apple',
    'brave',
    'candy',
    'delta',
    'eagle',
    'frost',
    'globe',
    'happy',
    'ivory',
    'joker',
    'kite',
    'lemon',
  ];

  for (const [index, label] of labels.entries()) {
    if (!label.textContent) continue;
    const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
    const expectedWord = words[wordNumber - 1];
    const input = inputs[index];
    if (!input) throw new Error(`Expected input at index ${String(index)}`);
    await user.type(input, expectedWord ?? '');
  }
}

async function navigateToStep3WithDefaults(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.click(screen.getByRole('button', { name: /i've saved it/i }));
  await fillVerificationInputs(user);
  await user.click(screen.getByRole('button', { name: /verify/i }));
}

describe('RecoveryPhraseModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegenerateRecoveryPhrase.mockResolvedValue({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: mockRecoveryWrappedPrivateKey,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { success: true },
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
  });

  describe('Step 1: Display', () => {
    it('renders the modal with recovery phrase when open', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Your Recovery Phrase')).toBeInTheDocument();
      });
      expect(screen.getByText(/write these 12 words/i)).toBeInTheDocument();
    });

    it('warns that the phrase cannot be viewed again', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(
          screen.getByText(/you will not be able to view this phrase again/i)
        ).toBeInTheDocument();
      });
    });

    it('displays all 12 words in the grid', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      await waitFor(() => {
        for (const [index, word] of words.entries()) {
          expect(
            screen.getByText(new RegExp(String.raw`${index + 1}\. ${word}`, 'i'))
          ).toBeInTheDocument();
        }
      });
    });

    it('shows warning about recovery', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(
          screen.getByText(/if you lose your password, this is your only recovery/i)
        ).toBeInTheDocument();
      });
    });

    it('has copy to clipboard button', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeInTheDocument();
      });
    });

    it('copies phrase to clipboard when copy button clicked', async () => {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /copy to clipboard/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('has "I\'ve saved it" button to proceed to verification', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });
    });

    it('advances to step 2 when "I\'ve saved it" is clicked', async () => {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /i've saved it/i }));

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
    });

    it('calls regenerateRecoveryPhrase with account private key when modal opens', async () => {
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(mockRegenerateRecoveryPhrase).toHaveBeenCalledWith(mockPrivateKey);
      });
    });
  });

  describe('Step 2: Verify', () => {
    async function goToStep2(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /i've saved it/i }));
      return user;
    }

    it('shows verification step after proceeding from display', async () => {
      await goToStep2();

      expect(screen.getByText('Verify Your Phrase')).toBeInTheDocument();
      expect(screen.getByText(/enter the words at these positions/i)).toBeInTheDocument();
    });

    it('shows 3 input fields for word verification', async () => {
      await goToStep2();

      const inputs = screen.getAllByRole('textbox');
      expect(inputs).toHaveLength(3);
    });

    it('associates each verification label with its input', async () => {
      await goToStep2();

      const labels = screen.getAllByText<HTMLLabelElement>(/word #\d+/i);
      expect(labels).toHaveLength(3);
      for (const label of labels) {
        const input = screen.getByLabelText(label.textContent);
        expect(input).toHaveAttribute('type', 'text');
      }
    });

    it('shows back button on step 2', async () => {
      await goToStep2();

      expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    });

    it('goes back to step 1 when back button is clicked', async () => {
      const user = await goToStep2();

      await user.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByText('Your Recovery Phrase')).toBeInTheDocument();
    });

    it('verify button is disabled until all 3 words are correct', async () => {
      await goToStep2();

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).toBeDisabled();
    });

    it('shows checkmark when word is correct', async () => {
      const user = await goToStep2();

      const labels = screen.getAllByText(/word #\d+/i);
      const firstLabel = labels[0];
      if (!firstLabel?.textContent) throw new Error('Label not found');

      const wordNumber = Number.parseInt(/\d+/.exec(firstLabel.textContent)?.[0] ?? '0', 10);
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];
      const expectedWord = words[wordNumber - 1];

      const inputs = screen.getAllByRole('textbox');
      const firstInput = inputs[0];
      if (!firstInput) throw new Error('Expected first input');
      await user.type(firstInput, expectedWord ?? '');

      expect(screen.getByTestId(TEST_ID_BUILDERS.wordCheck(0))).toBeInTheDocument();
    });

    it('enables verify button when all 3 words are correct', async () => {
      const user = await goToStep2();

      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      for (const [index, label] of labels.entries()) {
        if (!label.textContent) continue;
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const expectedWord = words[wordNumber - 1];
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        await user.type(input, expectedWord ?? '');
      }

      const verifyButton = screen.getByRole('button', { name: /verify/i });
      expect(verifyButton).not.toBeDisabled();
    });

    it('Enter on first verification input focuses second input', async () => {
      const user = await goToStep2();

      const inputs = screen.getAllByRole('textbox');
      await user.click(inputs[0]!);
      await user.keyboard('{Enter}');

      expect(inputs[1]).toHaveFocus();
    });

    it('Enter on last verification input triggers verify when all correct', async () => {
      const user = await goToStep2();
      await fillVerificationInputs(user);

      const inputs = screen.getAllByRole('textbox');
      await user.click(inputs[2]!);
      await user.keyboard('{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
    });

    it('advances to step 3 when verify button is clicked with correct words', async () => {
      const user = await goToStep2();

      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      for (const [index, label] of labels.entries()) {
        if (!label.textContent) continue;
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const expectedWord = words[wordNumber - 1];
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        await user.type(input, expectedWord ?? '');
      }

      await user.click(screen.getByRole('button', { name: /verify/i }));

      expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
    });
  });

  describe('Step 3: Success', () => {
    async function goToStep3(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });
      await navigateToStep3WithDefaults(user);
      return user;
    }

    it('shows success message', async () => {
      await goToStep3();

      expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      expect(screen.getByText(/your account is now protected/i)).toBeInTheDocument();
    });

    it('shows "Done" button on success step', async () => {
      await goToStep3();

      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    });

    it('calls onSuccess when done button is clicked', async () => {
      const onSuccess = vi.fn();
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} onSuccess={onSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /i've saved it/i }));

      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      for (const [index, label] of labels.entries()) {
        if (!label.textContent) continue;
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const expectedWord = words[wordNumber - 1];
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        await user.type(input, expectedWord ?? '');
      }

      await user.click(screen.getByRole('button', { name: /verify/i }));
      await user.click(screen.getByRole('button', { name: /done/i }));

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('does not show back button on success step', async () => {
      await goToStep3();

      expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument();
    });
  });

  describe('Recovery crypto material save', () => {
    async function setupForCryptoSaveTest(): Promise<ReturnType<typeof userEvent.setup>> {
      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });
      await navigateToStep3WithDefaults(user);
      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
      return user;
    }

    it('calls POST /auth/recovery/save with recoveryWrappedPrivateKey', async () => {
      await setupForCryptoSaveTest();

      // The save is routed through the typed Hono client (`client.auth.
      // recovery.save.$post`) which calls fetch with the absolute URL produced
      // by `hc(baseUrl)`. Normalize string | URL | Request inputs so a future
      // change in input type does not break this assertion.
      const matchedCall = await waitFor(() => {
        const call = vi
          .mocked(globalThis.fetch)
          .mock.calls.find((c) => urlFromFetchInput(c[0]).endsWith('/auth/recovery/save'));
        expect(call).toBeDefined();
        return call!;
      });

      const init = matchedCall[1];
      if (!init) throw new Error('Expected fetch call to have init arguments');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      const headers = new Headers(init.headers);
      expect(headers.get('Content-Type')).toBe('application/json');

      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toHaveProperty('recoveryWrappedPrivateKey');
      expect(body).not.toHaveProperty('phraseSalt');
      expect(body).not.toHaveProperty('phraseVerifier');
      expect(body).not.toHaveProperty('encryptedDekPhrase');
    });

    it('shows success step after API call succeeds', async () => {
      await setupForCryptoSaveTest();

      await waitFor(() => {
        expect(screen.getByText('Recovery Phrase Saved')).toBeInTheDocument();
      });
    });

    it('shows error when API call fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json(
          { error: 'SERVER_ERROR' },
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );

      const user = userEvent.setup();
      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /i've saved it/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /i've saved it/i }));

      const labels = screen.getAllByText(/word #\d+/i);
      const inputs = screen.getAllByRole('textbox');
      const words = [
        'apple',
        'brave',
        'candy',
        'delta',
        'eagle',
        'frost',
        'globe',
        'happy',
        'ivory',
        'joker',
        'kite',
        'lemon',
      ];

      for (const [index, label] of labels.entries()) {
        if (!label.textContent) continue;
        const wordNumber = Number.parseInt(/\d+/.exec(label.textContent)?.[0] ?? '0', 10);
        const expectedWord = words[wordNumber - 1];
        const input = inputs[index];
        if (!input) throw new Error(`Expected input at index ${String(index)}`);
        await user.type(input, expectedWord ?? '');
      }

      await user.click(screen.getByRole('button', { name: /verify/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
    });

    it('shows error when regenerateRecoveryPhrase rejects', async () => {
      mockRegenerateRecoveryPhrase.mockRejectedValueOnce(new Error('Crypto failure'));

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Crypto failure')).toBeInTheDocument();
      });
    });

    it('shows fallback error when regenerateRecoveryPhrase rejects with non-Error', async () => {
      mockRegenerateRecoveryPhrase.mockRejectedValueOnce('unknown error');

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to generate recovery phrase/i)).toBeInTheDocument();
      });
    });

    it('shows error when account private key is not available', async () => {
      const { useAuthStore } = await import('@/lib/auth');
      vi.mocked(useAuthStore.getState).mockReturnValueOnce({ privateKey: null } as ReturnType<
        typeof useAuthStore.getState
      >);

      render(<RecoveryPhraseModal {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/failed to save recovery/i)).toBeInTheDocument();
      });
    });
  });

  describe('Modal behavior', () => {
    it('does not render when open is false', () => {
      render(<RecoveryPhraseModal {...defaultProps} open={false} />);

      expect(screen.queryByText('Your Recovery Phrase')).not.toBeInTheDocument();
    });

    it('calls regenerateRecoveryPhrase each time modal opens', async () => {
      const { rerender } = render(<RecoveryPhraseModal {...defaultProps} open={false} />);

      rerender(<RecoveryPhraseModal {...defaultProps} open={true} />);

      await waitFor(() => {
        expect(mockRegenerateRecoveryPhrase).toHaveBeenCalled();
      });
    });
  });
});
