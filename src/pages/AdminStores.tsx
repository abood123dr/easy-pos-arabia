import { useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type Store = { id: string; name: string; active: boolean };
type Props = { stores: Store[]; onChanged: () => void };

// Visibility is convenience only. Database RLS authorizes every mutation.
export default function AdminStores({ stores, onChanged }: Props) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pause, setPause] = useState<Store | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch {
      setError("تعذر حفظ التغيير. تحقق من الاتصال والصلاحيات ثم أعد المحاولة.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function edit(store: Store) {
    setEditing(store.id);
    setName(store.name);
    setPendingId(null);
    setError("");
    setNotice("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value || value.length > 120) {
      setError("أدخل اسم المتجر، بحد أقصى 120 حرفًا.");
      return;
    }
    await run(async () => {
      // Reuse the ID after a lost response; a create retry cannot create a second store.
      const id = editing ?? pendingId ?? crypto.randomUUID();
      if (!editing) setPendingId(id);
      const result = editing
        ? await supabase!
            .from("stores")
            .update({ name: value })
            .eq("id", id)
            .select("id")
            .single()
        : await supabase!
            .from("stores")
            .insert({ id, name: value })
            .select("id")
            .single();
      if (!editing && result.error?.code === "23505") {
        const existing = await supabase!
          .from("stores")
          .select("id,name")
          .eq("id", id)
          .single();
        if (existing.error || existing.data.name !== value) throw result.error;
      } else if (result.error) throw result.error;
      setName("");
      setEditing(null);
      setPendingId(null);
      setNotice("تم حفظ المتجر.");
      onChanged();
    });
  }
  async function setActive(store: Store, active: boolean) {
    await run(async () => {
      const { error } = await supabase!
        .from("stores")
        .update({ active })
        .eq("id", store.id)
        .select("id")
        .single();
      if (error) throw error;
      setPause(null);
      setNotice(
        active ? "تم تفعيل المتجر." : "تم إيقاف المتجر. بياناته محفوظة.",
      );
      onChanged();
    });
  }
  return (
    <section
      className="space-y-4 rounded-xl border bg-white p-5"
      aria-label="إدارة المتاجر"
    >
      <h2 className="text-lg font-bold">إدارة المتاجر</h2>
      <form onSubmit={save} className="space-y-3">
        <Label htmlFor="store-name">
          {editing ? "تعديل اسم المتجر" : "متجر جديد"}
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 basis-48"
            id="store-name"
            required
            maxLength={120}
            value={name}
            disabled={busy || !!pendingId}
            onChange={(e) => setName(e.target.value)}
            placeholder="اسم المتجر"
          />
          <Button type="submit" disabled={busy}>
            {busy ? "جارٍ الحفظ…" : editing ? "حفظ الاسم" : "إضافة المتجر"}
          </Button>
          {editing && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setName("");
              }}
            >
              إلغاء
            </Button>
          )}
        </div>
        <p className="text-sm text-slate-500">
          بعد إضافة المتجر، افتح الحسابات لإضافة المالك والكاشير.
        </p>
      </form>
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
      {stores.map((store) => (
        <div
          key={store.id}
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
        >
          <div>
            <strong className="break-words">{store.name}</strong>
            <p className="text-sm text-slate-500">
              {store.active ? "نشط" : "موقوف"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy || !!pendingId}
              onClick={() => edit(store)}
            >
              تعديل الاسم
            </Button>
            <Button
              variant={store.active ? "outline" : "default"}
              disabled={busy}
              onClick={() =>
                store.active ? setPause(store) : void setActive(store, true)
              }
            >
              {store.active ? "إيقاف" : "تفعيل"}
            </Button>
          </div>
        </div>
      ))}
      {pause && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3"
          role="alert"
        >
          <p>
            إيقاف «{pause.name}» يمنع البيع والوصول إلى بياناته التشغيلية حتى
            إعادة تفعيله. تبقى البيانات محفوظة.
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => setActive(pause, false)}
            >
              تأكيد الإيقاف
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setPause(null)}
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
