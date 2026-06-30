import { describe, it, expect } from 'vitest';
import { extractErrorDiagnostics } from './error-diagnostics.js';

describe('extractErrorDiagnostics', () => {
  it('serializes a single Error to one layer with name and message', () => {
    const err = new Error('boom');
    const diag = extractErrorDiagnostics(err);
    expect(diag.layers).toHaveLength(1);
    expect(diag.layers[0]).toMatchObject({ name: 'Error', message: 'boom' });
    expect(diag.truncated).toBe(false);
  });

  it('walks a nested cause chain in order outermost → innermost', () => {
    const root = new Error('root');
    const middle = new Error('middle', { cause: root });
    const outer = new Error('outer', { cause: middle });
    const diag = extractErrorDiagnostics(outer);
    expect(diag.layers.map((l) => l.message)).toEqual(['outer', 'middle', 'root']);
  });

  it('extracts statusCode and url from an SDK-shaped APICallError layer', () => {
    const apiErr = new Error('Invalid JSON response') as Error & {
      statusCode?: number;
      url?: string;
    };
    apiErr.statusCode = 200;
    apiErr.url = 'https://ai-gateway.vercel.sh/v3/ai/image-model';
    const diag = extractErrorDiagnostics(apiErr);
    expect(diag.layers[0]).toMatchObject({
      statusCode: 200,
      url: 'https://ai-gateway.vercel.sh/v3/ai/image-model',
    });
  });

  it('strips query strings from urls (defense against API keys in URLs)', () => {
    const err = new Error('x') as Error & { url?: string };
    err.url = 'https://ai-gateway.vercel.sh/v3/ai/image-model?token=secret';
    const diag = extractErrorDiagnostics(err);
    expect(diag.layers[0]?.url).toBe('https://ai-gateway.vercel.sh/v3/ai/image-model');
  });

  it('captures bodyPreview from responseBody on APICallError-shaped layers', () => {
    const apiErr = new Error('Invalid JSON response') as Error & { responseBody?: string };
    apiErr.responseBody = '{\n  ,"images":[]}';
    const diag = extractErrorDiagnostics(apiErr);
    expect(diag.layers[0]?.bodyPreview).toBe('{\n  ,"images":[]}');
  });

  it('captures bodyPreview from text on JSONParseError-shaped layers', () => {
    const jsonErr = new Error('JSON parsing failed') as Error & { text?: string };
    jsonErr.text = '{\n  ,';
    const diag = extractErrorDiagnostics(jsonErr);
    expect(diag.layers[0]?.bodyPreview).toBe('{\n  ,');
  });

  it('prefers responseBody over text when both are present', () => {
    const err = new Error('x') as Error & { responseBody?: string; text?: string };
    err.responseBody = 'from-body';
    err.text = 'from-text';
    const diag = extractErrorDiagnostics(err);
    expect(diag.layers[0]?.bodyPreview).toBe('from-body');
  });

  it('truncates bodyPreview to maxBodyChars and suffixes with ellipsis', () => {
    const err = new Error('x') as Error & { responseBody?: string };
    err.responseBody = 'a'.repeat(5000);
    const diag = extractErrorDiagnostics(err, { maxBodyChars: 100 });
    expect(diag.layers[0]?.bodyPreview).toHaveLength(101);
    expect(diag.layers[0]?.bodyPreview?.endsWith('…')).toBe(true);
  });

  it('never includes requestBodyValues (contains user prompts)', () => {
    const err = new Error('x') as Error & { requestBodyValues?: unknown };
    err.requestBodyValues = { prompt: 'A secret family photo' };
    const diag = extractErrorDiagnostics(err);
    expect(JSON.stringify(diag)).not.toContain('requestBodyValues');
    expect(JSON.stringify(diag)).not.toContain('A secret family photo');
  });

  it('never includes responseHeaders (may carry auth tokens / cookies)', () => {
    const err = new Error('x') as Error & { responseHeaders?: Record<string, string> };
    err.responseHeaders = { authorization: 'Bearer sk-secret' };
    const diag = extractErrorDiagnostics(err);
    expect(JSON.stringify(diag)).not.toContain('responseHeaders');
    expect(JSON.stringify(diag)).not.toContain('sk-secret');
  });

  it('terminates cause cycles at maxDepth and sets truncated=true', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    const diag = extractErrorDiagnostics(a, { maxDepth: 3 });
    expect(diag.layers).toHaveLength(3);
    expect(diag.truncated).toBe(true);
  });

  it('handles non-Error input by returning a single Unknown layer', () => {
    expect(extractErrorDiagnostics(null).layers[0]).toMatchObject({
      name: 'Unknown',
      message: 'null',
    });
    expect(extractErrorDiagnostics('boom').layers[0]).toMatchObject({
      name: 'Unknown',
      message: 'boom',
    });
    expect(extractErrorDiagnostics(42).layers[0]).toMatchObject({
      name: 'Unknown',
      message: '42',
    });
  });

  it('handles a plain object with message but no Error prototype', () => {
    const diag = extractErrorDiagnostics({ message: 'hand-rolled', name: 'Custom' });
    expect(diag.layers[0]).toMatchObject({ name: 'Custom', message: 'hand-rolled' });
  });

  it('does not include fields matching the sensitive-property denylist', () => {
    const err = new Error('x') as Error & Record<string, unknown>;
    err['apiKey'] = 'sk-leak';
    err['secret'] = 'shh';
    err['cookie'] = 'session=abc';
    err['PROMPT'] = 'user content';
    const diag = extractErrorDiagnostics(err);
    const json = JSON.stringify(diag);
    expect(json).not.toContain('sk-leak');
    expect(json).not.toContain('shh');
    expect(json).not.toContain('session=abc');
    expect(json).not.toContain('user content');
  });
});
