// IndexedDB-backed protection for the OPAQUE export key.
//
// The export key is never persisted as raw bytes. A per-device, NON-EXTRACTABLE
// AES-GCM CryptoKey is generated and stored as a live key object in IndexedDB —
// a structured clone preserves a CryptoKey whose raw bytes JS can never read
// back. The export key is encrypted under that device key and only
// {iv, ciphertext, userId} is persisted alongside it. An attacker who statically
// dumps storage obtains ciphertext plus an unusable key handle, never a key that
// can reconstruct the account private key offline.
//
// E2E builds swap this module wholesale for `device-key-store.e2e.ts` at Vite
// module-resolution time (see device-key-store-e2e-resolution.ts) — never via a
// runtime dynamic import(): this module loads on the auth-bootstrap path for
// every route, and a navigation racing a runtime chunk fetch aborts it, turning
// the import() into an uncaught rejection that blanks the page.

const DB_NAME = 'hushbox-device-key';
const STORE_NAME = 'device-key';
const RECORD_KEY = 'export-key';
const IV_BYTES = 12;

interface DeviceKeyRecord {
  deviceKey: CryptoKey;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
  userId: string;
}

// crypto.subtle wants ArrayBuffer-backed views (BufferSource); a plain
// `Uint8Array` widens to `ArrayBufferLike`. Copy into a fresh ArrayBuffer-backed
// array so the exact byte view is guaranteed regardless of the caller's origin.
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

export interface ProtectedExportKey {
  exportKey: Uint8Array;
  userId: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (): void => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.addEventListener('error', () => {
      reject(new Error('IndexedDB open failed', { cause: request.error }));
    });
  });
}

function runRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
    request.onsuccess = (): void => {
      resolve(request.result);
    };
    request.addEventListener('error', () => {
      reject(new Error('IndexedDB request failed', { cause: request.error }));
    });
  });
}

export async function storeExportKeyProtected(
  exportKey: Uint8Array,
  userId: string
): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    // Non-extractable: the raw device-key bytes can never be read back out of JS.
    false,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, toArrayBufferView(exportKey))
  );
  const record: DeviceKeyRecord = { deviceKey, iv, ciphertext, userId };

  const db = await openDb();
  try {
    await runRequest(db, 'readwrite', (store) => store.put(record, RECORD_KEY));
  } finally {
    db.close();
  }
}

export async function loadExportKeyProtected(): Promise<ProtectedExportKey | null> {
  const db = await openDb();
  let record: DeviceKeyRecord | undefined;
  try {
    record = await runRequest<DeviceKeyRecord | undefined>(
      db,
      'readonly',
      (store) => store.get(RECORD_KEY) as IDBRequest<DeviceKeyRecord | undefined>
    );
  } finally {
    db.close();
  }

  if (!record) {
    return null;
  }

  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      record.deviceKey,
      record.ciphertext
    )
  );
  return { exportKey: plaintext, userId: record.userId };
}

export async function clearDeviceKeyStore(): Promise<void> {
  const db = await openDb();
  try {
    await runRequest(db, 'readwrite', (store) => store.delete(RECORD_KEY));
  } finally {
    db.close();
  }
}
