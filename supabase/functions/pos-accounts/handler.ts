export type Account = {
  request_id: string;
  store_id: string;
  email: string;
  role: "owner" | "cashier";
  mode: "create" | "attach";
  password?: string;
};
type AuthUser = { id: string; request_id?: string; actor_id?: string };
export type Dependencies = {
  verifyToken(token: string): Promise<string | null>;
  isAdmin(actor: string): Promise<boolean>;
  begin(
    actor: string,
    input: Account,
    fingerprint: string,
  ): Promise<{ completed: boolean; user_id: string | null }>;
  find(email: string): Promise<AuthUser | null>;
  create(input: Account, actor: string): Promise<AuthUser>;
  finish(
    actor: string,
    request: string,
    user: string,
  ): Promise<{ completed: boolean; user_id: string }>;
};
export class AccountError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError(400, "INVALID_INPUT");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new AccountError(413, "BODY_TOO_LARGE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new AccountError(400, "INVALID_INPUT");
  }
}
function validate(value: unknown): Account {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AccountError(400, "INVALID_INPUT");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "request_id",
          "store_id",
          "email",
          "role",
          "mode",
          "password",
        ].includes(k),
    ) ||
    typeof v.request_id !== "string" ||
    !uuid.test(v.request_id) ||
    typeof v.store_id !== "string" ||
    !uuid.test(v.store_id) ||
    typeof v.email !== "string" ||
    v.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim()) ||
    !["owner", "cashier"].includes(String(v.role)) ||
    !["create", "attach"].includes(String(v.mode))
  )
    throw new AccountError(400, "INVALID_INPUT");
  if (
    v.mode === "create" &&
    (typeof v.password !== "string" ||
      v.password.length < 12 ||
      v.password.length > 128)
  )
    throw new AccountError(400, "INVALID_PASSWORD");
  if (v.mode === "attach" && v.password !== undefined)
    throw new AccountError(400, "INVALID_INPUT");
  return {
    request_id: v.request_id,
    store_id: v.store_id,
    email: v.email.trim().toLowerCase(),
    role: v.role as Account["role"],
    mode: v.mode as Account["mode"],
    ...(v.mode === "create" ? { password: v.password as string } : {}),
  };
}
export function createHandler(deps: Dependencies, allowedOrigins: string[]) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    };
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers });
    if (!allowedOrigins.length) return respond(503, { code: "NOT_CONFIGURED" });
    if (origin && !allowedOrigins.includes(origin))
      return respond(403, { code: "ORIGIN_DENIED" });
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] =
      "authorization, apikey, content-type, x-client-info";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    if (request.method !== "POST")
      return respond(405, { code: "METHOD_NOT_ALLOWED" });
    try {
      const token = request.headers
        .get("authorization")
        ?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token) throw new AccountError(401, "UNAUTHORIZED");
      const actor = await deps.verifyToken(token);
      if (!actor) throw new AccountError(401, "UNAUTHORIZED");
      if (!(await deps.isAdmin(actor)))
        throw new AccountError(403, "FORBIDDEN");
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new AccountError(415, "INVALID_CONTENT_TYPE");
      const input = validate(await readBody(request));
      // No password is stored; a private request digest detects changed retries.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(input)),
      );
      const fingerprint = Array.from(new Uint8Array(digest), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("");
      const state = await deps.begin(actor, input, fingerprint);
      if (state.completed)
        return respond(200, {
          user_id: state.user_id,
          completed: true,
          replayed: true,
        });
      let user = await deps.find(input.email);
      if (input.mode === "attach") {
        if (!user) throw new AccountError(404, "ACCOUNT_NOT_FOUND");
      } else {
        if (
          user &&
          (user.request_id !== input.request_id || user.actor_id !== actor)
        )
          throw new AccountError(409, "ACCOUNT_EXISTS");
        if (!user) {
          try {
            user = await deps.create(input, actor);
          } catch (e) {
            // Auth creation is outside the SQL transaction. Recover only this
            // request's account, never take over an unrelated existing account.
            user = await deps.find(input.email);
            if (!user) throw e;
            if (user.request_id !== input.request_id || user.actor_id !== actor)
              throw new AccountError(409, "ACCOUNT_EXISTS");
          }
        }
      }
      const result = await deps.finish(actor, input.request_id, user.id);
      return respond(200, { ...result, replayed: false });
    } catch (e) {
      // Do not log/return tokens, passwords, SQL or upstream Auth details.
      if (e instanceof AccountError) return respond(e.status, { code: e.code });
      return respond(502, { code: "RETRY_SAME_REQUEST" });
    }
  };
}
