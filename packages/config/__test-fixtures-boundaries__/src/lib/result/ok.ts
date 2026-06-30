export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
