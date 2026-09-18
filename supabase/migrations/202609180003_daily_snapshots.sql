begin;
alter table public.desk_records drop constraint desk_records_kind_check;
alter table public.desk_records add constraint desk_records_kind_check check(kind in ('company','event','revision','settings','import','attempt','run','digest','budget','backup'));
create or replace view public.desk_ui_records with (security_invoker = true) as
 select owner_id,kind,id,version,updated_at,
 case when kind='company' then data-'quoteHistory'
      when kind='event' then data-'rawText'
      when kind='import' then data-'source'-'selections'
      when kind='backup' then data-'records'
      else data end as data
 from public.desk_records;
commit;
