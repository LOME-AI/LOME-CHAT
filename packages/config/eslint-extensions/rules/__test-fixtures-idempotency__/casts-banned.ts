// Fixture: every brand cast below must be reported.
type Idempotent<T> = T & { readonly __brand: 'Idempotent' };
type SettlementTx = { readonly __brand: 'SettlementTx' };

const a = { value: 1 } as Idempotent<{ value: number }>;
const b = {} as SettlementTx;
const c = Promise.resolve(1) as Promise<Idempotent<number>>;
const d = {} as unknown as SettlementTx;
const e = <SettlementTx>{};

export { a, b, c, d, e };
