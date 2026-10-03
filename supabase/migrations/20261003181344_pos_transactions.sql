create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.products (
  id uuid primary key,
  store_id uuid not null references public.stores(id),
  name text not null check (length(btrim(name)) between 1 and 160),
  barcode text check (barcode is null or length(barcode) between 1 and 80),
  price numeric(12,2) not null check (price >= 0 and price < 1000000000),
  stock numeric(12,3) not null default 0 check (stock >= 0 and stock < 1000000000),
  active boolean not null default true,
  unique(store_id,id), unique(store_id,barcode)
);
create table public.sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  invoice_no bigint generated always as identity,
  cashier_id uuid not null references auth.users(id),
  request_id uuid not null,
  request_payload jsonb not null,
  payment_method text not null check (payment_method in ('cash','card')),
  total numeric(14,2) not null default 0 check (total >= 0),
  created_at timestamptz not null default now(),
  unique(store_id,id), unique(store_id,request_id)
);
create index sales_store_created_idx on public.sales(store_id,created_at desc);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  sale_id uuid not null,
  product_id uuid not null,
  product_name text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  total numeric(14,2) not null check (total >= 0),
  foreign key (store_id,sale_id) references public.sales(store_id,id),
  foreign key (store_id,product_id) references public.products(store_id,id),
  unique(sale_id,product_id)
);
create index sale_items_store_sale_idx on public.sale_items(store_id,sale_id);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  product_id uuid not null,
  actor_id uuid not null references auth.users(id),
  delta numeric(12,3) not null check (delta <> 0),
  note text not null check (length(btrim(note)) between 1 and 300),
  request_id uuid not null,
  sale_id uuid,
  created_at timestamptz not null default now(),
  foreign key (store_id,product_id) references public.products(store_id,id),
  foreign key (store_id,sale_id) references public.sales(store_id,id),
  unique(store_id,product_id,request_id)
);
create index stock_movements_store_created_idx on public.stock_movements(store_id,created_at desc);
create index stock_movements_store_sale_idx on public.stock_movements(store_id,sale_id);
create index stock_movements_actor_idx on public.stock_movements(actor_id);
create index sales_cashier_idx on public.sales(cashier_id);

-- Client writes are prohibited. All mutations below validate membership and
-- store state on the server; sensitive writes run only as an atomic operation.
do $$ declare t text; begin
  foreach t in array array['products','sales','sale_items','stock_movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create policy member_reads on public.%I for select to authenticated using (
      exists (select 1 from public.stores s where s.id=store_id and s.active and (
        exists (select 1 from public.platform_admins a where a.user_id=(select auth.uid())) or
        exists (select 1 from public.store_memberships m where m.store_id=s.id and m.user_id=(select auth.uid()))
      )))', t);
  end loop;
end $$;

-- Definer code lives in a non-exposed schema, with fixed search_path and
-- explicit identity checks. Public REST wrappers remain SECURITY INVOKER.
create function private.pos_assert_access(p_store_id uuid, p_owner_only boolean)
returns void language plpgsql security definer set search_path='' as $$
declare v_admin boolean; v_role text; v_active boolean;
begin
  if auth.uid() is null then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  select s.active into v_active from public.stores s where s.id=p_store_id for share;
  if v_active is distinct from true then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  select exists(select 1 from public.platform_admins a where a.user_id=auth.uid()) into v_admin;
  select m.role into v_role from public.store_memberships m where m.store_id=p_store_id and m.user_id=auth.uid() for share;
  if not v_admin and (v_role is null or (p_owner_only and v_role<>'owner')) then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501';
  end if;
end $$;
revoke all on function private.pos_assert_access(uuid,boolean) from public, anon, authenticated;

create function private.pos_save_product(p_store_id uuid,p_id uuid,p_name text,p_barcode text,p_price numeric,p_active boolean)
returns public.products language plpgsql security definer set search_path='' as $$
declare v_product public.products;
begin
  perform private.pos_assert_access(p_store_id,true);
  if p_id is null or p_name is null or p_price is null or p_active is null
    or length(btrim(p_name)) not between 1 and 160
    or p_price < 0 or p_price >= 1000000000 or p_price <> round(p_price,2) then
    raise exception 'POS_INVALID_PRODUCT' using errcode='22023';
  end if;
  insert into public.products(id,store_id,name,barcode,price,active)
  values(p_id,p_store_id,btrim(p_name),nullif(btrim(p_barcode),''),p_price,p_active)
  on conflict(id) do update set name=excluded.name,barcode=excluded.barcode,price=excluded.price,active=excluded.active
    where products.store_id=p_store_id
  returning * into v_product;
  if v_product.id is null then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  return v_product;
end $$;
create function public.pos_save_product(p_store_id uuid,p_id uuid,p_name text,p_barcode text,p_price numeric,p_active boolean)
returns public.products language sql security invoker set search_path='' as $$
  select private.pos_save_product(p_store_id,p_id,p_name,p_barcode,p_price,p_active)
$$;

create function private.pos_adjust_stock(p_store_id uuid,p_product_id uuid,p_request_id uuid,p_delta numeric,p_note text)
returns public.stock_movements language plpgsql security definer set search_path='' as $$
declare v_product public.products; v_old public.stock_movements; v_new public.stock_movements;
begin
  perform private.pos_assert_access(p_store_id,true);
  if p_request_id is null or p_delta is null or p_delta=0 or abs(p_delta)>=1000000000
    or p_delta<>round(p_delta,3) or p_note is null or length(btrim(p_note)) not between 1 and 300 then
    raise exception 'POS_INVALID_STOCK' using errcode='22023';
  end if;
  -- Serializes a retry with the same key, also across product IDs.
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text||p_request_id::text,0));
  select * into v_old from public.stock_movements where store_id=p_store_id and request_id=p_request_id limit 1;
  if found then
    if v_old.sale_id is not null or v_old.product_id<>p_product_id or v_old.actor_id<>auth.uid()
      or v_old.delta<>p_delta or v_old.note<>btrim(p_note) then
      raise exception 'POS_REQUEST_CONFLICT' using errcode='22023';
    end if;
    return v_old;
  end if;
  select * into v_product from public.products where store_id=p_store_id and id=p_product_id for update;
  if not found then raise exception 'POS_PRODUCT_UNAVAILABLE' using errcode='22023'; end if;
  if v_product.stock+p_delta<0 then raise exception 'POS_INSUFFICIENT_STOCK' using errcode='22023'; end if;
  update public.products set stock=stock+p_delta where id=p_product_id;
  insert into public.stock_movements(store_id,product_id,actor_id,delta,note,request_id)
    values(p_store_id,p_product_id,auth.uid(),p_delta,btrim(p_note),p_request_id) returning * into v_new;
  return v_new;
end $$;
create function public.pos_adjust_stock(p_store_id uuid,p_product_id uuid,p_request_id uuid,p_delta numeric,p_note text)
returns public.stock_movements language sql security invoker set search_path='' as $$
  select private.pos_adjust_stock(p_store_id,p_product_id,p_request_id,p_delta,p_note)
$$;

create function private.pos_checkout(p_store_id uuid,p_request_id uuid,p_items jsonb,p_payment_method text)
returns public.sales language plpgsql security definer set search_path='' as $$
declare v_sale public.sales; v_product public.products; v_item record; v_count int; v_payload jsonb;
begin
  perform private.pos_assert_access(p_store_id,false);
  if p_request_id is null or p_payment_method is null or p_payment_method not in ('cash','card')
    or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception 'POS_INVALID_CART' using errcode='22023';
  end if;
  v_count:=jsonb_array_length(p_items);
  if v_count not between 1 and 200 then raise exception 'POS_INVALID_CART' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_items) x
    where jsonb_typeof(x)<>'object' or not(x ? 'product_id' and x ? 'quantity')
      or (x - 'product_id' - 'quantity')<>'{}'::jsonb) then
    raise exception 'POS_INVALID_CART' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as i(product_id uuid,quantity numeric)
    where i.product_id is null or i.quantity is null or i.quantity<=0 or i.quantity>=1000000000
      or i.quantity<>round(i.quantity,3))
    or (select count(distinct i.product_id) from jsonb_to_recordset(p_items) as i(product_id uuid,quantity numeric))<>v_count then
    raise exception 'POS_INVALID_CART' using errcode='22023';
  end if;
  select jsonb_agg(jsonb_build_object('product_id',i.product_id,'quantity',i.quantity) order by i.product_id)
    into v_payload from jsonb_to_recordset(p_items) as i(product_id uuid,quantity numeric);
  perform pg_advisory_xact_lock(hashtextextended(p_store_id::text||p_request_id::text,0));
  select * into v_sale from public.sales where store_id=p_store_id and request_id=p_request_id;
  if found then
    if v_sale.cashier_id<>auth.uid() or v_sale.request_payload<>v_payload or v_sale.payment_method<>p_payment_method then
      raise exception 'POS_REQUEST_CONFLICT' using errcode='22023';
    end if;
    return v_sale;
  end if;
  insert into public.sales(store_id,cashier_id,request_id,request_payload,payment_method)
    values(p_store_id,auth.uid(),p_request_id,v_payload,p_payment_method) returning * into v_sale;
  -- Consistent order prevents deadlocks across multi-product baskets.
  for v_item in select * from jsonb_to_recordset(v_payload) as i(product_id uuid,quantity numeric) order by i.product_id loop
    select * into v_product from public.products where id=v_item.product_id and store_id=p_store_id and active for update;
    if not found then raise exception 'POS_PRODUCT_UNAVAILABLE' using errcode='22023'; end if;
    if v_product.stock<v_item.quantity then raise exception 'POS_INSUFFICIENT_STOCK' using errcode='22023'; end if;
    update public.products set stock=stock-v_item.quantity where id=v_product.id;
    insert into public.sale_items(store_id,sale_id,product_id,product_name,quantity,unit_price,total)
      values(p_store_id,v_sale.id,v_product.id,v_product.name,v_item.quantity,v_product.price,round(v_product.price*v_item.quantity,2));
    insert into public.stock_movements(store_id,product_id,actor_id,delta,note,request_id,sale_id)
      values(p_store_id,v_product.id,auth.uid(),-v_item.quantity,'بيع',p_request_id,v_sale.id);
  end loop;
  update public.sales set total=(select sum(i.total) from public.sale_items i where i.sale_id=v_sale.id)
    where id=v_sale.id returning * into v_sale;
  return v_sale;
end $$;
create function public.pos_checkout(p_store_id uuid,p_request_id uuid,p_items jsonb,p_payment_method text)
returns public.sales language sql security invoker set search_path='' as $$
  select private.pos_checkout(p_store_id,p_request_id,p_items,p_payment_method)
$$;

revoke all on function private.pos_save_product(uuid,uuid,text,text,numeric,boolean),
  private.pos_adjust_stock(uuid,uuid,uuid,numeric,text), private.pos_checkout(uuid,uuid,jsonb,text),
  public.pos_save_product(uuid,uuid,text,text,numeric,boolean),
  public.pos_adjust_stock(uuid,uuid,uuid,numeric,text), public.pos_checkout(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function private.pos_save_product(uuid,uuid,text,text,numeric,boolean),
  private.pos_adjust_stock(uuid,uuid,uuid,numeric,text), private.pos_checkout(uuid,uuid,jsonb,text),
  public.pos_save_product(uuid,uuid,text,text,numeric,boolean),
  public.pos_adjust_stock(uuid,uuid,uuid,numeric,text), public.pos_checkout(uuid,uuid,jsonb,text) to authenticated;
