import { lazy, Suspense, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
const StoreWorkspace = lazy(() => import("./StoreWorkspace"));
const AdminAccounts = lazy(() => import("./AdminAccounts"));
import AdminStores, { type Store } from "./AdminStores";

export default function AccountHome({
  userId,
  email,
}: {
  userId: string;
  email: string;
}) {
  const [stores, setStores] = useState<Store[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const adminTab =
    pathname === "/super-admin/accounts"
      ? "accounts"
      : pathname === "/super-admin/stores"
        ? "stores"
        : "overview";
  const selected = stores.find(
    (store) => pathname === `/stores/${store.id}` && store.active,
  );
  const visibleStores = stores.filter(
    (store) =>
      store.name
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()) &&
      (filter === "all" || store.active === (filter === "active")),
  );
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    setLoading(true);
    setError("");
    async function load() {
      try {
        const [admin, visibleStores] = await Promise.all([
          supabase!
            .from("platform_admins")
            .select("user_id")
            .eq("user_id", userId)
            .maybeSingle(),
          supabase!.from("stores").select("id,name,active").order("name"),
        ]);
        if (admin.error || visibleStores.error) throw new Error("load failed");
        if (active) {
          setIsAdmin(!!admin.data);
          setStores(visibleStores.data ?? []);
        }
      } catch {
        if (active)
          setError("تعذر تحميل صلاحيات الحساب والمتاجر. حاول مرة أخرى.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [userId, retry]);
  async function logout() {
    const result = await supabase?.auth.signOut({ scope: "local" });
    if (result?.error) setError("تعذر تسجيل الخروج. حاول مرة أخرى.");
  }
  // Routes choose a view only; database permissions remain authoritative.
  if (!loading && !error) {
    if (pathname.startsWith("/stores/") && !selected) {
      return (
        <main dir="rtl" className="min-h-screen bg-slate-50 p-6">
          <section className="mx-auto max-w-md rounded-xl border bg-white p-6 space-y-4">
            <h1 className="text-xl font-bold">المتجر غير متاح</h1>
            <p>قد يكون موقوفًا أو غير مرتبط بحسابك.</p>
            <Button
              onClick={() =>
                navigate(isAdmin ? "/super-admin/stores" : "/stores", {
                  replace: true,
                })
              }
            >
              العودة إلى المتاجر
            </Button>
          </section>
        </main>
      );
    }
    if (
      pathname === "/" ||
      (!isAdmin && pathname.startsWith("/super-admin")) ||
      (isAdmin &&
        pathname.startsWith("/super-admin") &&
        ![
          "/super-admin",
          "/super-admin/stores",
          "/super-admin/accounts",
        ].includes(pathname))
    ) {
      const onlyStore = !isAdmin && stores.length === 1 && stores[0].active;
      return (
        <Navigate
          replace
          to={
            isAdmin
              ? "/super-admin"
              : onlyStore
                ? `/stores/${stores[0].id}`
                : "/stores"
          }
        />
      );
    }
  }
  if (!loading && !error && selected)
    return (
      <Suspense
        fallback={
          <main dir="rtl" className="p-6" role="status">
            جارٍ فتح المتجر…
          </main>
        }
      >
        <StoreWorkspace
          key={selected.id}
          store={selected}
          userId={userId}
          isAdmin={isAdmin}
          onBack={() => navigate(isAdmin ? "/super-admin/stores" : "/stores")}
        />
      </Suspense>
    );
  return (
    <main dir="rtl" className="min-h-screen bg-slate-50 p-4 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              {isAdmin ? "إدارة المنصة" : "متاجري"}
            </h1>
            <p className="text-slate-500 break-all" dir="ltr">
              {email}
            </p>
          </div>
          <Button variant="outline" onClick={logout}>
            تسجيل الخروج
          </Button>
        </header>
        <div className="rounded-xl border bg-amber-50 p-4 text-amber-900">
          نسخة قيد التطوير. لم يتم ربط قاعدة البيانات الفعلية واختبارها بعد.
        </div>
        {isAdmin && !loading && !error && (
          <nav className="flex flex-wrap gap-2" aria-label="إدارة المنصة">
            <Button
              variant={adminTab === "overview" ? "default" : "outline"}
              aria-current={adminTab === "overview" ? "page" : undefined}
              onClick={() => navigate("/super-admin")}
            >
              نظرة عامة
            </Button>
            <Button
              variant={adminTab === "stores" ? "default" : "outline"}
              aria-current={adminTab === "stores" ? "page" : undefined}
              onClick={() => navigate("/super-admin/stores")}
            >
              المتاجر
            </Button>
            <Button
              variant={adminTab === "accounts" ? "default" : "outline"}
              aria-current={adminTab === "accounts" ? "page" : undefined}
              onClick={() => navigate("/super-admin/accounts")}
            >
              الحسابات
            </Button>
          </nav>
        )}
        {isAdmin && !loading && !error && adminTab === "overview" && (
          <section className="space-y-5" aria-label="نظرة عامة على المنصة">
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ["إجمالي المتاجر", stores.length],
                ["متاجر نشطة", stores.filter((store) => store.active).length],
                [
                  "متاجر موقوفة",
                  stores.filter((store) => !store.active).length,
                ],
              ].map(([label, count]) => (
                <article key={label} className="rounded-xl border bg-white p-5">
                  <h2 className="text-slate-600">{label}</h2>
                  <p className="mt-2 text-3xl font-bold">{count}</p>
                </article>
              ))}
            </div>
            <section className="rounded-xl border bg-white p-5 space-y-3">
              <h2 className="text-lg font-bold">إدارة متاجرك</h2>
              <p className="text-slate-600">
                أضف متجرًا، ثم أنشئ حساب المالك والكاشير من الحسابات.
              </p>
              <div className="flex flex-wrap gap-3">
                <Button onClick={() => navigate("/super-admin/stores")}>
                  إدارة المتاجر
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigate("/super-admin/accounts")}
                >
                  إدارة الحسابات
                </Button>
              </div>
            </section>
          </section>
        )}
        {loading && <p role="status">جارٍ تحميل صلاحيات الحساب…</p>}
        {error && (
          <div role="alert" className="space-y-3">
            <p>{error}</p>
            <Button onClick={() => setRetry((v) => v + 1)}>
              إعادة المحاولة
            </Button>
          </div>
        )}
        {isAdmin && !loading && !error && adminTab === "accounts" && (
          <Suspense fallback={<p role="status">جارٍ فتح الحسابات…</p>}>
            <AdminAccounts stores={stores} userId={userId} />
          </Suspense>
        )}
        {!loading && !error && (!isAdmin || adminTab === "stores") && (
          <>
            {isAdmin && !loading && !error && (
              <AdminStores
                stores={stores}
                onChanged={() => setRetry((v) => v + 1)}
              />
            )}
            <h2 className="text-lg font-bold">
              {isAdmin ? "الدخول إلى متجر" : "اختر متجرك"}
            </h2>
            <div className="flex flex-wrap gap-3">
              <Input
                className="min-w-0 flex-1 basis-48"
                aria-label="بحث المتاجر"
                placeholder="ابحث باسم المتجر"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <select
                aria-label="حالة المتجر"
                className="rounded-md border bg-white p-2"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">كل المتاجر</option>
                <option value="active">النشطة</option>
                <option value="paused">الموقوفة</option>
              </select>
            </div>
            {stores.length ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {visibleStores.map((store) => (
                  <article
                    key={store.id}
                    className="rounded-xl border bg-white p-5"
                  >
                    <h2 className="font-bold text-lg">{store.name}</h2>
                    <p className="text-sm text-slate-500 mt-2">
                      {store.active ? "نشط" : "موقوف"}
                    </p>
                    <Button
                      className="mt-4"
                      disabled={!store.active}
                      onClick={() => navigate(`/stores/${store.id}`)}
                    >
                      فتح المتجر
                    </Button>
                  </article>
                ))}
                {!visibleStores.length && (
                  <p role="status">لا توجد متاجر تطابق البحث.</p>
                )}
              </div>
            ) : (
              <section className="rounded-xl border bg-white p-6">
                <h2 className="font-bold">لا توجد متاجر مرتبطة بحسابك</h2>
                <p className="text-slate-500 mt-2">
                  تواصل مع إدارة المنصة لتفعيل حساب المتجر.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
