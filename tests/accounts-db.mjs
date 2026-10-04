import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,raw_app_meta_data jsonb default '{}',deleted_at timestamptz,is_anonymous boolean default false);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated;
insert into auth.users(id,email) values ('${id(1)}','admin@example.test'),('${id(2)}','owner@example.test'),('${id(3)}','existing@example.test');`);
for (const f of readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort())
  await db.exec(readFileSync("supabase/migrations/" + f, "utf8"));
await db.exec(
  `insert into platform_admins(user_id) values ('${id(1)}');insert into stores(id,name) values ('${id(11)}','A'),('${id(12)}','B');insert into store_memberships(store_id,user_id,role) values ('${id(11)}','${id(2)}','owner');`,
);
let checks = 0;
async function login(n, role = "authenticated") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
    n ? id(n) : "",
  ]);
  await db.exec(`set role ${role}`);
}
async function q(sql, args = []) {
  return (await db.query(sql, args)).rows;
}
async function fail(fn, pattern) {
  await assert.rejects(fn, pattern);
  checks++;
}
async function eq(sql, want, args = []) {
  assert.deepEqual(await q(sql, args), want);
  checks++;
}
const begin = (
  actor = 1,
  key = 201,
  store = 11,
  email = "new@example.test",
  role = "cashier",
  mode = "create",
  digest = "a".repeat(64),
) =>
  q("select pos_account_begin($1,$2,$3,$4,$5,$6,$7) as value", [
    id(actor),
    id(key),
    id(store),
    email,
    role,
    mode,
    digest,
  ]);
const finish = (key = 201, user = 4, actor = 1) =>
  q("select pos_account_finish($1,$2,$3) as value", [
    id(actor),
    id(key),
    id(user),
  ]);
await login(1);
await fail(() => begin(), /permission denied/);
await fail(
  () => q("select pos_account_find('owner@example.test')"),
  /permission denied/,
);
await fail(() => finish(), /permission denied/);
await fail(
  () => q("select * from private.pos_account_requests"),
  /permission denied/,
);
await eq(
  "select * from pos_account_members($1)",
  [{ user_id: id(2), email: "owner@example.test", role: "owner" }],
  [id(11)],
);
await login(2);
await fail(
  () => q("select * from pos_account_members($1)", [id(11)]),
  /POS_ACCESS_DENIED/,
);
await login(0, "anon");
await fail(
  () => q("select * from pos_account_members($1)", [id(11)]),
  /permission denied/,
);
await login(0, "service_role");
await fail(() => begin(2), /POS_ACCESS_DENIED/);
await fail(
  () => begin(1, 202, 11, "new@example.test", "platform_admin"),
  /POS_INVALID_ACCOUNT/,
);
await eq(
  "select pos_account_find($1) as value",
  [{ value: null }],
  ["new@example.test"],
);
assert.deepEqual((await begin())[0].value, { completed: false, user_id: null });
checks++;
await begin();
await fail(() => begin(1, 201, 12), /POS_REQUEST_CONFLICT/);
await fail(
  () => begin(1, 201, 11, "new@example.test", "owner"),
  /POS_REQUEST_CONFLICT/,
);
await fail(
  () =>
    begin(1, 201, 11, "new@example.test", "cashier", "create", "b".repeat(64)),
  /POS_REQUEST_CONFLICT/,
);
await db.exec("reset role");
await db.query(
  "insert into auth.users(id,email,raw_app_meta_data) values($1,$2,$3::jsonb)",
  [
    id(4),
    "new@example.test",
    JSON.stringify({ pos_request_id: id(201), pos_actor_id: id(1) }),
  ],
);
await login(0, "service_role");
assert.equal((await finish())[0].value.user_id, id(4));
checks++;
await finish();
await login(1);
await eq(
  "select role from store_memberships where user_id=$1",
  [{ role: "cashier" }],
  [id(4)],
);
await db.exec(`delete from store_memberships where user_id='${id(4)}'`);
await login(0, "service_role");
await finish();
await login(1);
await eq("select * from store_memberships where user_id=$1", [], [id(4)]);
await login(0, "service_role");
await fail(() => finish(201, 3), /POS_REQUEST_CONFLICT/);
await begin(1, 203, 12, "existing@example.test", "owner", "attach");
await finish(203, 3);
await begin(1, 204, 12, "existing@example.test", "cashier", "attach");
await fail(() => finish(204, 3), /POS_ROLE_CONFLICT/);
await begin(1, 205, 11, "existing@example.test", "cashier", "create");
await fail(() => finish(205, 3), /POS_REQUEST_CONFLICT/);
await begin(1, 206, 11, "missing@example.test", "cashier", "attach");
await fail(() => finish(206, 3), /POS_INVALID_ACCOUNT/);
await login(1);
await eq(
  "select * from pos_account_members($1)",
  [{ user_id: id(3), email: "existing@example.test", role: "owner" }],
  [id(12)],
);
await db.exec(`update stores set active=false where id='${id(11)}'`);
await login(0, "service_role");
await fail(() => begin(1, 207), /POS_ACCESS_DENIED/);
await fail(() => finish(), /POS_ACCESS_DENIED/);
await db.exec("reset role");
await db.exec(
  `update stores set active=true where id='${id(11)}';delete from platform_admins where user_id='${id(1)}'`,
);
await login(0, "service_role");
await fail(() => finish(), /POS_ACCESS_DENIED/);
await db.close();
console.log(`${checks} account provisioning PostgreSQL assertions passed`);
