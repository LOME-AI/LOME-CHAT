import { describe, expect, it } from 'vitest';
import { fakeStores } from './test-fixtures.js';

describe('fakeStores', () => {
  it('treats any un-overridden store call as a test defect naming the method', () => {
    const stores = fakeStores({});
    expect(() => stores.members.countActive('c1')).toThrow(
      /unexpected store call: members.countActive/
    );
  });
});
