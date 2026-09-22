begin;
alter table public.desk_records drop constraint desk_records_kind_check;
alter table public.desk_records add constraint desk_records_kind_check check(kind in ('company','event','revision','settings','import','attempt','run','digest','budget','backup','article_cache','news_batch','integration','request','audit','job'));
create or replace function public.desk_batch_put(p_owner uuid,p_writes jsonb) returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; results jsonb := '[]'::jsonb;
begin
 if jsonb_typeof(p_writes) <> 'array' or jsonb_array_length(p_writes) > 20000 then raise exception 'invalid batch'; end if;
 for item in select value from jsonb_array_elements(p_writes) order by value->>'kind', value->>'id' loop
  results := results || jsonb_build_array(public.desk_put(p_owner,item->>'kind',item->>'id',item->'data',(item->>'expected')::integer));
 end loop;
 return results;
end $$;
revoke all on function public.desk_batch_put(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.desk_batch_put(uuid,jsonb) to service_role;
-- Integration metadata and request ledgers are served only by the authenticated API.
drop policy if exists "Private records" on public.desk_records;
create policy "Private records" on public.desk_records for select to authenticated using (owner_id=(select auth.uid()) and kind not in ('integration','request','audit'));
commit;
