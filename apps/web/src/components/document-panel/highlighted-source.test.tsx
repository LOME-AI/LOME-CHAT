import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { HighlightedSource } from './highlighted-source';

// Shiki lazy-loads through React.lazy() inside Streamdown, so nothing it
// highlights is visible in a synchronous test. The stub echoes the fenced block
// it was handed, which is the part this module builds.
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <pre>{children}</pre>,
}));

describe('HighlightedSource', () => {
  it('hands the source to the highlighter under its language', () => {
    render(<HighlightedSource content="print('hi')" language="python" />);

    expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toBe(
      "```python\nprint('hi')\n```"
    );
  });

  it('opens a fence longer than the longest backtick run in the source', () => {
    render(<HighlightedSource content="a ``` b" language="md" />);

    expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toBe('````md\na ``` b\n````');
  });

  it('leaves the fence bare when the source states no language', () => {
    render(<HighlightedSource content="plain" language={undefined} />);

    expect(screen.getByTestId(TEST_IDS.highlightedCode).textContent).toBe('```\nplain\n```');
  });
});
