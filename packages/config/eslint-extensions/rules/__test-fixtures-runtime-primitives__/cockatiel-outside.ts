// Fixture: this file sits outside the resilience policy factory, so every
// way of importing cockatiel below must be flagged: static import, dynamic
// import, named re-export, and star re-export.

import { retry } from 'cockatiel';

export * from 'cockatiel';

export { handleAll } from 'cockatiel';

export async function loadDynamically(): Promise<unknown> {
  return import('cockatiel');
}

export const reExported = retry;
