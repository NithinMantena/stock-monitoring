import type { DeskEvent, Doc } from "../supabase/functions/_shared/model";

// Every article the desk shows is kept on this device with the sync cursor, so
// opening the desk downloads only what changed since the last visit. The hosted
// plan meters data transfer; re-downloading every stored article per visit was
// the largest browser cost. A stale copy is discarded and rebuilt.
const MAX_AGE_DAYS = 21;
const CACHE_VERSION = 1;
interface NewsCache {
  version: number;
  savedAt: string;
  cursor: string;
  events: Doc<DeskEvent>[];
}
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("research-desk-news", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("news");
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
export async function loadNewsCache(
  owner: string,
): Promise<{ cursor: string; events: Doc<DeskEvent>[] } | null> {
  const db = await database;
  const cache = await new Promise<NewsCache | undefined>((resolve, reject) => {
    const request = db.transaction("news").objectStore("news").get(owner);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (
    !cache ||
    cache.version !== CACHE_VERSION ||
    !cache.cursor ||
    Date.now() - Date.parse(cache.savedAt) > MAX_AGE_DAYS * 86400000
  )
    return null;
  return { cursor: cache.cursor, events: cache.events };
}
export async function saveNewsCache(
  owner: string,
  cursor: string,
  events: Doc<DeskEvent>[],
) {
  const db = await database;
  const value: NewsCache = {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    cursor,
    events,
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("news", "readwrite");
    tx.objectStore("news").put(value, owner);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
