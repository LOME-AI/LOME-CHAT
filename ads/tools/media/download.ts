import { writeFileSync } from 'node:fs';

/**
 * Binary-safe download for generated media. Exists because piping binaries
 * through shell redirection in the agent harness corrupts them (UTF-8
 * replacement bytes); node fetch → Buffer → writeFileSync does not.
 */
export async function downloadBinary(url: string, destinationPath: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${String(res.status)} for ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(destinationPath, bytes);
  return bytes.byteLength;
}

/** `s3-take2-seedance20.mp4`-style archive names, per the ads README. */
export function takeFileName(
  scene: number,
  take: number,
  model: string,
  extension: 'mp4' | 'png' | 'wav'
): string {
  return `s${String(scene)}-take${String(take)}-${model}.${extension}`;
}
