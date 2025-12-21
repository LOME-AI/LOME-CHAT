import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from './ui';

describe('useUIStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('initial state', () => {
    it('has sidebar open by default', () => {
      const state = useUIStore.getState();
      expect(state.sidebarOpen).toBe(true);
    });
  });

  describe('setSidebarOpen', () => {
    it('sets sidebar to closed when passed false', () => {
      const { setSidebarOpen } = useUIStore.getState();
      setSidebarOpen(false);
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('sets sidebar to open when passed true', () => {
      useUIStore.setState({ sidebarOpen: false });
      const { setSidebarOpen } = useUIStore.getState();
      setSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('toggleSidebar', () => {
    it('toggles sidebar from open to closed', () => {
      const { toggleSidebar } = useUIStore.getState();
      toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('toggles sidebar from closed to open', () => {
      useUIStore.setState({ sidebarOpen: false });
      const { toggleSidebar } = useUIStore.getState();
      toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });
});
