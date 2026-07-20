import type { ToolDefinition } from '../../ai/index.js';
import type { ToolModule } from '../types.js';

export const pythonModule: ToolModule = {
  id: 'python-execution',
  capability: 'python-execution',

  getTools(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'execute_python',
          description: 'Execute Python code in a secure sandbox',
          parameters: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                description: 'Python code to execute',
              },
            },
            required: ['code'],
          },
        },
      },
    ];
  },
};
