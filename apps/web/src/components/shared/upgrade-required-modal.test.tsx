import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { useAppVersionStore } from '@/stores/app-version';
import { UpgradeRequiredModal } from './upgrade-required-modal';

const { mockIsNative, mockCheckForUpdate, mockApplyUpdate } = vi.hoisted(() => ({
  mockIsNative: vi.fn(() => false),
  mockCheckForUpdate: vi.fn(),
  mockApplyUpdate: vi.fn(),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: mockIsNative,
}));

vi.mock('@/capacitor/live-update', () => ({
  checkForUpdate: mockCheckForUpdate,
  applyUpdate: mockApplyUpdate,
}));

describe('UpgradeRequiredModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppVersionStore.setState({ upgradeRequired: false });
    mockIsNative.mockReturnValue(false);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
  });

  it('does not render when upgradeRequired is false', () => {
    render(<UpgradeRequiredModal />);

    expect(screen.queryByTestId(TEST_IDS.upgradeRequiredModal)).not.toBeInTheDocument();
  });

  it('renders when upgradeRequired is true', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();
  });

  it('displays update required title', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredTitle)).toHaveTextContent('Update Required');
  });

  it('renders refresh copy on web', () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(false);

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).toHaveTextContent('Refresh');
    expect(screen.getByTestId(TEST_IDS.upgradeRequiredDescription)).toHaveTextContent(
      'A new version is available. Please refresh to continue.'
    );
  });

  it('renders update copy on native', () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);

    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).toHaveTextContent('Update');
    expect(screen.getByTestId(TEST_IDS.upgradeRequiredDescription)).toHaveTextContent(
      'A new version is available. Please update to continue.'
    );
  });

  it('calls window.location.reload on web when refresh is clicked', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(false);
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    expect(reloadMock).toHaveBeenCalledOnce();
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it('does not call location.reload on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const reloadMock = vi.fn();
    Object.defineProperty(globalThis, 'location', {
      value: { reload: reloadMock },
      writable: true,
    });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('calls checkForUpdate on native when refresh is clicked', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
  });

  it('calls applyUpdate with server version when update is available', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(mockApplyUpdate).toHaveBeenCalledWith('v2');
    });
  });

  it('does not call applyUpdate when no update is available', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: false });
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(mockCheckForUpdate).toHaveBeenCalledOnce();
    });
    expect(mockApplyUpdate).not.toHaveBeenCalled();
  });

  it('disables button while updating on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    // Never-resolving promise to keep isUpdating=true
    mockCheckForUpdate.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).toBeDisabled();
    });
  });

  it('shows updating text while in progress on native', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).toHaveTextContent('Updating...');
    });
  });

  it('re-enables button after update attempt completes', async () => {
    useAppVersionStore.setState({ upgradeRequired: true });
    mockIsNative.mockReturnValue(true);
    mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, serverVersion: 'v2' });
    // applyUpdate resolves without destroying JS (simulating failure path)
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    mockApplyUpdate.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<UpgradeRequiredModal />);
    await user.click(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh));

    await vi.waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.upgradeRequiredRefresh)).not.toBeDisabled();
    });
  });

  it('does not show close button (non-dismissable)', () => {
    useAppVersionStore.setState({ upgradeRequired: true });

    render(<UpgradeRequiredModal />);

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('ignores dismissal attempts and stays open', async () => {
    // Pressing Escape fires the overlay's onOpenChange no-op handler; the modal
    // must remain because it is non-dismissable.
    const user = userEvent.setup();
    useAppVersionStore.setState({ upgradeRequired: true });
    render(<UpgradeRequiredModal />);

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.getByTestId(TEST_IDS.upgradeRequiredModal)).toBeInTheDocument();
  });
});
