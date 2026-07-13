import { test, expect } from '@playwright/test';
import { requireEnv } from '../helpers/env.js';

const apiUrl = requireEnv('VITE_API_URL');

test.describe('API Health Endpoint', () => {
  test('GET /health returns 200 with status ok', async ({ request }) => {
    const response = await request.get(`${apiUrl}/health`);

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string; timestamp: string };
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('timestamp');
  });
});
