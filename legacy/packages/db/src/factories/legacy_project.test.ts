import { describe, it, expect } from 'vitest';

import { projectFactory } from './legacy_project';

describe('projectFactory', () => {
  it('builds a complete project object', () => {
    const project = projectFactory.build();

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(project.encryptedName).toBeInstanceOf(Uint8Array);
    expect(project.encryptedName.length).toBeGreaterThan(0);
    expect(project.createdAt).toBeInstanceOf(Date);
    expect(project.updatedAt).toBeInstanceOf(Date);
  });

  it('generates encryptedDescription as nullable', () => {
    const projects = projectFactory.buildList(20);
    const hasNull = projects.some((p) => p.encryptedDescription === null);
    const hasValue = projects.some((p) => p.encryptedDescription instanceof Uint8Array);
    expect(hasNull || hasValue).toBe(true);
  });

  it('allows field overrides', () => {
    const customName = new TextEncoder().encode('Custom Project');
    const project = projectFactory.build({ encryptedName: customName });
    expect(project.encryptedName).toEqual(customName);
  });

  it('builds a list with unique IDs', () => {
    const projectList = projectFactory.buildList(3);
    expect(projectList).toHaveLength(3);
    const ids = new Set(projectList.map((p) => p.id));
    expect(ids.size).toBe(3);
  });
});
