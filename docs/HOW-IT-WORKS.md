# How Research Desk works

*A plain-language guide to the whole system: what each part does, what happens every minute, night and week, how a news article becomes something in your inbox, and where to look when something seems wrong. Written for the owner, not for programmers. Last updated September 25, 2026.*

If you only read one section, read [The short version](#1-the-short-version). If you want to understand a specific behaviour, the [contents](#contents) will take you straight there. Technical detail for programmers lives in [ARCHITECTURE.md](../ARCHITECTURE.md); this guide links to it where useful but never depends on it.

---

## Contents

1. [The short version](#1-the-short-version)
2. [The cast: every part of the system and its job](#2-the-cast-every-part-of-the-system-and-its-job)
3. [A day and a week in the life of the desk](#3-a-day-and-a-week-in-the-life-of-the-desk)
4. [The journey of a single news article](#4-the-journey-of-a-single-news-article)
5. [How the AI judges an article](#5-how-the-ai-judges-an-article)
6. [The rulebook that decides where an article goes](#6-the-rulebook-that-decides-where-an-article-goes)
7. [What you see on the desk](#7-what-you-see-on-the-desk)
8. [The 7am digest email](#8-the-7am-digest-email)
9. [Price alerts](#9-price-alerts)
10. [Where your information lives, and how it is kept safe](#10-where-your-information-lives-and-how-it-is-kept-safe)
11. [Living within free limits and being a polite visitor](#11-living-within-free-limits-and-being-a-polite-visitor)
12. [Privacy and security](#12-privacy-and-security)
13. [How the parts avoid tripping over each other](#13-how-the-parts-avoid-tripping-over-each-other)
14. [When something looks wrong: a troubleshooting guide](#14-when-something-looks-wrong-a-troubleshooting-guide)
15. [The dials you can turn](#15-the-dials-you-can-turn)
16. [Your setup today, and what would improve results](#16-your-setup-today-and-what-would-improve-results)
17. [A map of the code in plain words](#17-a-map-of-the-code-in-plain-words)
18. [Glossary](#18-glossary)

---

## 1. The short version

Research Desk is a private notebook for the companies you follow, paired with a tireless research assistant that reads the news for you overnight.

You keep notes, a thesis and a status (Portfolio, Perpetual watch, Watchlist and so on) for each company. Every night at **1am Chicago time** the system searches Google News for the previous day's articles about your **most important companies** (those in your Portfolio or on Perpetual watch). Every **Friday at 6pm** it searches the **past seven days for every company** you have not paused. For each article it finds, it asks an AI model called **TypeSafe** a set of careful, structured questions about the headline, publisher and date, reads the article's text when it can (the text sharpens the answers but is never required), and then applies a fixed rulebook to decide whether the article is worth your time. The results land in your **News & alerts inbox**, grouped so that five articles about the same event appear as one development. At **7am** a digest email summarises what is new.

All of this happens on rented servers in the cloud. **Your computer and browser can be off.** The website is simply a window onto work that has already been done.

---

## 2. The cast: every part of the system and its job

Think of the system as a small research office. Each part has one job.

```mermaid
flowchart LR
    You([You]) --> Website[The website<br/>your desk]
    Assistants([MCP / OpenClaw<br/>AI assistants]) --> Server
    Website --> Server[The server<br/>the back office]
    Timer[The timer<br/>checks every minute] --> Server
    Server --> Database[(The database<br/>the filing cabinet)]
    Server --> Google[Google News<br/>the newsstand]
    Server --> Publishers[Publisher websites<br/>and the SEC]
    Server --> TypeSafe[TypeSafe<br/>the analyst]
    Server --> Email[Resend<br/>the postman]
    Server -.-> Prices[EODHD<br/>price feed, optional]
```

| Part | Plain description | The real thing |
| --- | --- | --- |
| **The website** | The desk you look at. It shows your companies, notes and news, and sends your edits to the server. It holds no secrets and does no research itself. | A React web app hosted on **Cloudflare Pages** at [research-desk-2p0.pages.dev](https://research-desk-2p0.pages.dev). |
| **The server** | The back office. Every real piece of work happens here: searching, reading, asking the AI, applying rules, saving results, sending email. | A single program called `desk`, running as a **Supabase Edge Function**. It runs for at most about a minute each time it is called, then stops. |
| **The database** | The filing cabinet. It holds every company, note, article, setting and piece of progress. | A **Supabase Postgres** database, project `tcfricxifanwwzgxgexj`. |
| **The timer** | An alarm clock that checks every minute, inside the database, whether anything is in progress. If so, it wakes the server; if not, it only wakes the server every 10 minutes. Without it, nothing happens overnight. | A **pg_cron** job named `research-desk-monitor`, set to `* * * * *`, gated by `desk_scheduler_due()`. |
| **Google News** | The newsstand. It tells the system which articles exist about a company. It does not provide the article text. | Google News RSS search, the same results you would see at news.google.com. |
| **Publishers and the SEC** | Where the actual articles and filings live: Reuters, company press releases, trade magazines, SEC filings. | Ordinary public web pages and PDFs. |
| **TypeSafe** | The analyst. It never searches or browses. It reads exactly the text the server hands it and answers a fixed list of multiple-choice questions, giving its confidence in each answer. | The TypeSafe API, model `jev-1.13.0`. |
| **Resend** | The postman who delivers the 7am digest email. | The Resend email service. |
| **EODHD** | An optional price feed for automatic price alerts. **Not currently connected** for any company. | EODHD end-of-day price API. |
| **MCP and OpenClaw** | Other AI assistants that can read and update your desk through the same front door the website uses, with limited, expiring permission slips. | A local MCP server and an OpenClaw skill; see [INTEGRATIONS.md](INTEGRATIONS.md). |

Two ideas explain most of the design:

- **The server does the work in short bursts.** Cloud functions are only allowed to run for a short time and use a small amount of computing power per call (see [section 11](#11-living-within-free-limits-and-being-a-polite-visitor)). So long jobs, like searching 224 companies, are broken into many small steps. After each step the server writes down its place, like a bookmark, and the next ring of the timer carries on from there.
- **Everything that matters is written down in the database.** Progress, results and settings never live only in memory. If a step is interrupted halfway, the next step simply picks up from the last bookmark, and anything already saved is not redone or paid for twice.

---

## 3. A day and a week in the life of the desk

### Every minute

The timer rings and the server wakes up for up to about 50 seconds. It first reads a small **schedule record** (a few hundred bytes) that says what has already been done today. Then it works down a short checklist, doing only what is due:

1. **Queued jobs.** If you or an assistant asked for a specific job (for example "check this company now"), take one small step on it.
2. **The digest.** If it is 7am or later and today's email has not gone out, send it. Once sent, this is skipped for the rest of the day.
3. **The daily backup.** Once a day, save a snapshot of your research.
4. **The scheduled news run.** If a run is due, start it. If one is in progress, process up to **10 more articles** (about 45 seconds of work) and save a bookmark.
5. **Your manual news search.** If you started a search from the News page, keep it moving, even with your browser closed.
6. **Prices.** Once a night, check closing prices for companies that have a price source.
7. **Re-screens.** After the night's news run, re-examine up to **300** older articles a night that need a second look (see [below](#re-screens-second-looks-at-older-articles)).

On a quiet minute with nothing due, the whole visit costs about six tiny database reads.

### Every night at 1am: the daily run

At 1am Chicago time the server starts a **daily run** for your daily companies: everything in **Portfolio** or on **Perpetual watch**, unless you have overridden a company's frequency. There are 24 such companies today.

It asks Google News for articles published since the previous run began, with a two-hour overlap so nothing falls through the cracks at the edges. Normally that means **the last 26 hours**. For each company it runs one search per calendar day covered (usually two), keeps up to 10 results from each, and also checks any primary sources you have configured. It then reads and judges each new article, one at a time. A typical daily run finishes in a few minutes.

### After the run: prices, backup and second looks

Once the news run is done, the quieter chores happen: closing prices (for companies with a price source), the daily backup if it has not happened yet, and up to 300 re-screens.

### 7am: the digest

At 7am the digest email goes out, summarising everything discovered since the previous digest. See [section 8](#8-the-7am-digest-email).

### Every Friday at 6pm: the weekly sweep

After Friday's market close, the server starts a **weekly run** covering **every company that is not paused** (224 today), looking back **seven days**. Your daily companies go first, so the ones that matter most are finished early. After them, the others follow in alphabetical order.

This is the big job of the week: roughly 6,000 to 7,000 candidate articles, of which about half are usually new (the rest were already found by daily runs or earlier searches). At 10 articles a minute it takes several hours and is designed to finish overnight, before Saturday's 7am digest. If Google asks the server to slow down (see [section 11](#google-being-a-polite-visitor)), it will take longer, but nothing is skipped. Anything found after the digest simply appears in Sunday's.

Because the weekly sweep already covered your daily companies, **Saturday's 1am daily run is skipped**. The Sunday daily run picks up from where Friday's sweep began.

```mermaid
gantt
    title A typical week (America/Chicago)
    dateFormat  YYYY-MM-DD HH:mm
    axisFormat  %a %H:%M
    section Daily run (24 companies, last day)
    Mon 1am      :2026-09-21 01:00, 20m
    Tue 1am      :2026-09-22 01:00, 20m
    Wed 1am      :2026-09-23 01:00, 20m
    Thu 1am      :2026-09-24 01:00, 20m
    Fri 1am      :2026-09-25 01:00, 20m
    Sun 1am      :2026-09-27 01:00, 20m
    section Weekly sweep (224 companies, last 7 days)
    Fri 6pm to early Sat :2026-09-25 18:00, 10h
    section Digest email
    Every day 7am :milestone, 2026-09-26 07:00, 0m
```

### Safety nets

- **A missed run catches up.** If the servers were down at 1am, the daily run starts at the next opportunity that day. If a Friday is missed entirely, the weekly sweep starts on Saturday, and if a whole week passes without one, it starts immediately.
- **The first night after an update** starts cleanly: the September 22 update began with the next night's daily run, and the first weekly sweep on the following Friday.

---

## 4. The journey of a single news article

This is the heart of the system. Follow one article from Google to your inbox. Since September 23, 2026 (screening "v3") an article is judged from **what is known about every article**: the company, the headline, the publisher, any summary and the date. The article's text is read when it can be, and then used as extra evidence for the same questions, but it is never required. Missing text, missing company context or a missing ticker **never** sends an article to Needs verification.

```mermaid
flowchart TD
    A[1. Discover<br/>Google News search<br/>+ primary sources] --> B{2. Seen it before?}
    B -- yes --> Z[Skip, free]
    B -- no --> L{Google link<br/>or direct link?}
    L -- direct link<br/>company site, SEC, feed --> D[Read it now]
    L -- Google link --> H[3. Judge the headline<br/>one TypeSafe request]
    H --> W{Ruled out and<br/>nothing major?}
    W -- yes --> S[Screened out<br/>article never opened]
    W -- no --> G[4. One try to open it<br/>via Google]
    G -- refused or failed --> K[Keep the headline verdict<br/>no retry]
    G -- text read --> T[5. Same questions<br/>with the text]
    D --> T
    T --> R[6. Apply the rulebook]
    K --> R
    R --> I[7. Group with the same development]
    I --> J[8. Save and show]
```

### Step 1: discovery

For each company, the server asks Google News a question such as `"Kinsale" (company OR stock OR earnings OR business) after:2026-09-21 before:2026-09-22`. The extra words are only added for one-word names, to avoid articles about the town or the person. You can replace the whole search with your own wording for any company (**Monitoring → Company news search**). Progressive has a built-in special search.

Each day gets its own search, and up to **10 articles per day** are kept, in Google's own order. That means at most 20 or so per company for a daily run and 70 for a weekly run. The server also checks **primary sources**, meaning the company's own disclosures: SEC filings (built in for Netflix, Progressive, Zoom and American Coastal, or for any company with an SEC CIK number filled in), investor-relations pages, and any official RSS feeds you add.

### Step 2: have we seen it before?

Every article gets a fingerprint made from its link, title and date. If an article with that fingerprint is already stored for that company, it is skipped at once. This check costs almost nothing. It is why a weekly sweep that overlaps a daily run does not pay twice, and why an interrupted run can be resumed safely.

### Step 3: judging the headline

Google News gives a Google link, not the publisher's address. Translating it takes two requests to Google, which Google often refuses from cloud servers (see [section 11](#google-being-a-polite-visitor)). So for a Google link the server first asks TypeSafe the full set of questions using only the headline, publisher, summary and date. If that already rules the article out (another company, a law-firm advertisement, price chatter, trivia) **and** nothing major is suggested, the article is screened out without ever being opened. In testing, about half of all candidates ended here, which halves what the server asks of Google.

A **direct link** (the company's own site, the SEC, a feed you configured) costs Google nothing, so it is read straight away and skips this step.

### Step 4: one try to open it

If the headline does not rule the article out, or if it suggests something major, the server tries **once** to translate the Google link and read the publisher's page. If Google refuses, the page is paywalled or the site is slow, the headline verdict stands and **nothing is retried**. After two Google refusals in a run, the server stops asking Google for the rest of that run. Refusals that redirect to Google's "unusual traffic" page are recognised as refusals.

Reading itself works as before: the main text is extracted in "reader mode" style, PDFs are read page by page, addresses are checked to be genuine public websites, publishers that block the server twice are skipped for the rest of the run, and the system never tries to get around a paywall or a robot check.

### Step 5: the same questions, with the text

When text was read, TypeSafe is asked the same questions again with the text as extra evidence: its opening 12,000 characters, cut into numbered passages. One further question picks the passage that states the development. The text refines the verdict; it is not a gate. In the September 23 test, reading the text changed where about one article in five went, almost always because the text showed something the headline undersold.

The briefing always contains:

- the company's name, ticker, exchange, scale, business description and thesis, each shown as "not provided" when empty;
- the headline, publisher, summary and date;
- the number of days since publication, calculated in code because the AI is weak at comparing dates;
- up to four of the company's recently shown articles, for grouping.

### Step 6: the rulebook

TypeSafe's answers are probabilities, not decisions. A fixed, written rulebook in the code turns them into a verdict. See [section 6](#6-the-rulebook-that-decides-where-an-article-goes).

### Step 7: grouping the same development

Many articles describe the same event: an earnings release can produce ten stories. For each of up to four recently shown articles about the company, TypeSafe answers one yes/no question: **do these report the same development** (the same announcement, event or reporting period)? At **70%** or more the new article joins that development. All of its articles stay "relevant". The development appears as **one card led by its best source**, with the others listed underneath.

The best source is chosen by provenance, not by how much text happened to be readable. In order:

1. the company's own release;
2. established newsrooms (Reuters, Bloomberg, the Wall Street Journal, the FT, CNBC and similar);
3. other reporting;
4. investing-template sites (Simply Wall St, MarketBeat, Zacks, GuruFocus, Motley Fool and similar).

An article whose text was read gets a small bonus. Analysis pieces are listed as additions alongside the lead.

Grouping never deletes anything. Every article remains inspectable.

### Step 8: saved and shown

Each article is saved with:

- its verdict and the reason in plain English;
- a note on whether it was judged from the headline or the text, and why the text was unavailable;
- the supporting passage, when there was text.

It appears in your inbox the next time the website refreshes, and in the next digest if it qualifies.

### Re-screens: second looks at older articles

Some articles deserve a second look later:

- **Your edits.** When you change a company's context, thesis, watch points or name, its stored articles are re-judged with the new context.
- **A new screening version.** When the rulebook or questions are upgraded, older judgments are refreshed. With v3, about 6,400 older articles are queued; at 300 a night that takes about three weeks.
- **Processing failures** (TypeSafe unavailable) are retried after 24 hours, up to three attempts.

Re-screens judge **what is already stored** and never contact Google again. Unreadable articles are not retried. Your own Review, Save, Useful and Noise choices are kept.

---

## 5. How the AI judges an article

### Why structured questions, not a summary

The system never asks TypeSafe "is this article good?". It asks narrow, well-defined questions with fixed answer choices, and TypeSafe returns **how confident it is in each possible answer**, as probabilities that add up to 100%. This matters for three reasons:

1. **Borderline cases are handled deliberately.** A 55% answer is treated differently from a 95% one.
2. **The rulebook can be changed without paying again.** Because the raw answers are stored, a threshold can be adjusted and every stored article re-evaluated in code, at no AI cost.
3. **Answers are checked.** The server verifies that every answer is a permitted choice and that the probabilities add up. A malformed answer is a processing failure, never a verdict. When two options tie within rounding, TypeSafe's own choice is accepted.

### The five core questions

Every question can be answered from the headline alone. The text, when present, is extra evidence.

| Question | What it asks, in plain words |
| --- | --- |
| **Identity** | Is this about this company (or a business, brand or division it owns, or a named customer, supplier or regulator action tied to it), rather than something that merely shares its name? |
| **Significance** | How much does the development matter for the company's long-term value? A five-level scale (below). When the company's size is unknown, the nature of the event is judged instead of demoting it. |
| **Purpose** | What kind of article is it? The options: the company's own disclosure, a news report, real analysis, market commentary (price moves, ratings, targets, pundits), investment opinion (should-you-buy, comparisons, valuation templates), a law-firm solicitation, or something else. |
| **Issuer** | Did the company itself issue it (its own press release or filing, even when carried by a newswire or Yahoo)? |
| **Timeliness** | Is the development current, or old news recirculated? The days since publication are calculated in code and supplied. |

The significance scale:

| Level | Meaning |
| --- | --- |
| 0 | No business development: price moves, ratings or targets alone, should-you-buy templates, calendar notices, name mix-ups, promotion. |
| 1 | A real but routine or small event: minor contract, store opening, marketing, routine board appointment, rating affirmation. |
| 2 | Useful evidence about core performance: results, monthly or quarterly figures, guidance, pricing, costs, market share, a meaningful partnership. |
| 3 | Could meaningfully change earning power, competition, capital allocation, management or financial risk: a large deal or financing, a major customer or licence change, an activist campaign, material litigation or a regulatory decision. |
| 4 | Could transform control, survival or the core business: a takeover, insolvency, loss of the core licence. |

### Extra questions, asked only when relevant

- **Evidence** (only when text was read): which numbered passage states the development, plus a separate yes/no "does any passage state it?", so "none of them" cannot crowd out a real passage.
- **Same development** (for grouping): one yes/no per recently shown article.
- **Your watch points** (up to 20 per company): does this article bring real evidence about each one, and in which direction?

All of these are asked in **one request**; extra questions do not add waiting time.

### What it costs

TypeSafe charges only for the text sent to it: about **$0.042 per million "tokens"**. A headline judgment uses about 1,800 tokens and a judgment with text about 3,200, so an article costs roughly **a hundredth of a cent**. Before every request the server reserves the worst possible cost against your monthly ceiling, then settles it at the real amount. If the ceiling would be exceeded, the article waits, clearly labelled. See [budgets](#the-typesafe-budget).

---

## 6. The rulebook that decides where an article goes

After TypeSafe answers, a fixed set of rules (the "headline-first" policy of screening v3) gives each article a **role**. The rules are checked in order, and the first one that applies wins.

```mermaid
flowchart TD
    S[Article with AI answers] --> A{Another company, a law-firm ad,<br/>or old news?}
    A -- yes --> X[Screened out]
    A -- no --> B{Unsure it is this company?}
    B -- yes, possibly major --> V[Needs verification]
    B -- yes, nothing major --> X
    B -- no --> C{Price, rating or<br/>opinion piece?}
    C -- about a real development --> CO[Coverage]
    C -- nothing behind it --> X
    C -- no --> D{Any development<br/>of consequence?}
    D -- no --> X
    D -- yes --> E{Company's own<br/>release?}
    E -- yes --> P[Relevant: company source]
    E -- no --> F{Analysis?}
    F -- yes --> AN[Relevant: analysis,<br/>shown alongside]
    F -- no --> N[Relevant: news report,<br/>grouped under best source]
```

In words, with the exact thresholds:

1. **Another company:** identity below 20% → **Screened out**.
2. **Law-firm advertisement** (purpose at least 60%) → **Screened out**. A real lawsuit reaches the desk through news reports or filings.
3. **Old news** → **Screened out**. That covers articles published more than **45 days** ago, articles confidently historical (at least 80%), and headlines naming a reporting period that ended long ago (for example "fiscal year 2021", checked in code). An undated page must show it is current. Otherwise it is screened out, or sent to verification if it may be major.
4. **Unsure it is this company** (identity 20–80%): **Needs verification** only if the development may be major (levels 3–4 at least 50%). Otherwise **Screened out**.
5. **Price, rating or opinion piece** (market commentary or investment opinion at least 60%): **Coverage** when at least 20% suggests a meaningful development behind it. Otherwise **Screened out**. It is never recommended reading.
6. **Nothing of consequence:** levels 3–4 below 20% and levels 2–4 below 60% → **Screened out**.
7. **Mostly old information** (historical 50–80%): **Needs verification** if possibly major. Otherwise **Screened out**.
8. Everything that remains is a **relevant development**, and the article's role is one of:
   - **Company source**, when it comes from the company's own site or filings, or the issuer question is at least 80% (a company press release on a newswire counts);
   - **Analysis**, when the purpose is analysis (at least 60%), shown next to the development's lead;
   - **News report** otherwise, grouped with other reports of the same development under the best source.

**Needs verification is now rare.** It holds only articles that might be major but might concern another company or be old, plus processing failures. On 90 real articles in the September 23 test it held 3–4 articles; the previous rulebook sent 73 of the same 90 there.

**Possibly major is never silently dropped.** Anything with at least a 50% chance of a level 3–4 development is always opened once. It is never screened out, unless it is about another company, a law-firm advertisement or old news.

### Important developments

A relevant development is marked **Important** when TypeSafe gives at least **70%** combined confidence to significance levels 3 and 4. Important items lead the digest.

### Your own judgments always win

- **Useful** overrides the rulebook and promotes an item.
- **Noise** hides a development until you undo it.
- **Review** and **Save** apply to the whole development group, even members hidden by your current filters.
- Feedback about a single source ("poor source", "duplicate", "no new information") applies only to that one article.

---

## 7. What you see on the desk

The website has five sections, in the left-hand navigation.

### Companies

Your list of companies, searchable and filterable by status, research group and text. Selecting one opens its detail panel with four tabs:

- **Research:** notes (Markdown, saved automatically as you type), thesis, status, tags, idea source, and full note history.
- **Watch points:** specific concerns you want every article checked against, for example "customer concentration with Walmart". Up to 20 per company.
- **Alerts:** numerical rules such as "tell me if the price falls below $40" or "if it drops 25% from my baseline". See [section 9](#9-price-alerts).
- **Monitoring:** how this company is checked. Frequency (automatic, daily, weekly, paused), the Google News search wording, business scale and written business context (which the AI uses to judge significance), primary sources, SEC CIK number, enabled publishers, and publishers to exclude. The status of each news source is shown here too.

### News & alerts

The inbox of developments, newest first.

- **Folders:** **Inbox** holds unreviewed, unsaved items for 30 days after discovery. **Saved** keeps items forever. **History** holds reviewed items and ones that aged out. "Return to inbox" gives an item a fresh 30 days.
- **Views:** **Relevant developments** (one card per development, led by its best source), **Needs verification** (rare: possibly major but unclear), **Coverage / commentary** (price and opinion pieces about a real development), **Screened out / noise**, and **All events**.
- **Filters:** keyword, company, publisher, importance and publication date range.
- **Actions** on each card: Review, Save, Useful, Noise, Undo, and **Read available text**, which fetches the article text for you without any AI cost or change to the verdict.
- **The "Scheduled news runs" panel** shows the current or last nightly run (companies done, articles checked, new items, warnings), whether it is waiting because Google asked it to slow down, and a short history of recent runs.
- **Search news** starts your own screen, separate from the scheduled daily and weekly runs. Three choices beside the button set its size, and are remembered on that device:
  - **which companies:** those matching your current filters, your daily companies (Portfolio and Perpetual watch), or every monitored (non-paused) company;
  - **how far back:** 1, 2, 3, 7, 14 or 30 days (one Google search per company per day);
  - **articles kept per company per day:** 3, 5, 10 or 20.

  Hovering over the button shows the number of searches and the maximum number of articles. You can pause, resume or cancel a screen. It keeps running on the server even if you close the browser.
- **Email today's latest screen** sends an email of the developments found by the most recent screen that ran today, manual or scheduled, in the same format as the morning digest. It works while a screen is still running (the subject says so) and can be pressed again later for an updated copy.

### Monitoring health

A table of every active company showing its frequency, price status, the state of each news source (last fetch succeeded, or the error), and when news was last checked. **Run a batch** queues a one-off check of prices and news for every active company, one company per minute. The nightly runs usually make this unnecessary.

### Import & backup

- **Import** your research from a Markdown file, with a preview of duplicates and ambiguous names before anything is saved. The original file is always kept. An import can be rolled back; companies you have edited since are preserved.
- **Download** the latest daily research snapshot, or a **full export** of everything (companies, notes, all articles, note history, settings).
- **Restore** from an export. This only adds missing records; it never overwrites what you have.

### Settings & digest

The digest time (7am Chicago by default), a preview of tomorrow's digest, AI usage for the month, and the **MCP & OpenClaw** permission slips (create, see and revoke), plus a history of background jobs.

### How the website stays current, cheaply

- The website keeps a copy of your articles **in the browser itself**. Opening the desk downloads only what changed since your last visit on that device. The first visit on a new device, or after three weeks away, downloads everything once.
- Every 30 seconds while the page is visible, it asks the server "has anything changed?", a tiny question. Every minute it fetches any new or changed articles.
- Company data is only re-fetched for companies that actually changed, or when you come back to the tab after 10 minutes away.
- When the tab is hidden, it stops asking.

### Your edits are never lost

- **Autosave with a safety copy.** Every change to a company is saved on your device immediately, then sent to the server a moment later. If the network drops or the tab closes, the draft is recovered next time.
- **Conflict protection.** Each record carries a version number. If something else changed the same company in the meantime (another tab, an assistant, or a nightly run), the server merges changes to different fields automatically and refuses only a genuine clash on the same field, so nothing is silently overwritten.
- **Background work never overwrites research.** Price updates and monitoring checkpoints are kept separate from your notes and thesis.
- **Note history.** Every notes and thesis change keeps the previous version.

---

## 8. The 7am digest email

Every day at 7am Chicago time (adjustable in Settings), if the digest is enabled, the server builds and sends one email:

- It covers developments **discovered since the previous digest was delivered**, not just the last 24 hours, so nothing is missed if a day is skipped.
- It includes **relevant developments**, plus uncertain ones that might be significant (flagged **NEEDS VERIFICATION**), and **monitoring alerts**.
- Developments are ordered by importance: **Important** first, then other relevant items, then verification items, with fresher news ahead of older.
- It shows the **top 20** developments, each with its company, headline, the reason it qualified, the supporting passage, a link, and how long ago it was published. It then says how many more are waiting in the inbox.
- It lists up to 10 **monitoring alerts** (for example a feed that keeps failing) and a **coverage gaps** line naming companies with a missing or failing source.

The email is sent through Resend with a unique "one per day" key, so a hiccup cannot produce two copies. You can preview the next digest at any time in Settings. The **Email today's latest screen** button on the News page sends a separate email covering just the most recent screen; it does not affect the morning digest.

---

## 9. Price alerts

Each company can have numerical rules:

- **Price** at or below a threshold.
- **P/E** (price-to-earnings) at or below a threshold, using a positive trailing P/E of the named kind.
- **Decline** of a given percentage from a baseline price you set.

When a rule is met, you get **one alert**, not one every day. The rule then stays quiet until the price recovers past the threshold (with a small margin), which re-arms it. Changing a rule's meaning also re-arms it. Prices must be in the rule's currency, and future-dated or implausible data are rejected. A sudden jump of more than about 45% down or 80% up is treated as a possible stock split or data error: alerts are held back and you are told to check.

**Important:** automatic prices need a price source (EODHD) connected for each company, with a confirmed symbol and currency. **No company is connected today**, so rules can only use prices you enter yourself. Every company without a source produces a "No quote source configured" monitoring notice when its prices are due to be checked (daily for daily companies, weekly for the rest).

All arithmetic is done in code. The AI is never asked about prices.

---

## 10. Where your information lives, and how it is kept safe

### Everything is a "record"

The database holds everything as **records**. Each has a **kind** (what sort of thing it is), an **ID**, its **contents**, a **version number** that goes up by one on every change, and the time it last changed. The main kinds:

| Kind | What it holds |
| --- | --- |
| `company` | Everything about one company: identity, notes, thesis, status, watch points, rules, news sources, monitoring checkpoints, recent prices. |
| `event` | One article or alert: title, link, dates, the extracted text, the AI's answers, the verdict and reason, grouping, and your Review/Save/feedback. |
| `settings` | Digest time and on/off switch. |
| `revision` | An earlier version of a company's notes or thesis. |
| `import` | An original imported file and what was imported from it. |
| `backup` | A daily research snapshot (kept 30 days). |
| `news_batch` | A news run's progress: `latest` is your manual search, `scheduled` is the current nightly run. |
| `run` | Housekeeping: the scheduler's daily record (`schedule`), the re-screen queue, and the last monitoring result. |
| `article_cache` | Recently fetched article text, reused for a day (seven days if the full text was read). |
| `digest` | Which day's email was sent, and when. |
| `job`, `integration`, `request`, `audit` | Queued background jobs, assistant permission slips, and a log of what each assistant did. |

### Backups

- **Daily research snapshot** (automatic, kept 30 days): companies, notes, rules, settings and original import files. It does not include articles.
- **Full export** (on demand, from Import & backup): everything, including all articles and note history. Keep one somewhere outside the project from time to time. The daily snapshots live inside the same project, so they would not survive the project itself being deleted.
- **Weekly off-site backup** (automatic, Sundays): a GitHub Action in the private repository `NithinMantena/research-desk-backups` downloads the *essential* export and commits it gzipped, keeping the newest 26 (about six months). The essential export has every company, note, rule, feed, setting, import and note revision, plus every article you saved, reviewed or marked useful/noise. Stored article text and model internals are left out, and so are untouched screener results, which the next news run recreates. It is about 0.75 MB before compression, which costs about 3 MB of egress a month. It reads with a `backup:read`-only token that must be renewed yearly. The repository README explains how to restore.
- **Restore** adds missing records and never overwrites existing ones.

### How much space it uses

On September 22 the database held about 48 MB of its 500 MB free allowance: about 7,300 articles and 247 companies. Each stored article adds roughly 5 KB.

---

## 11. Living within free limits and being a polite visitor

The system runs on free or near-free plans, each with limits. Several design choices exist only to respect them.

### Data transfer ("egress"): 5 GB a month

Supabase counts every byte that leaves the database, including bytes the server reads for its own work, against a 5 GB monthly allowance (billing cycle: the 5th to the 5th).

In September 2026 that allowance was exhausted within days. The old five-minute timer re-read **every stored article (about 18 MB), the entire daily backup, and every company** on every visit: about 5 GB a day, just to find out that there was usually nothing to do.

Since September 22 the rule is: **read only what you need, only when you need it.**

- The server reads small **summaries** of records, a few fields each, when it is scanning, and fetches full records only for the handful it will actually work on.
- Existence checks ("is there already a backup today?", "have we seen this article?") read nothing but the record's ID.
- Heavy chores happen **once a night**, not every minute.
- The website keeps its own copy of your articles and asks only for changes.

Measured results: a quiet minute now reads about **370 bytes**. A news run reads about **28 KB per new article**. Expected total: **roughly 0.7 to 0.8 GB a month**, comfortably inside 5 GB.

There is a second free allowance: **1 GB a month of logs**, shared with the reading app. Supabase writes a small log entry for every single request, however tiny, so a timer that knocks every minute costs logs even when there is nothing to do. Since September 25 the timer only wakes the server when something is actually in progress (otherwise every 10 minutes), and the page asks "has anything changed?" every 30 seconds instead of every 5. News searches you start from Claude or ChatGPT still begin immediately. The detailed rules for future changes are in [ARCHITECTURE.md](../ARCHITECTURE.md#egress-and-resource-budgets).

### Server time and computing power

Each server visit may last at most 150 seconds, with only about **2 seconds of actual processor time**. Waiting on the network does not count; reading and parsing web pages does. Reading one article costs about 80 milliseconds of processor time, so each minute's visit handles at most **10 articles** (about half the allowance) and stops after about 45 seconds. This is why a weekly sweep takes hours, and why that is fine.

### The TypeSafe budget

The AI's monthly spending ceiling is set on the server (currently **$5**; the code will not allow more than $10). Expected spending is about **$3 a month**: roughly $1.60 for weekly sweeps, $0.30 for daily runs and $1 for re-screens. Usage for the calendar month appears in Settings. TypeSafe's own invoice is the final word.

### Google: being a polite visitor

Google tolerates automated news searches but pushes back on anything that looks like a flood. It replies "too many requests" (HTTP **429**) or "service unavailable" (**503**). Cloud servers share addresses with many other programs, so Google is stricter with them. On September 20 to 22, about **9 in 10** article lookups from the server were refused.

The system now behaves like a courteous visitor:

- **It spaces requests out:** at least 2 seconds between searches and 0.6 seconds between article lookups.
- **It backs off when refused.** It waits **1, then 3, 10, 20 and 30 minutes** before retrying the same step. The progress panel shows "Google News asked us to slow down; resuming around …".
- **It learns.** Each refusal doubles the spacing (up to 20 seconds between searches and 10 between lookups). Each success eases it back by 5%. The learned pace is saved with the run, so the next minute does not start fast again.
- **Searches are retried; article lookups are not.** A refused news search is retried later; only after **five refusals in a row** is it reported as a warning and skipped. An article lookup is tried **once**: if Google refuses, the article is judged from its headline and never looked up again. After **two refusals in a run**, the server stops asking Google for article links until the run ends.
- **It asks less.** Articles the headline already rules out are never looked up, and re-screens never contact Google (see [step 3](#step-3-judging-the-headline)).

If Google stays strict, the desk still works: articles are judged from their headlines, and the run finishes on time.

### Publishers

As described in [step 4](#step-4-reading-the-article): an 8-second timeout (10 for SEC, major news sites and configured sources), and a publisher that blocks the server or times out twice in a row is skipped for the rest of that run.

---

## 12. Privacy and security

- **Only you can sign in.** Sign-in is by email link only, and only for `nithin@mantena.com`. Public sign-up is disabled. There is no password to steal.
- **Secrets never reach the browser.** The TypeSafe key, the email key and the database master key live only on the server. The website carries only public identifiers that grant nothing on their own.
- **The timer has its own secret.** The scheduled endpoint accepts only the timer's credential, stored in Supabase's encrypted vault, and never a browser session.
- **Assistants get limited permission slips.** MCP and OpenClaw use credentials that are shown once, stored only as a scrambled fingerprint, expire on a date you choose, can be revoked instantly, and carry only the permissions you tick. Starting work that spends AI budget is a separate permission. Every assistant action is recorded in an audit log.
- **The database refuses direct edits.** Tables are locked so that only the server's checked functions can write, and each owner can only ever read their own records.
- **Article text is treated as untrusted.** The AI is told explicitly that article text is evidence, never instructions. Fetching refuses private network addresses and checks every redirect. Nothing tries to bypass paywalls or robot checks.
- **The website is locked to its own address.** The server refuses requests from web pages other than the desk itself.

---

## 13. How the parts avoid tripping over each other

Several things can happen at once: the timer ringing, you editing a company, an assistant adding a note, your manual search running. Three simple mechanisms keep them from colliding.

- **"Reserved" signs (leases).** Before starting a piece of work, a worker places a sign in the database, such as "article X is being screened" or "the nightly run is being advanced", with an expiry time. Anyone else who sees the sign leaves that work alone. The sign is removed when the work finishes, and if a worker crashes, the sign expires on its own (after 5 minutes for a run, 10 for an article), so work is delayed, never lost. This is what prevents the same article from being paid for twice.
- **Version numbers.** Every save says "I am changing version 7". If the record has meanwhile become version 8, the save is refused and the change is merged or retried. Nothing is silently overwritten.
- **Bookmarks.** Long jobs record exactly where they are: which company, which search, which articles are queued. Progress is saved every few steps. After an interruption, at most those few steps are redone, and anything already saved is skipped by the "seen it before" check.

---

## 14. When something looks wrong: a troubleshooting guide

| What you notice | What it usually means | Where to look / what to do |
| --- | --- | --- |
| Many cards say "screened from the headline" | Google refused the article lookup, or the publisher blocks automated reads. This is expected and changes little about where articles go. | Nothing to do. "Read available text" tries one article on demand. Primary sources (SEC CIK, investor-relations feed) give direct, readable documents. |
| The Scheduled news runs panel says **"resuming around …"** | Google asked the server to slow down; it is waiting as it should. | Nothing to do. It resumes automatically. |
| A run shows **warnings** | A source failed after retries, for example an investor-relations page blocking automated reads (HTTP 403), or a search refused five times. | Expand the warnings in the panel. A permanently failing source can be removed or replaced in the company's Monitoring tab. |
| **"Monitoring needs attention"** items in the inbox or digest | A company's source failed during a run. (Companies with no price source are simply skipped; they no longer raise an alert every night.) | The message names the source. See the company's Monitoring tab. |
| A company never gets any news | Its search wording finds nothing, often a spelling difference (the "Deckers Outdoors" versus "Deckers Outdoor" case), or a name shared with something else. | Monitoring tab → Company news search. Try the search at news.google.com first. |
| No digest this morning | The digest is off, email delivery is not configured, or it already went out earlier. | Settings & digest → preview. The `digest` record shows what was sent and when. |
| Items marked **"TypeSafe budget unavailable or reached"** | The monthly AI ceiling was reached. | They wait, labelled, and are re-screened once the new month starts. Usage is shown in Settings. |
| The desk feels stale | The browser only refreshes while the tab is visible. | Switch back to the tab, or reload. |
| You suspect the server has stopped | The timer or the server may be failing. | Ask for a check of the timer's recent answers (the `net._http_response` table: status 200 at least every 10 minutes, and every minute while a run is in progress) and of the `run/schedule` record. |
| Worried about data transfer | Something may be reading too much. | Supabase dashboard → Usage → Egress. The database's query statistics (`pg_stat_statements`) show which reads run most often. |

---

## 15. The dials you can turn

### From the website, no code needed

| Dial | Where | Effect |
| --- | --- | --- |
| Company status (Portfolio, Perpetual watch, Watchlist, …) | Research tab | Portfolio and Perpetual watch make a company **daily**; everything else is **weekly**. |
| Monitoring frequency | Monitoring tab | Override automatic: daily, weekly or **paused**. Paused companies are left out of all runs. |
| Company news search | Monitoring tab | Replace the automatic Google search wording. |
| Business scale and context | Monitoring tab | Tells the AI how big the company is and what matters to it, which sharpens significance judgments. Never required. |
| Primary sources, SEC CIK, official feeds | Monitoring tab | Adds the company's own disclosures, which can become recommended primary readings. |
| Enabled and excluded publishers | Monitoring tab | Allow additional publisher sites to be read; hide publishers you never want. |
| Watch points | Watch points tab | Every article is checked against each one. |
| Price rules | Alerts tab | Numerical alerts (automatic prices need a price source). |
| Digest on/off and hour | Settings & digest | When the daily email arrives. |
| Assistant permissions | Settings & digest | Create, limit and revoke MCP/OpenClaw access. |

### In the code, for a developer

| Dial | File | Current value |
| --- | --- | --- |
| Daily run hour, weekly day and hour, overlap, articles per minute, re-screens per night | `supabase/functions/_shared/constants.ts` → `NEWS_SCHEDULE` | 1am; Friday 6pm; 2 hours; 10; 300 |
| Articles kept per search per day | `news-batch.ts` → `articleLimit` | 10 |
| Google spacing and search back-off | `fetch-policy.ts`, `news-batch.ts` (`THROTTLE_DELAYS`) | 2 s / 0.6 s; 1, 3, 10, 20, 30 minutes |
| Google article lookups | `article-content.ts` (`enrichArticle`), `jobs.ts` (`processArticle`) | Once per article, never retried; paused for the run after 2 refusals |
| Publisher timeout, host-skip rule | `article-content.ts`, `fetch-policy.ts` | 8 s (10 s configured/SEC); 2 failures |
| Rulebook thresholds | `fundamental-policy.ts` | See [section 6](#6-the-rulebook-that-decides-where-an-article-goes) |
| AI questions | `screening-prompts.ts`, `news-screening.ts` | Version `headline-first-3.0.0` (screening `fundamental-v3`) |
| Grouping | `jobs.ts` (same-development match) | 70%, up to 4 recent articles compared |
| Lead-source preference | `screening-policy.ts` (`sourceQuality`, `screeningRank`) | Company release, established newsroom, other reporting, template sites |
| Inbox age limit | `event-inbox.ts` → `INBOX_DAYS` | 30 days |
| Digest size | `jobs.ts` → `DIGEST_DEVELOPMENT_LIMIT` | 20 |

### Server settings (Supabase Edge Function secrets)

`TYPESAFE_MONTHLY_BUDGET_USD` (AI ceiling, at most 10), `TYPESAFE_MODEL` (pinned `jev-1.13.0`), `ALLOWED_FEED_HOSTS` and `ALLOWED_ARTICLE_HOSTS` (extra permitted sites), `ALLOW_PUBLIC_ARTICLE_HOSTS` (set `false` to read only listed sites), `ENABLE_EMAIL_DELIVERY`, `RESEND_API_KEY`, `DIGEST_FROM`, `DIGEST_TO`, `EODHD_API_KEY`. Changing these is described in [DEPLOYMENT.md](../DEPLOYMENT.md).

---

## 16. Your setup today, and what would improve results

A snapshot from September 22, 2026:

| | Today |
| --- | --- |
| Companies | 247: 24 daily, 200 weekly, 23 paused |
| With business context written | 2 |
| With watch points | 0 |
| With primary sources, SEC CIK or official feeds | 0 (Netflix, Progressive, Zoom and American Coastal have built-in SEC/IR discovery) |
| With a price source | 0 |
| Digest | Enabled and delivering at 7am |
| AI ceiling | $5 a month ($1.15 used in September before the change) |

What would make the biggest difference, roughly in order:

1. **Add tickers and fix search wording for generic names.** Only 4 of 247 companies have a ticker, and in testing 36% of sampled headlines were about a different entity ("Metro Bank" cricket, "Lewis" Hamilton). The screener discards those, but a better search avoids them and gives the identity question more to go on.
2. **Write a line of business context for your daily companies.** It is never required, but it sharpens "does this matter at this company's size" ("mid-size specialty insurer; E&S lines are ~80% of premium; key risk is catastrophe exposure in Florida").
3. **Add primary sources for important companies:** an SEC CIK number for US filers, or the investor-relations news page or RSS feed. The company's own documents are the most reliable path to Recommended reading, and they avoid Google entirely.
4. **Add watch points** for the specific risks and catalysts you care about.
5. **Connect prices** if you want automatic price alerts. Otherwise, "No quote source configured" notices will keep appearing.

---

## 17. A map of the code in plain words

| Where | What lives there |
| --- | --- |
| `src/main.tsx` | The website: sign-in, navigation, company editor, autosave, settings, import screens, monitoring table. |
| `src/news-panel.tsx` | The News & alerts screen: folders, views, filters, cards, the scheduled-run and search-progress panels. |
| `src/news-cache.ts` | The browser's own copy of your articles, so opening the desk downloads only changes. |
| `src/drafts.ts` | The on-device safety copy of unsaved company edits. |
| `src/sync.ts`, `src/api.ts` | Merging fresh data into the screen safely, and talking to the server. |
| `supabase/functions/desk/index.ts` | The server's front door: checks who is calling (you, an assistant, or the timer). |
| `supabase/functions/_shared/scheduler.ts` | The minute-by-minute checklist: decides when daily and weekly runs, prices, backups, re-screens and the digest happen. |
| `supabase/functions/_shared/news-batch.ts` | The run engine: works through companies, searches and articles in small steps with bookmarks, back-off and warnings. Used by both nightly runs and your manual searches. |
| `supabase/functions/_shared/jobs.ts` | Processing one article end to end, re-screens, price checks, daily backup, and building and sending the digest. |
| `supabase/functions/_shared/article-content.ts` | Finding and reading articles: Google link translation, publisher fetching, safety checks, text extraction, SEC and investor-relations discovery. |
| `supabase/functions/_shared/fetch-policy.ts` | Politeness rules: Google spacing and slow-down, recognising "too many requests", skipping publishers that block. |
| `supabase/functions/_shared/providers.ts` | Reading RSS news feeds and the price feed; configuration. |
| `supabase/functions/_shared/news-screening.ts` | Preparing the briefing for TypeSafe (headline, plus text when it was read), sending it and checking its answers. |
| `supabase/functions/_shared/screening-prompts.ts` | The exact wording of the five core questions. |
| `supabase/functions/_shared/fundamental-policy.ts` | The rulebook (section 6): `decideScreening` for v3. The older v2 rules only replay stored v2 verdicts until those articles are re-screened. |
| `supabase/functions/_shared/screening-policy.ts` | Grouping duplicates, choosing the lead article, digest ordering, and compatibility with older judgments. |
| `supabase/functions/_shared/news.ts` | Google search wording, cleaning up article text, and which view an article belongs in. |
| `supabase/functions/_shared/engine.ts` | Daily/weekly schedule arithmetic, Chicago time, price-rule arithmetic. |
| `supabase/functions/_shared/event-inbox.ts` | Inbox, Saved and History rules. |
| `supabase/functions/_shared/api.ts`, `api-v1.ts` | Every request the website and assistants can make, with permission checks. |
| `supabase/functions/_shared/model.ts` | The shape of a company, an article and a record. |
| `supabase/functions/_shared/supabase-store.ts`, `server/store.ts` | The filing clerk: reading and writing records in the cloud database, or in a local file when running on your computer. |
| `supabase/functions/_shared/constants.ts` | Statuses, default settings, and the nightly schedule (`NEWS_SCHEDULE`). |
| `supabase/migrations/` | The database's structure and its guarded write functions. |
| `client/`, `mcp/`, `bot/`, `openclaw/` | How AI assistants connect, using the same operations as the website. |
| `tests/` | 223 automated checks, run with `npm test`. |
| `scripts/` | Maintenance, diagnostics and one-off tools. Some make paid AI calls; read before running. |

---

## 18. Glossary

- **Article role:** the rulebook's verdict for one article: primary reading, analytical addition (valuable analysis), coverage only, needs verification, or rejected.
- **Back-off:** waiting progressively longer before retrying after a "too many requests" reply.
- **Cadence:** how often a company is checked. Daily companies are in the 1am run; everyone not paused is in the Friday sweep.
- **Coverage:** other articles about the same development, grouped under the lead article.
- **Development:** one real-world event, however many articles describe it.
- **Digest:** the 7am email.
- **Edge Function:** a small cloud program that runs briefly when called. Here, the server.
- **Egress:** data leaving the database; limited to 5 GB a month on the free plan.
- **HTTP 403 / 429 / 503:** a website saying "forbidden", "too many requests" and "temporarily unavailable".
- **Lease:** a temporary "reserved" sign that stops two workers doing the same job.
- **Primary source:** the company's own disclosure or a regulator's document, such as an SEC filing or investor-relations release.
- **Probability / confidence:** how sure TypeSafe is of each possible answer, from 0% to 100%.
- **Re-screen:** judging a stored article again, after a failed read, a context change or a new rulebook version.
- **RSS:** a simple machine-readable news list; Google News search results come in this format.
- **Run:** one pass of news searching over a list of companies (the daily run, the weekly sweep, or your manual search).
- **Snapshot:** the automatic daily backup of your research.
- **Tick:** one ring of the minute timer, and the work the server does in response.
- **Token:** the unit TypeSafe charges by; roughly three-quarters of a word.
- **TypeSafe:** the AI service that answers the structured questions about each article.
- **Version number:** a counter on each record that prevents one save from silently overwriting another.
