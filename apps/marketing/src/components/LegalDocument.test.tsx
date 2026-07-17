import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { LegalSection, LegalDocumentMeta } from '@hushbox/shared/legal';
import { LegalDocument } from './LegalDocument';

const META: LegalDocumentMeta = {
  title: 'Privacy Policy',
  effectiveDate: '2026-01-01',
  contactEmail: 'legal@hushbox.ai',
};

const SECTIONS: LegalSection[] = [
  {
    id: 'data-collection',
    title: 'Data Collection',
    simplyPut: 'We collect very little.',
    points: ['Email', 'Username'],
  },
  {
    id: 'your-rights',
    title: 'Your Rights',
    simplyPut: 'You are in control.',
    points: ['Delete anytime'],
  },
];

describe('LegalDocument', () => {
  it('renders every section title', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(screen.getByRole('heading', { name: 'Data Collection' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your Rights' })).toBeInTheDocument();
  });

  it('renders the "Simply Put" summary for each section', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    expect(screen.getByText('We collect very little.')).toBeInTheDocument();
    expect(screen.getByText('You are in control.')).toBeInTheDocument();
  });

  it('renders a mailto contact link from the meta', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    const link = screen.getByRole('link', { name: 'legal@hushbox.ai' });
    expect(link).toHaveAttribute('href', 'mailto:legal@hushbox.ai');
  });

  it('invokes renderAfterSection for each section id and renders its output', () => {
    render(
      <LegalDocument
        meta={META}
        sections={SECTIONS}
        renderAfterSection={(id): React.ReactNode =>
          id === 'data-collection' ? <p>Extra for {id}</p> : null
        }
      />
    );
    expect(screen.getByText('Extra for data-collection')).toBeInTheDocument();
  });

  it('renders without extra content when renderAfterSection is omitted', () => {
    render(<LegalDocument meta={META} sections={SECTIONS} />);
    // The document still renders its sections; the optional slot is simply absent.
    expect(screen.getByRole('heading', { name: 'Data Collection' })).toBeInTheDocument();
  });
});
