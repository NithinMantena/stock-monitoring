begin;
create table if not exists public.desk_records (
 owner_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check(kind in ('company','event','revision','settings','import','attempt','run','digest','budget')),
 id text not null, data jsonb not null, version integer not null default 1 check(version > 0), updated_at timestamptz not null default now(),
 primary key(owner_id,kind,id)
);
create index if not exists desk_records_recent on public.desk_records(owner_id,kind,updated_at desc);
create table if not exists public.desk_locks(owner_id uuid not null references auth.users(id) on delete cascade,key text not null,token uuid not null,expires timestamptz not null,primary key(owner_id,key));
create table if not exists public.desk_ai_usage(id uuid primary key default gen_random_uuid(),owner_id uuid not null references auth.users(id) on delete cascade,month text not null,amount numeric not null check(amount >= 0),tokens integer not null default 0 check(tokens >= 0),settled boolean not null default false,created_at timestamptz not null default now());
create index if not exists desk_ai_usage_month on public.desk_ai_usage(owner_id,month);
alter table public.desk_records enable row level security;
alter table public.desk_locks enable row level security;
alter table public.desk_ai_usage enable row level security;
revoke all on public.desk_records,public.desk_locks,public.desk_ai_usage from anon,authenticated;
grant select on public.desk_records,public.desk_ai_usage to authenticated;
grant all on public.desk_records,public.desk_locks,public.desk_ai_usage to service_role;
create policy "Private records" on public.desk_records for select to authenticated using (owner_id = (select auth.uid()));
create policy "Private usage" on public.desk_ai_usage for select to authenticated using (owner_id = (select auth.uid()));
create or replace function public.desk_put(p_owner uuid,p_kind text,p_id text,p_data jsonb,p_expected integer) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result public.desk_records;
begin
 if p_expected = 0 then
  insert into public.desk_records(owner_id,kind,id,data) values(p_owner,p_kind,p_id,p_data) on conflict do nothing returning * into result;
 else
  update public.desk_records set data=p_data,version=version+1,updated_at=now() where owner_id=p_owner and kind=p_kind and id=p_id and version=p_expected returning * into result;
 end if;
 if result.id is null then raise exception 'record conflict'; end if;
 return to_jsonb(result);
end $$;
create or replace function public.desk_claim(p_owner uuid,p_key text,p_seconds integer) returns uuid language plpgsql security invoker set search_path='' as $$
declare result uuid; fresh uuid := gen_random_uuid();
begin
 insert into public.desk_locks(owner_id,key,token,expires) values(p_owner,p_key,fresh,now()+make_interval(secs=>least(p_seconds,600)))
 on conflict(owner_id,key) do update set token=excluded.token,expires=excluded.expires where public.desk_locks.expires < now() returning token into result;
 return result;
end $$;
create or replace function public.desk_release(p_owner uuid,p_key text,p_token uuid) returns void language sql security invoker set search_path='' as $$ delete from public.desk_locks where owner_id=p_owner and key=p_key and token=p_token $$;
create or replace function public.desk_reserve_ai(p_owner uuid,p_amount numeric,p_cap numeric) returns uuid language plpgsql security invoker set search_path='' as $$
declare result uuid; used numeric; month_key text := to_char(now() at time zone 'UTC','YYYY-MM');
begin
 if p_amount < 0 or p_cap < 0 then raise exception 'invalid budget'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select coalesce(sum(amount),0) into used from public.desk_ai_usage where owner_id=p_owner and month=month_key;
 if used+p_amount > p_cap then raise exception 'monthly budget exhausted'; end if;
 insert into public.desk_ai_usage(owner_id,month,amount) values(p_owner,month_key,p_amount) returning id into result;
 return result;
end $$;
revoke all on function public.desk_put(uuid,text,text,jsonb,integer),public.desk_claim(uuid,text,integer),public.desk_release(uuid,text,uuid),public.desk_reserve_ai(uuid,numeric,numeric) from public,anon,authenticated;
grant execute on function public.desk_put(uuid,text,text,jsonb,integer),public.desk_claim(uuid,text,integer),public.desk_release(uuid,text,uuid),public.desk_reserve_ai(uuid,numeric,numeric) to service_role;
commit;
