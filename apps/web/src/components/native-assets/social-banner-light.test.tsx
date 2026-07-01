import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { SocialBannerLight } from './social-banner-light';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: () => <canvas data-testid="cipher-wall" />,
  };
});

describe('SocialBannerLight', () => {
  it('renders the light social banner variant', () => {
    render(<SocialBannerLight />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('light'))).toBeInTheDocument();
  });
});
