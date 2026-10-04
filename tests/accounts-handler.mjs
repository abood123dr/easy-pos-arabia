import assert from "node:assert/strict";
import {
  createHandler,
  AccountError,
} from "../supabase/functions/pos-accounts/handler.ts";
const actor = "00000000-0000-0000-0000-000000000001",
  store = "00000000-0000-0000-0000-000000000011";
const input = {
  request_id: "00000000-0000-0000-0000-000000000201",
  store_id: store,
  email: "new@example.test",
  role: "owner",
  mode: "create",
  password: "StrongPassword123!",
};
let checks = 0;
function fixture() {
  const users = new Map(),
    requests = new Map(),
    members = new Map();
  let created = 0,
    admin = true,
    finishFailure = false,
    createUncertain = false;
  const deps = {
    async verifyToken(t) {
      return t === "valid" ? actor : null;
    },
    async isAdmin() {
      return admin;
    },
    async begin(a, i, f) {
      const old = requests.get(i.request_id);
      if (old && old.f !== f) throw new AccountError(409, "REQUEST_CONFLICT");
      if (!old)
        requests.set(i.request_id, { f, completed: false, user_id: null });
      return requests.get(i.request_id);
    },
    async find(email) {
      return users.get(email) ?? null;
    },
    async create(i, a) {
      created++;
      const user = {
        id: crypto.randomUUID(),
        request_id: i.request_id,
        actor_id: a,
      };
      users.set(i.email, user);
      if (createUncertain) throw Error("lost Auth response");
      return user;
    },
    async finish(a, r, u) {
      if (finishFailure) {
        finishFailure = false;
        throw Error("DB unavailable");
      }
      const state = requests.get(r);
      state.completed = true;
      state.user_id = u;
      members.set(u, true);
      return { completed: true, user_id: u };
    },
  };
  return {
    handler: createHandler(deps, ["https://pos.example.test"]),
    deps,
    users,
    members,
    get created() {
      return created;
    },
    set admin(v) {
      admin = v;
    },
    set fail(v) {
      finishFailure = v;
    },
    set uncertain(v) {
      createUncertain = v;
    },
  };
}
async function call(f, body = input, options = {}) {
  const response = await f.handler(
    new Request("https://backend.test", {
      method: options.method ?? "POST",
      headers: {
        origin: options.origin ?? "https://pos.example.test",
        authorization: options.auth ?? "Bearer valid",
        "content-type": "application/json",
      },
      ...(options.method === "GET" || options.method === "OPTIONS"
        ? {}
        : { body: options.raw ?? JSON.stringify(body) }),
    }),
  );
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}
async function expected(f, body, status, code, options = {}) {
  const result = await call(f, body, options);
  assert.equal(result.response.status, status);
  if (code) assert.equal(result.data.code, code);
  checks++;
  return result;
}
await expected(fixture(), input, 401, "UNAUTHORIZED", { auth: "" });
await expected(fixture(), input, 401, "UNAUTHORIZED", {
  auth: "Bearer forged",
});
let f = fixture();
f.admin = false;
await expected(f, input, 403, "FORBIDDEN");
assert.equal(f.created, 0);
checks++;
await expected(fixture(), input, 403, "ORIGIN_DENIED", {
  origin: "https://evil.test",
});
await expected(fixture(), input, 405, "METHOD_NOT_ALLOWED", { method: "GET" });
await expected(fixture(), input, 204, null, { method: "OPTIONS" });
for (const patch of [
  { role: "platform_admin" },
  { store_id: "bad" },
  { request_id: "bad" },
  { email: "not email" },
  { password: "short" },
  { mode: "other" },
  { actor_id: actor },
  { service_role: "secret" },
])
  await expected(
    fixture(),
    { ...input, ...patch },
    400,
    patch.password ? "INVALID_PASSWORD" : "INVALID_INPUT",
  );
await expected(fixture(), input, 400, "INVALID_INPUT", { raw: "{" });
await expected(fixture(), input, 413, "BODY_TOO_LARGE", {
  raw: "x".repeat(4097),
});
f = fixture();
let result = await call(f);
assert.equal(result.response.status, 200);
assert.equal(f.created, 1);
assert.equal(result.response.headers.get("cache-control"), "no-store");
assert.equal(JSON.stringify(result.data).includes(input.password), false);
checks += 4;
await call(f);
assert.equal(f.created, 1);
assert.equal(f.members.size, 1);
checks += 2;
await expected(f, { ...input, role: "cashier" }, 409, "REQUEST_CONFLICT");
await expected(
  f,
  { ...input, password: "DifferentPassword456!" },
  409,
  "REQUEST_CONFLICT",
);
f = fixture();
f.fail = true;
await expected(f, input, 502, "RETRY_SAME_REQUEST");
await expected(f, input, 200);
assert.equal(f.created, 1);
checks++;
f = fixture();
f.uncertain = true;
await expected(f, input, 200);
assert.equal(f.created, 1);
checks++;
f = fixture();
f.users.set(input.email, { id: crypto.randomUUID() });
await expected(f, input, 409, "ACCOUNT_EXISTS");
assert.equal(f.created, 0);
checks++;
const attach = { ...input, mode: "attach" };
delete attach.password;
f = fixture();
await expected(f, attach, 404, "ACCOUNT_NOT_FOUND");
f = fixture();
f.users.set(input.email, { id: crypto.randomUUID() });
await expected(f, attach, 200);
assert.equal(f.created, 0);
checks++;
await expected(
  fixture(),
  { ...attach, password: input.password },
  400,
  "INVALID_INPUT",
);
// Completed retries do not invoke Auth/finish and cannot restore revoked access.
f = fixture();
result = await call(f);
f.members.delete(result.data.user_id);
await call(f);
assert.equal(f.members.size, 0);
checks++;
const closed = { handler: createHandler(f.deps, []) };
await expected(closed, input, 503, "NOT_CONFIGURED");
console.log(
  `${checks} account handler assertions passed (mock Auth and DB; no real accounts created)`,
);
