import { z } from "zod";
import { statuses, type Status } from "./constants.ts";
export { statuses, statusLabels, defaultSettings } from "./constants.ts";
export type { Status } from "./constants.ts";
const text = (max = 500) => z.string().max(max);
const optionalNumber = z.number().finite().nullable();
export const QuoteSchema = z.object({
  price: z.number().positive().finite(),
  currency: text(12).min(1),
  session: text(10).regex(/^\d{4}-\d{2}-\d{2}$/),
  fetchedAt: text(40),
  source: text(100),
  pe: optionalNumber.default(null),
  marketCap: optionalNumber.default(null),
  peBasis: text(120).default("Unavailable"),
  fundamentalDate: text(40).default(""),
});
export type Quote = z.infer<typeof QuoteSchema>;
export const WatchPointSchema = z.object({
  id: text(100),
  text: text(3000).min(1),
  enabled: z.boolean().default(true),
});
export const RuleSchema = z.object({
  id: text(100),
  metric: z.enum(["price", "pe", "decline"]),
  threshold: z.number().positive().finite(),
  currency: text(12),
  baseline: z.number().positive().finite().nullable().default(null),
  enabled: z.boolean().default(true),
  triggered: z.boolean().default(false),
  episode: z.number().int().nonnegative().default(0),
  lastSession: text(40).default(""),
  lastFingerprint: text(200).default(""),
  basis: text(120).default("Trailing P/E"),
});
export type Rule = z.infer<typeof RuleSchema>;
export const FeedSchema = z.object({
  id: text(100),
  url: z.url().max(2000),
  label: text(120),
  official: z.boolean().default(false),
  lastSuccess: text(40).default(""),
  error: text(300).default(""),
});
export const CompanySchema = z.object({
  id: text(100),
  name: text(200).min(1),
  ticker: text(50).default(""),
  exchange: text(80).default(""),
  currency: text(12).default(""),
  status: z.enum(statuses).default("inbox"),
  cadence: z.enum(["auto", "daily", "weekly", "paused"]).default("auto"),
  originalGroup: text(300).default(""),
  researchDepth: text(50).default(""),
  tags: z.array(text(80)).max(50).default([]),
  notes: text(500000).default(""),
  thesis: text(3000).default(""),
  passReason: text(10000).default(""),
  source: text(2000).default(""),
  dateFound: text(40).default(""),
  lastReviewed: text(40).default(""),
  nextReview: text(40).default(""),
  targetPrice: z.number().positive().finite().nullable().default(null),
  archived: z.boolean().default(false),
  watchPoints: z.array(WatchPointSchema).max(20).default([]),
  rules: z.array(RuleSchema).max(30).default([]),
  feeds: z.array(FeedSchema).max(10).default([]),
  quote: QuoteSchema.nullable().default(null),
  provider: z.enum(["none", "eodhd", "fmp"]).default("none"),
  providerSymbol: text(80).default(""),
  quoteHistory: z.array(QuoteSchema).max(400).default([]),
  lastQuoteCheck: text(40).default(""),
  lastNewsCheck: text(40).default(""),
  quoteError: text(300).default(""),
  createdAt: text(40),
  updatedAt: text(40),
  revision: z.number().int().positive().default(1),
  importBatch: text(100).default(""),
  sourceLines: text(100).default(""),
});
export type Company = z.infer<typeof CompanySchema>;
export type Cadence = "daily" | "weekly" | "paused";
export interface DeskEvent {
  id: string;
  companyId: string;
  title: string;
  kind: "news" | "price" | "health";
  priority: "major" | "possible" | "normal" | "suppressed";
  body: string;
  url: string;
  publishedAt: string;
  discoveredAt: string;
  reviewed: boolean;
  feedback?: "useful" | "noise";
  evidence?: string;
  matches?: { text: string; relevance: number; direction: string }[];
  classification?: Record<string, unknown>;
  rawText?: string;
}
export interface Settings {
  timezone: "America/Chicago";
  digestHour: number;
  digestEnabled: boolean;
  skipEmpty: boolean;
}
export const SettingsSchema = z.object({
  timezone: z.literal("America/Chicago").default("America/Chicago"),
  digestHour: z.number().int().min(0).max(23).default(7),
  digestEnabled: z.boolean().default(false),
  skipEmpty: z.boolean().default(false),
});
export function newCompany(name: string, status: Status = "inbox"): Company {
  const now = new Date().toISOString();
  const query = new URLSearchParams({
    q: `"${name.trim().replace(/"/g, "")}" when:10d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  return CompanySchema.parse({
    id: crypto.randomUUID(),
    name: name.trim(),
    status,
    createdAt: now,
    updatedAt: now,
    feeds: [
      {
        id: crypto.randomUUID(),
        label: "Google News · broad headlines",
        url: `https://news.google.com/rss/search?${query}`,
        official: false,
      },
    ],
  });
}
export interface Doc<T = unknown> {
  id: string;
  kind: string;
  data: T;
  version: number;
  updatedAt: string;
}
export interface Store {
  list<T>(
    kind: string,
    options?: { summary?: boolean; limit?: number },
  ): Promise<Doc<T>[]>;
  get<T>(kind: string, id: string): Promise<Doc<T> | null>;
  put<T>(kind: string, id: string, data: T, expected: number): Promise<Doc<T>>;
  remove(kind: string, id: string, expected: number): Promise<void>;
  claim(key: string, seconds: number): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
  reserve(amount: number, cap: number): Promise<string>;
  settle(id: string, actual: number, tokens: number): Promise<void>;
  usage?(): unknown | Promise<unknown>;
}
export class ConflictError extends Error {
  constructor() {
    super(
      "This record changed elsewhere. Reload the latest version before saving.",
    );
  }
}
