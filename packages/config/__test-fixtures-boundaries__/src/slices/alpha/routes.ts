import { pipelineExample } from '../../middleware/pipeline-example.js';
import { buildGreeting } from './domain/index.js';
export const route = { buildGreeting, pipelineExample };
