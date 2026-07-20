import { buildSystemPrompt, type ModelFeatureId } from '@hushbox/shared';
import { pythonModule } from './modules/python.js';
import { javascriptModule } from './modules/javascript.js';
import type { ToolModule, PromptBuilderOptions, BuiltPrompt } from './types.js';

const TOOL_MODULES: ToolModule[] = [pythonModule, javascriptModule];

export function buildPrompt(options: PromptBuilderOptions): BuiltPrompt {
  const capabilitySet = new Set<ModelFeatureId>(options.supportedCapabilities);

  const activeModules = TOOL_MODULES.filter((m) => capabilitySet.has(m.capability));

  const systemPrompt = buildSystemPrompt(options.supportedCapabilities, options.customInstructions);
  const tools = activeModules.flatMap((m) => m.getTools());

  return { systemPrompt, tools };
}
