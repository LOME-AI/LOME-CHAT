import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PRIVACY_SECTIONS } from '@hushbox/shared/legal';
import { PrivacyDocument } from './PrivacyDocument';

describe('PrivacyDocument', () => {
  it('renders the privacy section titles from shared content', () => {
    render(<PrivacyDocument />);
    for (const section of PRIVACY_SECTIONS) {
      expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
    }
  });

  it('renders the data-collection nutrition label footnotes', () => {
    render(<PrivacyDocument />);
    expect(screen.getByText(/Sent to AI providers pseudonymously/)).toBeInTheDocument();
    expect(screen.getByText(/Handled entirely by payment processor/)).toBeInTheDocument();
  });

  it('renders the encryption-security data flow and live demo', () => {
    render(<PrivacyDocument />);
    expect(screen.getByText('How your data flows through HushBox')).toBeInTheDocument();
    expect(screen.getByText('See it for yourself')).toBeInTheDocument();
    expect(screen.getByText('How we compare')).toBeInTheDocument();
  });
});
