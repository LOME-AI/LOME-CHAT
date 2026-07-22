import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { serializeReasoningText, TEST_IDS } from '@hushbox/shared';
import { ThinkingDisclosure } from '@/components/chat/message/thinking-disclosure';

const SETTLED = serializeReasoningText('Consider the derivative first.', 'The slope is 16.');
// Streaming partial in the always-closed canonical form T8 assembles: the
// reasoning accumulates while the answer is still empty.
const STREAMING = serializeReasoningText('Consider the derivative', '');

describe('ThinkingDisclosure', () => {
  it('renders nothing when the message carries no reasoning', () => {
    const { container } = render(<ThinkingDisclosure content="Just an answer." />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty message', () => {
    const { container } = render(<ThinkingDisclosure content="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the disclosure when reasoning is present', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).toBeInTheDocument();
  });

  it('is collapsed by default with a real disclosure button', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('wires aria-controls from the button to the panel', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    // Attribute selector: useId values contain characters (":") that are
    // invalid in an unescaped id selector.
    const panel = document.querySelector(`[id="${controls ?? ''}"]`);
    expect(panel).toBeInTheDocument();
  });

  it('hides the collapsed preview from assistive tech', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosurePreview)).toHaveAttribute(
      'aria-hidden',
      'true'
    );
  });

  it('shows the reasoning text in the collapsed preview', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosurePreview)).toHaveTextContent(
      'Consider the derivative first.'
    );
  });

  it('glazes the collapsed preview with a mask gradient, never a blur filter', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    const preview = screen.getByTestId(TEST_IDS.thinkingDisclosurePreview);
    expect(preview.style.maskImage).toContain('linear-gradient');
    expect(preview.style.filter).toBe('');
    expect(preview.className).not.toMatch(/blur/);
  });

  it('keeps the collapsed preview at a fixed height class while streaming', () => {
    render(<ThinkingDisclosure content={STREAMING} isStreaming />);
    const preview = screen.getByTestId(TEST_IDS.thinkingDisclosurePreview);
    expect(preview.className).toContain('h-[4.75rem]');
    expect(preview.className).toContain('overflow-hidden');
  });

  it('expands on click and swaps the preview for readable content', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosurePreview)).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureContent)).toHaveTextContent(
      'Consider the derivative first.'
    );
  });

  it('collapses again on a second click', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosurePreview)).toBeInTheDocument();
  });

  it('bounds the expanded view height with internal scroll', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
    const panel = screen.getByTestId(TEST_IDS.thinkingDisclosureContent).parentElement;
    expect(panel?.className).toContain('max-h-60');
    expect(panel?.className).toContain('overflow-y-auto');
  });

  it('does not glaze the expanded view', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
    const content = screen.getByTestId(TEST_IDS.thinkingDisclosureContent);
    expect(content.getAttribute('style')).toBeNull();
  });

  it('labels the button "Thinking…" while reasoning is still streaming', () => {
    render(<ThinkingDisclosure content={STREAMING} isStreaming />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Thinking…');
  });

  it('labels the button "Thoughts" once the answer starts streaming', () => {
    render(<ThinkingDisclosure content={SETTLED} isStreaming />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Thoughts');
  });

  it('labels the button "Thoughts" when settled without a token count', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Thoughts');
  });

  it('derives the settled label from the reasoning token count when known', () => {
    render(<ThinkingDisclosure content={SETTLED} reasoningTokens={1204} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
      'Thoughts (1,204 tokens)'
    );
  });

  it('never shows a token count in the label while still thinking', () => {
    render(<ThinkingDisclosure content={STREAMING} isStreaming reasoningTokens={1204} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Thinking…');
  });

  it('shows the quiet "Reasoned privately" line when tokens were billed with no visible text', () => {
    render(<ThinkingDisclosure content="Just an answer." reasoningTokens={1204} />);
    expect(screen.getByTestId(TEST_IDS.reasonedPrivately)).toHaveTextContent(
      'Reasoned privately (1,204 tokens)'
    );
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
  });

  it('renders no privately-reasoned line when the token count is zero', () => {
    const { container } = render(
      <ThinkingDisclosure content="Just an answer." reasoningTokens={0} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while an answer streams with no reasoning and no count yet', () => {
    const { container } = render(<ThinkingDisclosure content="Partial answ" isStreaming />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps keyboard focus visible with an inset ring the overflow-hidden frame cannot clip', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle.className).toContain('focus-visible:ring-2');
    expect(toggle.className).toContain('ring-inset');
  });

  it('keeps the disclosure header chrome in the sans face inside a reading region', () => {
    render(<ThinkingDisclosure content={SETTLED} />);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle).className).toContain('font-sans');
  });
});
