begin;
alter table public.desk_records drop constraint desk_records_kind_check;
alter table public.desk_records add constraint desk_records_kind_check check(kind in ('company','event','revision','settings','import','attempt','run','digest','budget','backup','article_cache','news_batch'));
commit;
