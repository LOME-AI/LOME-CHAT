import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BlogSearch, type BlogIndexEntry } from './BlogSearch';

const ALL_TAGS: readonly string[] = ['ai-models', 'privacy', 'security'];
const TAG_COUNTS: Readonly<Record<string, number>> = {
  'ai-models': 2,
  privacy: 3,
  security: 2,
};

const INDEX: readonly BlogIndexEntry[] = [
  {
    slug: 'encrypted-by-default',
    title: 'Encrypted By Default',
    description: 'How we encrypt.',
    tags: ['privacy'],
  },
  {
    slug: 'pick-any-model',
    title: 'Pick Any Model',
    description: 'Switch models mid-thread.',
    tags: ['ai-models'],
  },
  {
    slug: 'zero-knowledge-auth',
    title: 'Zero Knowledge Auth',
    description: 'OPAQUE explained.',
    tags: ['security'],
  },
];

function stubIndexFetch(entries: readonly BlogIndexEntry[] = INDEX): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: (): Promise<readonly BlogIndexEntry[]> => Promise.resolve(entries),
    })
  );
}

function mountBlogCards(cards: readonly { id: string; tags: readonly string[] }[]): HTMLDivElement {
  const container = document.createElement('div');
  for (const card of cards) {
    const article = document.createElement('a');
    article.dataset.blogCard = '';
    article.dataset.tags = card.tags.join(',');
    article.dataset.testid = `card-${card.id}`;
    article.textContent = card.id;
    container.append(article);
  }
  document.body.append(container);
  return container;
}

function setUrl(search: string): void {
  globalThis.history.replaceState({}, '', `/blog${search}`);
}

beforeEach(() => {
  document.body.innerHTML = '';
  globalThis.history.replaceState({}, '', '/blog');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BlogSearch tag chips', () => {
  it('renders an "All" chip plus one chip per tag', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toBeInTheDocument();
    for (const tag of ALL_TAGS) {
      expect(screen.getByRole('link', { name: tag })).toBeInTheDocument();
    }
  });

  it('marks the "All" chip active when no ?tag is present', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'privacy' })).not.toHaveAttribute(
      'aria-current',
      'true'
    );
  });
});

describe('BlogSearch URL ↔ state sync', () => {
  it('reads activeTag from ?tag query on mount and marks that chip active', async () => {
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(await screen.findByRole('link', { name: 'privacy' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('link', { name: 'All' })).not.toHaveAttribute('aria-current', 'true');
  });

  it('updates the URL with ?tag= when a tag chip is clicked (without navigating)', async () => {
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    await user.click(screen.getByRole('link', { name: 'privacy' }));
    expect(globalThis.location.pathname + globalThis.location.search).toBe('/blog?tag=privacy');
  });

  it('clears the URL ?tag= when the "All" chip is clicked', async () => {
    setUrl('?tag=privacy');
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    await user.click(screen.getByRole('link', { name: 'All' }));
    expect(globalThis.location.pathname + globalThis.location.search).toBe('/blog');
  });

  it('updates state when popstate fires (back/forward navigation)', async () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');

    act(() => {
      globalThis.history.pushState({}, '', '/blog?tag=security');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByRole('link', { name: 'security' })).toHaveAttribute(
      'aria-current',
      'true'
    );
  });
});

describe('BlogSearch DOM filtering of [data-blog-card]', () => {
  it('keeps all cards visible when no tag is active', () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
      { id: 'c', tags: ['privacy', 'security'] },
    ]);
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-c')).not.toHaveAttribute('hidden');
  });

  it('hides cards whose data-tags do not include the active tag', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
      { id: 'c', tags: ['privacy', 'security'] },
    ]);
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await screen.findByRole('link', { name: 'privacy' });

    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).toHaveAttribute('hidden');
    expect(screen.getByTestId('card-c')).not.toHaveAttribute('hidden');
  });

  it('restores all cards when "All" is clicked after a filter', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
    ]);
    setUrl('?tag=privacy');
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await user.click(screen.getByRole('link', { name: 'All' }));

    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
  });

  it('toggles visibility when switching from one tag to another', async () => {
    mountBlogCards([
      { id: 'a', tags: ['privacy'] },
      { id: 'b', tags: ['ai-models'] },
    ]);
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await user.click(screen.getByRole('link', { name: 'privacy' }));
    expect(screen.getByTestId('card-a')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).toHaveAttribute('hidden');

    await user.click(screen.getByRole('link', { name: 'ai-models' }));
    expect(screen.getByTestId('card-a')).toHaveAttribute('hidden');
    expect(screen.getByTestId('card-b')).not.toHaveAttribute('hidden');
  });
});

describe('BlogSearch "Posts tagged" line', () => {
  it('is absent when no tag is active', () => {
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    expect(screen.queryByText(/Posts tagged:/)).not.toBeInTheDocument();
  });

  it('shows the active tag name and post count when filtered', async () => {
    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);
    const line = await screen.findByText(/Posts tagged:/);
    expect(line).toHaveTextContent('privacy');
    expect(line).toHaveTextContent('3 posts');
  });

  it('uses singular "post" for a tag with exactly one match', async () => {
    setUrl('?tag=solo');
    render(<BlogSearch allTags={['solo']} tagCounts={{ solo: 1 }} />);
    const line = await screen.findByText(/Posts tagged:/);
    expect(line).toHaveTextContent('1 post');
    expect(line).not.toHaveTextContent('1 posts');
  });
});

describe('BlogSearch combobox accessibility', () => {
  it('exposes the input as a combobox controlling a labelled listbox', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');

    await user.type(combobox, 'model');

    const listbox = await screen.findByRole('listbox');
    expect(combobox).toHaveAttribute('aria-expanded', 'true');
    expect(combobox).toHaveAttribute('aria-controls', listbox.id);
    expect(within(listbox).getAllByRole('option')).toHaveLength(1);
  });

  it('moves the active option down with ArrowDown and up with ArrowUp', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'a');
    await screen.findByRole('listbox');

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);

    await user.keyboard('{ArrowDown}');
    expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    expect(combobox).toHaveAttribute('aria-activedescendant', options[1].id);

    await user.keyboard('{ArrowUp}');
    expect(combobox).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates to the active option href when Enter is pressed', async () => {
    stubIndexFetch();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, search: '', pathname: '/blog' });
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'model');
    await screen.findByRole('listbox');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    expect(assign).toHaveBeenCalledWith('/blog/pick-any-model');
  });

  it('dismisses the listbox when Escape is pressed', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'model');
    await screen.findByRole('listbox');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the listbox and clears results when the query is emptied', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'model');
    await screen.findByRole('listbox');

    await user.clear(combobox);

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
  });

  it('announces the result count in a polite live region', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');

    await user.type(screen.getByRole('combobox', { name: /search articles/i }), 'model');
    await screen.findByRole('listbox');

    await waitFor(() => {
      expect(status).toHaveTextContent('1 result');
    });
  });

  it('wraps to the last option when ArrowUp is pressed with no active option', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'a');
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    const lastOption = options.at(-1);
    if (!lastOption) throw new Error('expected at least one option');

    await user.keyboard('{ArrowUp}');
    expect(combobox).toHaveAttribute('aria-activedescendant', lastOption.id);
  });

  it('does nothing on Enter when no option is active', async () => {
    stubIndexFetch();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, search: '', pathname: '/blog' });
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'model');
    await screen.findByRole('listbox');

    await user.keyboard('{Enter}');

    expect(assign).not.toHaveBeenCalled();
  });

  it('reopens the listbox on focus when results already exist', async () => {
    stubIndexFetch();
    const user = userEvent.setup();
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    const combobox = screen.getByRole('combobox', { name: /search articles/i });
    await user.type(combobox, 'model');
    await screen.findByRole('listbox');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    combobox.blur();
    await user.click(combobox);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('treats a card with no data-tags as untagged when a tag is active', async () => {
    const container = document.createElement('div');
    const untagged = document.createElement('a');
    untagged.dataset.blogCard = '';
    untagged.dataset.testid = 'card-untagged';
    untagged.textContent = 'untagged';
    container.append(untagged);
    document.body.append(container);

    setUrl('?tag=privacy');
    render(<BlogSearch allTags={[...ALL_TAGS]} tagCounts={TAG_COUNTS} />);

    await screen.findByRole('link', { name: 'privacy' });
    expect(screen.getByTestId('card-untagged')).toHaveAttribute('hidden');
  });

  it('shows a zero count for an active tag missing from tagCounts', async () => {
    setUrl('?tag=orphan');
    render(<BlogSearch allTags={['orphan']} tagCounts={{}} />);
    const line = await screen.findByText(/Posts tagged:/);
    expect(line).toHaveTextContent('0 posts');
  });
});
