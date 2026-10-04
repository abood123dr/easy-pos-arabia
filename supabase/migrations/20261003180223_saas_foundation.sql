-- Apply only to a new, dedicated POS project.
create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.store_memberships (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'cashier')),
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index store_memberships_user_id_idx on public.store_memberships(user_id);

alter table public.platform_admins enable row level security;
alter table public.stores enable row level security;
alter table public.store_memberships enable row level security;

-- No browser role may grant itself platform privileges, including an existing admin.
revoke all on public.platform_admins, public.stores, public.store_memberships from anon, authenticated;
grant select on public.platform_admins to authenticated;
grant select, insert, update, delete on public.stores, public.store_memberships to authenticated;
grant all on public.platform_admins, public.stores, public.store_memberships to service_role;

create policy admin_can_read_own on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));
create policy member_can_read_own on public.store_memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy admin_manages_members on public.store_memberships for all to authenticated
  using (exists (select 1 from public.platform_admins where user_id = (select auth.uid())))
  with check (exists (select 1 from public.platform_admins where user_id = (select auth.uid())));
create policy member_reads_store on public.stores for select to authenticated
  using (exists (select 1 from public.store_memberships m where m.store_id = stores.id and m.user_id = (select auth.uid())));
create policy admin_manages_stores on public.stores for all to authenticated
  using (exists (select 1 from public.platform_admins where user_id = (select auth.uid())))
  with check (exists (select 1 from public.platform_admins where user_id = (select auth.uid())));
