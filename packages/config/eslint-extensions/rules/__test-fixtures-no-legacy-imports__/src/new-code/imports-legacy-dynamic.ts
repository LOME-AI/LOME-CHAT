export async function load(): Promise<unknown> {
  return import('../legacy/inner.js');
}
