-- Browser and digest reads of articles (desk_ui_records) omit model internals
-- that only the server uses: raw TypeSafe answers, probability tables,
-- coverage comparisons and duplicated evidence. Opening the desk with ~7,000
-- stored articles downloaded 19 MB before this change. Full records remain in
-- desk_records for rescreens, exports and backups.
create or replace view public.desk_ui_records with (security_invoker = true) as
 select owner_id,kind,id,version,updated_at,
 case when kind='company' then data-'quoteHistory'
      when kind='event' then (data-'rawText')
        #- '{screening,rawAnswers}'
        #- '{screening,probabilities}'
        #- '{screening,comparisons}'
        #- '{classification,evidence}'
        #- '{classification,matches}'
      when kind='import' then data-'source'-'selections'
      when kind='backup' then data-'records'
      else data end as data
 from public.desk_records;
