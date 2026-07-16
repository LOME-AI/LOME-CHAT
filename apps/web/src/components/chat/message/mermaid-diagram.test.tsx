import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MermaidDiagram } from '@/components/chat/message/mermaid-diagram';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

let mockThemeMode: 'light' | 'dark' = 'light';
vi.mock('@/providers/theme-provider', () => ({
  useTheme: () => ({ mode: mockThemeMode, triggerTransition: vi.fn() }),
}));

import mermaid from 'mermaid';

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThemeMode = 'light';
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: '<svg data-testid="mermaid-svg"><text>Diagram</text></svg>',
      bindFunctions: vi.fn(),
      diagramType: 'flowchart',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders mermaid diagram from chart definition', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
    });
  });

  it('calls mermaid.render with chart definition', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalled();
    });

    const renderCalls = vi.mocked(mermaid.render).mock.calls;
    expect(renderCalls[0]?.[1]).toBe(chart);
  });

  it('displays rendered SVG content', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container.innerHTML).toContain('svg');
    });
  });

  it('shows error message for invalid diagram syntax', async () => {
    vi.mocked(mermaid.render).mockRejectedValue(new Error('Parse error'));

    const invalidChart = 'invalid mermaid syntax !!!';

    render(<MermaidDiagram chart={invalidChart} />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
  });

  it('applies custom className', async () => {
    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} className="custom-class" />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container).toHaveClass('custom-class');
    });
  });

  it('shows loading state while rendering', () => {
    vi.mocked(mermaid.render).mockImplementation(() => new Promise(() => {}));

    const chart = `graph TD
      A[Start] --> B[End]`;

    render(<MermaidDiagram chart={chart} />);

    expect(screen.getByTestId('mermaid-loading')).toBeInTheDocument();
  });

  it('initializes mermaid with the light theme in light mode', async () => {
    mockThemeMode = 'light';
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ theme: 'default' });
  });

  it('initializes mermaid with the dark theme in dark mode', async () => {
    mockThemeMode = 'dark';
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ theme: 'dark' });
  });

  it('keeps securityLevel strict to mitigate XSS', async () => {
    const chart = 'graph TD\n  A --> B';

    render(<MermaidDiagram chart={chart} />);

    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenCalled();
    });
    const initCalls = vi.mocked(mermaid.initialize).mock.calls;
    expect(initCalls.at(-1)?.[0]).toMatchObject({ securityLevel: 'strict' });
  });

  it('falls back to a generic message when a non-Error value is thrown', async () => {
    vi.mocked(mermaid.render).mockRejectedValue('boom');

    render(<MermaidDiagram chart="graph TD\n A --> B" />);

    await waitFor(() => {
      expect(screen.getByText(/could not render this diagram/i)).toBeInTheDocument();
    });
  });

  it('renders an empty diagram container when mermaid resolves without svg', async () => {
    vi.mocked(mermaid.render).mockResolvedValue({
      svg: undefined as unknown as string,
      bindFunctions: vi.fn(),
      diagramType: 'flowchart',
    });

    render(<MermaidDiagram chart="graph TD\n A --> B" />);

    await waitFor(() => {
      const container = screen.getByTestId('mermaid-diagram');
      expect(container).toBeInTheDocument();
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('ignores a successful render that resolves after unmount', async () => {
    let resolveRender: ((value: { svg: string }) => void) | undefined;
    vi.mocked(mermaid.render).mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve as (value: { svg: string }) => void;
      })
    );

    const { unmount } = render(<MermaidDiagram chart="graph TD\n A --> B" />);
    unmount();
    resolveRender?.({ svg: '<svg></svg>' });

    // The mounted guard must skip state updates, leaving nothing rendered.
    await Promise.resolve();
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  it('ignores a failed render that rejects after unmount', async () => {
    let rejectRender: ((reason: unknown) => void) | undefined;
    vi.mocked(mermaid.render).mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRender = reject;
      })
    );

    const { unmount } = render(<MermaidDiagram chart="graph TD\n A --> B" />);
    unmount();
    rejectRender?.(new Error('late failure'));

    await Promise.resolve();
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });
});
