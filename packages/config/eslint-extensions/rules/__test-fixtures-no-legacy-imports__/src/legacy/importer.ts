// Inside the /legacy/ corpus: exempt from no-legacy-imports (self-reference).
import { inner } from './inner.js';
export const importer = inner;
