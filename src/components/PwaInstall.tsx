import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
function standalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
export default function PwaInstall() {
  const [installed, setInstalled] = useState(standalone);
  const [prompt, setPrompt] = useState<InstallEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const available = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };
    const connection = () => setOnline(navigator.onLine);
    const media = window.matchMedia("(display-mode: standalone)");
    const displayChanged = () => setInstalled(standalone());
    window.addEventListener("beforeinstallprompt", available);
    window.addEventListener("appinstalled", done);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    media.addEventListener("change", displayChanged);
    return () => {
      window.removeEventListener("beforeinstallprompt", available);
      window.removeEventListener("appinstalled", done);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
      media.removeEventListener("change", displayChanged);
    };
  }, []);
  async function install() {
    if (!prompt || busy) return;
    setBusy(true);
    setError("");
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === "accepted") setInstalled(true);
    } catch {
      setError("تعذر فتح نافذة التثبيت. استخدم قائمة المتصفح.");
    } finally {
      setPrompt(null);
      setBusy(false);
    }
  }
  return (
    <aside
      dir="rtl"
      className="print:hidden border-b bg-white px-4 py-2 text-sm"
      aria-label="تثبيت التطبيق والاتصال"
    >
      <div className="mx-auto max-w-6xl space-y-2">
        {!installed && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-slate-500">
              لمحة POS — يلزم اتصال بالإنترنت
            </span>
            {prompt ? (
              <Button size="sm" disabled={busy} onClick={install}>
                {busy ? "جارٍ فتح التثبيت…" : "تثبيت التطبيق"}
              </Button>
            ) : (
              <details>
                <summary className="cursor-pointer font-medium">
                  تثبيت على الجهاز
                </summary>
                <p className="mt-2 max-w-md text-slate-600">
                  على iPhone: افتح الموقع في Safari، ثم المشاركة ← إضافة إلى
                  الشاشة الرئيسية. على Android أو الكمبيوتر: افتح قائمة المتصفح
                  واختر تثبيت التطبيق أو إضافة إلى الشاشة الرئيسية، إن كان
                  الخيار متاحًا.
                </p>
              </details>
            )}
          </div>
        )}
        {!online && (
          <p role="status" className="text-amber-800">
            الاتصال منقطع. حفظ المبيعات والمخزون يحتاج الإنترنت؛ أعد محاولة
            الطلب المعلق بعد عودة الاتصال.
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
      </div>
    </aside>
  );
}
