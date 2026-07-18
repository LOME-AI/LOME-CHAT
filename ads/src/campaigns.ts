import { adSpecSchema, type AdSpec } from '../tools/remotion/index.js';
import { hqTour } from '../2026-07-hq-tour/spec.js';

/**
 * Every ad the studio and renderer know about, each a validated AdSpec. Adding
 * an ad = add its `spec.ts` (data) to a campaign folder and list it here; no
 * new rendering code. Parsing at load surfaces a bad spec immediately.
 */
export const campaigns: AdSpec[] = [adSpecSchema.parse(hqTour)];
