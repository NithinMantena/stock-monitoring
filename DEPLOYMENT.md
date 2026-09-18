# Hosted setup

The Supabase database, private owner account, TypeSafe integration, and monitoring scheduler have been installed in `tcfricxifanwwzgxgexj`. The other Supabase project was not modified.

## Frontend hosting

Cloudflare authentication is still needed to publish the permanent web address:

```powershell
npx wrangler login
npx wrangler pages project create research-desk --production-branch main
npm run build
npx wrangler pages deploy dist --project-name research-desk
```

Use the project name actually created if the name is unavailable. The Cloudflare build needs these **public** values: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`. The local `.env.production.local` was prepared from the selected project. No secret belongs in the frontend bundle.

After obtaining the final hostname:

1. Add its exact HTTPS origin to the Supabase `APP_ORIGIN` secret (alongside local origins if desired).
2. Configure Supabase Auth's Site URL and redirect allowlist to this hostname. Review `npx supabase config diff` before `config push`.
3. Disable new account signup for this single-owner desk. The allowed owner account already exists.
4. Test a sign-in link requested from the app, company creation, notes, refresh and sign-out. Do not send a login email automatically without the user requesting it.

## Quote data

Set `EODHD_API_KEY` as an Edge Function secret. Confirm each symbol, exchange and native quote currency before selecting EODHD in the company's Monitoring tab. The adapter retrieves raw daily closes and historical observations for weekly crossing detection. It does not assume that the same subscription includes fundamentals.

The first release supports manual P/E and market-cap observations. Automated global fundamentals remain a coverage/provider decision. Do not buy a higher tier automatically or treat GBP and GBX as interchangeable.

## Daily digest

Configure a Resend account with a verified sender/domain and set:

```dotenv
RESEND_API_KEY=your-server-key
DIGEST_FROM=Research Desk <a-verified-sender@your-domain>
DIGEST_TO=nithin@mantena.com
ENABLE_EMAIL_DELIVERY=true
```

Then enable **Settings & digest → Enable daily digest**. The default hour is 07:00 in `America/Chicago`. Preview the digest first. The sender must pass Resend/domain requirements; possession of an API key alone does not verify a domain. Sending has not been tested against a real recipient in the initial setup.

## Updating the backend

```powershell
npx supabase login
npx supabase link --project-ref tcfricxifanwwzgxgexj
npx supabase functions deploy desk --project-ref tcfricxifanwwzgxgexj --use-api
```

Migrations were initially applied through `supabase db query --linked --file ...`, so do not blindly reapply their non-idempotent policy/constraint creation. Record migration history before adopting a `db push` pipeline. Apply only new reviewed migrations.

`scripts/prepare-cloud.ps1` and `scripts/prepare-cloud.ts` handle approved account/credential setup. They temporarily use powerful credentials in ignored `.local` files. Keep those files private, remove them after setup/testing, and exclude `.local` from any Obsidian/cloud-file synchronization. They must never be committed. Existing environment TypeSafe keys are copied only to the app's server secrets.

The scheduler is `research-desk-monitor`, installed through `scripts/prepare-schedule.ts`. It uses a Vault secret and does not depend on GitHub Actions or the user's PC. Inspect recent `net._http_response` status codes and `desk_records` kind `run` to diagnose failures. Disable it with `select cron.unschedule('research-desk-monitor');` when intentionally stopping monitoring.

## Backup and recovery

Daily hosted research snapshots retain 30 days. Use **Import & backup → Download latest daily research snapshot** or a complete manual export. Restore adds missing IDs and preserves existing records; to recover a prior note on an existing company, use its note history. Always keep an off-project export before deleting or replacing the project. In-project snapshots do not protect against deletion of the entire Supabase project.

## Sources consulted during implementation

- [TypeSafe API](https://docs.typesafe.ai/api), [choice primitive](https://docs.typesafe.ai/primitives/choice), [evidence cookbook](https://docs.typesafe.ai/cookbooks/citation_check).
- [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions) and installed CLI help/config-diff guidance.
- [Cloudflare Vite deployment](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/).
- EODHD's official API/pricing references and provider tradeoffs are preserved in the approved PRD.
