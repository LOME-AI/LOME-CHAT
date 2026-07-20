/**
 * Per-request memoized accessor for the processed AI Gateway catalog.
 *
 * `processModels` is non-trivial (ZDR filter + percentile classification +
 * premium detection + Smart Model synthesis), and several callers within a
 * single chat request all need its output: chat route's tier gate, billing
 * resolution, stream-pipeline's Smart Model staging, models route serving.
 *
 * Memoizing keyed on the request Context object is the SoT: first call fetches
 * the raw catalog and processes it; subsequent calls within the same request
 * return the cached Promise. Different requests have separate Context objects
 * and therefore separate caches, preventing cross-request bleed.
 *
 * Rejections are cached too — if the catalog fetch fails on first call, all
 * subsequent calls within that request see the same rejection without
 * re-hitting the gateway. Each request gets one shot at the catalog.
 */

import { processModels, type ProcessedModels } from '@hushbox/shared/models';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';

const cache = new WeakMap<Context<AppEnv>, Promise<ProcessedModels>>();

async function loadProcessedCatalog(c: Context<AppEnv>): Promise<ProcessedModels> {
  const raw = await c.var.aiClient.listRawModels();
  return processModels(raw);
}

export function getProcessedCatalog(c: Context<AppEnv>): Promise<ProcessedModels> {
  const existing = cache.get(c);
  if (existing) return existing;
  const promise = loadProcessedCatalog(c);
  cache.set(c, promise);
  return promise;
}
