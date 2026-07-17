/**
 * Deterministic name → UUID derivation for seeded fixtures. The same name
 * always yields the same v4-shaped UUID, so tooling (screenshot generation,
 * seeds) can address seeded rows without querying for them.
 *
 * The hash algorithm is frozen: derived IDs leak into external artifacts
 * (store screenshots, cached crypto material keyed by credential identifier),
 * so changing it silently re-derives every ID. See the pinned-value test.
 */
export function seedUUID(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    /* v8 ignore next -- index < name.length, so codePointAt never returns undefined */
    const char = name.codePointAt(index) ?? 0;
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(12, '0').slice(0, 12);
  return `00000000-0000-4000-8000-${hex}`;
}
