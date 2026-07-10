import { describe, expect, it } from 'vitest';
import {
  TOOL_REGISTRY,
  WEB_SEARCH_ENGINE,
  WEB_SEARCH_TOOL_NAME,
  resolveToolRegistry,
  webSearch,
} from './tool-registry.js';

describe('tool-registry: webSearch', () => {
  it('emits the OpenRouter web-search server tool pinned to the perplexity engine', () => {
    expect(WEB_SEARCH_ENGINE).toBe('perplexity');
    expect(webSearch.providerTool).toEqual({
      kind: 'web-search',
      args: { engine: 'perplexity' },
    });
  });

  it('is registered under the canonical name in the closed registry', () => {
    expect(WEB_SEARCH_TOOL_NAME).toBe('webSearch');
    expect(TOOL_REGISTRY).toEqual({ webSearch });
  });

  it('never runs a client execute — the provider searches server-side', async () => {
    await expect(webSearch.execute({})).rejects.toThrow(/server-side/i);
  });
});

describe('tool-registry: resolveToolRegistry', () => {
  it('resolves a subset of known tool names to their definitions', () => {
    expect(resolveToolRegistry([WEB_SEARCH_TOOL_NAME])).toEqual({ webSearch });
  });

  it('resolves an empty selection to an empty registry', () => {
    expect(resolveToolRegistry([])).toEqual({});
  });

  it('returns undefined when any requested name is not in the closed set', () => {
    expect(resolveToolRegistry([WEB_SEARCH_TOOL_NAME, 'unknownTool'])).toBeUndefined();
  });
});
