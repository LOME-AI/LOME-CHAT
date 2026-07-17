import { render, screen, act } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TableOfContents, type Heading } from './TableOfContents';

let observeMock: ReturnType<typeof vi.fn>;
let disconnectMock: ReturnType<typeof vi.fn>;
let observerCallback: IntersectionObserverCallback;

beforeEach(() => {
  document.body.innerHTML = '';
  observeMock = vi.fn();
  disconnectMock = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    vi.fn(function MockIntersectionObserver(callback: IntersectionObserverCallback) {
      observerCallback = callback;
      return { observe: observeMock, disconnect: disconnectMock, unobserve: vi.fn() };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function addHeadingElements(slugs: readonly string[]): void {
  for (const slug of slugs) {
    const el = document.createElement('h2');
    el.id = slug;
    document.body.append(el);
  }
}

const H2 = (slug: string, text: string): Heading => ({ depth: 2, slug, text });

describe('TableOfContents', () => {
  it('renders nothing when there are no depth-2 or depth-3 headings', () => {
    const { container } = render(
      <TableOfContents headings={[{ depth: 1, slug: 'title', text: 'Title' }]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one link per depth-2/3 heading and skips other depths', () => {
    render(
      <TableOfContents
        headings={[
          { depth: 1, slug: 'title', text: 'Title' },
          { depth: 2, slug: 'intro', text: 'Intro' },
          { depth: 3, slug: 'detail', text: 'Detail' },
          { depth: 4, slug: 'aside', text: 'Aside' },
        ]}
      />
    );
    expect(screen.getByRole('link', { name: 'Intro' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Detail' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Aside' })).not.toBeInTheDocument();
  });

  it('indents depth-3 headings but not depth-2 headings', () => {
    render(
      <TableOfContents
        headings={[H2('intro', 'Intro'), { depth: 3, slug: 'detail', text: 'Detail' }]}
      />
    );
    expect(screen.getByRole('link', { name: 'Intro' })).not.toHaveClass('pl-3');
    expect(screen.getByRole('link', { name: 'Detail' })).toHaveClass('pl-3');
  });

  it('observes only headings whose target element exists in the DOM', () => {
    addHeadingElements(['intro']);
    render(<TableOfContents headings={[H2('intro', 'Intro'), H2('missing', 'Missing')]} />);
    // 'intro' resolves to an element and is observed; 'missing' has no element.
    expect(observeMock).toHaveBeenCalledTimes(1);
  });

  it('marks the intersecting heading active', () => {
    addHeadingElements(['intro', 'usage']);
    render(<TableOfContents headings={[H2('intro', 'Intro'), H2('usage', 'Usage')]} />);

    act(() => {
      observerCallback(
        [{ isIntersecting: true, target: { id: 'usage' } } as unknown as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByRole('link', { name: 'Usage' })).toHaveClass('text-brand-red');
    expect(screen.getByRole('link', { name: 'Intro' })).not.toHaveClass('text-brand-red');
  });

  it('ignores entries that are not intersecting', () => {
    addHeadingElements(['intro']);
    render(<TableOfContents headings={[H2('intro', 'Intro')]} />);

    act(() => {
      observerCallback(
        [
          {
            isIntersecting: false,
            target: { id: 'intro' },
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver
      );
    });

    expect(screen.getByRole('link', { name: 'Intro' })).not.toHaveClass('text-brand-red');
  });

  it('sets the active heading via click', async () => {
    const user = userEvent.setup();
    render(<TableOfContents headings={[H2('intro', 'Intro'), H2('usage', 'Usage')]} />);

    await user.click(screen.getByRole('link', { name: 'Usage' }));

    expect(screen.getByRole('link', { name: 'Usage' })).toHaveClass('text-brand-red');
  });

  it('activates the last heading when the reader scrolls to the bottom', () => {
    render(<TableOfContents headings={[H2('intro', 'Intro'), H2('usage', 'Usage')]} />);

    act(() => {
      globalThis.dispatchEvent(new Event('scroll'));
    });

    expect(screen.getByRole('link', { name: 'Usage' })).toHaveClass('text-brand-red');
  });

  it('does not force-activate the last heading when scrolling mid-page', () => {
    // A tall body with a small viewport keeps innerHeight + scrollY below the
    // bottom threshold, so the scroll handler leaves the active heading alone.
    Object.defineProperty(document.body, 'offsetHeight', { configurable: true, value: 5000 });
    vi.stubGlobal('innerHeight', 400);
    try {
      render(<TableOfContents headings={[H2('intro', 'Intro'), H2('usage', 'Usage')]} />);
      act(() => {
        globalThis.dispatchEvent(new Event('scroll'));
      });
      expect(screen.getByRole('link', { name: 'Usage' })).not.toHaveClass('text-brand-red');
    } finally {
      Reflect.deleteProperty(document.body, 'offsetHeight');
    }
  });

  it('disconnects the observer on unmount', () => {
    addHeadingElements(['intro']);
    const { unmount } = render(<TableOfContents headings={[H2('intro', 'Intro')]} />);
    unmount();
    expect(disconnectMock).toHaveBeenCalled();
  });
});
