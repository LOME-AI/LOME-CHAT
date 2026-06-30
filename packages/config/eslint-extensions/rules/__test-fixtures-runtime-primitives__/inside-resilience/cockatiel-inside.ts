// Fixture: stands in for the policy factory module — the one place allowed
// to import raw cockatiel. Zero findings expected.

import { retry } from 'cockatiel';

export const allowed = retry;
