import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { AccountError, createHandler, type Dependencies } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const origins = (Deno.env.get("POS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!url || !key) throw new Error("Missing server configuration");
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function dbError(error: { code?: string; message?: string }) {
  if (error.code === "42501") throw new AccountError(403, "FORBIDDEN");
  if (error.message?.includes("POS_ROLE_CONFLICT"))
    throw new AccountError(409, "ROLE_CONFLICT");
  if (error.message?.includes("POS_REQUEST_CONFLICT"))
    throw new AccountError(409, "REQUEST_CONFLICT");
  if (error.code === "22023") throw new AccountError(400, "INVALID_INPUT");
  throw new AccountError(502, "RETRY_SAME_REQUEST");
}
const deps: Dependencies = {
  async verifyToken(token) {
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : (data.user?.id ?? null);
  },
  async isAdmin(actor) {
    const { data, error } = await admin
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", actor)
      .maybeSingle();
    if (error) dbError(error);
    return !!data;
  },
  async begin(actor, input, fingerprint) {
    const { data, error } = await admin.rpc("pos_account_begin", {
      p_actor: actor,
      p_request: input.request_id,
      p_store: input.store_id,
      p_email: input.email,
      p_role: input.role,
      p_mode: input.mode,
      p_fingerprint: fingerprint,
    });
    if (error) dbError(error);
    return data;
  },
  async find(email) {
    const { data, error } = await admin.rpc("pos_account_find", {
      p_email: email,
    });
    if (error) dbError(error);
    return data;
  },
  async create(input, actor) {
    const { data, error } = await admin.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      app_metadata: { pos_request_id: input.request_id, pos_actor_id: actor },
    });
    if (error || !data.user) {
      if (error?.code === "weak_password")
        throw new AccountError(400, "PASSWORD_REJECTED");
      throw new AccountError(502, "RETRY_SAME_REQUEST");
    }
    return { id: data.user.id };
  },
  async finish(actor, request, user) {
    const { data, error } = await admin.rpc("pos_account_finish", {
      p_actor: actor,
      p_request: request,
      p_user: user,
    });
    if (error) dbError(error);
    return data;
  },
};
Deno.serve(createHandler(deps, origins));
