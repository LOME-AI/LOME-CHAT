import { describe, it, expect } from 'vitest';
import { parseSpecifier, moduleUrlFor } from './specifier.js';

describe('parseSpecifier', () => {
  it('parses a bare package name', () => {
    expect(parseSpecifier('react')).toEqual({ name: 'react', version: undefined, subpath: '' });
  });

  it('parses a package with a subpath', () => {
    expect(parseSpecifier('react-dom/client')).toEqual({
      name: 'react-dom',
      version: undefined,
      subpath: '/client',
    });
  });

  it('parses a versioned package', () => {
    expect(parseSpecifier('canvas-confetti@1.9.3')).toEqual({
      name: 'canvas-confetti',
      version: '1.9.3',
      subpath: '',
    });
  });

  it('parses a versioned package with a subpath', () => {
    expect(parseSpecifier('react@19.1.0/jsx-runtime')).toEqual({
      name: 'react',
      version: '19.1.0',
      subpath: '/jsx-runtime',
    });
  });

  it('parses a scoped package', () => {
    expect(parseSpecifier('@scope/pkg')).toEqual({
      name: '@scope/pkg',
      version: undefined,
      subpath: '',
    });
  });

  it('parses a scoped package with a subpath', () => {
    expect(parseSpecifier('@scope/pkg/sub/deep')).toEqual({
      name: '@scope/pkg',
      version: undefined,
      subpath: '/sub/deep',
    });
  });

  it('parses a scoped, versioned package with a subpath', () => {
    expect(parseSpecifier('@scope/pkg@1.2.3/sub')).toEqual({
      name: '@scope/pkg',
      version: '1.2.3',
      subpath: '/sub',
    });
  });
});

describe('moduleUrlFor', () => {
  it('builds a bare URL with no version', () => {
    expect(moduleUrlFor('canvas-confetti', 'https://esm.sh', {})).toBe(
      'https://esm.sh/canvas-confetti'
    );
  });

  it('keeps an author-declared version (pin where the specifier names one)', () => {
    expect(moduleUrlFor('canvas-confetti@1.9.3', 'https://esm.sh', {})).toBe(
      'https://esm.sh/canvas-confetti@1.9.3'
    );
  });

  it('applies a runtime pin only when the specifier omits a version', () => {
    expect(moduleUrlFor('react', 'https://esm.sh', { react: '19.1.0' })).toBe(
      'https://esm.sh/react@19.1.0'
    );
  });

  it('lets an explicit version override a pin', () => {
    expect(moduleUrlFor('react@18.0.0', 'https://esm.sh', { react: '19.1.0' })).toBe(
      'https://esm.sh/react@18.0.0'
    );
  });

  it('applies the pin to a subpath of a pinned package', () => {
    expect(moduleUrlFor('react-dom/client', 'https://esm.sh', { 'react-dom': '19.1.0' })).toBe(
      'https://esm.sh/react-dom@19.1.0/client'
    );
  });

  it('normalises a trailing slash on the CDN base', () => {
    expect(moduleUrlFor('react', 'http://localhost:7400/esm-stub/', {})).toBe(
      'http://localhost:7400/esm-stub/react'
    );
  });
});
