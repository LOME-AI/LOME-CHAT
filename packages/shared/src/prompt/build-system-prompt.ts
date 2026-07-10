import { BASE_SYSTEM_PREAMBLE } from './base-preamble.js';

import type { ModelFeatureId } from '../capabilities/types.js';

/**
 * Builds the system prompt based on active capabilities.
 * Mirrors the prompt building logic from the API for token estimation.
 */
export function buildSystemPrompt(
  capabilities: ModelFeatureId[],
  customInstructions?: string
): string {
  const sections: string[] = [];

  const isoDate = new Date().toISOString();
  const currentDate = isoDate.slice(0, Math.max(0, isoDate.indexOf('T')));
  sections.push(`${BASE_SYSTEM_PREAMBLE}\nCurrent date: ${currentDate}`);

  if (capabilities.includes('python-execution')) {
    sections.push(`## Python Code Execution
You can execute Python code using the execute_python tool.
- Use this for calculations, data processing, file operations
- Libraries available: numpy, pandas, matplotlib, requests
- Output is captured from stdout and returned to you
- Execution timeout: 30 seconds`);
  }

  if (capabilities.includes('javascript-execution')) {
    sections.push(`## JavaScript Code Execution
You can execute JavaScript code using the execute_javascript tool.
- Use this for calculations, data transformations, JSON processing
- Runs in Node.js environment
- Output is captured from console.log and returned to you
- Execution timeout: 30 seconds`);
  }

  if (customInstructions) {
    sections.push(`## User's Custom Instructions\n${customInstructions}`);
  }

  return sections.join('\n\n');
}
