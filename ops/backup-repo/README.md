# Research Desk backups (private)

Weekly off-site copy of the Research Desk data, made by
`.github/workflows/weekly-backup.yml` every Sunday at 06:17 UTC (or on demand
from the Actions tab → *Weekly Research Desk backup* → *Run workflow*).

**Keep this repository private** — backups contain private research notes.

## What is in each backup

`backups/research-desk-YYYY-MM-DD.json.gz` is the app's *essential* export:
all companies (with notes, thesis, watch points, alert rules and news feeds),
research revisions, settings, import history, and every article you acted on
(saved, marked useful/noise, or reviewed). Stored article text and TypeSafe
model internals are left out; unreviewed screener output is not kept because
the next news run recreates it. The newest 26 backups are kept.

## Restore

1. `gunzip -k backups/research-desk-YYYY-MM-DD.json.gz`
2. In the app: Import & backup → **Restore backup**, and choose the
   `.json` file. Restore only adds missing records; it never overwrites current work.

## Setup

The workflow needs one secret, `DESK_BACKUP_TOKEN`: an integration token made
in the app (Settings → MCP & OpenClaw → new token, client *Other API client*,
scope **backup:read** only, expiry 1 year). Renew it before it expires; a
failed run emails the repository owner.
