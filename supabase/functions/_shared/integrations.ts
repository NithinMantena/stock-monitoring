import { z } from "zod";
import { hash } from "./engine.ts";
import type { Store } from "./model.ts";

export const scopes = [
  "read",
  "research:write",
  "monitoring:write",
  "news:write",
  "jobs:start",
  "jobs:control",
  "settings:write",
  "backup:read",
  "import:write",
] as const;
export type Scope = (typeof scopes)[number];
export type Actor = {
  id: string;
  channel: "website" | "mcp" | "openclaw" | "integration";
  admin: boolean;
  scopes: readonly Scope[];
};
export const ownerActor: Actor = {
  id: "owner",
  channel: "website",
  admin: true,
  scopes,
};
export interface Integration {
  name: string;
  channel: Actor["channel"];
  scopes: Scope[];
  hash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string;
}
export const IntegrationInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    channel: z.enum(["mcp", "openclaw", "integration"]),
    scopes: z.array(z.enum(scopes)).min(1),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export function publicIntegration(doc: {
  id: string;
  version: number;
  data: Integration;
}) {
  const { hash: _hash, ...data } = doc.data;
  return { id: doc.id, version: doc.version, ...data };
}
export async function issueIntegration(store: Store, input: unknown) {
  const data = IntegrationInput.parse(input);
  if (Date.parse(data.expiresAt) <= Date.now())
    throw new Error("Expiry must be in the future.");
  const id = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const token = `smt_${id}_${secret}`;
  const doc = await store.put<Integration>(
    "integration",
    id,
    {
      ...data,
      scopes: [...new Set(data.scopes)],
      hash: await hash(token),
      createdAt: new Date().toISOString(),
      revokedAt: "",
    },
    0,
  );
  return { ...publicIntegration(doc), token };
}
export async function authenticateIntegration(
  store: Store,
  token: string,
): Promise<Actor | null> {
  const match = /^smt_([a-f0-9-]{36})_([a-f0-9]{64})$/.exec(token);
  if (!match) return null;
  const doc = await store.get<Integration>("integration", match[1]);
  if (
    !doc ||
    doc.data.revokedAt ||
    Date.parse(doc.data.expiresAt) <= Date.now() ||
    doc.data.hash !== (await hash(token))
  )
    return null;
  return {
    id: doc.id,
    channel: doc.data.channel,
    scopes: doc.data.scopes,
    admin: false,
  };
}
