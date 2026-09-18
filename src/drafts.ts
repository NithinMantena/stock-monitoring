import type { Company } from "../supabase/functions/_shared/model";
export interface Draft {
  data: Company;
  base: Company;
  version: number;
  generation: number;
}
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("research-desk-drafts", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("drafts");
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
// IndexedDB writes are asynchronous, so typing never waits for a network or a large synchronous storage write.
export async function saveDraft(owner: string, id: string, draft?: Draft) {
  const db = await database;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    const key = `${owner}:${id}`;
    if (draft) tx.objectStore("drafts").put(draft, key);
    else tx.objectStore("drafts").delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function loadDrafts(owner: string): Promise<Map<string, Draft>> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const result = new Map<string, Draft>();
    const request = db.transaction("drafts").objectStore("drafts").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(result);
        return;
      }
      const key = String(cursor.key);
      if (key.startsWith(owner + ":"))
        result.set(key.slice(owner.length + 1), cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
