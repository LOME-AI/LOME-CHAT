import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { OverlayDialog } from './overlay-dialog';

describe('OverlayDialog', () => {
  it('caps its own height and scrolls internally so actions stay reachable', () => {
    render(
      <OverlayDialog open={true} onOpenChange={() => {}} ariaLabel="Test overlay">
        <p>Child</p>
      </OverlayDialog>
    );

    const content = screen.getByTestId(TEST_IDS.overlayContent);
    expect(content).toHaveClass('max-h-[calc(100dvh-2rem)]');
    expect(content).toHaveClass('overflow-y-auto');
  });
});
