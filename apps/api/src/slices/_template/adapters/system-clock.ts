import type { Clock } from '../ports/index.js';

/** Example adapter: the only layer allowed to touch infra implementations. */
export const systemClock: Clock = {
  now: (): Date => new Date(),
};
