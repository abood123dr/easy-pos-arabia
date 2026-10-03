import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { supabase } from '@/lib/supabase';
import { money, posError, type Product, type Sale, type SaleItem, type Checkout } from '@/lib/pos';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Props = { store: { id: string; name: string }; userId: string; isAdmin: boolean; onBack: () => void };
const stockSchema = z.object({ id: z.string().uuid(), productId: z.string().uuid(), delta: z.number().finite().refine(n => n !== 0), note: z.string().trim().min(1).max(300) });
const pendingSchema = z.object({ requestId: z.string().uuid(), items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.number().positive() })).min(1).max(200), payment: z.enum(['cash','card']) });
export default function StoreWorkspace({ store, userId, isAdmin, onBack }: Props) {
  const storageKey = `pos-pending:${userId}:${store.id}`;
  const stockKey = `pos-stock-pending:${userId}:${store.id}`;
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [owner, setOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [tab, setTab] = useState('sell');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [payment, setPayment] = useState<'cash'|'card'>('cash');
  const [pending, setPending] = useState<Checkout | null>(null);
  const [receipt, setReceipt] = useState<{ sale: Sale; items: SaleItem[] } | null>(null);
  const [form, setForm] = useState({ id: '', name: '', barcode: '', price: '', active: true });
  const [adjust, setAdjust] = useState({ productId: '', delta: '', note: '' });
  const [stockRequest, setStockRequest] = useState<{ id: string; productId: string; delta: number; note: string } | null>(null);
  const ready = useRef(false);

  useEffect(() => {
    let active = true;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const value = pendingSchema.parse(JSON.parse(saved)) as Checkout;
        setPending(value); setCart(Object.fromEntries(value.items.map(i => [i.product_id, i.quantity]))); setPayment(value.payment);
      }
      const savedStock = localStorage.getItem(stockKey);
      if (savedStock) {
        const value = stockSchema.parse(JSON.parse(savedStock)) as { id: string; productId: string; delta: number; note: string };
        setStockRequest(value); setAdjust({ productId: value.productId, delta: String(value.delta), note: value.note });
      }
      ready.current = true;
    } catch { setError('تعذر استعادة الطلب السابق. لا تبدأ بيعًا جديدًا حتى يتم التحقق من بيانات المتصفح.'); }
    async function load() {
      setLoading(true);
      try {
        const [p,s,m] = await Promise.all([
          supabase!.from('products').select('*').eq('store_id',store.id).order('name'),
          supabase!.from('sales').select('id,invoice_no,total,payment_method,created_at').eq('store_id',store.id).order('created_at',{ascending:false}).limit(100),
          supabase!.from('store_memberships').select('role').eq('store_id',store.id).eq('user_id',userId).maybeSingle(),
        ]);
        if (p.error || s.error || m.error) throw p.error || s.error || m.error;
        if (active) { setProducts(p.data ?? []); setSales(s.data ?? []); setOwner(isAdmin || m.data?.role==='owner'); }
      } catch { if (active) setError('تعذر تحميل بيانات المتجر. حاول تحديث البيانات.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active=false; };
  }, [store.id, userId, isAdmin, storageKey, stockKey]);
  async function refresh() {
    const [p,s] = await Promise.all([
      supabase!.from('products').select('*').eq('store_id',store.id).order('name'),
      supabase!.from('sales').select('id,invoice_no,total,payment_method,created_at').eq('store_id',store.id).order('created_at',{ascending:false}).limit(100),
    ]);
    if (p.error || s.error) throw p.error || s.error;
    setProducts(p.data ?? []); setSales(s.data ?? []);
  }
  async function task(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current=true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (e) { setError(posError(e as { message?: string; code?: string })); }
    finally { inFlight.current=false; setBusy(false); }
  }
  function add(product: Product) {
    if (busy || pending || !product.active) return;
    setCart(old => ({ ...old, [product.id]: Number(((old[product.id] ?? 0)+1).toFixed(3)) }));
  }
  async function checkout() {
    await task(async () => {
      if (!ready.current) throw new Error('pending unavailable');
      const request = pending ?? { requestId: crypto.randomUUID(), items: Object.entries(cart).filter(([,q])=>q>0).map(([product_id,quantity])=>({product_id,quantity})), payment };
      pendingSchema.parse(request);
      // Persist before sending. A lost response/refresh retries the identical key.
      localStorage.setItem(storageKey, JSON.stringify(request)); setPending(request);
      const { data, error } = await supabase!.rpc('pos_checkout',{p_store_id:store.id,p_request_id:request.requestId,p_items:request.items,p_payment_method:request.payment});
      if (error) {
        if (['22023','22P02','23514','23505','42501'].includes(error.code)) {
          localStorage.removeItem(storageKey); setPending(null);
        }
        throw error;
      }
      localStorage.removeItem(storageKey); setPending(null); setCart({});
      setNotice(`حُفظت الفاتورة رقم ${data.invoice_no} — الإجمالي ${money(Number(data.total))}`);
      // Failure to refresh must never imply checkout itself failed.
      try { await refresh(); } catch { setError('حُفظ البيع، لكن تعذر تحديث القوائم. اضغط تحديث البيانات.'); }
    });
  }
  async function saveProduct(e: FormEvent) {
    e.preventDefault();
    await task(async () => {
      const id = form.id || crypto.randomUUID(); setForm(f=>({...f,id}));
      const { error } = await supabase!.rpc('pos_save_product',{p_store_id:store.id,p_id:id,p_name:form.name,p_barcode:form.barcode,p_price:Number(form.price),p_active:form.active});
      if (error) throw error;
      setForm({id:'',name:'',barcode:'',price:'',active:true}); setNotice('تم حفظ المنتج.');
      await refresh();
    });
  }
  async function saveStock(e: FormEvent) {
    e.preventDefault();
    await task(async () => {
      const request = stockRequest ?? {id:crypto.randomUUID(),productId:adjust.productId,delta:Number(adjust.delta),note:adjust.note};
      if (!ready.current) throw new Error('pending unavailable');
      stockSchema.parse(request);
      localStorage.setItem(stockKey, JSON.stringify(request)); setStockRequest(request);
      const {error} = await supabase!.rpc('pos_adjust_stock',{p_store_id:store.id,p_product_id:request.productId,p_request_id:request.id,p_delta:request.delta,p_note:request.note});
      if (error) { if (['22023','22P02','23514','42501'].includes(error.code)) { localStorage.removeItem(stockKey); setStockRequest(null); } throw error; }
      localStorage.removeItem(stockKey); setStockRequest(null); setAdjust({productId:'',delta:'',note:''}); setNotice('تم تسجيل حركة المخزون.');
      try { await refresh(); } catch { setError('حُفظت الحركة، لكن تعذر تحديث القوائم. اضغط تحديث البيانات.'); }
    });
  }
  async function openReceipt(sale: Sale) {
    await task(async () => {
      const {data,error} = await supabase!.from('sale_items').select('id,product_name,quantity,unit_price,total').eq('store_id',store.id).eq('sale_id',sale.id);
      if (error) throw error;
      setReceipt({sale,items:data ?? []});
    });
  }
  const visible = products.filter(p=>p.active && (p.name.includes(search) || p.barcode?.includes(search)));
  const lines = Object.entries(cart).filter(([,q])=>q>0);
  const estimate = lines.reduce((total,[id,q])=>total+Math.round(Number(products.find(p=>p.id===id)?.price ?? 0)*q*100)/100,0);
  const frozen = busy || !!pending;
  return <main dir="rtl" className="min-h-screen bg-slate-50 p-4 sm:p-8"><div className="mx-auto max-w-6xl space-y-5"><header className="flex flex-wrap justify-between gap-3 print:hidden"><div><h1 className="text-2xl font-bold">{store.name}</h1><p className="text-sm text-slate-500">نقطة البيع</p></div><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={()=>task(refresh)}>تحديث البيانات</Button><Button variant="outline" disabled={busy || !!stockRequest} onClick={onBack}>المتاجر</Button></div></header><div className="print:hidden rounded-lg border bg-amber-50 p-3 text-sm">نسخة تطوير — لم تُختبر بعد على قاعدة البيانات الفعلية.</div>{error && <p role="alert" className="print:hidden rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}{notice && <p role="status" className="print:hidden rounded-lg bg-green-50 p-3 text-green-800">{notice}</p>}
    <nav className="flex gap-2 print:hidden" aria-label="أقسام المتجر">{[['sell','البيع'],['products','المنتجات والمخزون'],['invoices','الفواتير']].map(([id,label])=><Button key={id} variant={tab===id?'default':'outline'} onClick={()=>setTab(id)}>{label}</Button>)}</nav>
    {loading ? <p role="status">جارٍ التحميل…</p> : <div className="print:hidden">
    {tab==='sell' && <div className="grid gap-5 lg:grid-cols-2"><section className="space-y-4"><Label htmlFor="product-search">اسم المنتج أو الباركود</Label><Input id="product-search" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){const p=products.find(p=>p.active && p.barcode===search.trim());if(p){add(p);setSearch('');}}}} placeholder="ابحث أو امسح الباركود ثم Enter" /><div className="grid grid-cols-2 gap-3">{visible.map(p=><button type="button" disabled={frozen || p.stock<=0} onClick={()=>add(p)} key={p.id} className="rounded-xl border bg-white p-4 text-right disabled:opacity-50"><strong className="block">{p.name}</strong><span className="block mt-2">{money(Number(p.price))}</span><span className="block text-xs text-slate-500">المخزون: {p.stock}</span></button>)}</div>{!visible.length && <p>لا توجد منتجات مطابقة. أضف المنتجات والمخزون أولًا.</p>}</section><section className="rounded-xl border bg-white p-5 space-y-4"><h2 className="text-lg font-bold">السلة</h2>{pending && <p className="bg-amber-50 p-3">طلب البيع قيد التحقق. أعد المحاولة بنفس الطلب لتجنب تكرار الفاتورة.</p>}{lines.map(([id,q])=><div className="flex flex-wrap items-center gap-2 border-b pb-3" key={id}><span className="flex-1">{products.find(p=>p.id===id)?.name ?? 'منتج في الطلب السابق'}</span><label className="text-xs">الكمية<Input className="w-24" type="number" min="0.001" step="0.001" value={q} disabled={frozen} onChange={e=>setCart(c=>({...c,[id]:Number(e.target.value)}))} /></label><Button variant="outline" disabled={frozen} onClick={()=>setCart(c=>{const next={...c};delete next[id];return next;})}>حذف</Button></div>)}{!lines.length && <p className="text-slate-500">السلة فارغة</p>}<p className="text-xl font-bold">الإجمالي المتوقع: {money(estimate)}</p><p className="text-xs text-slate-500">يُحسب الإجمالي النهائي من الأسعار المحفوظة عند البيع.</p><Label htmlFor="payment">طريقة السداد</Label><select className="w-full border rounded-md p-2" id="payment" value={payment} disabled={frozen} onChange={e=>setPayment(e.target.value as 'cash'|'card')}><option value="cash">نقدًا</option><option value="card">بطاقة — تسجيل فقط</option></select><Button className="w-full" disabled={busy || !lines.length || !ready.current} onClick={checkout}>{busy?'جارٍ الحفظ…':pending?'التحقق وإعادة المحاولة':'حفظ البيع'}</Button></section></div>}
    {tab==='products' && <div className="space-y-5">{owner && <div className="grid gap-4 md:grid-cols-2"><form onSubmit={saveProduct} className="rounded-xl border bg-white p-5 space-y-3"><h2 className="font-bold">{form.id?'تعديل المنتج':'إضافة منتج'}</h2><Label htmlFor="name">اسم المنتج</Label><Input id="name" required maxLength={160} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} /><Label htmlFor="barcode">الباركود (اختياري)</Label><Input id="barcode" maxLength={80} dir="ltr" value={form.barcode} onChange={e=>setForm(f=>({...f,barcode:e.target.value}))} /><Label htmlFor="price">سعر البيع</Label><Input id="price" type="number" min="0" step="0.01" required value={form.price} onChange={e=>setForm(f=>({...f,price:e.target.value}))} /><label className="flex gap-2"><input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))} /> متاح للبيع</label><Button disabled={busy} type="submit">حفظ المنتج</Button></form><form onSubmit={saveStock} className="rounded-xl border bg-white p-5 space-y-3"><h2 className="font-bold">حركة مخزون</h2><Label htmlFor="stock-product">المنتج</Label><select required id="stock-product" className="w-full border rounded-md p-2" value={adjust.productId} disabled={busy || !!stockRequest} onChange={e=>setAdjust(a=>({...a,productId:e.target.value}))}><option value="">اختر المنتج</option>{products.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><Label htmlFor="delta">الكمية المضافة أو المخصومة</Label><Input id="delta" type="number" step="0.001" required disabled={busy || !!stockRequest} placeholder="مثل 10 أو -2" value={adjust.delta} onChange={e=>setAdjust(a=>({...a,delta:e.target.value}))} /><Label htmlFor="note">سبب الحركة</Label><Input id="note" required maxLength={300} disabled={busy || !!stockRequest} placeholder="استلام بضاعة / تسوية جرد" value={adjust.note} onChange={e=>setAdjust(a=>({...a,note:e.target.value}))} /><Button disabled={busy || !ready.current} type="submit">{stockRequest?'إعادة محاولة الطلب نفسه':'حفظ حركة المخزون'}</Button></form></div>}<div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-right"><thead><tr><th className="p-3">المنتج</th><th>السعر</th><th>المخزون</th><th>الحالة</th>{owner && <th>تعديل</th>}</tr></thead><tbody>{products.map(p=><tr className="border-t" key={p.id}><td className="p-3">{p.name}<small className="block text-slate-500">{p.barcode}</small></td><td>{money(Number(p.price))}</td><td>{p.stock}</td><td>{p.active?'نشط':'موقوف'}</td>{owner && <td><Button variant="ghost" disabled={busy} onClick={()=>setForm({id:p.id,name:p.name,barcode:p.barcode ?? '',price:String(p.price),active:p.active})}>تعديل</Button></td>}</tr>)}</tbody></table></div></div>}
    {tab==='invoices' && <section className="space-y-3"><p className="text-sm text-slate-500">آخر 100 فاتورة محفوظة</p>{sales.map(s=><article className="flex flex-wrap justify-between items-center gap-3 rounded-xl border bg-white p-4" key={s.id}><div><strong>فاتورة {s.invoice_no}</strong><p className="text-sm text-slate-500">{new Date(s.created_at).toLocaleString('ar-SA')} — {s.payment_method==='cash'?'نقدًا':'بطاقة'}</p></div><span>{money(Number(s.total))}</span><Button disabled={busy} variant="outline" onClick={()=>openReceipt(s)}>عرض الفاتورة</Button></article>)}{!sales.length && <p>لا توجد فواتير محفوظة بعد.</p>}</section>}
    </div>}
    {receipt && <section className="rounded-xl border bg-white p-6 space-y-3 print:border-0"><h2 className="text-xl font-bold">{store.name} — فاتورة {receipt.sale.invoice_no}</h2><p>{new Date(receipt.sale.created_at).toLocaleString('ar-SA')}</p><table className="w-full text-right"><thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>{receipt.items.map(i=><tr key={i.id}><td>{i.product_name}</td><td>{i.quantity}</td><td>{money(Number(i.unit_price))}</td><td>{money(Number(i.total))}</td></tr>)}</tbody></table><strong className="block">الإجمالي: {money(Number(receipt.sale.total))}</strong><div className="flex gap-3 print:hidden"><Button onClick={()=>window.print()}>طباعة</Button><Button variant="outline" onClick={()=>setReceipt(null)}>إغلاق</Button></div></section>}
  </div></main>;
}
