import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Img } from './img';

describe('Img', () => {
  it('renders an img element with the required alt text', () => {
    render(<Img alt="A photo" src="/photo.png" />);
    const img = screen.getByAltText('A photo');
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe('IMG');
  });

  it('passes through the src attribute', () => {
    render(<Img alt="logo" src="/logo.png" />);
    expect(screen.getByAltText('logo')).toHaveAttribute('src', '/logo.png');
  });

  it("defaults loading to 'lazy' when not specified", () => {
    render(<Img alt="lazy image" src="/x.png" />);
    expect(screen.getByAltText('lazy image')).toHaveAttribute('loading', 'lazy');
  });

  it('allows overriding the loading attribute', () => {
    render(<Img alt="eager image" src="/x.png" loading="eager" />);
    expect(screen.getByAltText('eager image')).toHaveAttribute('loading', 'eager');
  });

  it('does not emit data-no-invert', () => {
    render(<Img alt="content" src="/x.png" />);
    expect(screen.getByAltText('content')).not.toHaveAttribute('data-no-invert');
  });

  it('forwards className to the img element', () => {
    render(<Img alt="styled" src="/x.png" className="rounded-full" />);
    expect(screen.getByAltText('styled')).toHaveClass('rounded-full');
  });

  it('forwards width and height attributes', () => {
    render(<Img alt="sized" src="/x.png" width={64} height={64} />);
    const img = screen.getByAltText('sized');
    expect(img).toHaveAttribute('width', '64');
    expect(img).toHaveAttribute('height', '64');
  });

  it('forwards arbitrary native img attributes', () => {
    render(<Img alt="ref" src="/x.png" id="my-img" data-testid="my-img" />);
    const img = screen.getByTestId('my-img');
    expect(img).toHaveAttribute('id', 'my-img');
  });
});
