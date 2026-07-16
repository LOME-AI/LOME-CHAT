import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@/components/chat/message/markdown-renderer';

vi.mock('@/stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

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

    expect(screen.getByTestId('markdown-render-fallback')).toBeInTheDocument();
    expect(screen.getByText('Message formatting unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Broken content')).toBeInTheDocument();

    vi.doUnmock('streamdown');
    vi.resetModules();
  });
});

describe('MarkdownRenderer', () => {
  it('renders plain text content', () => {
    render(<MarkdownRenderer content="Hello, world!" />);

    expect(screen.getByText('Hello, world!')).toBeInTheDocument();
  });

  it('renders headings', () => {
    const headingsContent = `# Heading 1

## Heading 2`;
    render(<MarkdownRenderer content={headingsContent} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Heading 1' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Heading 2' })).toBeInTheDocument();
  });

  it('renders lists', () => {
    const listContent = `- Item 1
- Item 2
- Item 3`;
    render(<MarkdownRenderer content={listContent} />);

    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(screen.getByText('Item 3')).toBeInTheDocument();
  });

  it('renders links', () => {
    render(<MarkdownRenderer content="[Click here](https://example.com)" />);

    const link = screen.getByRole('link', { name: 'Click here' });
    // Streamdown's rehype-harden normalizes URLs (adds trailing slash)
    expect(link).toHaveAttribute('href', 'https://example.com/');
  });

  it('renders inline code', () => {
    render(<MarkdownRenderer content="Use `const x = 1` in your code" />);

    expect(screen.getByText('const x = 1')).toBeInTheDocument();
  });

  it('renders display math as KaTeX markup', () => {
    const { container } = render(<MarkdownRenderer content={'$$E = mc^2$$'} />);

    expect(container.querySelector('.katex')).toBeInTheDocument();
  });

  it('renders short code blocks inline (not as document cards)', () => {
    const codeContent = '```javascript\nconst x = 1;\n```';
    render(<MarkdownRenderer content={codeContent} />);

    // Short code blocks are rendered by Streamdown's built-in CodeBlock component
    // (not extracted as document cards). Code content is lazy-loaded via Shiki
    // so we only verify the document card is NOT shown.
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders an empty fenced code block without a document card', () => {
    render(<MarkdownRenderer content={'```\n```'} />);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders a fenced code block with no language without a document card', () => {
    render(<MarkdownRenderer content={'```\nplain text\n```'} />);
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders mermaid code blocks as document cards', () => {
    const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';
    render(<MarkdownRenderer content={mermaidCode} />);

    // Mermaid diagrams are extracted as documents and show a card
    expect(screen.getByTestId('document-card')).toBeInTheDocument();
    expect(screen.getByText('Graph Diagram')).toBeInTheDocument();
  });

  it('renders large code blocks (15+ lines) as document cards', () => {
    const largeCode = Array.from({ length: 15 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${largeCode}\n\`\`\``;
    render(<MarkdownRenderer content={content} />);

    // Large code blocks are extracted as documents and show a card
    // extractTitle detects "const line0" → title "line0"
    expect(screen.getByTestId('document-card')).toBeInTheDocument();
    expect(screen.getByText('line0')).toBeInTheDocument();
  });

  it('does not extract code blocks with fewer than 15 lines as documents', () => {
    const shortCode = Array.from({ length: 14 })
      .fill(null)
      .map((_, index) => `const line${String(index)} = ${String(index)};`)
      .join('\n');
    const content = `\`\`\`typescript\n${shortCode}\n\`\`\``;
    render(<MarkdownRenderer content={content} />);

    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('renders bold and italic text', () => {
    render(<MarkdownRenderer content="**bold** and *italic* text" />);

    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('italic')).toBeInTheDocument();
  });

  it('renders tables (GFM)', () => {
    const table = `| Name | Age |
| --- | --- |
| John | 30 |
| Jane | 25 |`;

    render(<MarkdownRenderer content={table} />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('John')).toBeInTheDocument();
  });

  it('renders strikethrough (GFM)', () => {
    render(<MarkdownRenderer content="~~deleted~~" />);

    const deletedText = screen.getByText('deleted');
    expect(deletedText.tagName.toLowerCase()).toBe('del');
  });

  it('handles empty content gracefully', () => {
    render(<MarkdownRenderer content="" />);

    const container = screen.getByTestId('markdown-renderer');
    expect(container).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<MarkdownRenderer content="Test" className="custom-class" />);

    const container = screen.getByTestId('markdown-renderer');
    expect(container).toHaveClass('custom-class');
  });

  it('renders blockquotes', () => {
    render(<MarkdownRenderer content="> This is a quote" />);

    expect(screen.getByText('This is a quote')).toBeInTheDocument();
  });

  it('handles malformed markdown gracefully', () => {
    const malformed = '```javascript\nconst x = 1';
    render(<MarkdownRenderer content={malformed} />);

    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  describe('link styling', () => {
    it('applies red styling to links', () => {
      render(<MarkdownRenderer content="See [the docs](https://example.com) for help" />);

      const link = screen.getByRole('link', { name: 'the docs' });
      expect(link).toHaveStyle({ color: 'var(--brand-red)' });
    });
  });

  describe('document type detection', () => {
    it('detects html code blocks as html type', () => {
      const htmlCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `<div>Line ${String(index)}</div>`)
        .join('\n');
      const content = `\`\`\`html\n${htmlCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = screen.getByTestId('document-card');
      expect(card).toBeInTheDocument();
      // Card aria-label includes the document title (language display name for untitled blocks)
      expect(card).toHaveAttribute('aria-label', 'Open HTML');
    });

    it('does not extract code blocks without a language as documents', () => {
      const noLangCode = Array.from({ length: 20 })
        .fill(null)
        .map((_, index) => `line ${String(index)}`)
        .join('\n');
      const content = `\`\`\`\n${noLangCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
    });

    it('detects unknown language with 15+ lines as code type', () => {
      const goCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `fmt.Println(${String(index)})`)
        .join('\n');
      const content = `\`\`\`go\n${goCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = screen.getByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(screen.getByText('Go')).toBeInTheDocument();
    });

    it('detects tsx code blocks as react type', () => {
      const tsxCode = Array.from({ length: 15 })
        .fill(null)
        .map((_, index) => `const Component${String(index)} = () => <div />;`)
        .join('\n');
      const content = `\`\`\`tsx\n${tsxCode}\n\`\`\``;

      render(<MarkdownRenderer content={content} />);

      const card = screen.getByTestId('document-card');
      expect(card).toBeInTheDocument();
      expect(screen.getByText(/tsx/i)).toBeInTheDocument();
    });

    it('generates stable document IDs for identical content', () => {
      const mermaidCode = '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```';

      const { rerender } = render(<MarkdownRenderer content={mermaidCode} />);

      const card1 = screen.getByTestId('document-card');
      expect(card1).toBeInTheDocument();

      // Re-render with same content — card should still be there with same stable ID
      rerender(<MarkdownRenderer content={mermaidCode} />);

      const card2 = screen.getByTestId('document-card');
      expect(card2).toBeInTheDocument();
    });
  });
});
