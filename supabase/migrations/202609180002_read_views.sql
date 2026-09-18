begin;
create or replace view public.desk_ui_records with (security_invoker = true) as
 select owner_id,kind,id,version,updated_at,
 case when kind='company' then data-'quoteHistory'
      when kind='event' then data-'rawText'
      when kind='import' then data-'source'-'selections'
      else data end as data
 from public.desk_records;
create or replace view public.desk_usage_summary with (security_invoker = true) as
 select owner_id,month,sum(amount) as cost,sum(tokens) as tokens,count(*) as requests from public.desk_ai_usage group by owner_id,month;
revoke all on public.desk_ui_records,public.desk_usage_summary from anon;
grant select on public.desk_ui_records,public.desk_usage_summary to authenticated,service_role;
commit;
