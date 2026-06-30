import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';

describe('idempotency barrel', () => {
  it('never re-exports the brand constructors', () => {
    // The constructors are the only way to mint Idempotent/SettlementTx; a
    // barrel re-export would hand every slice a forgery path the deep-import
    // lint ban cannot see.
    expect('brandIdempotent' in barrel).toBe(false);
    expect('brandSettlementTx' in barrel).toBe(false);
  });
});
