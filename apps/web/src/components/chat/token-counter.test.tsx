import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TokenCounter } from './token-counter';

describe('TokenCounter', () => {
  it('displays current tokens and context limit', () => {
    render(<TokenCounter currentTokens={1500} contextLimit={128000} />);

    expect(screen.getByTestId('token-counter')).toBeInTheDocument();
    expect(screen.getByText(/1,500/)).toBeInTheDocument();
    expect(screen.getByText(/128k/)).toBeInTheDocument();
  });

  it('shows normal styling when under 80% of limit', () => {
    render(<TokenCounter currentTokens={50000} contextLimit={128000} />);

    const counter = screen.getByTestId('token-counter');
    expect(counter).toHaveClass('text-muted-foreground');
  });

  it('shows warning styling when between 80-95% of limit', () => {
    // 80% of 128000 = 102400
    render(<TokenCounter currentTokens={105000} contextLimit={128000} />);

    const counter = screen.getByTestId('token-counter');
    expect(counter).toHaveClass('text-yellow-600');
  });

  it('shows danger styling when over 95% of limit', () => {
    // 95% of 128000 = 121600
    render(<TokenCounter currentTokens={125000} contextLimit={128000} />);

    const counter = screen.getByTestId('token-counter');
    expect(counter).toHaveClass('text-destructive');
  });

  it('shows danger styling when over limit', () => {
    render(<TokenCounter currentTokens={150000} contextLimit={128000} />);

    const counter = screen.getByTestId('token-counter');
    expect(counter).toHaveClass('text-destructive');
  });

  it('formats large token counts with k suffix', () => {
    render(<TokenCounter currentTokens={50000} contextLimit={128000} />);

    expect(screen.getByText(/50k/)).toBeInTheDocument();
  });

  it('shows tooltip on hover', () => {
    render(<TokenCounter currentTokens={1500} contextLimit={128000} />);

    // The counter should have tooltip trigger
    const trigger = screen.getByTestId('token-counter');
    expect(trigger).toHaveAttribute('data-slot', 'tooltip-trigger');
  });

  it('accepts custom className', () => {
    render(<TokenCounter currentTokens={1500} contextLimit={128000} className="custom-class" />);

    expect(screen.getByTestId('token-counter')).toHaveClass('custom-class');
  });

  it('displays percentage usage', () => {
    render(<TokenCounter currentTokens={64000} contextLimit={128000} />);

    // 64000/128000 = 50%
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });
});
