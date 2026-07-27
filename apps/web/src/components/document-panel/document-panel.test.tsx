import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { DocumentPanel } from './document-panel';
import { useDocumentStore } from '../../stores/document';
import type { Document } from '../../lib/document-parser';

// Mock Streamdown: Shiki lazy-loads via React.lazy() in JSDOM, so code content
// isn't visible in sync tests. The mock renders children (fenced code block string)
// as plain text, keeping text assertions working.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

// isMobile: true = mobile (<768px), false = desktop (>=768px)
const mockMatchMedia = (isMobile: boolean): void => {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      // useIsMobile uses max-width: 767px query
      matches: query.includes('max-width') ? isMobile : !isMobile,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
};

describe('DocumentPanel', () => {
  const createDocument = (overrides: Partial<Document> = {}): Document => ({
    id: 'doc-123',
    type: 'code',
    language: 'typescript',
    title: 'MyComponent',
    content: 'const x = 1;\nconst y = 2;',
    lineCount: 2,
    isStreaming: false,
    ...overrides,
  });

  const defaultDocument = createDocument();

  beforeEach(() => {
    mockMatchMedia(false);
    vi.stubEnv('VITE_SANDBOX_ORIGIN_URL', 'http://localhost:7400');
    useDocumentStore.setState({
      isPanelOpen: false,
      panelWidth: 400,
      activeDocumentId: null,
      activeDocument: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('visibility', () => {
    it('does not render when panel is closed', () => {
      render(<DocumentPanel />);

      expect(screen.queryByTestId(TEST_IDS.documentPanel)).not.toBeInTheDocument();
    });

    it('renders when panel is open', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.documentPanel)).toBeInTheDocument();
    });

    it('does not render when no active document', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: null,
        activeDocument: null,
      });
      render(<DocumentPanel />);

      expect(screen.queryByTestId(TEST_IDS.documentPanel)).not.toBeInTheDocument();
    });
  });

  describe('header', () => {
    it('displays document title', () => {
      const document_ = createDocument({ title: 'UserService' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('UserService')).toBeInTheDocument();
    });

    it('has close button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('closes panel when close button is clicked', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /close/i }));

      expect(useDocumentStore.getState().isPanelOpen).toBe(false);
    });

    it('has copy button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies document content when copy button is clicked', async () => {
      const user = userEvent.setup();
      const mockWriteText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: mockWriteText },
        writable: true,
        configurable: true,
      });

      const content = 'const x = 1;\nconst y = 2;';
      const document_ = createDocument({ content });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('does not crash when clipboard API fails', async () => {
      const user = userEvent.setup();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(() => Promise.reject(new Error('Clipboard not available'))) },
        writable: true,
        configurable: true,
      });

      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /copy/i }));

      // Should not crash — feedback still shown even when clipboard API fails
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
      });
    });

    it('has download button', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
    });

    it('triggers download when download button is clicked', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({
        title: 'MyComponent',
        language: 'typescript',
        content: 'const x = 1;',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const mockUrl = 'blob:mock-url';
      const createObjectURL = vi.fn(() => mockUrl);
      const revokeObjectURL = vi.fn();
      globalThis.URL.createObjectURL = createObjectURL;
      globalThis.URL.revokeObjectURL = revokeObjectURL;

      const clickSpy = vi.fn();
      vi.spyOn(document, 'createElement').mockReturnValueOnce({
        href: '',
        download: '',
        click: clickSpy,
        style: {},
      } as unknown as HTMLAnchorElement);

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith(mockUrl);
    });

    it('displays title with primary color', () => {
      const document_ = createDocument({ title: 'TestTitle' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const title = screen.getByText('TestTitle');
      expect(title).toHaveClass('text-primary');
    });
  });

  describe('content rendering', () => {
    it('renders code content for code documents', () => {
      const document_ = createDocument({ type: 'code', content: 'const hello = "world";' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText(/const hello/)).toBeInTheDocument();
    });

    it('renders mermaid diagram for mermaid documents', () => {
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // MermaidDiagram shows loading state initially
      expect(screen.getByTestId(TEST_IDS.mermaidLoading)).toBeInTheDocument();
    });

    it('shows raw toggle button for mermaid documents', () => {
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /show raw/i })).toBeInTheDocument();
    });

    it('toggles between rendered and raw view for mermaid', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ type: 'mermaid', content: 'flowchart TD\n    A --> B' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(
        screen.queryByTestId(TEST_IDS.mermaidLoading) ??
          screen.queryByTestId(TEST_IDS.mermaidDiagram)
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /show raw/i }));

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.getByText(/flowchart TD/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /show rendered/i }));

      // Back to mermaid diagram (either loading or rendered)
      expect(
        screen.queryByTestId(TEST_IDS.mermaidLoading) ??
          screen.queryByTestId(TEST_IDS.mermaidDiagram)
      ).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.highlightedCode)).not.toBeInTheDocument();
    });

    it('does not show raw toggle for code documents', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.queryByRole('button', { name: /show raw/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /show rendered/i })).not.toBeInTheDocument();
    });

    it('renders the sandbox preview for html documents by default', () => {
      const document_ = createDocument({
        type: 'html',
        language: 'html',
        title: 'Landing',
        content: '<div>Hello</div>',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const frame = screen.getByTitle('Landing');
      expect(frame).toBeInTheDocument();
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(screen.queryByTestId(TEST_IDS.highlightedCode)).not.toBeInTheDocument();
    });

    it('shows a raw toggle for runnable documents and reveals source when toggled', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({
        type: 'html',
        language: 'html',
        title: 'Landing',
        content: '<div>Hello</div>',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /show raw/i }));

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByTitle('Landing')).not.toBeInTheDocument();
    });

    it('renders the sandbox preview for js documents', () => {
      const document_ = createDocument({
        type: 'js',
        language: 'javascript',
        title: 'Script',
        content: 'document.body.append("x");',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTitle('Script')).toBeInTheDocument();
    });

    it('renders a Run control for python documents', () => {
      const document_ = createDocument({
        type: 'python',
        language: 'python',
        title: 'Analysis',
        content: 'print("hi")',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('wraps code content in document-panel-code class', () => {
      const document_ = createDocument({ type: 'code', content: 'const x = 1;' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      const codeContainer = screen.getByTestId(TEST_IDS.highlightedCode);
      expect(codeContainer).toHaveClass('document-panel-code');
    });

    it('renders the sandbox preview for react documents by default', () => {
      const document_ = createDocument({
        type: 'react',
        language: 'tsx',
        title: 'Widget',
        content: 'export default function App() { return <div /> }',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByTitle('Widget')).toBeInTheDocument();
    });
  });

  describe('streaming documents', () => {
    const statusOf = (container: HTMLElement): string | null =>
      container.querySelector<HTMLElement>('#document-render-status')?.dataset['status'] ?? null;

    const reactDocument = (overrides: Partial<Document> = {}): Document =>
      createDocument({
        type: 'react',
        language: 'jsx',
        title: 'Widget',
        content: 'export default function App() { return <div /> }',
        ...overrides,
      });

    const openDocument = (document_: Document): void => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
    };

    it('hands a still-streaming document to the sandbox rather than withholding it', () => {
      openDocument(reactDocument({ isStreaming: true }));
      render(<DocumentPanel />);

      expect(screen.getByTitle('Widget')).toBeInTheDocument();
    });

    it('shows the source and no error until something renders', () => {
      openDocument(reactDocument({ isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('announces the wait as a status, not as a failure', () => {
      openDocument(reactDocument({ isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      const status = container.querySelector('#document-render-status');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent(/preview starts when the code is ready/i);
      expect(screen.getAllByText(/preview starts when the code is ready/i).length).toBeGreaterThan(
        0
      );
    });

    it('holds back the mermaid diagram while its message streams', () => {
      openDocument(
        createDocument({
          type: 'mermaid',
          language: 'mermaid',
          content: 'flowchart TD\n    A --> B',
          isStreaming: true,
        })
      );
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.mermaidLoading)).not.toBeInTheDocument();
      expect(statusOf(container)).toBe('streaming');
    });

    it('shows a plain code document as source with no preview status', () => {
      openDocument(createDocument({ type: 'code', isStreaming: true }));
      const { container } = render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(statusOf(container)).toBeNull();
    });

    it('offers the raw toggle while the message is still streaming', () => {
      openDocument(reactDocument({ isStreaming: true }));
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /show raw/i })).toBeInTheDocument();
    });

    it('still requires an explicit run for python while its message streams', () => {
      openDocument(
        createDocument({
          type: 'python',
          language: 'python',
          title: 'Analysis',
          content: 'print("hi")',
          isStreaming: true,
        })
      );
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('keeps an explicit raw choice when the message settles', async () => {
      const user = userEvent.setup();
      const streaming = reactDocument({ isStreaming: true });
      openDocument(streaming);
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /show raw/i }));
      act(() => {
        useDocumentStore.getState().refreshActiveDocument({ ...streaming, isStreaming: false });
      });

      expect(screen.getByTestId(TEST_IDS.highlightedCode)).toBeInTheDocument();
      expect(screen.queryByTitle('Widget')).not.toBeInTheDocument();
    });

    it('keeps the same sandbox frame as a streaming document grows', () => {
      const streaming = reactDocument({ isStreaming: true });
      openDocument(streaming);
      render(<DocumentPanel />);
      const frame = screen.getByTitle('Widget');

      act(() => {
        useDocumentStore.getState().refreshActiveDocument({
          ...streaming,
          id: 'doc-grown',
          content: `${streaming.content}\n// more`,
        });
      });

      expect(screen.getByTitle('Widget')).toBe(frame);
    });

    it('drops the raw choice when the user opens another document', async () => {
      const user = userEvent.setup();
      openDocument(reactDocument());
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /show raw/i }));
      act(() => {
        useDocumentStore
          .getState()
          .setActiveDocument(reactDocument({ id: 'doc-other', title: 'Other' }));
      });

      expect(screen.getByTitle('Other')).toBeInTheDocument();
    });

    it('remounts the sandbox frame when the user opens another document', () => {
      openDocument(reactDocument());
      render(<DocumentPanel />);
      const frame = screen.getByTitle('Widget');

      act(() => {
        useDocumentStore.getState().setActiveDocument(reactDocument({ id: 'doc-other' }));
      });

      expect(screen.getByTitle('Widget')).not.toBe(frame);
    });
  });

  describe('panel width', () => {
    it('uses panel width from store', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).toHaveStyle({ width: '500px' });
    });
  });

  describe('scrolling', () => {
    it('uses ScrollArea for content scrolling', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.documentPanelScroll)).toBeInTheDocument();
    });

    // A rendered document sizes itself against the panel: every `h-full`/`flex-1`
    // under here resolves against this element, so a percentage height it cannot
    // resolve collapses the document to nothing.
    it('gives the content a height for a rendered document to fill', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const content = screen.getByTestId(TEST_IDS.documentPanelScroll).firstElementChild;
      expect(content).toHaveClass('h-full');
    });

    // Fill and overflow trade against each other: a content box that fills the
    // panel must still let taller source spill into the scroller above it.
    it('lets source taller than the panel spill to the scroller', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const scroll = screen.getByTestId(TEST_IDS.documentPanelScroll);
      expect(scroll).toHaveClass('overflow-auto');
      expect(scroll.firstElementChild?.className).not.toMatch(/overflow-(hidden|auto|clip)/);
    });
  });

  describe('responsive behavior', () => {
    it('renders panel with fixed width on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '500px' });
    });

    it('renders panel with full width on mobile', () => {
      mockMatchMedia(true);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveStyle({ width: '100%' });
    });

    it('hides resize handle on mobile', () => {
      mockMatchMedia(true);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.queryByTestId(TEST_IDS.resizeHandle)).not.toBeInTheDocument();
    });

    it('shows resize handle on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByTestId(TEST_IDS.resizeHandle)).toBeInTheDocument();
    });

    it('shows document title on mobile', () => {
      mockMatchMedia(true);
      const document_ = createDocument({ title: 'MobileTitle' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      expect(screen.getByText('MobileTitle')).toBeInTheDocument();
    });
  });

  describe('fullscreen toggle', () => {
    it('renders fullscreen button on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /fullscreen/i })).toBeInTheDocument();
    });

    it('toggles fullscreen state when clicked', async () => {
      const user = userEvent.setup();
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      await user.click(screen.getByRole('button', { name: /fullscreen/i }));

      expect(useDocumentStore.getState().isFullscreen).toBe(true);
    });

    it('shows exit fullscreen label when fullscreen is active', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      expect(screen.getByRole('button', { name: /exit fullscreen/i })).toBeInTheDocument();
    });

    it('does not render fullscreen button on mobile', () => {
      mockMatchMedia(true);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      expect(screen.queryByRole('button', { name: /fullscreen/i })).not.toBeInTheDocument();
    });

    it('has width transition class when not resizing', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel.className).toContain('transition-');
    });

    it('uses 100% width when fullscreen is active on desktop', () => {
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 500,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).toHaveStyle({ width: '100%' });
    });

    it('exits fullscreen when user starts resizing', async () => {
      const user = userEvent.setup();
      mockMatchMedia(false);
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        isFullscreen: true,
      });
      render(<DocumentPanel />);

      expect(useDocumentStore.getState().isFullscreen).toBe(true);

      const handle = screen.getByTestId(TEST_IDS.resizeHandle);
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      expect(useDocumentStore.getState().isFullscreen).toBe(false);
    });
  });

  describe('resize handle', () => {
    it('renders resize handle with visible indicator', () => {
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId(TEST_IDS.resizeHandle);
      expect(handle).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.resizeIndicator)).toBeInTheDocument();
    });

    it('starts resizing on mouse down', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId(TEST_IDS.resizeHandle);
      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).toHaveClass('select-none');
    });

    it('stops resizing on mouse up', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId(TEST_IDS.resizeHandle);

      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      await user.pointer({ keys: '[/MouseLeft]' });

      const panel = screen.getByTestId(TEST_IDS.documentPanel);
      expect(panel).not.toHaveClass('select-none');
    });

    it('updates width on mouse move while resizing', async () => {
      const user = userEvent.setup();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: 'doc-123',
        activeDocument: defaultDocument,
        panelWidth: 400,
      });
      render(<DocumentPanel />);

      const handle = screen.getByTestId(TEST_IDS.resizeHandle);

      await user.pointer({ keys: '[MouseLeft>]', target: handle });

      await user.pointer({ coords: { x: 100, y: 100 } });

      expect(screen.getByTestId(TEST_IDS.documentPanel)).toBeInTheDocument();

      await user.pointer({ keys: '[/MouseLeft]' });
    });
  });

  describe('code fence generation', () => {
    it('builds a fence longer than any backtick run in the content, with no language', () => {
      const document_ = createDocument({
        language: '',
        // Two backtick runs (3 then 1): the shorter later run exercises the
        // `current > maxRun` false branch in the fence-length scan.
        content: 'intro ``` middle ` end',
      });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      // The Streamdown mock echoes the fenced string; the source content survives.
      expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toContain(
        'intro ``` middle ` end'
      );
    });
  });

  describe('copy feedback timeout', () => {
    it('resets the copied indicator after the timeout', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(() => Promise.resolve()) },
        configurable: true,
      });
      const document_ = createDocument({ content: 'copy me' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
      });

      // The setTimeout callback flips `copied` back after 2s.
      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
        },
        { timeout: 3000 }
      );
    });
  });

  describe('download without language', () => {
    it('uses a .txt extension when the document has no language', async () => {
      const user = userEvent.setup();
      const document_ = createDocument({ title: 'PlainNotes', language: '', content: 'x' });
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
      globalThis.URL.revokeObjectURL = vi.fn();
      const anchor = { href: '', download: '', click: vi.fn(), style: {} };
      vi.spyOn(document, 'createElement').mockReturnValueOnce(
        anchor as unknown as HTMLAnchorElement
      );

      await user.click(screen.getByRole('button', { name: /download/i }));

      expect(anchor.download).toBe('PlainNotes.txt');
    });
  });

  describe('resize dragging', () => {
    it('updates the panel width while dragging the resize handle', () => {
      const document_ = createDocument();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
      });
      render(<DocumentPanel />);

      fireEvent.mouseDown(screen.getByTestId(TEST_IDS.resizeHandle));
      fireEvent.mouseMove(document, { clientX: 120 });
      fireEvent.mouseUp(document);

      expect(screen.getByTestId(TEST_IDS.documentPanel)).toBeInTheDocument();
    });

    it('exits fullscreen when a resize begins', () => {
      const document_ = createDocument();
      const toggleFullscreen = vi.fn();
      const setPanelWidth = vi.fn();
      useDocumentStore.setState({
        isPanelOpen: true,
        activeDocumentId: document_.id,
        activeDocument: document_,
        isFullscreen: true,
        toggleFullscreen,
        setPanelWidth,
      });
      render(<DocumentPanel />);

      fireEvent.mouseDown(screen.getByTestId(TEST_IDS.resizeHandle));

      expect(toggleFullscreen).toHaveBeenCalled();
    });
  });
});
