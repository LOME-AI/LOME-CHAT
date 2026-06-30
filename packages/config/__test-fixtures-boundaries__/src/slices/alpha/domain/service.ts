import type { Clock } from '../ports/index.js';
export function buildGreeting(clock: Clock): string {
  return `hello at ${clock.now().toISOString()}`;
}
