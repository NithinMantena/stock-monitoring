import type { Cadence, Company, DeskEvent, Quote, Rule } from "./model.ts";
export function cadenceOf(
  c: Pick<Company, "status" | "cadence" | "archived">,
): Cadence {
  if (c.archived || c.cadence === "paused") return "paused";
  if (c.cadence !== "auto") return c.cadence;
  return c.status === "owned" || c.status === "perpetual" ? "daily" : "weekly";
}
export function chicagoParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: parts.weekday,
  };
}
export function due(c: Company, last: string, now = new Date()): boolean {
  const cadence = cadenceOf(c);
  if (cadence === "paused") return false;
  if (!last) return true;
  const then = new Date(last);
  if (!Number.isFinite(then.getTime())) return true;
  if (cadence === "daily")
    return chicagoParts(then).date !== chicagoParts(now).date;
  return (
    now.getTime() - then.getTime() >= 7 * 86400000 ||
    (chicagoParts(now).weekday === "Mon" &&
      now.getTime() - then.getTime() >= 86400000)
  );
}
export function safeLink(value: string): string {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.toString() : "";
  } catch {
    return "";
  }
}
export async function hash(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function evaluateRules(
  company: Company,
  quotes: Quote[],
  at = new Date(),
): { rules: Rule[]; events: DeskEvent[] } {
  const rules = structuredClone(company.rules);
  const events: DeskEvent[] = [];
  for (const q of [...quotes].sort((a, b) =>
    a.session.localeCompare(b.session),
  )) {
    if (q.session > at.toISOString().slice(0, 10)) continue;
    for (const r of rules) {
      if (
        !r.enabled ||
        q.currency.toUpperCase() !== r.currency.toUpperCase() ||
        (r.lastSession && q.session < r.lastSession)
      )
        continue;
      const fp = `${q.session}|${q.price}|${q.pe}|${q.peBasis}|${r.threshold}|${r.baseline}|${r.basis}`;
      if (fp === r.lastFingerprint) continue;
      let value: number | null = null;
      if (r.metric === "price") value = q.price;
      if (
        r.metric === "pe" &&
        q.pe != null &&
        q.pe > 0 &&
        q.peBasis === r.basis
      )
        value = q.pe;
      if (r.metric === "decline" && r.baseline && r.baseline > 0)
        value = (100 * (r.baseline - q.price)) / r.baseline;
      if (value == null || !Number.isFinite(value)) continue;
      const hit =
        r.metric === "decline" ? value >= r.threshold : value <= r.threshold;
      const cleared =
        r.metric === "decline"
          ? value < r.threshold - 1
          : r.metric === "pe"
            ? value > r.threshold + 0.25
            : value > r.threshold * 1.01;
      if (hit && !r.triggered) {
        r.episode++;
        r.triggered = true;
        events.push({
          id: `rule-${company.id}-${r.id}-${r.episode}`,
          companyId: company.id,
          kind: "price",
          priority: "major",
          title:
            r.metric === "decline"
              ? `Down ${value.toFixed(1)}% from your baseline`
              : `${r.metric === "pe" ? r.basis : "Price"} reached ${value.toFixed(2)}`,
          body: `Observed ${q.session}. ${r.metric === "pe" ? r.basis : q.currency} threshold ${r.threshold}; value ${value.toFixed(2)}. ${q.source}. ${r.lastSession ? "First observed satisfaction in this episode." : "Condition met at first eligible observation."} Check the latest quote before acting.`,
          url: "",
          publishedAt: q.session,
          discoveredAt: at.toISOString(),
          reviewed: false,
        });
      } else if (cleared) r.triggered = false;
      r.lastSession = q.session;
      r.lastFingerprint = fp;
    }
  }
  return { rules, events };
}
export function quoteState(c: Company, now = new Date()): string {
  if (!c.quote)
    return c.provider === "none" ? "No data source" : "Awaiting first quote";
  if (c.quoteError) return "Refresh failed";
  const age =
    (now.getTime() - new Date(c.quote.session + "T00:00:00Z").getTime()) /
    86400000;
  return age > (cadenceOf(c) === "weekly" ? 10 : 4)
    ? "Stale quote"
    : c.quote.source === "Manual"
      ? "Manual observation"
      : "Latest stored close";
}
export function formatMoney(n: number | null | undefined, currency = "") {
  return n == null
    ? "—"
    : `${currency ? currency + " " : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, notation: n >= 1e6 ? "compact" : "standard" }).format(n)}`;
}
