import type { Clock } from '../ports/index.js';
export const systemClock: Clock = {
  now: (): Date => new Date(),
};
