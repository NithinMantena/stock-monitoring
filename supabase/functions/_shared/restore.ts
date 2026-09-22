import { z } from "zod";
import { CompanySchema, SettingsSchema } from "./model.ts";

const text = z.string();
const probability = z.number().finite().min(0).max(1);
const Screening = z
  .object({
    version: text,
    at: text,
    disposition: z.enum(["relevant", "uncertain", "suppressed"]),
    reason: text,
    category: text,
    identity: probability,
    materiality: z.number().finite().min(0).max(4),
    quality: z.number().finite().min(0).max(3),
    addedValue: z.number().finite().min(0).max(3),
    evidenceSufficiency: probability,
    primary: z.boolean(),
    contentDepth: z.enum([
      "full",
      "partial",
      "snippet",
      "supplied",
      "unavailable",
    ]),
    charactersRead: z.number().nonnegative(),
    availableCharacters: z.number().nonnegative(),
    retrievalNote: text.default(""),
    possibleMajor: z.boolean(),
    sourceUrl: text,
    comparisons: z
      .array(z.object({ id: text, relation: text, probability }))
      .optional(),
  })
  .passthrough();
const Event = z
  .object({
    id: text.min(1),
    companyId: text.min(1),
    kind: z.enum(["news", "price", "health"]),
    priority: z.enum(["major", "normal", "possible", "suppressed"]),
    title: text,
    body: text,
    url: text,
    publishedAt: text,
    discoveredAt: text,
    reviewed: z.boolean(),
    saved: z.boolean().optional(),
    inboxAt: text.optional(),
    feedback: z.enum(["useful", "noise"]).optional(),
    clusterId: text.optional(),
    classification: z.record(text, z.unknown()).optional(),
    screening: Screening.optional(),
    matches: z
      .array(z.object({ text, relevance: probability, direction: text }))
      .optional(),
  })
  .passthrough();
const Revision = z
  .object({ companyId: text.min(1), notes: text, thesis: text, at: text })
  .passthrough();
const Import = z
  .object({
    source: text,
    count: z.number().nonnegative().optional(),
    at: text.optional(),
  })
  .passthrough();

// Validate the complete file before the first write, including the shapes rendered by the UI.
export function validateRestoreRecords(
  records: { kind: string; id: string; data: unknown }[],
) {
  const keys = new Set<string>();
  return records.map((record) => {
    const key = `${record.kind}:${record.id}`;
    if (keys.has(key)) throw new Error("Backup contains duplicate record IDs.");
    keys.add(key);
    const schema = {
      company: CompanySchema,
      settings: SettingsSchema,
      event: Event,
      revision: Revision,
      import: Import,
    }[record.kind];
    if (!schema) throw new Error("Backup contains an unsupported record type.");
    const data = schema.parse(record.data);
    if (
      (record.kind === "company" || record.kind === "event") &&
      (data as { id: string }).id !== record.id
    )
      throw new Error("Backup record ID does not match its contents.");
    return { ...record, data };
  });
}
