import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export default class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main
        dir="rtl"
        className="min-h-screen bg-slate-50 flex items-center justify-center p-4"
      >
        <section
          role="alert"
          className="max-w-md rounded-xl border bg-white p-6 space-y-4"
        >
          <h1 className="text-xl font-bold">تعذر عرض الصفحة</h1>
          <p>
            أعد فتح الصفحة للمحاولة. إذا كان لديك بيع معلّق، تحقق منه داخل
            المتجر قبل بدء بيع جديد.
          </p>
          <Button className="w-full" onClick={() => window.location.reload()}>
            إعادة فتح الصفحة
          </Button>
        </section>
      </main>
    );
  }
}
