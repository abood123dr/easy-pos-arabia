export type Product = { id: string; store_id: string; name: string; barcode: string | null; price: number; stock: number; active: boolean };
export type Sale = { id: string; invoice_no: number; total: number; payment_method: string; created_at: string };
export type SaleItem = { id: string; product_name: string; quantity: number; unit_price: number; total: number };
export type Checkout = { requestId: string; items: { product_id: string; quantity: number }[]; payment: 'cash' | 'card' };
export const money = (n: number) => new Intl.NumberFormat('ar-SA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
export function posError(error: { message?: string; code?: string }) {
  const message = error.message ?? '';
  if (message.includes('POS_INSUFFICIENT_STOCK')) return 'المخزون لا يكفي. حدّث البيانات وراجع الكمية.';
  if (message.includes('POS_ACCESS_DENIED')) return 'لا تملك الصلاحية أو المتجر موقوف.';
  if (message.includes('POS_PRODUCT_UNAVAILABLE')) return 'أحد المنتجات غير متاح. حدّث البيانات.';
  if (message.includes('POS_REQUEST_CONFLICT')) return 'الطلب السابق مختلف. تواصل مع إدارة المنصة للتحقق.';
  if (error.code === '23505') return 'الباركود مستخدم لمنتج آخر.';
  if (error.code?.startsWith('22') || error.code === '23514') return 'تحقق من القيم المدخلة.';
  return 'تعذر إتمام العملية. تحقق من الاتصال وحاول مرة أخرى.';
}
