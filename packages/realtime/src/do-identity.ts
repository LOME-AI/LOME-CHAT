/**
 * Durable Object identity persistence, shared by every named DO in this
 * package. `DurableObjectState.id.name` is populated only when the object is
 * reached through a live `idFromName` stub; the platform revives an
 * alarm-firing (or hibernation-woken) DO from the stored id alone, where the
 * name is absent. So the name is persisted on every live construction and
 * read back when the platform reconstructs the DO. The first construction is
 * always a live wake, so storage is populated before any revival can happen.
 */

/** The slim slice of DO storage the identity resolver needs. */
export interface DoIdentityStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export interface DoIdentityOptions {
  /** DO-storage key under which the name is persisted. */
  readonly storageKey: string;
  /** Error thrown when neither the live id nor storage carries a name. */
  readonly missingMessage: string;
}

export async function resolveDoName(
  idName: string | undefined,
  store: DoIdentityStore,
  options: DoIdentityOptions
): Promise<string> {
  if (idName !== undefined) {
    await store.put(options.storageKey, idName);
    return idName;
  }
  const stored = await store.get(options.storageKey);
  if (stored !== undefined) return stored;
  throw new Error(options.missingMessage);
}
