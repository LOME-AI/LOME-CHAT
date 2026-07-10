import { z } from 'zod';
import type { ToolDefinition, ToolRegistry } from '../ports/index.js';

/**
 * The closed, server-side tool registry. Definitions here describe tools the
 * model may call during an agentic loop; the adapter builds the concrete
 * provider/SDK tool from each. The set is deliberately fixed — a new tool is a
 * new registered entry, never open client input.
 */

/** The registry name a definition (chat turn, workflow node) selects web search by. */
export const WEB_SEARCH_TOOL_NAME = 'webSearch';

/**
 * The search engine web search is pinned to. Perplexity (Sonar) is the only
 * model-agnostic OpenRouter search engine that is zero-data-retention by
 * default — the search hop's ZDR guarantee. Never `auto`, which may route to
 * a non-ZDR engine (Exa).
 */
export const WEB_SEARCH_ENGINE = 'perplexity';

/** The client input schema the SDK tool advertises; OpenRouter returns results
 * server-side, so nothing client-side ever populates it. */
const webSearchInputSchema = z.object({ results: z.array(z.unknown()).optional() });

/**
 * Web search over OpenRouter's server-side `openrouter:web_search` tool, pinned
 * to Perplexity Sonar. It is PROVIDER-executed (the `providerTool` spec drives
 * the adapter's SDK construction), so `execute` is a defensive stub the model
 * provider never calls — reaching it is a wiring defect, not a runtime path.
 */
export const webSearch: ToolDefinition = {
  description:
    'Search the web for current information via the model provider’s server-side search.',
  inputSchema: webSearchInputSchema,
  execute: (): Promise<never> =>
    Promise.reject(
      new Error('webSearch runs server-side at the provider; its client execute is never invoked')
    ),
  providerTool: { kind: 'web-search', args: { engine: WEB_SEARCH_ENGINE } },
};

/** The closed registry: name → definition. Extending it is adding an entry. */
export const TOOL_REGISTRY: ToolRegistry = { [WEB_SEARCH_TOOL_NAME]: webSearch };

/**
 * Resolve a definition's declared tool names against the closed registry. An
 * empty selection yields an empty registry (a plain, no-tool call); any name
 * outside the closed set yields `undefined` — a clean compile guarantees the
 * names exist, so a miss is a wiring defect the caller surfaces, never a
 * silent drop.
 */
export function resolveToolRegistry(names: readonly string[]): ToolRegistry | undefined {
  const resolved: Record<string, ToolDefinition> = {};
  for (const name of names) {
    const definition = TOOL_REGISTRY[name];
    if (definition === undefined) return undefined;
    resolved[name] = definition;
  }
  return resolved;
}
