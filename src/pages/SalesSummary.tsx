import { useRef, useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import { money, posError } from "@/lib/pos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Summary = {
  sales_count: number;
  total: number;
  cash_total: number;
  card_total: number;
};
function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export default function SalesSummary({ storeId }: { storeId: string }) {
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(today);
  const [result, setResult] = useState<{
    values: Summary;
    from: string;
    until: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function load(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${until}T00:00:00`);
    end.setDate(end.getDate() + 1);
    const calendarDays =
      (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86400000 +
      1;
    if (
      calendarDays > 31 ||
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start ||
      end.getTime() - start.getTime() > 32 * 86400000
    ) {
      setError("اختر فترة صحيحة لا تتجاوز 31 يومًا.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const { data, error } = await supabase!.rpc("pos_sales_summary", {
        p_store_id: storeId,
        p_from: start.toISOString(),
        p_until: end.toISOString(),
      });
      if (error) throw error;
      if (!Array.isArray(data) || data.length !== 1)
        throw new Error("missing report");
      setResult({ values: data[0], from, until });
    } catch (e) {
      setError(posError(e as { message?: string; code?: string }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border bg-white p-5">
      <h2 className="text-lg font-bold">ملخص المبيعات</h2>
      <form onSubmit={load} className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="sales-from">من تاريخ</Label>
          <Input
            id="sales-from"
            type="date"
            required
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sales-until">إلى تاريخ</Label>
          <Input
            id="sales-until"
            type="date"
            required
            value={until}
            min={from}
            disabled={busy}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? "جارٍ الحساب…" : "عرض الملخص"}
        </Button>
      </form>
      <p className="text-sm text-slate-500">
        التواريخ تشمل اليوم كاملًا حسب توقيت جهازك. الفترة حتى 31 يومًا.
      </p>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {result && (
        <div className="space-y-3">
          <p>
            من {result.from} إلى {result.until}
          </p>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ["عدد الفواتير", String(result.values.sales_count)],
              ["إجمالي المبيعات", money(Number(result.values.total))],
              ["نقدًا", money(Number(result.values.cash_total))],
              ["بطاقة", money(Number(result.values.card_total))],
            ].map(([label, value]) => (
              <div className="rounded-lg bg-slate-50 p-4" key={label}>
                <dt className="text-sm text-slate-500">{label}</dt>
                <dd className="mt-2 text-xl font-bold">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-slate-500">
            إجمالي البيع المسجل؛ لا يمثل صافي الربح. طريقة البطاقة تسجيل للسداد
            فقط.
          </p>
        </div>
      )}
    </section>
  );
}
