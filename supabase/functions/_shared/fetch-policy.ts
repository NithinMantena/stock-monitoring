// Shared outbound-request policy: polite pacing for Google News, explicit
// throttling signals, and per-run memory of publishers that refuse automated reads.

// Google answers bursts with 429/503. Callers must retry later rather than
// record the source (or article) as permanently unavailable.
export class ThrottledError extends Error {
  readonly host: string;
  readonly status: number;
  constructor(host: string, status: number) {
    super(`${host} is rate limiting requests (HTTP ${status}); retrying later.`);
    this.host = host;
    this.status = status;
  }
}
export const throttleStatus = (status: number) =>
  status === 429 || status === 503;

// Minimum spacing between successive requests of each kind within one worker.
// Searches are the requests Google throttles first, so they are spaced widest.
// After a refusal the spacing doubles (to a cap) and eases back on success; runs
// save it, because hosted workers share addresses Google already rate limits.
export type Pacing = { search: number; page: number };
const base: Pacing = { search: 2000, page: 600 };
const ceiling: Pacing = { search: 20000, page: 10000 };
const pacing: Pacing = { ...base };
const lastRequest = { search: 0, page: 0 };
export function configurePacing(next: Partial<Pacing>) {
  Object.assign(base, next);
  Object.assign(pacing, next);
}
export function currentPacing(): Pacing {
  return { ...pacing };
}
export function restorePacing(saved?: Pacing) {
  pacing.search = Math.max(base.search, saved?.search ?? 0);
  pacing.page = Math.max(base.page, saved?.page ?? 0);
}
export function slowDown() {
  pacing.search = Math.min(ceiling.search, pacing.search * 2);
  pacing.page = Math.min(ceiling.page, pacing.page * 2);
}
export function speedUp() {
  pacing.search = Math.max(base.search, pacing.search * 0.95);
  pacing.page = Math.max(base.page, pacing.page * 0.95);
}
export async function paceGoogle(kind: keyof typeof pacing) {
  // Bounded by the interval itself, even if the clock moved backwards.
  const wait = Math.min(
    pacing[kind],
    lastRequest[kind] + pacing[kind] - Date.now(),
  );
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest[kind] = Date.now();
}

// Within a news run, a publisher that blocks us (401/403) or times out twice in a
// row is skipped for the rest of the run. Its articles are recorded exactly as a
// failed read would be. Reads outside a run (e.g. opening an article) never skip.
const HOST_FAILURE_LIMIT = 2;
const hostFailures = new Map<string, number>();
let tracking = false;
export function hostSkipped(host: string) {
  return tracking && (hostFailures.get(host) || 0) >= HOST_FAILURE_LIMIT;
}
export function noteHostResult(host: string, ok: boolean) {
  if (!tracking) return;
  if (ok) hostFailures.delete(host);
  else hostFailures.set(host, (hostFailures.get(host) || 0) + 1);
}
// Runs span several short worker invocations; the skip list is saved with the run.
export function beginHostTracking(skipped: string[] = []) {
  hostFailures.clear();
  for (const host of skipped) hostFailures.set(host, HOST_FAILURE_LIMIT);
  tracking = true;
}
export function trackedSkips(): string[] {
  return [...hostFailures]
    .filter(([, n]) => n >= HOST_FAILURE_LIMIT)
    .map(([host]) => host)
    .slice(0, 300);
}
export function endHostTracking() {
  hostFailures.clear();
  tracking = false;
}
