-- Wake the hosted scheduler only when it has something to do.
--
-- Every scheduler call writes Supabase log entries (function invocation plus
-- each database call it makes), and the free plan allows 1 GB of log ingestion
-- a month. pg_cron still fires every minute, but this check runs inside the
-- database and adds no API logs. When it returns false, no HTTP call is made.
--
-- Due when:
--  * a news run, manual news batch or API job is in progress or queued
--  * nightly re-screens are pending, or tonight's closing prices are not done
--  * otherwise every 10th minute (idle heartbeat: starts the daily/weekly runs,
--    digest and backup, all at most ~10 minutes after their scheduled time)
-- The 01:00 America/Chicago hour matches NEWS_SCHEDULE.dailyHour in
-- supabase/functions/_shared/constants.ts.
create or replace function public.desk_scheduler_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with local as (
    select to_char(now() at time zone 'America/Chicago', 'YYYY-MM-DD') as day,
           extract(hour from now() at time zone 'America/Chicago')::int as hour
  ), schedule as (
    select data from public.desk_records where kind = 'run' and id = 'schedule'
  )
  select extract(minute from now())::int % 10 = 0
    or not exists (select 1 from schedule)
    or exists (
      select 1 from schedule, local
       where coalesce(schedule.data->>'activeRunId', '') <> ''
          or coalesce((schedule.data->>'rescreenPending')::int, 0) > 0
          or (local.hour >= 1 and (schedule.data->>'quotesDate') is distinct from local.day)
    )
    or exists (
      select 1 from public.desk_records
       where kind = 'news_batch' and id = 'latest' and data->>'status' = 'running'
    )
    or exists (
      select 1 from public.desk_records
       where kind = 'job' and data->>'status' in ('queued', 'running')
    );
$$;
revoke all on function public.desk_scheduler_due() from public, anon, authenticated;
grant execute on function public.desk_scheduler_due() to postgres, service_role;

-- Same call as scripts/prepare-schedule.ts, now gated.
select cron.alter_job(
  job_id := (select jobid from cron.job where jobname = 'research-desk-monitor'),
  command := $job$
 select net.http_post(
  url := 'https://tcfricxifanwwzgxgexj.supabase.co/functions/v1/desk/scheduled',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='research_desk_cron')),
  body := '{}'::jsonb,
  timeout_milliseconds := 120000
 )
 where public.desk_scheduler_due();
$job$
);
