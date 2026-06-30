import { describe, it, expect } from 'vitest';
import { getLinearClient } from './index.js';
import { MOCK_PROJECTS } from './mock-fixtures/roadmap.js';

describe('getLinearClient', () => {
  it('returns the mock client in local dev (no NODE_ENV, no CI, no E2E)', async () => {
    const client = getLinearClient({});
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('returns the mock client when E2E is set', async () => {
    const client = getLinearClient({ E2E: 'true' });
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('throws for NODE_ENV=test (vitest mode no longer treated as dev)', () => {
    expect(() => getLinearClient({ NODE_ENV: 'test' })).toThrow(
      /LINEAR_API_KEY_READ required outside dev \/ E2E/
    );
  });

  it('throws when production-mode and LINEAR_API_KEY_READ is missing', () => {
    expect(() => getLinearClient({ NODE_ENV: 'production' })).toThrow(
      /LINEAR_API_KEY_READ required outside dev \/ E2E/
    );
  });

  it('throws when CI-mode and LINEAR_API_KEY_READ is missing', () => {
    expect(() => getLinearClient({ CI: 'true' })).toThrow(
      /LINEAR_API_KEY_READ required outside dev \/ E2E/
    );
  });

  it('throws when LINEAR_API_KEY_READ is the empty string in production', () => {
    expect(() => getLinearClient({ NODE_ENV: 'production', LINEAR_API_KEY_READ: '' })).toThrow(
      /LINEAR_API_KEY_READ required outside dev \/ E2E/
    );
  });

  it('returns the real client when production-mode and a key is present', () => {
    const client = getLinearClient({
      NODE_ENV: 'production',
      LINEAR_API_KEY_READ: 'fake-key-for-construction-test',
    });
    expect(typeof client.fetchRoadmap).toBe('function');
  });
});
