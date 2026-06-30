import { describe, it, expect } from 'vitest';

import { usageRecordFactory } from './legacy_usage-record';

describe('usageRecordFactory', () => {
  it('builds a complete usage record object', () => {
    const record = usageRecordFactory.build();

    expect(record.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(record.type).toBeTruthy();
    expect(record.status).toBeTruthy();
    expect(record.cost).toBeTruthy();
    expect(record.sourceType).toBeTruthy();
    expect(record.sourceId).toBeTruthy();
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('generates valid status values', () => {
    const record = usageRecordFactory.build();
    expect(['pending', 'completed', 'failed']).toContain(record.status);
  });

  it('generates userId as nullable UUID by default', () => {
    const record = usageRecordFactory.build();
    expect(record.userId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows null userId', () => {
    const record = usageRecordFactory.build({ userId: null });
    expect(record.userId).toBeNull();
  });

  it('generates cost as numeric string', () => {
    const record = usageRecordFactory.build();
    expect(Number(record.cost)).not.toBeNaN();
    expect(Number(record.cost)).toBeGreaterThan(0);
  });

  it('sets completedAt when status is completed', () => {
    const record = usageRecordFactory.build({ status: 'completed' });
    expect(record.completedAt).toBeInstanceOf(Date);
  });

  it('sets completedAt to null when status is pending', () => {
    const record = usageRecordFactory.build({ status: 'pending' });
    expect(record.completedAt).toBeNull();
  });

  it('allows field overrides', () => {
    const record = usageRecordFactory.build({ type: 'llm_completion', cost: '0.05000000' });
    expect(record.type).toBe('llm_completion');
    expect(record.cost).toBe('0.05000000');
  });

  it('builds a list with unique IDs', () => {
    const recordList = usageRecordFactory.buildList(3);
    expect(recordList).toHaveLength(3);
    const ids = new Set(recordList.map((r) => r.id));
    expect(ids.size).toBe(3);
  });
});
