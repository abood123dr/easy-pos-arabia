import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

// Real PostgreSQL engine in-process. This verifies policy semantics; it does not
// replace testing Auth configuration and the live Supabase REST API.
const db = new PGlite();
const uid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as
$$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
insert into auth.users values ('${uid(1)}'), ('${uid(2)}'), ('${uid(3)}'), ('${uid(4)}');`);
for (const file of readdirSync('supabase/migrations').filter(x => x.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
}
await db.exec(`insert into platform_admins(user_id) values ('${uid(1)}');
insert into stores(id,name) values ('${uid(11)}','A'), ('${uid(12)}','B');
insert into store_memberships(store_id,user_id,role) values
('${uid(11)}','${uid(2)}','owner'), ('${uid(12)}','${uid(3)}','cashier');`);
let checks = 0;
async function login(n, role = 'authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [n ? uid(n) : '']);
  await db.exec(`set role ${role}`);
}
async function rows(sql, expected) {
  assert.deepEqual((await db.query(sql)).rows, expected); checks++;
}
async function denied(sql) {
  await assert.rejects(db.exec(sql), /permission denied|row-level security/); checks++;
}
await login(0, 'anon');
await denied('select * from stores');
await denied('select * from store_memberships');
await denied('select * from platform_admins');
await login(2);
await rows('select name from stores order by name', [{ name: 'A' }]);
await rows('select role from store_memberships', [{ role: 'owner' }]);
await rows('select * from platform_admins', []);
await denied(`insert into platform_admins(user_id) values ('${uid(2)}')`);
await denied(`insert into store_memberships values ('${uid(12)}','${uid(2)}','owner', now())`);
await denied(`insert into stores(name) values ('intruder')`);
await rows(`update store_memberships set role='cashier' where user_id='${uid(2)}' returning role`, []);
await rows(`update stores set name='hacked' where id='${uid(11)}' returning name`, []);
await rows(`delete from stores where id='${uid(11)}' returning name`, []);
await login(3);
await rows('select name from stores order by name', [{ name: 'B' }]);
await rows('select role from store_memberships', [{ role: 'cashier' }]);
await login(4);
await rows('select * from stores', []);
await rows('select * from store_memberships', []);
await login(1);
await rows('select name from stores order by name', [{ name: 'A' }, { name: 'B' }]);
await rows('select role from store_memberships order by role', [{ role: 'cashier' }, { role: 'owner' }]);
await rows(`insert into stores(id,name) values ('${uid(13)}','new store') returning name`, [{ name: 'new store' }]);
await rows(`update stores set name='renamed' where id='${uid(13)}' returning name`, [{ name: 'renamed' }]);
await rows(`update stores set active=false where id='${uid(13)}' returning active`, [{ active: false }]);
await rows(`update stores set active=false where id='${uid(11)}' returning active`, [{ active: false }]);
await denied(`insert into platform_admins(user_id) values ('${uid(4)}')`);
await rows(`insert into store_memberships(store_id,user_id,role) values ('${uid(12)}','${uid(4)}','owner') returning role`, [{ role: 'owner' }]);
await rows(`delete from store_memberships where user_id='${uid(4)}' returning role`, [{ role: 'owner' }]);
await login(4);
await rows('select * from stores', []);
await db.close();
console.log(`${checks} PostgreSQL RLS assertions passed`);
