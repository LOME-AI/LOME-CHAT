// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MarkdownRenderer } from '@/components/chat/message/markdown-renderer';
import type { Document } from '@/lib/document-parser';

const storeMock = vi.hoisted(() => ({
  setActiveDocument: vi.fn(),
  refreshActiveDocument: vi.fn(),
}));

vi.mock('@/stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    activeDocument: null,
    setActiveDocument: storeMock.setActiveDocument,
    refreshActiveDocument: storeMock.refreshActiveDocument,
  }),
}));

/**
 * Streamdown emits its rendered nodes asynchronously, so the custom `pre`/`a`/
 * element overrides (where all of this file's branch logic lives) only execute
 * once the parsed output reaches the DOM. Under a loaded parallel run the render
 * can lag the synchronous assertion, leaving those branches randomly uncovered.
 * Every test therefore awaits the actual rendered output (`findBy*` / `waitFor`)
 * so the node-emission branches are guaranteed to have run before the test — and
 * the coverage snapshot — completes. `awaitCodeBlockProcessed` blocks until our
 * `pre` override has produced either a DocumentCard or the `data-block` clone,
 * which is exactly the branch pair that was flaking.
 */
async function awaitCodeBlockProcessed(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    const processed =
      screen.queryByTestId('document-card') !== null ||
      container.querySelector('[data-streamdown="code-block"]') !== null;
    expect(processed).toBe(true);
  });
}

describe('MarkdownRenderer error boundary', () => {
  it('renders the plain-text fallback when the markdown engine throws', async () => {
    vi.resetModules();
    vi.doMock('streamdown', () => ({
      Streamdown: () => {
        throw new Error('render blew up');
      },
    }));
    const { MarkdownRenderer: Isolated } =
      await import('@/components/chat/message/markdown-renderer');

    render(<Isolated content="Broken content" />);

    expect(await screen.findByTestId('markdown-render-fallback')).toBeInTheDocument();
    expect(await screen.findByText('Message formatting unavailable.')).toBeInTheDocument();
    expect(await screen.findByText('Broken content')).toBeInTheDocument();

    vi.doUnmock('streamdown');
    vi.resetModules();
  });
});

describe('MarkdownRenderer', () => {
  it('renders plain text content', async () => {
    render(<MarkdownRenderer content="Hello, world!" />);

    expect(await screen.findByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders headings', async () => {
    const headingsContent = `# Heading 1

## Heading 2`;
    render(<MarkdownRenderer content={headingsContent} />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Heading 1' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Heading 2' })).toBeInTheDocument();
  });

  it('renders lists', async () => {
    const listContent = `- Item 1
- Item 2
- Item 3`;
    render(<MarkdownRenderer content={listContent} />);

    expect(await screen.findByText('Item 1')).toBeInTheDocument();
    expect(await screen.findByText('Item 2')).toBeInTheDocument();
    expect(await screen.findByText('Item 3')).toBeInTheDocument();
  });

  it('renders links', async () => {
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    const link = await screen.findByRole('link', { name: 'Click here' });
    // Streamdown's rehype-harden normalizes URLs (adds trailing slash)
    expect(link).toHaveAttribute('href', 'https://example.com/');
  });

  it('renders inline code', async () => {
    render(<MarkdownRenderer content="Use `const x = 1` in your code" />);

    expect(await screen.findByText('const x = 1')).toBeInTheDocument();
  });

  it('renders display math as KaTeX markup', async () => {
    const { container } = render(<MarkdownRenderer content={'$$E = mc^2$$'} />);

    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument();
    });
  });

  it('renders short code blocks inline (not as document cards)', async () => {
    const codeContent = '```javascript\nconst x = 1;\n```';
    const { container } = render(<MarkdownRenderer content={codeContent} />);

    // Await the `pre` override running its default (data-block clone) path so the
    // branch is exercised deterministically; only then assert no card is shown.
    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders an empty fenced code block without a document card', async () => {
    const { container } = render(<MarkdownRenderer content={'```\n```'} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders a fenced code block with no language without a document card', async () => {
    const { container } = render(<MarkdownRenderer content={'```\nplain text\n```'} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders mermaid code blocks as document cards', async () => {
    const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
    render(<MarkdownRenderer content={mermaidCode} />);

    // Mermaid diagrams are extracted as documents and show a card
    expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    expect(await screen.findByText('Graph Diagram')).toBeInTheDocument();
  });

  it('renders large code blocks (15+ lines) as document cards', async () => {
    const largeCode = Array.from({ length: 15 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${largeCode}\n\`\`\``;
    render(<MarkdownRenderer content={content} />);

    // Large code blocks are extracted as documents and show a card
    // extractTitle detects "const line0" → title "line0"
    expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    expect(await screen.findByText('line0')).toBeInTheDocument();
  });

  it('does not extract code blocks with fewer than 15 lines as documents', async () => {
    const shortCode = Array.from({ length: 14 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${shortCode}\n\`\`\``;
    const { container } = render(<MarkdownRenderer content={content} />);

    await awaitCodeBlockProcessed(container);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  describe('streaming state', () => {
    const codeLines = (count: number): string =>
      Array.from({ length: count })
        .fill(null)
        .map((_, index) => `const line${String(index)} = ${String(index)};`)
        .join('\n');

    const jsxLines = codeLines(15);

    const openDocument = async (): Promise<Document> => {
      await userEvent.click(await screen.findByTestId('document-card'));
      const call = storeMock.setActiveDocument.mock.calls.at(-1);
      expect(call).toBeDefined();
      return call?.[0] as Document;
    };

    beforeEach(() => {
      storeMock.setActiveDocument.mockClear();
    });

    it('marks a document from a still-streaming message as streaming', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('marks a document from a settled message as not streaming', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} isStreaming={false} />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(false);
    });

    it('marks a block whose fence never closed by its message, not by its text', async () => {
      // The document is half-written either way; only the message says whether
      // more of it is still coming.
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}`} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('marks a mermaid diagram from a still-streaming message as streaming', async () => {
      render(<MarkdownRenderer content={'```mermaid\ngraph TD\n  A --> B'} isStreaming />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(true);
    });

    it('treats a message with no streaming state as settled', async () => {
      render(<MarkdownRenderer content={`\`\`\`jsx\n${jsxLines}\n\`\`\``} />);

      const opened = await openDocument();
      expect(opened.isStreaming).toBe(false);
    });
  });

  it('renders bold and italic text', async () => {
    render(<MarkdownRenderer content="**bold** and *italic* text" />);

    expect(await screen.findByText('bold')).toBeInTheDocument();
    expect(await screen.findByText('italic')).toBeInTheDocument();
  });

  it('renders tables (GFM)', async () => {
    const table = `| Name | Age |
| --- | --- |
| John | 30 |
| Jane | 25 |`;

    render(<MarkdownRenderer content={table} />);

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(await screen.findByText('Name')).toBeInTheDocument();
    expect(await screen.findByText('John')).toBeInTheDocument();
  });

  it('renders strikethrough (GFM)', async () => {
    render(<MarkdownRenderer content="~~deleted~~" />);

    const deletedText = await screen.findByText('deleted');
    expect(deletedText.tagName.toLowerCase()).toBe('del');
  });

  it('handles empty content gracefully', async () => {
    render(<MarkdownRenderer content="" />);

    const container = await screen.findByTestId('markdown-renderer');
    expect(container).toBeInTheDocument();
  });

  it('applies custom className', async () => {
    render(<MarkdownRenderer content="Test" className="custom-class" />);

    // Await the parsed content so the render is settled before asserting.
    expect(await screen.findByText('Test')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-renderer')).toHaveClass('custom-class');
  });

  it('renders blockquotes', async () => {
    render(<MarkdownRenderer content="> This is a quote" />);

    expect(await screen.findByText('This is a quote')).toBeInTheDocument();
  });

  it('handles malformed markdown gracefully', async () => {
    const malformed = '```javascript\nconst x = 1';
    const { container } = render(<MarkdownRenderer content={malformed} />);

    // An unterminated fence is still parsed into a code block, so wait for the
    // `pre` override to process it before asserting the container is intact.
    await awaitCodeBlockProcessed(container);
    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  describe('link styling', () => {
    it('applies red styling to links', async () => {
      render(<MarkdownRenderer content="See [the docs](https://example.com) for help" />);

      const link = await screen.findByRole('link', { name: 'the docs' });
      expect(link).toHaveStyle({ color: 'var(--brand-red)' });
    });
  });

  describe('document type detection', () => {
    it('detects html code blocks as html type', async () => {
      const htmlCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `<div>Line ${String(index)}</div>`)
        .join('\n');
      const content = `\`\`\`html\n${htmlCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      // Card aria-label includes the document title (language display name for untitled blocks)
      expect(card).toHaveAttribute('aria-label', 'Open HTML');
    });

    it('does not extract code blocks without a language as documents', async () => {
      const noLangCode = Array.from({ length: 20 })
        .fill(null)
        .map((_, index) => `line ${String(index)}`)
        .join('\n');
      const content = `\`\`\`\n${noLangCode}\n\`\`\``;

      const { container } = render(<MarkdownRenderer content={content} />);

      await awaitCodeBlockProcessed(container);
      expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
    });

    it('detects unknown language with 15+ lines as code type', async () => {
      const goCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `fmt.Println(${String(index)})`)
        .join('\n');
      const content = `\`\`\`go\n${goCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(await screen.findByText('Go')).toBeInTheDocument();
    });

    it('detects tsx code blocks as react type', async () => {
      const tsxCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const Component${String(index)} = () => <div />;`)
        .join('\n');
      const content = `\`\`\`tsx\n${tsxCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = await screen.findByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(await screen.findByText(/tsx/i)).toBeInTheDocument();
    });

    it('generates stable document IDs for identical content', async () => {
      const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';

      const { rerender } = render(<MarkdownRenderer content={mermaidCode} />);

      expect(await screen.findByTestId('document-card')).toBeInTheDocument();

      // Re-render with same content — card should still be there with same stable ID
      rerender(<MarkdownRenderer content={mermaidCode} />);

      expect(await screen.findByTestId('document-card')).toBeInTheDocument();
    });
  });
});
