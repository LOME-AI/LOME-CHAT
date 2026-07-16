import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Click
      </Button>
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders default variant', () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'default');
  });

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'destructive');
  });

  it('renders outline variant', () => {
    render(<Button variant="outline">Outline</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'outline');
  });

  it('renders secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'secondary');
  });

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
  });

  it('renders link variant', () => {
    render(<Button variant="link">Link</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'link');
  });

  it('renders default size', () => {
    render(<Button>Default Size</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'default');
  });

  it('renders small size', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'sm');
  });

  it('renders large size', () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'lg');
  });

  it('renders icon size', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon');
  });

  it('icon size resolves to 44px (size-11) for HIG/Material minimum touch target', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveClass('size-11');
  });

  it('icon-sm size resolves to 32px (size-8) for dense desktop contexts', () => {
    render(<Button size="icon-sm">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon-sm');
    expect(screen.getByRole('button')).toHaveClass('size-8');
  });

  it('icon-lg size resolves to 48px (size-12)', () => {
    render(<Button size="icon-lg">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon-lg');
    expect(screen.getByRole('button')).toHaveClass('size-12');
  });

  it('applies custom className', () => {
    render(<Button className="custom-class">Custom</Button>);
    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('forwards ref to button element', () => {
    const ref = vi.fn();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref).toHaveBeenCalled();
  });

  it('has correct type attribute by default', () => {
    render(<Button>Submit</Button>);
    expect(screen.getByRole('button')).not.toHaveAttribute('type');
  });

  it('accepts type attribute', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('renders as child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/somewhere">Link button</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Link button' });
    expect(link).toHaveAttribute('href', '/somewhere');
    expect(link).toHaveAttribute('data-slot', 'button');
  });
});
