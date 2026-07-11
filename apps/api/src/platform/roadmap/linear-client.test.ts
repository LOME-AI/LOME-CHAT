import { describe, expect, it } from 'vitest';
import { createEnvUtilities } from '@hushbox/shared';
import { getLinearClient } from './linear-client.js';
import { MOCK_PROJECTS } from './mock-roadmap-fixture.js';

const localDev = createEnvUtilities({ NODE_ENV: 'development' });
const e2e = createEnvUtilities({ NODE_ENV: 'development', E2E: 'true' });
const production = createEnvUtilities({ NODE_ENV: 'production' });

describe('getLinearClient', () => {
  it('returns the mock client in local dev (no key needed)', async () => {
    const client = getLinearClient({}, localDev);
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('returns the mock client in E2E', async () => {
    const client = getLinearClient({}, e2e);
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('fails fast outside dev/E2E when LINEAR_API_KEY_READ is missing', () => {
    expect(() => getLinearClient({}, production)).toThrow(/LINEAR_API_KEY_READ/);
    expect(() => getLinearClient({ LINEAR_API_KEY_READ: '' }, production)).toThrow(
      /LINEAR_API_KEY_READ/
    );
  });

  it('returns the real client outside dev/E2E when the key is present', () => {
    const client = getLinearClient({ LINEAR_API_KEY_READ: 'lin_api_test' }, production);
    expect(typeof client.fetchRoadmap).toBe('function');
  });
});
