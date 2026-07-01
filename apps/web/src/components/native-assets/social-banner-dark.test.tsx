import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { SocialBannerDark } from './social-banner-dark';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: () => <canvas data-testid="cipher-wall" />,
  };
});

describe('SocialBannerDark', () => {
  it('renders the dark social banner variant', () => {
    render(<SocialBannerDark />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('dark'))).toBeInTheDocument();
  });
});
