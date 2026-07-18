import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useA11yStore } from './accessibility/store';
import { CharacterCountTextarea } from './character-count-textarea';

describe('CharacterCountTextarea', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    // Keep the merged reduced-motion signal derived from OS/store only — a
    // contaminated VITE_E2E from a prior e2e run would otherwise force reduced.
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    useA11yStore.getState().reset();
    vi.unstubAllEnvs();
  });

  it('renders the counter reflecting the value length and limit', () => {
    render(<CharacterCountTextarea value="hello" limit={4000} onChange={vi.fn()} />);

    expect(screen.getByText('5 / 4,000')).toBeInTheDocument();
  });

  it('formats large counts and limits with thousands separators', () => {
    render(<CharacterCountTextarea value={'x'.repeat(1234)} limit={5000} onChange={vi.fn()} />);

    expect(screen.getByText('1,234 / 5,000')).toBeInTheDocument();
  });

  it('shows a muted counter and no truncation notice while under the limit', () => {
    render(<CharacterCountTextarea value={'x'.repeat(10)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('10 / 20')).toHaveClass('text-muted-foreground');
    expect(
      screen.queryByText('Only the first 20 characters will be used.')
    ).not.toBeInTheDocument();
  });

  it('keeps a muted counter and no notice exactly at the limit', () => {
    render(<CharacterCountTextarea value={'x'.repeat(20)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('20 / 20')).toHaveClass('text-muted-foreground');
    expect(
      screen.queryByText('Only the first 20 characters will be used.')
    ).not.toBeInTheDocument();
  });

  it('turns the counter destructive and shows the truncation notice when over the limit', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('21 / 20')).toHaveClass('text-destructive');
    const notice = screen.getByText('Only the first 20 characters will be used.');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveClass('text-destructive');
  });

  it('renders the truncation notice as a polite live region', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('Only the first 20 characters will be used.')).toHaveAttribute(
      'aria-live',
      'polite'
    );
  });

  it('does not set a native maxLength (typing is never blocked)', () => {
    render(<CharacterCountTextarea value="hi" limit={4} onChange={vi.fn()} />);

    expect(screen.getByRole('textbox')).not.toHaveAttribute('maxLength');
  });

  it('wires the counter into aria-describedby when under the limit', () => {
    render(<CharacterCountTextarea value="hi" limit={20} onChange={vi.fn()} />);

    const describedBy = screen.getByRole('textbox').getAttribute('aria-describedby');
    const counterId = screen.getByText('2 / 20').getAttribute('id');
    expect(counterId).toBeTruthy();
    expect(describedBy?.split(' ')).toContain(counterId);
  });

  it('wires both the counter and the notice into aria-describedby when over the limit', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    const describedBy = screen.getByRole('textbox').getAttribute('aria-describedby')?.split(' ');
    const counterId = screen.getByText('21 / 20').getAttribute('id');
    const noticeId = screen
      .getByText('Only the first 20 characters will be used.')
      .getAttribute('id');
    expect(describedBy).toContain(counterId);
    expect(describedBy).toContain(noticeId);
  });

  it('preserves an incoming aria-describedby alongside the counter id', () => {
    render(
      <CharacterCountTextarea
        value="hi"
        limit={20}
        aria-describedby="external-hint"
        onChange={vi.fn()}
      />
    );

    const describedBy = screen.getByRole('textbox').getAttribute('aria-describedby')?.split(' ');
    expect(describedBy).toContain('external-hint');
  });

  it('caps growth with a bounded height and scrolls', () => {
    render(<CharacterCountTextarea value="hi" limit={20} onChange={vi.fn()} />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveClass('max-h-72');
    expect(textarea).toHaveClass('overflow-y-auto');
    expect(textarea).toHaveClass('resize-none');
  });

  it('merges an incoming className with the height classes', () => {
    render(
      <CharacterCountTextarea value="hi" limit={20} className="custom-class" onChange={vi.fn()} />
    );

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveClass('custom-class');
    expect(textarea).toHaveClass('max-h-72');
  });

  it('forwards the value to the textarea', () => {
    render(<CharacterCountTextarea value="typed content" limit={20} onChange={vi.fn()} />);

    expect(screen.getByRole('textbox')).toHaveValue('typed content');
  });

  it('forwards onChange events from the textarea', async () => {
    const onChange = vi.fn();
    render(<CharacterCountTextarea value="" limit={20} onChange={onChange} />);

    await userEvent.type(screen.getByRole('textbox'), 'a');

    expect(onChange).toHaveBeenCalled();
  });

  it('forwards arbitrary textarea props such as placeholder', () => {
    render(
      <CharacterCountTextarea value="" limit={20} placeholder="Say something" onChange={vi.fn()} />
    );

    expect(screen.getByPlaceholderText('Say something')).toBeInTheDocument();
  });

  it('groups the counter and the notice in one flex row with a static right-aligned counter', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    const counter = screen.getByText('21 / 20');
    const notice = screen.getByText('Only the first 20 characters will be used.');
    const row = counter.parentElement;
    expect(row).toHaveClass('flex', 'justify-between');
    expect(row).toContainElement(notice);
  });

  it('renders the notice to the left of the static counter', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    const counter = screen.getByText('21 / 20');
    const notice = screen.getByText('Only the first 20 characters will be used.');
    // The counter is the row's last child; the notice sits before it (to the left).
    expect(counter.parentElement?.lastElementChild).toBe(counter);
    expect(
      Boolean(counter.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_PRECEDING)
    ).toBe(true);
  });

  it('removes the notice after the value drops back under the limit', async () => {
    const { rerender } = render(
      <CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />
    );
    expect(screen.getByText('Only the first 20 characters will be used.')).toBeInTheDocument();

    rerender(<CharacterCountTextarea value={'x'.repeat(10)} limit={20} onChange={vi.fn()} />);

    await waitFor(() => {
      expect(
        screen.queryByText('Only the first 20 characters will be used.')
      ).not.toBeInTheDocument();
    });
  });

  it('marks the notice animated when motion is not reduced', () => {
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('Only the first 20 characters will be used.')).toHaveAttribute(
      'data-animated',
      'true'
    );
  });

  it('drops the slide animation when reduced motion is requested', () => {
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    render(<CharacterCountTextarea value={'x'.repeat(21)} limit={20} onChange={vi.fn()} />);

    expect(screen.getByText('Only the first 20 characters will be used.')).toHaveAttribute(
      'data-animated',
      'false'
    );
  });
});
