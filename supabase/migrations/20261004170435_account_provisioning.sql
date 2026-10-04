-- Provisioning secrets/requests stay outside exposed schemas.
create table private.pos_account_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id),
  store_id uuid not null references public.stores(id),
  email text not null,
  member_role text not null check(member_role in ('owner','cashier')),
  mode text not null check(mode in ('create','attach')),
  fingerprint text not null check(length(fingerprint)=64),
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table private.pos_account_requests enable row level security;
revoke all on private.pos_account_requests from public,anon,authenticated,service_role;
grant usage on schema private to service_role;

create function private.pos_account_begin(p_actor uuid,p_request uuid,p_store uuid,p_email text,p_role text,p_mode text,p_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.pos_account_requests;
begin
  perform 1 from public.platform_admins where user_id=p_actor for share;
  if not found then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  perform 1 from public.stores where id=p_store and active for share;
  if not found then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  if p_request is null or p_email is null or length(p_email) not between 3 and 254
    or p_email<>lower(btrim(p_email)) or p_role is null or p_role not in ('owner','cashier')
    or p_mode is null or p_mode not in ('create','attach') or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'POS_INVALID_ACCOUNT' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
  select * into r from private.pos_account_requests where request_id=p_request for update;
  if found then
    if r.actor_id<>p_actor or r.store_id<>p_store or r.email<>p_email or r.member_role<>p_role or r.mode<>p_mode or r.fingerprint<>p_fingerprint then
      raise exception 'POS_REQUEST_CONFLICT' using errcode='22023'; end if;
  else
    insert into private.pos_account_requests(request_id,actor_id,store_id,email,member_role,mode,fingerprint)
      values(p_request,p_actor,p_store,p_email,p_role,p_mode,p_fingerprint) returning * into r;
  end if;
  return jsonb_build_object('completed',r.completed_at is not null,'user_id',r.user_id);
end $$;

create function private.pos_account_find(p_email text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if (select count(*) from auth.users where lower(email)=p_email and deleted_at is null and not coalesce(is_anonymous,false))>1 then
    raise exception 'POS_AMBIGUOUS_ACCOUNT' using errcode='22023'; end if;
  select jsonb_build_object('id',u.id,'request_id',u.raw_app_meta_data->>'pos_request_id','actor_id',u.raw_app_meta_data->>'pos_actor_id')
    into result from auth.users u where lower(u.email)=p_email and u.deleted_at is null and not coalesce(u.is_anonymous,false);
  return result;
end $$;

create function private.pos_account_finish(p_actor uuid,p_request uuid,p_user uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.pos_account_requests; v_role text; v_user auth.users;
begin
  perform 1 from public.platform_admins where user_id=p_actor for share;
  if not found then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  select * into r from private.pos_account_requests where request_id=p_request and actor_id=p_actor for update;
  if not found or p_user is null then raise exception 'POS_INVALID_ACCOUNT' using errcode='22023'; end if;
  perform 1 from public.stores where id=r.store_id and active for share;
  if not found then raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  if r.completed_at is not null then
    if r.user_id<>p_user then raise exception 'POS_REQUEST_CONFLICT' using errcode='22023'; end if;
    -- Never restore a membership removed/changed after the original operation.
    return jsonb_build_object('completed',true,'user_id',r.user_id);
  end if;
  select * into v_user from auth.users where id=p_user and deleted_at is null and not coalesce(is_anonymous,false);
  if not found or lower(v_user.email) is distinct from r.email then raise exception 'POS_INVALID_ACCOUNT' using errcode='22023'; end if;
  if r.mode='create' and ((v_user.raw_app_meta_data->>'pos_request_id') is distinct from r.request_id::text or (v_user.raw_app_meta_data->>'pos_actor_id') is distinct from p_actor::text) then
    raise exception 'POS_REQUEST_CONFLICT' using errcode='22023'; end if;
  insert into public.store_memberships(store_id,user_id,role) values(r.store_id,p_user,r.member_role) on conflict do nothing;
  select role into v_role from public.store_memberships where store_id=r.store_id and user_id=p_user for share;
  if v_role<>r.member_role then raise exception 'POS_ROLE_CONFLICT' using errcode='22023'; end if;
  update private.pos_account_requests set user_id=p_user,completed_at=now() where request_id=p_request;
  return jsonb_build_object('completed',true,'user_id',p_user);
end $$;

create function private.pos_account_members(p_store uuid)
returns table(user_id uuid,email text,role text) language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.platform_admins a where a.user_id=auth.uid()) then
    raise exception 'POS_ACCESS_DENIED' using errcode='42501'; end if;
  return query select m.user_id,u.email,m.role from public.store_memberships m join auth.users u on u.id=m.user_id
    where m.store_id=p_store order by u.email;
end $$;
create function public.pos_account_members(p_store uuid) returns table(user_id uuid,email text,role text)
language sql security invoker set search_path='' as $$select * from private.pos_account_members(p_store)$$;
create function public.pos_account_begin(p_actor uuid,p_request uuid,p_store uuid,p_email text,p_role text,p_mode text,p_fingerprint text)
returns jsonb language sql security invoker set search_path='' as $$select private.pos_account_begin(p_actor,p_request,p_store,p_email,p_role,p_mode,p_fingerprint)$$;
create function public.pos_account_find(p_email text) returns jsonb language sql security invoker set search_path='' as $$select private.pos_account_find(p_email)$$;
create function public.pos_account_finish(p_actor uuid,p_request uuid,p_user uuid) returns jsonb language sql security invoker set search_path='' as $$select private.pos_account_finish(p_actor,p_request,p_user)$$;

revoke all on function private.pos_account_begin(uuid,uuid,uuid,text,text,text,text),private.pos_account_find(text),private.pos_account_finish(uuid,uuid,uuid),
 public.pos_account_begin(uuid,uuid,uuid,text,text,text,text),public.pos_account_find(text),public.pos_account_finish(uuid,uuid,uuid),
 private.pos_account_members(uuid),public.pos_account_members(uuid) from public,anon,authenticated,service_role;
grant execute on function private.pos_account_begin(uuid,uuid,uuid,text,text,text,text),private.pos_account_find(text),private.pos_account_finish(uuid,uuid,uuid),
 public.pos_account_begin(uuid,uuid,uuid,text,text,text,text),public.pos_account_find(text),public.pos_account_finish(uuid,uuid,uuid) to service_role;
grant execute on function private.pos_account_members(uuid),public.pos_account_members(uuid) to authenticated;
