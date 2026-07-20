import { describe, it, expect } from 'vitest';
import { safeJsonParse } from './safe-json.js';

describe('safeJsonParse', () => {
  it('returns parsed JSON when body is valid', async () => {
    const response = Response.json({ name: 'test', value: 42 });

    const result = await safeJsonParse<{ name: string; value: number }>(response, 'TestService');

    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('throws with context string when body is not JSON', async () => {
    const response = new Response('<html>Service Unavailable</html>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(safeJsonParse(response, 'AI Gateway models')).rejects.toThrow(
      'AI Gateway models: expected JSON but received unparseable body (HTTP 503)'
    );
  });

  it('throws with context string when body is empty', async () => {
    const response = new Response('', {
      status: 502,
    });

    await expect(safeJsonParse(response, 'Helcim payment')).rejects.toThrow(
      'Helcim payment: expected JSON but received unparseable body (HTTP 502)'
    );
  });

  it('includes HTTP status code in error message', async () => {
    const response = new Response('not json at all', {
      status: 504,
    });

    await expect(safeJsonParse(response, 'Resend email')).rejects.toThrow('HTTP 504');
  });
});
