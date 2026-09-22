import type { Doc } from "../supabase/functions/_shared/model.ts";
import type { NewsBatchSummary } from "../supabase/functions/_shared/news-batch.ts";

// Poll responses can arrive after a save or a newer poll. Never replace a newer version.
export function mergeDocuments<T>(
  current: Doc<T>[],
  incoming: Doc<T>[],
  optimistic = new Map<string, Doc<T>>(),
): Doc<T>[] {
  const merged = new Map(current.map((doc) => [doc.id, doc]));
  let changed = false;
  for (const doc of incoming) {
    if (doc.version > (merged.get(doc.id)?.version ?? 0)) {
      merged.set(doc.id, doc);
      changed = true;
    }
  }
  if (!changed && !optimistic.size) return current;
  return [...merged.values()].map((doc) => optimistic.get(doc.id) || doc);
}
export function latestBatch(
  current?: NewsBatchSummary | null,
  incoming?: NewsBatchSummary | null,
) {
  if (!incoming) return current || incoming;
  if (!current) return incoming;
  return (
    current.id === incoming.id
      ? current.updatedAt > incoming.updatedAt
      : current.createdAt > incoming.createdAt
  )
    ? current
    : incoming;
}
