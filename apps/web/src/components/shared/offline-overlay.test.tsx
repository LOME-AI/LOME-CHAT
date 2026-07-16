import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { useNetworkStore } from '@/stores/network';
import { OfflineOverlay } from './offline-overlay';

describe('OfflineOverlay', () => {
  beforeEach(() => {
    useNetworkStore.setState({ isOffline: false });
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
  });

  afterEach(() => {
    document.querySelector('#root')?.remove();
  });

  it('does not render when online', () => {
    render(<OfflineOverlay />);

    expect(screen.queryByTestId(TEST_IDS.offlineOverlay)).not.toBeInTheDocument();
  });

  it('renders when offline', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
  });

  it('displays offline title', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlayTitle)).toHaveTextContent("You're Offline");
  });

  it('displays reconnection message', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlayDescription)).toHaveTextContent(
      'reconnect automatically'
    );
  });

  it('auto-dismisses when network returns', () => {
    useNetworkStore.setState({ isOffline: true });

    const { rerender } = render(<OfflineOverlay />);
    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();

    act(() => {
      useNetworkStore.setState({ isOffline: false });
    });
    rerender(<OfflineOverlay />);

    expect(screen.queryByTestId(TEST_IDS.offlineOverlay)).not.toBeInTheDocument();
  });

  it('announces the offline state via a polite live status region', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    const overlay = screen.getByTestId(TEST_IDS.offlineOverlay);
    expect(overlay).toHaveAttribute('role', 'status');
    expect(overlay).toHaveAttribute('aria-live', 'polite');
  });

  it('uses the top overlay z-index level so it sits above modals', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toHaveClass('z-overlay');
  });

  it('makes the application root inert while offline', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(document.querySelector('#root')).toHaveAttribute('inert');
  });

  it('restores interactivity to the application root when back online', () => {
    useNetworkStore.setState({ isOffline: true });

    const { rerender } = render(<OfflineOverlay />);
    expect(document.querySelector('#root')).toHaveAttribute('inert');

    act(() => {
      useNetworkStore.setState({ isOffline: false });
    });
    rerender(<OfflineOverlay />);

    expect(document.querySelector('#root')).not.toHaveAttribute('inert');
  });

  it('renders outside the application root so portaled dialogs cannot cover it', () => {
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    const overlay = screen.getByTestId(TEST_IDS.offlineOverlay);
    expect(document.querySelector('#root')?.contains(overlay)).toBe(false);
  });

  it('skips inert marking when the app root is absent', () => {
    // Exercises the `if (!root) return` guard: the overlay is body-portaled and
    // still renders even when #root cannot be found.
    const root = document.querySelector('#root');
    root?.remove();
    useNetworkStore.setState({ isOffline: true });

    render(<OfflineOverlay />);

    expect(screen.getByTestId(TEST_IDS.offlineOverlay)).toBeInTheDocument();
    if (root) document.body.append(root);
  });
});
