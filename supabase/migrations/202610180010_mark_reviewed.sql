-- "Mark all reviewed": sets reviewed=true on many articles in one statement,
-- changing only that field, so the browser and server never download or
-- resend whole article records (egress). Saved and already reviewed articles
-- are left alone. Returns the new version of each changed article.
begin;
create or replace function public.desk_mark_reviewed(p_owner uuid,p_ids text[]) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if coalesce(array_length(p_ids,1),0) > 5000 then raise exception 'invalid batch'; end if;
 with changed as (
  update public.desk_records
     set data=jsonb_set(data,'{reviewed}','true'::jsonb),version=version+1,updated_at=now()
   where owner_id=p_owner and kind='event' and id=any(p_ids)
     and coalesce((data->>'reviewed')::boolean,false)=false
     and coalesce((data->>'saved')::boolean,false)=false
  returning id,version,updated_at)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'updatedAt',updated_at)),'[]'::jsonb) into result from changed;
 return result;
end $$;
revoke all on function public.desk_mark_reviewed(uuid,text[]) from public,anon,authenticated;
grant execute on function public.desk_mark_reviewed(uuid,text[]) to service_role;
commit;
