/**
 * Smart Model's published surface. The classifier-answer reducers stay behind
 * the wall (`docs/BILLING.md` §Where the Code Lives): resolving a raw answer
 * against the presented set is the producer's job, so the parse-and-fall-back
 * functions are absent here rather than absent one level up.
 */

export * from './eligible-models.js';
export * from './prompts.js';
export type { ClassifierEffortLevel } from './effort-dimension.js';
