import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CompanySchema,
  ConflictError,
  type Doc,
  type ListOptions,
  type Store,
} from "./model.ts";
import { readDatabase } from "./database-read.ts";
export class SupabaseStore implements Store {
  private db: SupabaseClient;
  private owner: string;
  constructor(db: SupabaseClient, owner: string) {
    this.db = db;
    this.owner = owner;
  }
  decode<T>(r: any): Doc<T> {
    return {
      kind: r.kind,
      id: r.id,
      data: r.kind === "company" ? CompanySchema.parse(r.data) : r.data,
      version: r.version,
      updatedAt: r.updated_at,
    };
  }
  // Only the requested JSON paths leave the database; each is aliased f0, f1, …
  private columns(fields?: string[]) {
    return fields
      ? ["kind,id,version,updated_at", ...fields.map((f, i) => `f${i}:data->${f.split(".").join("->")}`)].join(",")
      : "*";
  }
  private project<T>(r: any, fields: string[]): Doc<T> {
    const flat: any = {};
    fields.forEach((f, i) => {
      if (r[`f${i}`] !== null && r[`f${i}`] !== undefined) {
        let target = flat;
        const path = f.split(".");
        for (const key of path.slice(0, -1)) target = target[key] ??= {};
        target[path.at(-1)!] = r[`f${i}`];
      }
    });
    // Projected records are partial by design: never schema-fill or write them back.
    return {
      kind: r.kind,
      id: r.id,
      data: flat as T,
      version: r.version,
      updatedAt: r.updated_at,
    };
  }
  async list<T>(kind: string, options?: ListOptions) {
    if (!options?.ids) return this.scan<T>(kind, options);
    // Bounded URL length; each chunk is one request.
    const out: Doc<T>[] = [];
    for (let i = 0; i < options.ids.length; i += 50)
      out.push(
        ...(await this.scan<T>(kind, options, options.ids.slice(i, i + 50))),
      );
    return out;
  }
  private async scan<T>(kind: string, options?: ListOptions, idChunk?: string[]) {
    const out: Doc<T>[] = [];
    for (let start = 0; ; start += 500) {
      if (options?.limit && start >= options.limit) break;
      const data = await readDatabase(`list:${kind}`, () => {
        let query = this.db
          .from(
            options?.summary && !options.fields
              ? "desk_ui_records"
              : "desk_records",
          )
          .select(this.columns(options?.fields))
          .eq("owner_id", this.owner)
          .eq("kind", kind);
        if (options?.companyId)
          query = query.eq("data->>companyId", options.companyId);
        if (options?.updatedSince)
          query = query.gte("updated_at", options.updatedSince);
        if (idChunk) query = query.in("id", idChunk);
        if (options?.cluster) {
          const key = JSON.stringify(options.cluster);
          query = query.or(`id.eq.${key},data->>clusterId.eq.${key}`);
        }
        return query
          .order(kind === "event" ? "data->>discoveredAt" : "updated_at", {
            ascending: false,
          })
          .order("id")
          .range(start, Math.min(start + 499, (options?.limit || 1000000) - 1));
      });
      out.push(
        ...((data || []) as any[]).map((r) =>
          options?.fields
            ? this.project<T>(r, options.fields)
            : this.decode<T>(r),
        ),
      );
      if (!data || data.length < 500) break;
    }
    return out;
  }
  async get<T>(kind: string, id: string, options?: { fields?: string[] }) {
    const data = await readDatabase(`get:${kind}`, () =>
      this.db
        .from("desk_records")
        .select(this.columns(options?.fields))
        .eq("owner_id", this.owner)
        .eq("kind", kind)
        .eq("id", id)
        .maybeSingle(),
    );
    if (!data) return null;
    return options?.fields
      ? this.project<T>(data, options.fields)
      : this.decode<T>(data);
  }
  async changes(since: string) {
    const rows: {
      kind: string;
      id: string;
      version: number;
      updatedAt: string;
    }[] = [];
    for (let start = 0; ; start += 500) {
      const data = await readDatabase("changes", () =>
        this.db
          .from("desk_records")
          .select("kind,id,version,updated_at")
          .eq("owner_id", this.owner)
          .in("kind", ["company", "event", "settings", "news_batch", "job"])
          .gte("updated_at", since)
          .order("updated_at")
          .order("kind")
          .order("id")
          .range(start, start + 499),
      );
      rows.push(
        ...(data || []).map((r) => ({
          kind: r.kind,
          id: r.id,
          version: r.version,
          updatedAt: r.updated_at,
        })),
      );
      if (!data || data.length < 500) return rows;
    }
  }
  async put<T>(
    kind: string,
    id: string,
    value: T,
    expected: number,
  ): Promise<Doc<T>> {
    const { data, error } = await this.db.rpc("desk_put", {
      p_owner: this.owner,
      p_kind: kind,
      p_id: id,
      p_data: value,
      p_expected: expected,
    });
    if (error?.message.includes("conflict")) throw new ConflictError();
    if (error) throw new Error("Database write failed.");
    return this.decode<T>(data);
  }
  async remove(kind: string, id: string, expected: number) {
    const { data, error } = await this.db
      .from("desk_records")
      .delete()
      .eq("owner_id", this.owner)
      .eq("kind", kind)
      .eq("id", id)
      .eq("version", expected)
      .select("id");
    if (error) throw new Error("Database delete failed.");
    if (!data?.length) throw new ConflictError();
  }
  async batch(
    writes: { kind: string; id: string; data: unknown; expected: number }[],
  ) {
    const { data, error } = await this.db.rpc("desk_batch_put", {
      p_owner: this.owner,
      p_writes: writes,
    });
    if (error?.message.includes("conflict")) throw new ConflictError();
    if (error) throw new Error("Atomic database write failed.");
    return (data as any[]).map((row) => this.decode(row));
  }
  async claim(key: string, seconds: number): Promise<string | null> {
    const { data, error } = await this.db.rpc("desk_claim", {
      p_owner: this.owner,
      p_key: key,
      p_seconds: seconds,
    });
    if (error) throw new Error("Job lock failed.");
    return data;
  }
  async release(key: string, token: string) {
    const { error } = await this.db.rpc("desk_release", {
      p_owner: this.owner,
      p_key: key,
      p_token: token,
    });
    if (error) throw new Error("Job lock release failed.");
  }
  async reserve(amount: number, cap: number): Promise<string> {
    const { data, error } = await this.db.rpc("desk_reserve_ai", {
      p_owner: this.owner,
      p_amount: amount,
      p_cap: cap,
    });
    if (error)
      throw new Error(
        "TypeSafe budget unavailable or exhausted. News remains unclassified.",
      );
    return data;
  }
  async settle(id: string, actual: number, tokens: number) {
    const { error } = await this.db
      .from("desk_ai_usage")
      .update({ amount: actual, tokens, settled: true })
      .eq("owner_id", this.owner)
      .eq("id", id);
    if (error) throw new Error("Usage reconciliation failed.");
  }
  async usage() {
    const { data, error } = await this.db
      .from("desk_usage_summary")
      .select("month,cost,tokens,requests")
      .eq("owner_id", this.owner);
    if (error) return [];
    return data;
  }
}
export { createClient };
