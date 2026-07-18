import * as React from 'react';
import { Button } from '@hushbox/ui';

/** The keyset pager under a dense table; renders nothing on the last page. */
export function LoadMoreButton({
  testId,
  hasNextPage,
  pending,
  onLoadMore,
}: Readonly<{
  testId: string;
  hasNextPage: boolean;
  pending: boolean;
  onLoadMore: () => void;
}>): React.JSX.Element | null {
  if (!hasNextPage) {
    return null;
  }
  return (
    <div>
      <Button
        data-testid={testId}
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onLoadMore}
      >
        Load more
      </Button>
    </div>
  );
}
