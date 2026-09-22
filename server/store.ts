import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ConflictError,
  CompanySchema,
  pickFields,
  type Doc,
  type ListOptions,
  type Store,
} from "../supabase/functions/_shared/model.ts";

export class LocalStore implements Store {
  db: DatabaseSync;
  constructor(path = ".local/desk.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_updated ON records(kind,updated_at);
      CREATE TABLE IF NOT EXISTS locks(key TEXT PRIMARY KEY,token TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,month TEXT,amount REAL,tokens INTEGER DEFAULT 0,settled INTEGER DEFAULT 0);`);
  }
  decode<T>(r: any): Doc<T> {
    return {
      kind: r.kind,
      id: r.id,
      data:
        r.kind === "company"
          ? CompanySchema.parse(JSON.parse(r.data))
          : JSON.parse(r.data),
      version: r.version,
      updatedAt: r.updated_at,
    };
  }
  async list<T>(kind: string, options?: ListOptions) {
    const ids = options?.ids;
    if (ids && !ids.length) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM records WHERE kind=? AND (?='' OR json_extract(data, '$.companyId')=?) AND updated_at>=? AND (?='' OR id=? OR json_extract(data, '$.clusterId')=?)${ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY CASE WHEN kind='event' THEN json_extract(data, '$.discoveredAt') ELSE updated_at END DESC,id LIMIT ?`,
      )
      .all(
        kind,
        options?.companyId || "",
        options?.companyId || "",
        options?.updatedSince || "",
        options?.cluster || "",
        options?.cluster || "",
        options?.cluster || "",
        ...(ids || []),
        options?.limit || 100000,
      );
    if (options?.fields) return rows.map((r) => this.project<T>(r, options.fields!));
    const docs = rows.map((r) => this.decode<T>(r));
    if (options?.summary)
      for (const doc of docs) {
        const data = doc.data as any;
        delete data.quoteHistory;
        delete data.rawText;
        if (kind === "import") {
          delete data.source;
          delete data.selections;
        }
        if (kind === "backup") delete data.records;
      }
    return docs;
  }
  async get<T>(kind: string, id: string, options?: { fields?: string[] }) {
    const r = this.db
      .prepare("SELECT * FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    if (!r) return null;
    return options?.fields
      ? this.project<T>(r, options.fields)
      : this.decode<T>(r);
  }
  // Projected records are partial by design: never schema-fill or write them back.
  project<T>(r: any, fields: string[]): Doc<T> {
    return {
      kind: r.kind,
      id: r.id,
      data: pickFields(JSON.parse(r.data), fields) as T,
      version: r.version,
      updatedAt: r.updated_at,
    };
  }
  async changes(since: string) {
    return this.db
      .prepare(
        "SELECT kind,id,version,updated_at AS updatedAt FROM records WHERE updated_at>=? AND kind IN ('company','event','settings','news_batch','job') ORDER BY updated_at,id",
      )
      .all(since) as {
      kind: string;
      id: string;
      version: number;
      updatedAt: string;
    }[];
  }
  async put<T>(
    kind: string,
    id: string,
    data: T,
    expected: number,
  ): Promise<Doc<T>> {
    return this.write(kind, id, data, expected);
  }
  private write<T>(
    kind: string,
    id: string,
    data: T,
    expected: number,
  ): Doc<T> {
    const at = new Date().toISOString();
    const json = JSON.stringify(data);
    if (expected === 0) {
      const result = this.db
        .prepare("INSERT OR IGNORE INTO records VALUES(?,?,?,1,?)")
        .run(kind, id, json, at);
      if (!result.changes) throw new ConflictError();
    } else {
      const result = this.db
        .prepare(
          "UPDATE records SET data=?,version=version+1,updated_at=? WHERE kind=? AND id=? AND version=?",
        )
        .run(json, at, kind, id, expected);
      if (!result.changes) throw new ConflictError();
    }
    return { kind, id, data, version: expected + 1, updatedAt: at };
  }
  async batch(
    writes: { kind: string; id: string; data: unknown; expected: number }[],
  ) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = writes.map((w) =>
        this.write(w.kind, w.id, w.data, w.expected),
      );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async remove(kind: string, id: string, expected: number) {
    if (
      !this.db
        .prepare("DELETE FROM records WHERE kind=? AND id=? AND version=?")
        .run(kind, id, expected).changes
    )
      throw new ConflictError();
  }
  async claim(key: string, seconds: number) {
    const token = crypto.randomUUID();
    const now = Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO locks VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE locks.expires<?",
      )
      .run(key, token, now + seconds * 1000, now);
    return result.changes ? token : null;
  }
  async release(key: string, token: string) {
    this.db
      .prepare("DELETE FROM locks WHERE key=? AND token=?")
      .run(key, token);
  }
  async reserve(amount: number, cap: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const month = new Date().toISOString().slice(0, 7);
      const row = this.db
        .prepare(
          "SELECT coalesce(sum(amount),0) AS total FROM ai_usage WHERE month=?",
        )
        .get(month) as { total: number };
      if (row.total + amount > cap)
        throw new Error(
          "TypeSafe monthly budget reached. News remains unclassified for review.",
        );
      const id = crypto.randomUUID();
      this.db
        .prepare("INSERT INTO ai_usage(id,month,amount) VALUES(?,?,?)")
        .run(id, month, amount);
      this.db.exec("COMMIT");
      return id;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async settle(id: string, actual: number, tokens: number) {
    this.db
      .prepare("UPDATE ai_usage SET amount=?,tokens=?,settled=1 WHERE id=?")
      .run(actual, tokens, id);
  }
  usage() {
    return this.db
      .prepare(
        "SELECT month,sum(amount) as cost,sum(tokens) as tokens,count(*) as requests FROM ai_usage GROUP BY month ORDER BY month DESC",
      )
      .all();
  }
}
