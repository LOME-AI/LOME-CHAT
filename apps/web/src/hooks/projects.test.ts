import { describe, it, expect } from 'vitest';
import { projectKeys } from './projects';

describe('projectKeys', () => {
  describe('all', () => {
    it('returns base projects key', () => {
      expect(projectKeys.all).toEqual(['projects']);
    });
  });

  describe('list', () => {
    it('returns list key array', () => {
      expect(projectKeys.list()).toEqual(['projects', 'list']);
    });
  });

  describe('detail', () => {
    it('returns detail key with id', () => {
      expect(projectKeys.detail('proj-123')).toEqual(['projects', 'proj-123']);
    });
  });
});
