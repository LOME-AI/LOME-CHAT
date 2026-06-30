// Fixture: ordinary casts and annotations must not be reported.
interface Thing {
  readonly value: number;
}

const a = { value: 1 } as Thing;
const b: Thing = { value: 2 };
const c = JSON.parse('{}') as Record<string, unknown>;

export { a, b, c };
