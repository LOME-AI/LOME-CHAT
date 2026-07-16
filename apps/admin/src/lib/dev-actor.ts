import { useSyncExternalStore } from 'react';

/**
 * The two dev actors the API's dev-mode ADMIN_ACTOR_ALLOWLIST admits (see
 * packages/shared/src/env.config.ts). The actor switcher toggles between them;
 * the dev-auth fetch wrapper mints a fresh Access JWT per actor.
 */
export const DEV_ADMIN_ACTORS = ['admin@hushbox.test', 'ops@hushbox.test'] as const;

export type DevAdminActor = (typeof DEV_ADMIN_ACTORS)[number];

let currentActor: DevAdminActor = DEV_ADMIN_ACTORS[0];
const listeners = new Set<() => void>();

export function getDevActor(): DevAdminActor {
  return currentActor;
}

export function setDevActor(actor: DevAdminActor): void {
  if (actor === currentActor) return;
  currentActor = actor;
  for (const listener of listeners) listener();
}

export function subscribeDevActor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDevActor(): DevAdminActor {
  return useSyncExternalStore(subscribeDevActor, getDevActor);
}
