import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CrossPortNav } from './cross-port-nav';

describe('CrossPortNav', () => {
  it('links "Back to /chat" to the web origin when one is present', () => {
    render(<CrossPortNav webOrigin="http://localhost:5173" inspectedUrl="" />);

    const link = screen.getByRole('link', { name: /back to \/chat/i });
    expect(link).toHaveAttribute('href', 'http://localhost:5173/chat');
    expect(link).not.toHaveAttribute('target');
  });

  it('disables "Back to /chat" when no web origin is available', () => {
    render(<CrossPortNav webOrigin={undefined} inspectedUrl="https://example.com" />);

    expect(screen.queryByRole('link', { name: /back to \/chat/i })).toBeNull();
    expect(screen.getByRole('button', { name: /back to \/chat/i })).toBeDisabled();
  });

  it('disables "Open inspected page" when no URL has been analyzed', () => {
    render(<CrossPortNav webOrigin="http://localhost:5173" inspectedUrl="" />);

    expect(screen.queryByRole('link', { name: /open inspected page/i })).toBeNull();
    expect(screen.getByRole('button', { name: /open inspected page/i })).toBeDisabled();
  });

  it('opens the inspected page in a new tab when a URL is present', () => {
    render(
      <CrossPortNav webOrigin="http://localhost:5173" inspectedUrl="https://example.com/page" />
    );

    const link = screen.getByRole('link', { name: /open inspected page/i });
    expect(link).toHaveAttribute('href', 'https://example.com/page');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');
  });
});
