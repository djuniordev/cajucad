/** Minimal IndexedDB key/value helpers (documents and uploaded fonts). */

const DB = 'open-cad';
const VERSION = 2;
export type StoreName = 'docs' | 'fonts';

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      for (const s of ['docs', 'fonts']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  dbp.catch(() => (dbp = null));
  return dbp;
}

const done = (r: IDBRequest | IDBTransaction) =>
  new Promise<void>((res, rej) => {
    if (r instanceof IDBTransaction) {
      r.oncomplete = () => res();
      r.onerror = () => rej(r.error);
    } else {
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    }
  });

export async function idbPut(store: StoreName, key: string, value: unknown) {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  await done(tx);
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  const r = (await db()).transaction(store).objectStore(store).get(key);
  await done(r);
  return r.result as T | undefined;
}

export async function idbDelete(store: StoreName, key: string) {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function idbEntries<T>(store: StoreName): Promise<[string, T][]> {
  const os = (await db()).transaction(store).objectStore(store);
  const keys = os.getAllKeys();
  const vals = os.getAll();
  await done(vals);
  return (keys.result as string[]).map((k, i) => [k, vals.result[i] as T]);
}
