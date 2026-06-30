import type { ToolDefinition } from '../../ai/index.js';
import type { ToolModule } from '../types.js';

export const javascriptModule: ToolModule = {
  id: 'javascript-execution',
  capability: 'javascript-execution',

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_javascript',
          description: 'Execute JavaScript code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'JavaScript code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
