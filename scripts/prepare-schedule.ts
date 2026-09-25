import { readFileSync, writeFileSync } from "node:fs";
const setup = JSON.parse(readFileSync(".local/cloud-setup.json", "utf8"));
if (!/^[A-Za-z0-9_-]{40,100}$/.test(setup.cronSecret))
  throw new Error("Unexpected scheduler token format.");
writeFileSync(
  ".local/install-schedule.sql",
  `begin;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $block$ begin
 if not exists(select 1 from vault.secrets where name='research_desk_cron') then
  perform vault.create_secret('${setup.cronSecret}', 'research_desk_cron', 'Research Desk scheduler credential');
 else
  perform vault.update_secret((select id from vault.secrets where name='research_desk_cron'), '${setup.cronSecret}');
 end if;
end $block$;
-- Fires every minute but only calls the desk when desk_scheduler_due() says
-- work is in progress (else every 10th minute). Requires migration
-- 202609250009_gated_scheduler.sql; see scheduler.ts.
select cron.schedule('research-desk-monitor','* * * * *',$job$
 select net.http_post(
  url := 'https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/scheduled',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='research_desk_cron')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
 )
 where public.desk_scheduler_due();
$job$);
commit;`,
);
console.log("Scheduler SQL prepared in ignored local setup folder.");
