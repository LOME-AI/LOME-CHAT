import { describe, it, expect } from 'vitest';
import { transpileReact, TranspileError } from './transpile.js';

describe('transpileReact', () => {
  it('compiles JSX to runtime calls and auto-imports the jsx runtime', () => {
    const out = transpileReact(`export default function App() { return <h1>hi</h1> }`);
    // Automatic runtime: no raw JSX survives, and the runtime is imported so the
    // author never has to import React explicitly.
    expect(out).not.toContain('<h1>');
    expect(out).toContain('react/jsx-runtime');
  });

  it('strips TypeScript annotations', () => {
    const out = transpileReact(
      `const n: number = 1\nexport default function App() { return <span>{n}</span> }`
    );
    expect(out).not.toContain(': number');
  });

  it('throws a typed TranspileError on a syntax error', () => {
    expect(() => transpileReact(`export default () => <div>`)).toThrow(TranspileError);
  });

  it('carries the underlying message on the typed error', () => {
    let caught: unknown;
    try {
      transpileReact(`const = ;`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranspileError);
    expect((caught as TranspileError).message.length).toBeGreaterThan(0);
  });
});
