import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/realtime/use-conversation-links.js', () => ({
  useCreateLink: vi.fn(),
}));

vi.mock('@hushbox/crypto', () => ({
  createSharedLink: vi.fn(),
}));

const mockRotationResult = {
  params: {
    expectedEpoch: 1,
    epochPublicKey: 'ep',
    confirmationHash: 'ch',
    chainLink: 'cl',
    encryptedTitle: 'et',
    memberWraps: [],
  },
  newEpochPrivateKey: new Uint8Array(32).fill(8),
  newEpochNumber: 2,
};
const mockExecuteWithRotation = vi.fn(
  async (input: { execute: (r: unknown) => Promise<unknown> }) => {
    await input.execute(mockRotationResult.params);
    return mockRotationResult;
  }
);
vi.mock('@/lib/rotation.js', () => ({
  executeWithRotation: (...args: unknown[]) =>
    mockExecuteWithRotation(...(args as [{ execute: (r: unknown) => Promise<unknown> }])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    toBase64: vi.fn(),
  };
});

import { createSharedLink } from '@hushbox/crypto';
import { toBase64, MAX_CONVERSATION_MEMBERS } from '@hushbox/shared';
import { useCreateLink } from '@/hooks/realtime/use-conversation-links.js';
import { InviteLinkModal } from '@/components/chat/member/invite-link-modal.js';

const mockUseCreateLink = vi.mocked(useCreateLink);
const mockCreateSharedLink = vi.mocked(createSharedLink);
const mockToBase64 = vi.mocked(toBase64);

const mockMutateAsync = vi.fn();

describe('InviteLinkModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    currentEpochPrivateKey: new Uint8Array([1, 2, 3]),
    currentEpochNumber: 1,
    plaintextTitle: 'Test Chat',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRotation.mockImplementation(
      async (input: { execute: (r: unknown) => Promise<unknown> }) => {
        await input.execute(mockRotationResult.params);
        return mockRotationResult;
      }
    );
    mockUseCreateLink.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateLink>);
    mockMutateAsync.mockResolvedValue({ linkId: 'link-1' });
    mockCreateSharedLink.mockReturnValue({
      linkSecret: new Uint8Array([10, 20, 30]),
      linkPublicKey: new Uint8Array([40, 50, 60]),
      linkWrap: new Uint8Array([70, 80, 90]),
    });
    mockToBase64.mockImplementation((bytes: Uint8Array) => {
      if (bytes[0] === 10) return 'link-secret-b64';
      if (bytes[0] === 40) return 'link-pubkey-b64';
      if (bytes[0] === 70) return 'link-wrap-b64';
      return 'unknown-b64';
    });
  });

  it('renders create phase by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-modal')).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-generate-button')).toBeInTheDocument();
  }, 15_000);

  it('shows permission selector with Read as default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const select = screen.getByTestId('invite-link-privilege-select') as HTMLSelectElement;
    expect(select.value).toBe('read');
  });

  it('shows history checkbox unchecked by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-history-checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('has optional guest name input', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-name-input')).toBeInTheDocument();
  });

  it('shows warning text about link security', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-warning')).toHaveTextContent(
      'Anyone with this link can decrypt'
    );
  });

  it('calls createSharedLink and useCreateLink on generate', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochPrivateKey);
    // No-history link goes through executeWithRotation, which calls mutateAsync with rotation
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        linkPublicKey: 'link-pubkey-b64',
        memberWrap: 'link-wrap-b64',
        privilege: 'read',
        giveFullHistory: false,
        rotation: mockRotationResult.params,
      })
    );
  });

  it('passes giveFullHistory true when history checkbox is checked', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ giveFullHistory: true })
    );
  });

  it('passes selected privilege to mutation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.selectOptions(screen.getByTestId('invite-link-privilege-select'), 'write');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ privilege: 'write' }));
  });

  it('includes a trimmed display name on the no-history mutation when a guest name is entered', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId('invite-link-name-input'), '  Guest Bob  ');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest Bob', giveFullHistory: false })
    );
  });

  it('includes a trimmed display name on the full-history mutation when a guest name is entered', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByTestId('invite-link-name-input'), 'Guest Bob');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest Bob', giveFullHistory: true })
    );
  });

  it('builds the rotation member set including the new link public key', async () => {
    let capturedMembers: unknown;
    mockExecuteWithRotation.mockImplementationOnce((async (input: {
      execute: (r: unknown) => Promise<unknown>;
      filterMembers: (keys: { publicKey: string }[]) => unknown;
    }) => {
      capturedMembers = input.filterMembers([{ publicKey: 'AQID' }]);
      await input.execute(mockRotationResult.params);
      return mockRotationResult;
    }) as unknown as Parameters<typeof mockExecuteWithRotation.mockImplementationOnce>[0]);

    render(<InviteLinkModal {...defaultProps} />);
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    // One existing member's key plus the freshly-generated link key.
    expect(Array.isArray(capturedMembers)).toBe(true);
    expect(capturedMembers as unknown[]).toHaveLength(2);
  });

  it('closes the modal from the generated phase Done button', async () => {
    const onOpenChange = vi.fn();
    render(<InviteLinkModal {...defaultProps} onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await screen.findByRole('button', { name: 'Done' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('switches to generated phase with URL after generation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(screen.getByTestId('invite-link-url')).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-copy-button')).toBeInTheDocument();
  });

  it('constructs URL with linkSecret in fragment', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    const urlEl = screen.getByTestId('invite-link-url');
    expect(urlEl.textContent).toContain('/share/c/conv-123#link-secret-b64');
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows "Copied" text after clicking copy button', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await userEvent.click(screen.getByTestId('invite-link-copy-button'));

    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copied');
  });

  it('resets to create phase when reopened', () => {
    const { rerender } = render(<InviteLinkModal {...defaultProps} open={false} />);
    rerender(<InviteLinkModal {...defaultProps} open={true} />);

    expect(screen.getByTestId('invite-link-generate-button')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-link-url')).not.toBeInTheDocument();
  });

  it('shows member limit alert and disables generate when at capacity', () => {
    render(<InviteLinkModal {...defaultProps} memberCount={MAX_CONVERSATION_MEMBERS} />);

    expect(screen.getByText(/reached the maximum of 100 members/)).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-generate-button')).toBeDisabled();
  });

  it('does not show member limit alert when below capacity', () => {
    render(<InviteLinkModal {...defaultProps} memberCount={50} />);

    expect(screen.queryByText(/reached the maximum of 100 members/)).not.toBeInTheDocument();
  });

  it('renders create phase buttons side-by-side with Cancel on left', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const generateButton = screen.getByTestId('invite-link-generate-button');
    const cancelButton = screen.getByTestId('invite-link-cancel-button');

    const container = generateButton.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('gap-2');
    expect(container).not.toHaveClass('flex-col');

    expect(generateButton).toHaveClass('flex-1');
    expect(cancelButton).toHaveClass('flex-1');

    const buttons = [...container!.children];
    expect(buttons.indexOf(cancelButton)).toBeLessThan(buttons.indexOf(generateButton));
  });

  it('Enter on guest name input triggers link generation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    const nameInput = screen.getByTestId('invite-link-name-input');
    nameInput.focus();

    // Dispatch Enter keydown — the hook intercepts this and calls requestSubmit
    nameInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    await waitFor(() => {
      expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochPrivateKey);
    });
    expect(mockMutateAsync).toHaveBeenCalled();
  });

  it('uses executeWithRotation for no-history link creation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        currentEpochPrivateKey: defaultProps.currentEpochPrivateKey,
        currentEpochNumber: 1,
        plaintextTitle: 'Test Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('does not use executeWithRotation when includeHistory is true', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ giveFullHistory: true })
    );
  });

  it('shows fresh Copy state when reopened after a prior copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    const { rerender } = render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await userEvent.click(screen.getByTestId('invite-link-copy-button'));
    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copied');

    rerender(<InviteLinkModal {...defaultProps} open={false} />);
    rerender(<InviteLinkModal {...defaultProps} open={true} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('invite-link-copy-button')).not.toHaveTextContent('Copied');
  });

  it('reverts to Copy after the reset timeout elapses', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InviteLinkModal {...defaultProps} />);

    await user.click(screen.getByTestId('invite-link-generate-button'));
    await user.click(screen.getByTestId('invite-link-copy-button'));
    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('invite-link-copy-button')).not.toHaveTextContent('Copied');

    vi.useRealTimers();
  });

  it('clears the copy-reset timer on unmount', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<InviteLinkModal {...defaultProps} />);

    await user.click(screen.getByTestId('invite-link-generate-button'));
    setSpy.mockClear();
    await user.click(screen.getByTestId('invite-link-copy-button'));

    const copyTimerResult = setSpy.mock.results[
      setSpy.mock.calls.findIndex((args) => args[1] === 3000)
    ] as { value: ReturnType<typeof setTimeout> } | undefined;
    expect(copyTimerResult).toBeDefined();

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(copyTimerResult!.value);

    vi.useRealTimers();
  });

  it('renders generated phase buttons side-by-side with Done on left', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    const copyButton = screen.getByTestId('invite-link-copy-button');
    // ModalActions renders label text twice per button (visible slot + width-
    // reservation slot) so query by role to get the actual <button>.
    const doneButton = screen.getByRole('button', { name: 'Done' });

    const container = copyButton.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('gap-2');
    expect(container).not.toHaveClass('flex-col');

    expect(copyButton).toHaveClass('flex-1');
    expect(doneButton).toHaveClass('flex-1');

    const buttons = [...container!.children];
    expect(buttons.indexOf(doneButton)).toBeLessThan(buttons.indexOf(copyButton));
  });
});
