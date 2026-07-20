import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  useA11yStore,
  reconcileAccessibilityPreferences,
  type AccessibilityPreferences,
} from '@hushbox/ui/accessibility/store';
import { client, fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';

const DEBOUNCE_MS = 750;
const QUERY_KEY = ['accessibility-preferences'] as const;

interface ServerPrefsResponse {
  preferences: AccessibilityPreferences;
  updatedAt: string | null;
}

interface PutBody {
  preferences: AccessibilityPreferences;
  updatedAt: string;
}

function extractPrefs(state: ReturnType<typeof useA11yStore.getState>): AccessibilityPreferences {
  // Schema-driven: reconcile strips action functions and `updatedAt`, leaving
  // exactly the fields defined by `accessibilityPreferencesSchema`.
  return reconcileAccessibilityPreferences(state);
}

/**
 * Syncs accessibility preferences with the server using LWW semantics.
 * - Mount: GET, then reconcile (server-newer overwrites local; local-newer pushes; equal no-op).
 * - On store change: debounced PUT after DEBOUNCE_MS.
 * - On `visibilitychange` to 'hidden': flush any pending PUT immediately.
 *
 * Multi-device conflicts use whole-blob LWW — a later writer can clobber an
 * earlier writer's per-field changes. Acceptable here because accessibility
 * settings aren't co-edited in real time.
 *
 * Failures (401, network, etc.) are silently swallowed. localStorage is the
 * source of truth; the next store change retries the push.
 */
export function useAccessibilitySync(): void {
  const { isAuthenticated } = useStableSession();

  const { data: serverPrefs } = useQuery<ServerPrefsResponse>({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<ServerPrefsResponse> =>
      fetchJson(client.account.preferences.accessibility.$get()),
    enabled: isAuthenticated,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const putMutation = useMutation<unknown, Error, PutBody>({
    mutationFn: async (body: PutBody): Promise<unknown> =>
      fetchJson(client.account.preferences.accessibility.$put({ json: body })),
  });
  // TanStack Query's `mutate` is referentially stable across the mutation
  // lifecycle, but the mutation object is not. Depending on the whole object in
  // the sync effect below re-subscribes (and resets the debounce timer) on every
  // pending->success transition, which can drop a pending write.
  const { mutate: putMutate } = putMutation;

  const lastSyncedTsRef = React.useRef<string | null>(null);
  const bootReconciledRef = React.useRef<boolean>(false);

  React.useEffect(() => {
    if (!serverPrefs || bootReconciledRef.current) return;
    bootReconciledRef.current = true;

    const local = useA11yStore.getState();
    const localTs = local.updatedAt;
    const serverTs = serverPrefs.updatedAt;
    const serverMs = serverTs === null ? -Infinity : Date.parse(serverTs);
    const localMs = localTs === null ? -Infinity : Date.parse(localTs);

    if (serverMs > localMs) {
      // Server wins: stamp the dedup gate BEFORE applying server state so the
      // subscribe handler sees `state.updatedAt === lastSyncedTsRef.current`
      // and skips queuing an echo PUT.
      lastSyncedTsRef.current = serverTs;
      useA11yStore.setState({ ...serverPrefs.preferences, updatedAt: serverTs });
    } else if (localTs !== null && localMs > serverMs) {
      // Local wins: push to server.
      lastSyncedTsRef.current = localTs;
      putMutate({ preferences: extractPrefs(local), updatedAt: localTs });
    } else {
      // Equal: nothing to do.
      lastSyncedTsRef.current = serverTs;
    }
  }, [serverPrefs, putMutate]);

  React.useEffect(() => {
    if (!isAuthenticated) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ReturnType<typeof useA11yStore.getState> | null = null;

    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null && pending.updatedAt !== null) {
        const ts = pending.updatedAt;
        lastSyncedTsRef.current = ts;
        putMutate({ preferences: extractPrefs(pending), updatedAt: ts });
        pending = null;
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    const unsubscribe = useA11yStore.subscribe((state, previous) => {
      // Skip writes that originated from a server pull (same ts as last synced).
      if (state.updatedAt === lastSyncedTsRef.current) return;
      // Skip non-mutation rehydrates that don't bump the timestamp.
      if (state.updatedAt === previous.updatedAt) return;
      if (state.updatedAt === null) return;
      pending = state;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) clearTimeout(timer);
    };
  }, [isAuthenticated, putMutate]);
}
