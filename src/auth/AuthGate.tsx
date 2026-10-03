import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AccountHome from '@/pages/AccountHome';

export default function AuthGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    let active = true;
    let eventReceived = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      eventReceived = true;
      if (active) { setSession(next); setLoading(false); }
    });
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || eventReceived) return;
      setSession(data.session);
      if (error) setError('تعذر استعادة الجلسة. حاول مرة أخرى.');
      setLoading(false);
    }).catch(() => { if (active) { setError('تعذر الاتصال. حدّث الصفحة للمحاولة مجددًا.'); setLoading(false); } });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!supabase || busy) return;
    setBusy(true); setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setError('تعذر تسجيل الدخول. تحقق من بياناتك أو حاول لاحقًا.');
    } catch { setError('تعذر الاتصال بالخادم. حاول مرة أخرى.'); }
    finally { setBusy(false); }
  }
  const panel = (content: React.ReactNode) => <main dir="rtl" className="min-h-screen bg-slate-50 flex items-center justify-center p-4"><section className="w-full max-w-md rounded-2xl border bg-white p-6 shadow-sm">{content}</section></main>;
  if (!supabase) return panel(<><h1 className="text-xl font-bold mb-3">لمحة — نقطة البيع</h1><p>النظام قيد التجهيز. لم يتم ربط قاعدة البيانات بعد.</p></>);
  if (loading) return panel(<p role="status">جارٍ استعادة الجلسة…</p>);
  if (session) return <AccountHome key={session.user.id} userId={session.user.id} email={session.user.email ?? ''} />;
  return panel(<form onSubmit={login} className="space-y-5"><header><h1 className="text-2xl font-bold">لمحة — نقطة البيع</h1><p className="text-slate-500 mt-2">سجّل الدخول إلى حساب متجرك</p></header><div className="space-y-2"><Label htmlFor="email">البريد الإلكتروني</Label><Input id="email" type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></div><div className="space-y-2"><Label htmlFor="password">كلمة المرور</Label><Input id="password" type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></div>{error && <p role="alert" className="text-red-700">{error}</p>}<Button className="w-full" disabled={busy} type="submit">{busy ? 'جارٍ الدخول…' : 'تسجيل الدخول'}</Button><p className="text-sm text-slate-500">الحسابات تُنشأ بواسطة إدارة المنصة.</p></form>);
}
