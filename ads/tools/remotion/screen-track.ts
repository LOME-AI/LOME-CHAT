export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
  /** 3 for RGB, 4 for RGBA. */
  channels: number;
}

/**
 * Seeded chroma tracking: sample the colour at `seed`, then flood-fill the
 * connected region whose pixels are within `tolerance` (max per-channel
 * difference) of it, and return that region's bounding rect. Seeding + 4-way
 * connectivity is what makes it robust — it grabs the one screen the seed sits
 * on, tolerating the gradient and compression noise of a generated green, and
 * ignores same-colour pixels elsewhere. Pure so the tracking is tested without
 * a decoder or a render.
 */
export function regionBounds(
  image: RgbaImage,
  seed: { x: number; y: number },
  tolerance: number
): Rect {
  const { data, width, height, channels } = image;
  const at = (x: number, y: number): number => (y * width + x) * channels;
  const seedIndex = at(seed.x, seed.y);
  const sr = Number(data[seedIndex]);
  const sg = Number(data[seedIndex + 1]);
  const sb = Number(data[seedIndex + 2]);
  const within = (index: number): boolean =>
    Math.abs(Number(data[index]) - sr) <= tolerance &&
    Math.abs(Number(data[index + 1]) - sg) <= tolerance &&
    Math.abs(Number(data[index + 2]) - sb) <= tolerance;

  // The seed always matches itself, so the region has ≥1 pixel and min/max are
  // always assigned; no empty-region guard is reachable.
  const visited = new Uint8Array(width * height);
  const start = seed.y * width + seed.x;
  const stack = [start];
  visited[start] = 1;
  const enqueue = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const cell = y * width + x;
    if (visited[cell] === 0) {
      visited[cell] = 1;
      stack.push(cell);
    }
  };

  let minX = seed.x;
  let minY = seed.y;
  let maxX = seed.x;
  let maxY = seed.y;
  const grow = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  while (stack.length > 0) {
    const cell = Number(stack.pop());
    const x = cell % width;
    const y = (cell - x) / width;
    if (!within(at(x, y))) continue;
    grow(x, y);
    enqueue(x + 1, y);
    enqueue(x - 1, y);
    enqueue(x, y + 1);
    enqueue(x, y - 1);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Moving-average smoothing of a per-frame rect track over ±`window` frames, so
 * the pin glides instead of jittering with the tracker's per-frame noise.
 */
export function smoothTrack(track: readonly Rect[], window: number): Rect[] {
  return track.map((_, index) => {
    const lo = Math.max(0, index - window);
    const neighbours = track.slice(lo, Math.min(track.length, index + window + 1));
    let sx = 0;
    let sy = 0;
    let sw = 0;
    let sh = 0;
    for (const r of neighbours) {
      sx += r.x;
      sy += r.y;
      sw += r.width;
      sh += r.height;
    }
    const n = neighbours.length;
    return { x: sx / n, y: sy / n, width: sw / n, height: sh / n };
  });
}

/** Expands a rect by `overshoot` of its size on every side (edge bleed). */
export function expandRect(rect: Rect, overshoot: number): Rect {
  const bleedX = rect.width * overshoot;
  const bleedY = rect.height * overshoot;
  return {
    x: rect.x - bleedX,
    y: rect.y - bleedY,
    width: rect.width + bleedX * 2,
    height: rect.height + bleedY * 2,
  };
}
