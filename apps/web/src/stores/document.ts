import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Document } from '@/lib/document-parser';

const MIN_PANEL_WIDTH = 300;
const DEFAULT_PANEL_WIDTH = 400;

interface DocumentState {
  isPanelOpen: boolean;
  panelWidth: number;
  activeDocumentId: string | null;
  activeDocument: Document | null;
  /**
   * Increments once per explicit open. The document id is a content hash, so it
   * mutates as a message streams; this counter is what identifies one user
   * selection across those mutations.
   */
  activeSelectionId: number;
  isFullscreen: boolean;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  /** Opens a document the user picked — a new selection. */
  setActiveDocument: (document: Document) => void;
  /** Replaces the open document with a newer parse of the same selection. */
  refreshActiveDocument: (document: Document) => void;
  setPanelWidth: (width: number, maxWidth: number) => void;
  toggleFullscreen: () => void;
}

export const useDocumentStore = create<DocumentState>()(
  persist(
    (set) => ({
      isPanelOpen: false,
      panelWidth: DEFAULT_PANEL_WIDTH,
      activeDocumentId: null,
      activeDocument: null,
      activeSelectionId: 0,
      isFullscreen: false,

      openPanel: () => set({ isPanelOpen: true }),

      closePanel: () =>
        set({
          isPanelOpen: false,
          activeDocumentId: null,
          activeDocument: null,
          isFullscreen: false,
        }),

      togglePanel: () =>
        set((state) => ({
          isPanelOpen: !state.isPanelOpen,
          ...(state.isPanelOpen ? { activeDocumentId: null, activeDocument: null } : {}),
        })),

      setActiveDocument: (document) =>
        set((state) => ({
          activeDocumentId: document.id,
          activeDocument: document,
          activeSelectionId: state.activeSelectionId + 1,
          isPanelOpen: true,
        })),

      refreshActiveDocument: (document) =>
        set({ activeDocumentId: document.id, activeDocument: document }),

      setPanelWidth: (width, maxWidth) =>
        set({
          panelWidth: Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width)),
        }),

      toggleFullscreen: () => set((state) => ({ isFullscreen: !state.isFullscreen })),
    }),
    {
      name: 'hushbox-document-storage',
      partialize: (state) => ({ panelWidth: state.panelWidth }),
    }
  )
);
