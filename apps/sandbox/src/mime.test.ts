import { describe, it, expect } from 'vitest';
import { contentTypeFor } from './mime.js';

describe('contentTypeFor', () => {
  it('serves .wasm as application/wasm (Pyodide fetches it from the opaque frame)', () => {
    expect(contentTypeFor('/pyodide/pyodide.asm.wasm')).toBe('application/wasm');
  });

  it('serves .html as text/html with utf-8', () => {
    expect(contentTypeFor('/render.html')).toBe('text/html; charset=utf-8');
  });

  it('serves .js as text/javascript with utf-8', () => {
    expect(contentTypeFor('/config.js')).toBe('text/javascript; charset=utf-8');
  });

  it('serves .mjs as text/javascript (ES module scripts)', () => {
    expect(contentTypeFor('/pyodide/pyodide.mjs')).toBe('text/javascript; charset=utf-8');
  });

  it('serves .json as application/json with utf-8', () => {
    expect(contentTypeFor('/pyodide/pyodide-lock.json')).toBe('application/json; charset=utf-8');
  });

  it('serves .whl (Python wheels) as application/octet-stream', () => {
    expect(contentTypeFor('/pyodide/numpy-2.4.3-cp314.whl')).toBe('application/octet-stream');
  });

  it('serves .zip (python_stdlib.zip) as application/zip', () => {
    expect(contentTypeFor('/pyodide/python_stdlib.zip')).toBe('application/zip');
  });

  it('serves .css as text/css with utf-8', () => {
    expect(contentTypeFor('/style.css')).toBe('text/css; charset=utf-8');
  });

  it('is case-insensitive on the extension', () => {
    expect(contentTypeFor('/PYODIDE/CORE.WASM')).toBe('application/wasm');
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(contentTypeFor('/data.bin')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream when there is no extension', () => {
    expect(contentTypeFor('/no-extension')).toBe('application/octet-stream');
  });
});
