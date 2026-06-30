export async function load(): Promise<unknown> {
  return import('../legacy_old.js');
}
