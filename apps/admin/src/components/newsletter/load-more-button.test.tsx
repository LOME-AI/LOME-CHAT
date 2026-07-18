import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoadMoreButton } from './load-more-button.js';

describe('LoadMoreButton', () => {
  it('renders nothing on the last page', () => {
    render(
      <LoadMoreButton testId="pager" hasNextPage={false} pending={false} onLoadMore={vi.fn()} />
    );
    expect(screen.queryByTestId('pager')).not.toBeInTheDocument();
  });

  it('requests the next page on click', async () => {
    const onLoadMore = vi.fn();
    render(<LoadMoreButton testId="pager" hasNextPage pending={false} onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByTestId('pager'));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('disables while a page is in flight', () => {
    render(<LoadMoreButton testId="pager" hasNextPage pending onLoadMore={vi.fn()} />);
    expect(screen.getByTestId('pager')).toBeDisabled();
  });
});
