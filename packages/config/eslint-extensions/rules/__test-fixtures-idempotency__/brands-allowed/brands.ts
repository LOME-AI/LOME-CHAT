// Fixture: the brand-minting module — the one file where the casts are legal.
type Idempotent<T> = T & { readonly __brand: 'Idempotent' };
type SettlementTx = { readonly __brand: 'SettlementTx' };

export function brandIdempotent<T>(value: T): Idempotent<T> {
  return value as Idempotent<T>;
}

export function brandSettlementTx(tx: object): SettlementTx {
  return tx as SettlementTx;
}
