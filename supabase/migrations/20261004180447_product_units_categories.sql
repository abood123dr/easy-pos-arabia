-- Labels only: quantities and prices remain expressed in this single selling unit.
-- Existing products and invoices have an unspecified legacy unit; no balances are converted.
alter table public.products add column unit text not null default 'unit'
  check (unit in ('unit','piece','kg','g','liter','pack'));
alter table public.products add column category text
  check (category is null or (category = btrim(category) and length(category) between 1 and 80));
alter table public.sale_items add column product_unit text not null default 'unit'
  check (product_unit in ('unit','piece','kg','g','liter','pack'));

create function private.pos_save_product_details(
  p_store_id uuid,p_id uuid,p_name text,p_barcode text,p_price numeric,p_active boolean,
  p_unit text,p_category text
) returns public.products language plpgsql security definer set search_path='' as $$
declare v_product public.products; v_category text := nullif(btrim(p_category),'');
begin
  perform private.pos_assert_access(p_store_id,true);
  if p_unit is null or p_unit not in ('unit','piece','kg','g','liter','pack')
    or (v_category is not null and length(v_category)>80) then
    raise exception 'POS_INVALID_PRODUCT' using errcode='22023';
  end if;
  -- Upsert obtains the row lock even if a concurrent request just created this ID.
  -- Unit checks happen after the lock, so concurrent stock changes cannot slip through.
  v_product := private.pos_save_product(p_store_id,p_id,p_name,p_barcode,p_price,p_active);
  if v_product.id is not null and v_product.unit<>p_unit and v_product.stock<>0 then
    raise exception 'POS_UNIT_HAS_STOCK' using errcode='22023';
  end if;
  -- A rejected unit change rolls back the name/price update from the upsert too.
  update public.products set unit=p_unit,category=v_category
    where store_id=p_store_id and id=p_id returning * into v_product;
  return v_product;
end $$;
create function public.pos_save_product_details(
  p_store_id uuid,p_id uuid,p_name text,p_barcode text,p_price numeric,p_active boolean,
  p_unit text,p_category text
) returns public.products language sql security invoker set search_path='' as $$
  select private.pos_save_product_details(p_store_id,p_id,p_name,p_barcode,p_price,p_active,p_unit,p_category)
$$;
revoke all on function private.pos_save_product_details(uuid,uuid,text,text,numeric,boolean,text,text),
  public.pos_save_product_details(uuid,uuid,text,text,numeric,boolean,text,text) from public,anon,authenticated;
grant execute on function private.pos_save_product_details(uuid,uuid,text,text,numeric,boolean,text,text),
  public.pos_save_product_details(uuid,uuid,text,text,numeric,boolean,text,text) to authenticated;

-- Checkout already holds the product row lock; snapshot the trusted server unit.
create function private.pos_snapshot_product_unit()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  select p.unit into new.product_unit from public.products p
    where p.store_id=new.store_id and p.id=new.product_id;
  if new.product_unit is null then
    raise exception 'POS_PRODUCT_UNAVAILABLE' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function private.pos_snapshot_product_unit() from public,anon,authenticated;
create trigger sale_items_unit_snapshot before insert on public.sale_items
for each row execute function private.pos_snapshot_product_unit();
