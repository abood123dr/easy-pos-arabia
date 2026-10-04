import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Store } from "./AdminStores";

type Member = { user_id: string; email: string; role: "owner" | "cashier" };
const schema = z.object({
  request_id: z.string().uuid(),
  store_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["owner", "cashier"]),
  mode: z.enum(["create", "attach"]),
});
type Pending = {
  request_id: string;
  store_id: string;
  email: string;
  role: "owner" | "cashier";
  mode: "create" | "attach";
};
const messages: Record<string, string> = {
  ACCOUNT_EXISTS:
    "الحساب موجود بالفعل. استخدم خيار ربط حساب موجود؛ كلمة مروره لن تتغير.",
  ACCOUNT_NOT_FOUND: "لا يوجد حساب بهذا البريد. اختر إنشاء حساب جديد.",
  FORBIDDEN: "لا تملك صلاحية إدارة الحسابات أو المتجر موقوف.",
  UNAUTHORIZED: "تعذر التحقق من الجلسة. حاول تسجيل الدخول من جديد.",
  INVALID_PASSWORD: "اختر كلمة مرور من 12 إلى 128 حرفًا.",
  PASSWORD_REJECTED: "كلمة المرور مرفوضة. اختر كلمة مرور أقوى.",
  INVALID_INPUT: "راجع البيانات المدخلة.",
  ROLE_CONFLICT: "الحساب مرتبط بالمتجر بدور مختلف. غيّر دوره من القائمة.",
  REQUEST_CONFLICT:
    "الطلب السابق مختلف. استخدم بيانات الطلب وكلمة المرور الأصلية.",
  NOT_CONFIGURED: "خدمة الحسابات لم تُجهز على الخادم بعد.",
};
export default function AdminAccounts({
  stores,
  userId,
}: {
  stores: Store[];
  userId: string;
}) {
  const key = `pos-account-pending:${userId}`;
  const [storeId, setStoreId] = useState(
    stores.find((s) => s.active)?.id ?? "",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"owner" | "cashier">("owner");
  const [mode, setMode] = useState<"create" | "attach">("create");
  const [pending, setPending] = useState<Pending | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [remove, setRemove] = useState<Member | null>(null);
  const [retry, setRetry] = useState(0);
  const inFlight = useRef(false);
  const storageReady = useRef(false);
  useEffect(() => {
    try {
      const value = sessionStorage.getItem(key);
      if (value) {
        const p = schema.parse(JSON.parse(value)) as Pending;
        setPending(p);
        setStoreId(p.store_id);
        setEmail(p.email);
        setRole(p.role);
        setMode(p.mode);
      }
      storageReady.current = true;
    } catch {
      setError(
        "تعذر استعادة الطلب. لا تبدأ طلبًا جديدًا حتى التحقق من بيانات المتصفح.",
      );
    }
  }, [key]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setMembers([]);
    setRemove(null);
    if (!storeId) {
      setLoading(false);
      return;
    }
    supabase!
      .rpc("pos_account_members", { p_store: storeId })
      .then(({ data, error }) => {
        if (active) {
          if (error)
            setError("تعذر تحميل الحسابات. تحقق من إعداد خدمة الحسابات.");
          else setMembers(data ?? []);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [storeId, retry]);
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch {
      setError("تعذر إتمام العملية. تحقق من الاتصال ثم أعد المحاولة.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      if (!storageReady.current) throw new Error("storage unavailable");
      const request = pending ?? {
        request_id: crypto.randomUUID(),
        store_id: storeId,
        email: email.trim().toLowerCase(),
        role,
        mode,
      };
      schema.parse(request);
      sessionStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      const body = {
        ...request,
        ...(request.mode === "create" ? { password } : {}),
      };
      const { data, error } = await supabase!.functions.invoke("pos-accounts", {
        body,
      });
      if (error) {
        let code = "RETRY_SAME_REQUEST";
        if ("context" in error && error.context instanceof Response) {
          try {
            code = (await error.context.json()).code ?? code;
          } catch {
            /* Preserve unknown requests. */
          }
        }
        if (
          [
            "ACCOUNT_EXISTS",
            "ACCOUNT_NOT_FOUND",
            "INVALID_INPUT",
            "INVALID_PASSWORD",
            "PASSWORD_REJECTED",
            "ROLE_CONFLICT",
          ].includes(code)
        ) {
          sessionStorage.removeItem(key);
          setPending(null);
          setPassword("");
        }
        setError(
          messages[code] ??
            "تعذر تأكيد حفظ الحساب. أعد محاولة الطلب نفسه بالبيانات وكلمة المرور الأصلية.",
        );
        return;
      }
      if (!data?.completed || !data.user_id) throw new Error("invalid result");
      sessionStorage.removeItem(key);
      setPending(null);
      setPassword("");
      setEmail("");
      setNotice(
        "اكتمل طلب الحساب. راجع القائمة؛ إعادة المحاولة لا تعيد صلاحية أُلغيت لاحقًا.",
      );
      setRetry((n) => n + 1);
    });
  }
  async function change(member: Member, next: "owner" | "cashier") {
    await run(async () => {
      const { error } = await supabase!
        .from("store_memberships")
        .update({ role: next })
        .eq("store_id", storeId)
        .eq("user_id", member.user_id)
        .eq("role", member.role)
        .select("user_id")
        .single();
      if (error) throw error;
      setNotice("تم تحديث الدور.");
      setRetry((n) => n + 1);
    });
  }
  async function revoke(member: Member) {
    await run(async () => {
      const { error } = await supabase!
        .from("store_memberships")
        .delete()
        .eq("store_id", storeId)
        .eq("user_id", member.user_id)
        .select("user_id")
        .single();
      if (error) throw error;
      setRemove(null);
      setNotice("أُلغي وصول الحساب لهذا المتجر.");
      setRetry((n) => n + 1);
    });
  }
  return (
    <section
      aria-label="حسابات المتاجر"
      className="space-y-4 rounded-xl border bg-white p-5"
    >
      <h2 className="text-lg font-bold">حسابات المتاجر</h2>
      <Label htmlFor="account-store">المتجر</Label>
      <select
        id="account-store"
        className="w-full rounded-md border p-2"
        value={storeId}
        disabled={busy || !!pending}
        onChange={(e) => setStoreId(e.target.value)}
      >
        <option value="">اختر متجرًا</option>
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.active ? "" : " — موقوف"}
          </option>
        ))}
      </select>
      {pending && (
        <p className="rounded-lg bg-amber-50 p-3">
          يوجد طلب قيد التحقق. أعد المحاولة بنفس البيانات؛ للحساب الجديد أدخل
          كلمة المرور الأصلية. لا تحفظ كلمات المرور في المتصفح.
        </p>
      )}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="account-mode">نوع الطلب</Label>
          <select
            id="account-mode"
            className="w-full rounded-md border p-2"
            value={mode}
            disabled={busy || !!pending}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setPassword("");
            }}
          >
            <option value="create">إنشاء حساب جديد</option>
            <option value="attach">ربط حساب موجود</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="account-role">الدور</Label>
          <select
            id="account-role"
            className="w-full rounded-md border p-2"
            value={role}
            disabled={busy || !!pending}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="owner">مالك المتجر</option>
            <option value="cashier">كاشير</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="account-email">بريد الحساب</Label>
          <Input
            id="account-email"
            type="email"
            dir="ltr"
            required
            maxLength={254}
            disabled={busy || !!pending}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        {mode === "create" && (
          <div className="space-y-2">
            <Label htmlFor="account-password">كلمة مرور الحساب الجديد</Label>
            <Input
              id="account-password"
              type="password"
              dir="ltr"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              disabled={busy}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        )}
        <Button
          className="sm:col-span-2"
          disabled={
            busy ||
            !storeId ||
            !storageReady.current ||
            !stores.find((s) => s.id === storeId)?.active
          }
          type="submit"
        >
          {busy
            ? "جارٍ الحفظ…"
            : pending
              ? "إعادة محاولة الطلب نفسه"
              : "حفظ الحساب"}
        </Button>
      </form>
      <p className="text-sm text-slate-500">
        الحساب الجديد يدخل بالبريد وكلمة المرور التي تحددها. ربط حساب موجود
        يحافظ على كلمة مروره. لا يُرسل بريد تلقائيًا.
      </p>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-green-700">
          {notice}
        </p>
      )}
      <div className="flex items-center justify-between">
        <h3 className="font-bold">الحسابات المرتبطة</h3>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError("");
            setRetry((n) => n + 1);
          }}
        >
          تحديث الحسابات
        </Button>
      </div>
      {loading ? (
        <p role="status">جارٍ تحميل الحسابات…</p>
      ) : members.length ? (
        members.map((m) => (
          <article
            key={m.user_id}
            className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          >
            <div>
              <p dir="ltr" className="break-all">
                {m.email}
              </p>
              <p className="text-sm text-slate-500">
                {m.role === "owner" ? "مالك المتجر" : "كاشير"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  change(m, m.role === "owner" ? "cashier" : "owner")
                }
              >
                {m.role === "owner" ? "تحويل إلى كاشير" : "تحويل إلى مالك"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRemove(m)}
              >
                إلغاء الوصول
              </Button>
            </div>
          </article>
        ))
      ) : (
        <p className="text-slate-500">لا توجد حسابات مرتبطة ظاهرة.</p>
      )}
      {remove && (
        <div className="rounded-lg bg-amber-50 p-4 space-y-3" role="alert">
          <p>
            إلغاء وصول {remove.email} إلى هذا المتجر؟ يبقى حسابه وبقية متاجره
            محفوظين.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => revoke(remove)}
            >
              تأكيد إلغاء الوصول
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemove(null)}
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
