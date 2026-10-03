import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import StoreWorkspace from './StoreWorkspace';
import AdminStores, { type Store } from './AdminStores';

export default function AccountHome({ userId, email }: { userId: string; email: string }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Store | null>(null);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    setLoading(true); setError('');
    async function load() {
      try {
        const [admin, visibleStores] = await Promise.all([
          supabase!.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
          supabase!.from('stores').select('id,name,active').order('name'),
        ]);
        if (admin.error || visibleStores.error) throw new Error('load failed');
        if (active) { setIsAdmin(!!admin.data); setStores(visibleStores.data ?? []); }
      } catch { if (active) setError('تعذر تحميل صلاحيات الحساب والمتاجر. حاول مرة أخرى.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, [userId, retry]);
  async function logout() {
    const result = await supabase?.auth.signOut({ scope: 'local' });
    if (result?.error) setError('تعذر تسجيل الخروج. حاول مرة أخرى.');
  }
  if (selected) return <StoreWorkspace key={selected.id} store={selected} userId={userId} isAdmin={isAdmin} onBack={() => setSelected(null)} />;
  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 sm:p-8"><div className="max-w-5xl mx-auto space-y-6"><header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">{isAdmin ? 'إدارة المنصة' : 'متاجري'}</h1><p className="text-slate-500 break-all" dir="ltr">{email}</p></div><Button variant="outline" onClick={logout}>تسجيل الخروج</Button></header><div className="rounded-xl border bg-amber-50 p-4 text-amber-900">نسخة قيد التطوير. لم يتم ربط قاعدة البيانات الفعلية واختبارها بعد.</div>{isAdmin && !loading && !error && <AdminStores stores={stores} onChanged={() => setRetry(v => v + 1)} />}<h2 className="text-lg font-bold">فتح متجر</h2>{loading ? <p role="status">جارٍ تحميل المتاجر…</p> : error ? <div role="alert" className="space-y-3"><p>{error}</p><Button onClick={() => setRetry(v => v + 1)}>إعادة المحاولة</Button></div> : stores.length ? <div className="grid gap-4 sm:grid-cols-2">{stores.map(store => <article key={store.id} className="rounded-xl border bg-white p-5"><h2 className="font-bold text-lg">{store.name}</h2><p className="text-sm text-slate-500 mt-2">{store.active ? 'نشط' : 'موقوف'}</p><Button className="mt-4" disabled={!store.active} onClick={() => setSelected(store)}>فتح المتجر</Button></article>)}</div> : <section className="rounded-xl border bg-white p-6"><h2 className="font-bold">لا توجد متاجر مرتبطة بحسابك</h2><p className="text-slate-500 mt-2">تواصل مع إدارة المنصة لتفعيل حساب المتجر.</p></section>}</div></main>;
}
