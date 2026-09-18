import { newCompany, type Company, type Status } from "./model.ts";

export interface ImportCandidate {
  id: string;
  name: string;
  group: string;
  status: Status;
  notes: string;
  start: number;
  end: number;
  review: boolean;
}
export interface ImportPreview {
  source: string;
  candidates: ImportCandidate[];
  unattached: string;
  lineCount: number;
}
function groupStatus(group: string): Status {
  if (/perpetual/i.test(group)) return "perpetual";
  if (/pass/i.test(group)) return "pass";
  if (/potential/i.test(group)) return "watchlist";
  return "inbox";
}
const nonNames =
  /^(what |why |how |need |check |watch |keep |have |are |and |then |if |we |they |company |currently |trading |business$|moat$|valuation$|reasoning$|revenue growth$|financials?$|financisl$|capital allocation$|management$|thin |clean financials|pay out|retain |super well|well researched|ideas that|real estate worth|cash that|from |there |most |three parts|for each|\d+[mk]? (?:GBP|USD|EUR).*market cap|cleaning and decontamination|construction and engineer|profitable last|fou?y?nded in)/i;
export function parseInvestmentMarkdown(source: string): ImportPreview {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const candidates: ImportCandidate[] = [];
  const unattached: string[] = [];
  let group = "Unsorted";
  let current: ImportCandidate | null = null;
  const append = (line: string, index: number) => {
    if (current) {
      current.notes += line + "\n";
      current.end = index + 1;
    } else unattached.push(line);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{2,}\s/.test(line) || /^Companies to (?:add|be added)/i.test(line)) {
      group =
        line
          .replace(/^#+\s*/, "")
          .replace(/\*\*/g, "")
          .trim() || group;
      current = null;
      unattached.push(line);
      continue;
    }
    const top = /^-\s+(.+?)\s*$/.exec(line);
    if (!top) {
      append(line, i);
      continue;
    }
    const raw = top[1].replace(/\\([&+*_.])/g, "$1").trim();
    const clean = raw.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    const isCandidate =
      clean.length > 1 &&
      clean.length < 130 &&
      /^[A-Z0-9À-Ž]/.test(clean) &&
      !nonNames.test(clean) &&
      !/^H[12] \d{4}/.test(clean);
    if (!isCandidate) {
      append(line, i);
      continue;
    }
    const name = clean
      .replace(
        /\s*\((?:date last checked:|research|look into|add writeup|https?:\/\/|\d{1,2}\/)[^)]*\)/gi,
        "",
      )
      .trim();
    const review =
      clean.length > 65 ||
      /\band\b|ISIN:|^PGOLD|^Keeper|^[A-Z]{1,4}$/.test(clean) ||
      /[.!?]$/.test(clean);
    current = {
      id: `line-${i + 1}`,
      name,
      group,
      status: groupStatus(group),
      notes: line + "\n",
      start: i + 1,
      end: i + 1,
      review,
    };
    candidates.push(current);
  }
  const names = new Map<string, number>();
  for (const item of candidates) {
    const key = item.name
      .toLowerCase()
      .replace(/\([^)]*\)/g, "")
      .trim();
    names.set(key, (names.get(key) || 0) + 1);
  }
  for (const item of candidates)
    if (
      (names.get(
        item.name
          .toLowerCase()
          .replace(/\([^)]*\)/g, "")
          .trim(),
      ) || 0) > 1
    )
      item.review = true;
  return {
    source,
    candidates,
    unattached: unattached.join("\n"),
    lineCount: lines.length,
  };
}
export function candidateToCompany(
  item: ImportCandidate,
  batch: string,
): Company {
  return {
    ...newCompany(item.name, item.status),
    originalGroup: item.group,
    notes: item.notes.trim(),
    importBatch: batch,
    sourceLines: `${item.start}–${item.end}`,
    source: "Investment Pitch List.md",
  };
}
export function markdownExport(c: Company): string {
  return `---\nid: ${JSON.stringify(c.id)}\nname: ${JSON.stringify(c.name)}\nstatus: ${c.status}\nticker: ${JSON.stringify(c.ticker)}\ncurrency: ${JSON.stringify(c.currency)}\nmonitoring: ${c.cadence}\ntags: ${JSON.stringify(c.tags)}\n---\n\n# ${c.name}\n\n${c.thesis ? "## Thesis\n\n" + c.thesis + "\n\n" : ""}${c.passReason ? "## Why I passed\n\n" + c.passReason + "\n\n" : ""}## Notes\n\n${c.notes}\n\n## Watching\n\n${c.watchPoints.map((w) => "- " + w.text).join("\n")}\n`;
}
