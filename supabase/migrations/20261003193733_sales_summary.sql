-- Exact aggregate over the selected interval, not the last 100 invoice cards.
-- SECURITY INVOKER preserves RLS; owner/platform membership is checked from DB.
create function public.pos_sales_summary(p_store_id uuid, p_from timestamptz, p_until timestamptz)
returns table(sales_count bigint, total numeric, cash_total numeric, card_total numeric)
language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.stores s where s.id=p_store_id and s.active and (
      exists(select 1 from public.platform_admins a where a.user_id=(select auth.uid())) or
      exists(select 1 from public.store_memberships m where m.store_id=s.id and m.user_id=(select auth.uid()) and m.role='owner')
    )
  ) then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  if p_from is null or p_until is null or not isfinite(p_from) or not isfinite(p_until)
    or p_until<=p_from or p_until>p_from+interval '32 days' then
    raise exception 'POS_INVALID_RANGE' using errcode='22023';
  end if;
  return query select count(*),coalesce(sum(s.total),0),
    coalesce(sum(s.total) filter(where s.payment_method='cash'),0),
    coalesce(sum(s.total) filter(where s.payment_method='card'),0)
    from public.sales s where s.store_id=p_store_id and s.created_at>=p_from and s.created_at<p_until;
end $$;
revoke all on function public.pos_sales_summary(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.pos_sales_summary(uuid,timestamptz,timestamptz) to authenticated;
