// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { SplashScreen } from './splash-screen';

mockLogoImport();

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (props: Record<string, unknown>) => (
      <canvas data-testid="cipher-wall" data-props={JSON.stringify(props)} />
    ),
  };
});

const VARIANT_CONFIG = {
  dark: { background: '#0a0a0a', foreground: '#fafafa' },
  light: { background: '#ffffff', foreground: '#0a0a0a' },
} as const;

describe('SplashScreen', () => {
  it.each(['dark', 'light'] as const)(
    'renders container with data-testid for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.splash(variant))).toBeInTheDocument();
    }
  );

  it.each(['dark', 'light'] as const)('fills the viewport for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(TEST_ID_BUILDERS.splash(variant));
    expect(container).toHaveStyle({ width: '100vw', height: '100vh' });
  });

  it.each(['dark', 'light'] as const)('uses correct background color for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(TEST_ID_BUILDERS.splash(variant));
    expect(container).toHaveStyle({ backgroundColor: VARIANT_CONFIG[variant].background });
  });

  it.each(['dark', 'light'] as const)('uses relative positioning for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(TEST_ID_BUILDERS.splash(variant));
    expect(container).toHaveStyle({ position: 'relative' });
  });

  it.each(['dark', 'light'] as const)('renders a CipherWall canvas for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    expect(screen.getByTestId(TEST_IDS.cipherWall)).toBeInTheDocument();
  });

  it.each(['dark', 'light'] as const)(
    'wraps CipherWall with scale but no opacity for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      const canvas = screen.getByTestId(TEST_IDS.cipherWall);
      const wrapper = canvas.parentElement!;
      expect(wrapper).toHaveStyle({ transform: 'scale(1.5)' });
      expect(wrapper.style.opacity).toBe('');
    }
  );

  it.each(['dark', 'light'] as const)('renders the logo image for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
  });

  it.each(['dark', 'light'] as const)(
    'renders the HushBox brand text for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByText('Hush')).toBeInTheDocument();
      expect(screen.getByText('Box')).toBeInTheDocument();
    }
  );

  it.each(['dark', 'light'] as const)(
    'renders Hush in correct foreground color for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByText('Hush')).toHaveStyle({ color: VARIANT_CONFIG[variant].foreground });
    }
  );

  it.each(['dark', 'light'] as const)('renders Box in brand-red for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    expect(screen.getByText('Box')).toHaveStyle({ color: '#ec4755' });
  });

  it('passes frozen + the 4 splash messages to CipherWall', () => {
    render(<SplashScreen variant="dark" />);
    const canvas = screen.getByTestId(TEST_IDS.cipherWall);
    const props = JSON.parse(canvas.dataset['props']!);
    expect(props).toMatchObject({
      frozen: true,
      cipherOpacity: 0.5,
      messages: [
        'Encrypted By Default',
        'Every Model, One Place',
        'Private Group Chats',
        'No Subscriptions Required',
      ],
    });
  });
});
