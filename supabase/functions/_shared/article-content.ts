import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { Company, Store } from "./model.ts";
import type { Article, Env } from "./providers.ts";
import { cleanNewsText } from "./news.ts";
import { hash } from "./engine.ts";
import { MAX_ARTICLE_CHARS } from "./screening-policy.ts";
import { resolve4, resolve6 } from "node:dns/promises";
import {
  hostSkipped,
  noteHostResult,
  paceGoogle,
  ThrottledError,
  throttleStatus,
} from "./fetch-policy.ts";

const DEFAULT_HOSTS = [
  "news.google.com",
  "ir.netflix.net",
  "about.netflix.com",
  "s22.q4cdn.com",
  "investors.progressive.com",
  "progressive.mediaroom.com",
  "s202.q4cdn.com",
  "www.sec.gov",
  "data.sec.gov",
  "www.ftc.gov",
  "www.justice.gov",
  "www.courtlistener.com",
  "www.reuters.com",
  "apnews.com",
  "www.ft.com",
  "www.wsj.com",
  "www.bloomberg.com",
  "www.economist.com",
  "www.nytimes.com",
  "www.bbc.com",
  "www.cnbc.com",
  "www.insurancejournal.com",
  "www.insurancebusinessmag.com",
  "www.prnewswire.com",
  "www.businesswire.com",
  "www.globenewswire.com",
  "finance.yahoo.com",
];
export const EXTRACTION_VERSION = "paragraphs-v2";
function verifiedPrimary(c: Company, url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      [
        "www.sec.gov",
        "data.sec.gov",
        "www.ftc.gov",
        "www.justice.gov",
      ].includes(host) ||
      primaryUrls(c).some((p) => new URL(p).hostname === host)
    );
  } catch {
    return false;
  }
}
export function primarySourceDefaults(
  c: Pick<Company, "name" | "ticker">,
): string[] {
  if (
    /^zoom(?: video)?(?: communications)?(?:,? inc\.?)?$/i.test(
      c.name.trim(),
    ) ||
    c.ticker.toUpperCase() === "ZM"
  )
    return [
      "https://investors.zoom.us/financial-information/quarterly-results",
    ];
  if (/american coastal/i.test(c.name) || c.ticker.toUpperCase() === "ACIC")
    return ["https://investors.amcoastal.com/news/default.aspx"];
  if (
    /^(netflix)(,? inc\.?)?$/i.test(c.name.trim()) ||
    c.ticker.toUpperCase() === "NFLX"
  )
    return [
      "https://ir.netflix.net/financials/quarterly-earnings/default.aspx",
      "https://ir.netflix.net/investor-news-and-events/financial-releases/default.aspx",
    ];
  if (
    /^(the )?progressive( corporation| corp\.?)?$/i.test(c.name.trim()) ||
    c.ticker.toUpperCase() === "PGR"
  )
    return [
      "https://investors.progressive.com/financials/financial-news-releases/default.aspx",
    ];
  return [];
}
export function primaryUrls(c: Company): string[] {
  return [
    ...new Set([
      ...primarySourceDefaults(c),
      ...c.primarySources,
      ...c.feeds.filter((f) => f.official).map((f) => f.url),
    ]),
  ];
}
export function contentHosts(c: Company, env: Env): Set<string> {
  const hosts = new Set(
    [
      ...DEFAULT_HOSTS,
      ...(env.ALLOWED_ARTICLE_HOSTS || "").split(","),
      ...(env.ALLOWED_FEED_HOSTS || "").split(","),
    ]
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const host of c.articleHosts || []) hosts.add(host.trim().toLowerCase());
  for (const url of primaryUrls(c)) {
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* invalid source is reported when fetched */
    }
  }
  return hosts;
}
export function validateContentUrl(value: string, hosts: Set<string>): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !hosts.has(u.hostname) ||
    /^(localhost|.*\.(local|internal|localhost)|\d+(?:\.\d+){3}|\[.*\])$/i.test(
      u.hostname,
    )
  )
    throw new Error("Article host is not enabled for text retrieval.");
  u.hash = "";
  return u.href;
}

export function publicAddress(address: string): boolean {
  if (address.includes(":"))
    return (
      /^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2001:(?:0:|db8:|0?10:|0?20:)|^2002:/i.test(address)
    );
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function authorizeDocumentUrl(
  value: string,
  hosts: Set<string>,
  env: Env,
) {
  const host = new URL(value).hostname;
  // Keep explicit HTTPS/port/credential/private-host checks for every redirect.
  if (hosts.has(host) || env.ALLOW_PUBLIC_ARTICLE_HOSTS === "false")
    return validateContentUrl(value, hosts);
  const url = validateContentUrl(value, new Set([...hosts, host]));
  if (
    !host.includes(".") ||
    /\.(test|invalid|example|home|lan|arpa)$/i.test(host)
  )
    throw new Error("Article destination is not a public website.");
  const answers = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const addresses = answers.flatMap((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
    throw new Error(
      "Article destination does not resolve to public Internet addresses.",
    );
  return url;
}
export function canonicalUrl(value: string): string {
  try {
    const u = new URL(value);
    u.hash = "";
    for (const key of [...u.searchParams.keys()])
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    return u.href;
  } catch {
    return value;
  }
}

export async function fetchDocument(
  url: string,
  hosts: Set<string>,
  env: Env,
  init: RequestInit = {},
) {
  let current = await authorizeDocumentUrl(url, hosts, env);
  const first = new URL(current).hostname;
  // No successful publisher read took over 8 s in the 2026-09-22 profile; configured
  // and regulator sources keep a longer allowance for large primary documents.
  const signal = AbortSignal.timeout(
    hosts.has(first) || first.endsWith("sec.gov") ? 10000 : 8000,
  );
  for (let redirects = 0; redirects <= 4; redirects++) {
    const host = new URL(current).hostname;
    const google = host === "news.google.com";
    if (!google && hostSkipped(host))
      throw new Error(
        `Skipped: ${host} blocked or timed out repeatedly earlier in this run.`,
      );
    if (google) await paceGoogle("page");
    let response: Response;
    try {
      response = await fetch(current, {
        ...init,
        redirect: "manual",
        signal,
        headers: {
          "User-Agent":
            env.FEED_USER_AGENT ||
            "ResearchDesk/0.2 (personal research; nithin@mantena.com)",
          ...init.headers,
        },
      });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") noteHostResult(host, false);
      throw error;
    }
    if (google && throttleStatus(response.status)) {
      await response.body?.cancel();
      throw new ThrottledError(host, response.status);
    }
    if (response.status === 401 || response.status === 403)
      noteHostResult(host, false);
    else if (response.ok) noteHostResult(host, true);
    if (response.status >= 300 && response.status < 400) {
      const target = response.headers.get("location");
      await response.body?.cancel();
      if (!target) throw new Error("Source redirect has no destination.");
      current = await authorizeDocumentUrl(
        new URL(target, current).href,
        hosts,
        env,
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Source returned HTTP ${response.status}.`);
    }
    const limit = 8000000;
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error("Document exceeds 8 MB retrieval limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Source returned no document.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit)
          throw new Error("Document exceeds 8 MB retrieval limit.");
        chunks.push(value);
      }
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError") noteHostResult(host, false);
      throw error;
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return {
      bytes,
      url: current,
      type: response.headers.get("content-type") || "",
    };
  }
  throw new Error("Too many source redirects.");
}

export function extractHtml(html: string, url: string) {
  // EDGAR exhibits may wrap the HTML in SGML DOCUMENT/TEXT records.
  const start = html.search(/<html\b/i);
  if (start > 0) html = html.slice(start);
  const end = html.toLowerCase().lastIndexOf("</html>");
  if (end >= 0) html = html.slice(0, end + 7);
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll("a[href]")].map((a) => {
    try {
      return {
        url: new URL(a.getAttribute("href")!, url).href,
        title: cleanNewsText(a.textContent || ""),
      };
    } catch {
      return { url: "", title: "" };
    }
  });
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  const date =
    document
      .querySelector(
        'meta[property="article:published_time"],meta[name="date"]',
      )
      ?.getAttribute("content") || "";
  const restricted =
    /["']isAccessibleForFree["']\s*:\s*(?:false|["']false["'])/i.test(html);
  // Never evaluate page scripts or infer article quality from navigation/related headlines.
  document
    .querySelectorAll("script,style,nav,footer,header,aside,form")
    .forEach((n) => n.remove());
  const structuredBody =
    new URL(url).hostname === "www.sec.gov" &&
    new URL(url).pathname.startsWith("/Archives/")
      ? document.body.innerHTML
      : "";
  const parsed = new Readability(document as unknown as Document, {
    charThreshold: 150,
  }).parse();
  const body = (structuredBody || parsed?.content || "")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .split("\n")
    .map(cleanNewsText)
    .filter(Boolean)
    .join("\n")
    .replace(/(?:\|[ \t]*){2,}/g, " | ");
  return {
    text: restricted ? "" : body,
    title: cleanNewsText(parsed?.title || ""),
    links,
    date,
    canonical: canonical ? new URL(canonical, url).href : url,
    restricted,
  };
}

async function resolveGoogle(
  url: string,
  hosts: Set<string>,
  env: Env,
): Promise<string> {
  // Google redirects feed links to the same page with its locale parameters
  // added; asking for that page directly saves one of three Google requests.
  const page = new URL(url);
  if (page.pathname.startsWith("/rss/articles/") && !page.searchParams.has("hl"))
    for (const [key, value] of [
      ["hl", "en-US"],
      ["gl", "US"],
      ["ceid", "US:en"],
    ])
      page.searchParams.set(key, value);
  const response = await fetchDocument(page.href, hosts, env);
  if (new URL(response.url).hostname !== "news.google.com") return response.url;
  const html = new TextDecoder().decode(response.bytes);
  const { document } = parseHTML(html);
  const node = document.querySelector("[data-n-a-sg][data-n-a-ts]");
  const id = new URL(url).pathname.split("/").at(-1);
  if (!node || !id)
    throw new Error("Google News did not expose the publisher link.");
  const signature = node.getAttribute("data-n-a-sg");
  const timestamp = Number(node.getAttribute("data-n-a-ts"));
  if (!signature || !Number.isFinite(timestamp))
    throw new Error("Publisher link metadata unavailable.");
  // Best-effort public link resolver. Rate limits/challenges are surfaced, never bypassed.
  const query = [
    "garturlreq",
    [
      [
        "en-US",
        "US",
        ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"],
        null,
        null,
        1,
        1,
        "US:en",
        null,
        480,
        null,
        null,
        null,
        null,
        null,
        0,
        5,
      ],
      "en-US",
      "US",
      1,
      [2, 4, 8],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    id,
    timestamp,
    signature,
  ];
  const body = new URLSearchParams({
    "f.req": JSON.stringify([
      [["Fbv4je", JSON.stringify(query), null, "generic"]],
    ]),
  });
  const decoded = await fetchDocument(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute",
    hosts,
    env,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  const text = new TextDecoder().decode(decoded.bytes);
  for (const line of text.split("\n")) {
    try {
      const rows = JSON.parse(line);
      for (const row of rows) {
        if (row[1] !== "Fbv4je" || typeof row[2] !== "string") continue;
        const result = JSON.parse(row[2]);
        if (result[0] === "garturlres" && typeof result[1] === "string")
          return result[1];
      }
    } catch {
      /* non-JSON framing */
    }
  }
  throw new Error("Publisher link resolution failed.");
}

export async function enrichArticle(
  c: Company,
  input: Article,
  env: Env,
  store: Store,
  options: { throttleOk?: boolean } = {},
): Promise<Article> {
  if (input.contentDepth === "supplied") return input;
  const hosts = contentHosts(c, env);
  const key = await hash(
    `${EXTRACTION_VERSION}|${input.url}|${input.title}|${input.publishedAt}`,
  );
  const cached = input.url
    ? await store.get<{ at: string; article: Article }>("article_cache", key)
    : null;
  if (
    cached &&
    !cached.data.article.retrievalNote?.includes("host is not enabled") &&
    Date.now() - Date.parse(cached.data.at) <
      (cached.data.article.contentDepth === "full" ? 7 : 1) * 86400000
  )
    return {
      ...input,
      ...cached.data.article,
      id: input.id,
      official: verifiedPrimary(c, cached.data.article.url),
    };
  let article: Article = {
    ...input,
    official: verifiedPrimary(c, input.url),
    contentDepth: input.contentDepth || "snippet",
    availableCharacters: input.text.length,
  };
  try {
    if (!input.url) return article;
    const url =
      new URL(input.url).hostname === "news.google.com"
        ? await resolveGoogle(input.url, hosts, env)
        : input.url;
    article.url = canonicalUrl(url);
    article.source = new URL(url).hostname;
    const doc = await fetchDocument(url, hosts, env);
    let text = "",
      partial = false;
    if (/application\/pdf/i.test(doc.type) || /\.pdf(?:$|\?)/i.test(doc.url)) {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(doc.bytes);
      try {
        for (let page = 1; page <= Math.min(pdf.numPages, 80); page++) {
          const content = await (await pdf.getPage(page)).getTextContent();
          text +=
            `\n[Page ${page}] ` +
            content.items.map((item: any) => item.str || "").join(" ");
          if (text.length > MAX_ARTICLE_CHARS) {
            partial = true;
            break;
          }
        }
        partial ||= pdf.numPages > 80;
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else {
      const extracted = extractHtml(
        new TextDecoder().decode(doc.bytes),
        doc.url,
      );
      if (extracted.restricted)
        throw new Error(
          "Publisher restricts full text; accessible snippet only.",
        );
      text = extracted.text;
      article.extractedTitle = extracted.title;
      if (input.official) {
        const attachments = [
          ...new Map(
            extracted.links
              .filter(
                (l) =>
                  /ex(?:hibit)?[-_]?99|shareholder.{0,12}letter/i.test(
                    l.title + " " + l.url,
                  ) && l.url !== doc.url,
              )
              .map((l) => [l.url, l]),
          ).values(),
        ].slice(0, 2);
        for (const attachment of attachments) {
          // An exhibit is fetched as its own document; do not recursively traverse its links.
          const additional = await enrichArticle(
            { ...c, primarySources: [] },
            {
              id: await hash(attachment.url),
              title: attachment.title,
              text: "",
              url: attachment.url,
              source: input.source,
              official: false,
              publishedAt: input.publishedAt,
            },
            env,
            store,
            options,
          );
          if (
            additional.contentDepth === "full" ||
            additional.contentDepth === "partial"
          )
            text += `\n[Attached primary document: ${additional.url}]\n${additional.text}`;
          else {
            partial = true;
            article.retrievalNote = "Linked primary exhibit could not be read.";
          }
        }
      }
      if (!article.publishedAt && Number.isFinite(Date.parse(extracted.date)))
        article.publishedAt = new Date(extracted.date).toISOString();
    }
    if (
      text.length < 200 ||
      /^(access denied|just a moment|enable javascript)/i.test(text)
    )
      throw new Error("Could not extract a substantive article body.");
    article = {
      ...article,
      text: text.slice(0, MAX_ARTICLE_CHARS),
      url: canonicalUrl(doc.url),
      availableCharacters: text.length,
      contentDepth:
        partial || text.length > MAX_ARTICLE_CHARS ? "partial" : "full",
      retrievalNote:
        article.retrievalNote ||
        (partial || text.length > MAX_ARTICLE_CHARS
          ? "Document exceeds the reading limit; available sections assessed."
          : "Article/document text retrieved."),
    };
    article.official = verifiedPrimary(c, doc.url);
  } catch (e) {
    // Throttling says nothing about the article; retry it later rather than
    // caching (and screening) it as unreadable.
    if (e instanceof ThrottledError && !options.throttleOk) throw e;
    article.retrievalNote =
      e instanceof Error ? e.message : "Full text unavailable.";
  }
  if (input.url)
    await store
      .put(
        "article_cache",
        key,
        { at: new Date().toISOString(), article },
        cached?.version || 0,
      )
      .catch(() => undefined);
  return article;
}

// Primary pages supply original documents directly, even when the news aggregator misses them.
export async function discoverPrimary(
  c: Company,
  env: Env,
): Promise<{ articles: Article[]; errors: string[] }> {
  const articles: Article[] = [],
    errors: string[] = [];
  const hosts = contentHosts(c, env);
  const knownCik =
    /^(netflix)(,? inc\.?)?$/i.test(c.name.trim()) ||
    c.ticker.toUpperCase() === "NFLX"
      ? "1065280"
      : /^(the )?progressive( corporation| corp\.?)?$/i.test(c.name.trim()) ||
          c.ticker.toUpperCase() === "PGR"
        ? "80661"
        : "";
  const cik =
    c.secCik ||
    knownCik ||
    (/^zoom(?: video)?(?: communications)?(?:,? inc\.?)?$/i.test(
      c.name.trim(),
    ) || c.ticker.toUpperCase() === "ZM"
      ? "1585521"
      : /american coastal/i.test(c.name) || c.ticker.toUpperCase() === "ACIC"
        ? "1401521"
        : "");
  if (cik) {
    try {
      const doc = await fetchDocument(
        `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
        hosts,
        env,
      );
      const data = JSON.parse(new TextDecoder().decode(doc.bytes));
      const filings = data.filings?.recent;
      if (!Array.isArray(filings?.form))
        throw new Error("SEC filing list unavailable.");
      const seen = new Set<string>();
      for (let i = 0; i < filings.form.length && articles.length < 12; i++) {
        const form = filings.form[i],
          date = filings.filingDate[i];
        if (!/^(8-K|10-K|10-Q|6-K|20-F)(\/A)?$/.test(form)) continue;
        const core = /^(10-K|10-Q|20-F)$/.test(form) && !seen.has(form);
        if (!core && Date.parse(date) < Date.now() - 35 * 86400000) continue;
        seen.add(form);
        const accession = String(filings.accessionNumber[i]).replace(/-/g, "");
        const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${filings.primaryDocument[i]}`;
        articles.push({
          id: await hash(url),
          title: `${c.name}: ${form} filing (${date})`,
          text: "",
          url,
          source: "SEC EDGAR",
          official: true,
          publishedAt: `${date}T00:00:00Z`,
          contentDepth: "unavailable",
        });
      }
    } catch (e) {
      errors.push(
        `SEC EDGAR: ${e instanceof Error ? e.message : "Filings unavailable"}`,
      );
    }
  }
  for (const url of [
    ...new Set([...primarySourceDefaults(c), ...c.primarySources]),
  ]) {
    try {
      const doc = await fetchDocument(url, hosts, env);
      const html = new TextDecoder().decode(doc.bytes);
      if (/^\s*(?:<\?xml[^>]*>\s*)?<(rss|feed)\b/i.test(html)) {
        const { parseFeed } = await import("./providers.ts");
        articles.push(...(await parseFeed(html, url, true)).slice(0, 20));
        continue;
      }
      const extracted = extractHtml(html, doc.url);
      const year = new Date().getUTCFullYear();
      const found = extracted.links.filter(
        (l) =>
          /\.pdf(?:$|\?)|news-details\/|news-release-details\//i.test(l.url) &&
          (/news-release-details\//i.test(l.url) ||
            (l.title + l.url).includes(String(year)) ||
            (l.title + l.url).includes(String(year - 1))) &&
          /results|earnings|shareholder|letter|report|10-k|10-q|financial|release|quarter|month/i.test(
            l.title + " " + l.url,
          ),
      );
      for (const link of [
        ...new Map(found.map((l) => [canonicalUrl(l.url), l])).values(),
      ].slice(0, 12)) {
        articles.push({
          id: await hash(canonicalUrl(link.url)),
          title: `${c.name}: ${
            !link.title || /download|opens in new/i.test(link.title)
              ? decodeURIComponent(
                  new URL(link.url).pathname.split("/").at(-1)!,
                )
                  .replace(/[-_]/g, " ")
                  .replace(/\.pdf$/i, "")
              : link.title
          }`,
          url: link.url,
          text: "",
          source: new URL(url).hostname,
          official: true,
          publishedAt: "",
          contentDepth: "unavailable",
        });
      }
      if (!found.length)
        errors.push(
          `${new URL(url).hostname}: primary page exposed no readable document links; coverage needs review.`,
        );
    } catch (e) {
      errors.push(
        `${url}: ${e instanceof Error ? e.message : "Primary source unavailable"}`,
      );
    }
  }
  return {
    articles: [...new Map(articles.map((a) => [a.id, a])).values()],
    errors,
  };
}
