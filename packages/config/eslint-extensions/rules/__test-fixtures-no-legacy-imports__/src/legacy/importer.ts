// Inside a legacy dir: exempt from no-legacy-imports.
import { old } from '../legacy_old.js';
export const importer = old;
