import { describe, it, expect, beforeEach } from 'vitest';
import { useDocumentStore } from './document';
import type { Document } from '@/lib/document-parser';

function makeDocument(overrides?: Partial<Document>): Document {
  return {
    id: 'doc-789',
    type: 'code',
    language: 'python',
    title: 'fibonacci',
    content: 'def fibonacci(n): pass',
    lineCount: 15,
    isStreaming: false,
    ...overrides,
  };
}

describe('useDocumentStore', () => {
  beforeEach(() => {
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
      activeDocument: null,
      isFullscreen: false,
    });
  });

  describe('initial state', () => {
    it('has panel closed by default', () => {
      const state = useDocumentStore.getState();
      expect(state.isPanelOpen).toBe(false);
    });

    it('has default panel width of 400', () => {
      const state = useDocumentStore.getState();
      expect(state.panelWidth).toBe(400);
    });

    it('has no active document by default', () => {
      const state = useDocumentStore.getState();
      expect(state.activeDocumentId).toBeNull();
      expect(state.activeDocument).toBeNull();
    });

    it('has fullscreen disabled by default', () => {
      const state = useDocumentStore.getState();
      expect(state.isFullscreen).toBe(false);
    });
  });

  describe('openPanel', () => {
    it('opens the panel', () => {
      const { openPanel } = useDocumentStore.getState();
      openPanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('closePanel', () => {
    it('closes the panel', () => {
      useDocumentStore.setState({ isPanelOpen: true });
      const { closePanel } = useDocumentStore.getState();
      closePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('clears active document when closing', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: makeDocument({ id: 'doc-123' }),
      });
      const { closePanel } = useDocumentStore.getState();
      closePanel();
      expect(useDocumentStore.getState().activeDocumentId).toBeNull();
      expect(useDocumentStore.getState().activeDocument).toBeNull();
    });

    it('resets fullscreen when closing', () => {
      useDocumentStore.setState({ isPanelOpen: true, isFullscreen: true });
      const { closePanel } = useDocumentStore.getState();
      closePanel();
      expect(useDocumentStore.getState().isFullscreen).toBe(false);
    });
  });

  describe('togglePanel', () => {
    it('opens panel when closed', () => {
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });

    it('closes panel when open', () => {
      useDocumentStore.setState({ isPanelOpen: true });
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('clears active document when toggling closed', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-456',
        activeDocument: makeDocument({ id: 'doc-456' }),
      });
      const { togglePanel } = useDocumentStore.getState();
      togglePanel();
      expect(useDocumentStore.getState().activeDocumentId).toBeNull();
      expect(useDocumentStore.getState().activeDocument).toBeNull();
    });
  });

  describe('setActiveDocument', () => {
    it('sets the active document ID and object', () => {
      const document = makeDocument();
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument(document);
      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-789');
      expect(useDocumentStore.getState().activeDocument).toBe(document);
    });

    it('opens the panel when setting active document', () => {
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument(makeDocument({ id: 'doc-abc' }));
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });

    it('changes active document when panel is already open', () => {
      const oldDocument = makeDocument({ id: 'doc-old' });
      const newDocument = makeDocument({ id: 'doc-new', title: 'new-title' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-old',
        activeDocument: oldDocument,
      });
      const { setActiveDocument } = useDocumentStore.getState();
      setActiveDocument(newDocument);
      expect(useDocumentStore.getState().activeDocumentId).toBe('doc-new');
      expect(useDocumentStore.getState().activeDocument).toBe(newDocument);
      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
    });
  });

  describe('setPanelWidth', () => {
    it('sets the panel width', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(500, 1200);
      expect(useDocumentStore.getState().panelWidth).toBe(500);
    });

    it('enforces minimum width of 300', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(200, 1200);
      expect(useDocumentStore.getState().panelWidth).toBe(300);
    });

    it('enforces dynamic maximum width', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(1000, 600);
      expect(useDocumentStore.getState().panelWidth).toBe(600);
    });

    it('accepts values within range', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(600, 1200);
      expect(useDocumentStore.getState().panelWidth).toBe(600);
    });

    it('clamps to different max widths', () => {
      const { setPanelWidth } = useDocumentStore.getState();
      setPanelWidth(900, 850);
      expect(useDocumentStore.getState().panelWidth).toBe(850);
    });
  });

  describe('toggleFullscreen', () => {
    it('enables fullscreen', () => {
      const { toggleFullscreen } = useDocumentStore.getState();
      toggleFullscreen();
      expect(useDocumentStore.getState().isFullscreen).toBe(true);
    });

    it('disables fullscreen when already enabled', () => {
      useDocumentStore.setState({ isFullscreen: true });
      const { toggleFullscreen } = useDocumentStore.getState();
      toggleFullscreen();
      expect(useDocumentStore.getState().isFullscreen).toBe(false);
    });

    it('does not affect panel width when toggling fullscreen', () => {
      useDocumentStore.setState({ panelWidth: 500 });
      const { toggleFullscreen } = useDocumentStore.getState();
      toggleFullscreen();
      expect(useDocumentStore.getState().panelWidth).toBe(500);
    });
  });
});

describe('useDocumentStore selections', () => {
  beforeEach(() => {
    useDocumentStore.setState({
      isPanelOpen: false,
      activeDocumentId: null,
      activeDocument: null,
      activeSelectionId: 0,
    });
  });

  it('counts each explicit open as a new selection', () => {
    const { setActiveDocument } = useDocumentStore.getState();

    setActiveDocument(makeDocument({ id: 'doc-a' }));
    const first = useDocumentStore.getState().activeSelectionId;
    setActiveDocument(makeDocument({ id: 'doc-b' }));

    expect(useDocumentStore.getState().activeSelectionId).toBeGreaterThan(first);
  });

  it('replaces the active document on refresh without starting a new selection', () => {
    const { setActiveDocument, refreshActiveDocument } = useDocumentStore.getState();
    setActiveDocument(makeDocument({ id: 'doc-a', title: 'Partial' }));
    const selectionId = useDocumentStore.getState().activeSelectionId;

    refreshActiveDocument(makeDocument({ id: 'doc-b', title: 'Complete' }));

    const state = useDocumentStore.getState();
    expect(state.activeDocumentId).toBe('doc-b');
    expect(state.activeDocument?.title).toBe('Complete');
    expect(state.activeSelectionId).toBe(selectionId);
  });
});
