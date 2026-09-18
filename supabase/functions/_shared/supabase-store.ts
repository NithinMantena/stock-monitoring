import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, type Doc, type Store } from "./model.ts";
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
      data: r.data,
      version: r.version,
      updatedAt: r.updated_at,
    };
  }
  async list<T>(kind: string, options?: { summary?: boolean; limit?: number }) {
    const out: Doc<T>[] = [];
    for (let start = 0; ; start += 500) {
      if (options?.limit && start >= options.limit) break;
      const { data, error } = await this.db
        .from(options?.summary ? "desk_ui_records" : "desk_records")
        .select("*")
        .eq("owner_id", this.owner)
        .eq("kind", kind)
        .order("updated_at", { ascending: false })
        .order("id")
        .range(start, Math.min(start + 499, (options?.limit || 1000000) - 1));
      if (error) throw new Error("Database read failed.");
      out.push(...data.map((r) => this.decode<T>(r)));
      if (data.length < 500) break;
    }
    return out;
  }
  async get<T>(kind: string, id: string) {
    const { data, error } = await this.db
      .from("desk_records")
      .select("*")
      .eq("owner_id", this.owner)
      .eq("kind", kind)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error("Database read failed.");
    return data ? this.decode<T>(data) : null;
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
