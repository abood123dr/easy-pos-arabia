// Mock API integration test. Never contacts a real Supabase project.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--port", "4187", "--strictPort"],
  {
    env: {
      ...process.env,
      VITE_SUPABASE_URL: "https://pos-test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "local-test-placeholder",
    },
    stdio: "ignore",
  },
);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch("http://127.0.0.1:4187")).ok) break;
    } catch {}
    if (i === 99) throw new Error("Test server did not start");
    await setTimeout(100);
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.POS_TEST_CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const uid = "00000000-0000-0000-0000-000000000002",
    sid = "00000000-0000-0000-0000-000000000011",
    pid = "00000000-0000-0000-0000-000000000101";
  const token =
    "eyJhbGciOiJIUzI1NiJ9." +
    Buffer.from(
      JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url") +
    ".test";
  let requests = [],
    fail = true,
    stockFail = true,
    stockRequests = [];
  let admin = false,
    createFail = true,
    creates = [],
    patches = [];
  const stores = [{ id: sid, name: "متجر الاختبار", active: true }];
  const user = {
    id: uid,
    email: "owner@example.test",
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  await page.route("https://pos-test.supabase.co/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    let data = [];
    let status = 200;
    if (url.pathname.includes("/auth/v1/token"))
      data = {
        access_token: token,
        refresh_token: "fake",
        expires_in: 3600,
        token_type: "bearer",
        user,
      };
    else if (url.pathname.includes("/auth/v1/user")) data = user;
    else if (url.pathname.endsWith("/platform_admins"))
      data = admin ? { user_id: uid } : null;
    else if (url.pathname.endsWith("/stores")) {
      if (req.method() === "POST") {
        const value = req.postDataJSON();
        creates.push(value);
        if (stores.some((s) => s.id === value.id)) {
          status = 409;
          data = { code: "23505", message: "duplicate" };
        } else {
          stores.push({ ...value, active: true });
          if (createFail) {
            createFail = false;
            return route.abort("failed");
          }
          data = { id: value.id };
        }
      } else if (req.method() === "PATCH") {
        const value = req.postDataJSON();
        patches.push(value);
        const store = stores.find(
          (s) => s.id === url.searchParams.get("id")?.slice(3),
        );
        Object.assign(store, value);
        data = { id: store.id };
      } else if (url.searchParams.has("id"))
        data = stores.find((s) => s.id === url.searchParams.get("id").slice(3));
      else data = stores;
    } else if (url.pathname.endsWith("/store_memberships"))
      data = { role: "owner" };
    else if (url.pathname.endsWith("/products"))
      data = [
        {
          id: pid,
          store_id: sid,
          name: "حليب",
          barcode: "101",
          price: 2.35,
          stock: 10,
          active: true,
        },
      ];
    else if (url.pathname.endsWith("/rpc/pos_checkout")) {
      requests.push(req.postDataJSON());
      if (fail) {
        fail = false;
        return route.abort("failed");
      }
      data = { id: "test-sale", invoice_no: 1, total: 2.35 };
    } else if (url.pathname.endsWith("/rpc/pos_adjust_stock")) {
      stockRequests.push(req.postDataJSON());
      if (stockFail) {
        stockFail = false;
        return route.abort("failed");
      }
      data = { id: "movement" };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("http://127.0.0.1:4187");
  await page.getByLabel("البريد الإلكتروني").fill("owner@example.test");
  await page.getByLabel("كلمة المرور").fill("password");
  await page.getByRole("button", { name: "تسجيل الدخول", exact: true }).click();
  await page.getByRole("button", { name: "فتح المتجر" }).click();
  await page.getByRole("button", { name: /حليب/ }).click();
  await page.getByRole("button", { name: "حفظ البيع", exact: true }).click();
  await page.getByText("طلب البيع قيد التحقق.", { exact: false }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "فتح المتجر" }).click();
  await page.getByRole("button", { name: "التحقق وإعادة المحاولة" }).click();
  await page.getByText(/حُفظت الفاتورة رقم/).waitFor();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  await page.getByRole("button", { name: "المنتجات والمخزون" }).click();
  await page.getByLabel("المنتج", { exact: true }).selectOption(pid);
  await page.getByLabel("الكمية المضافة أو المخصومة").fill("4");
  await page.getByLabel("سبب الحركة").fill("استلام");
  await page.getByRole("button", { name: "حفظ حركة المخزون" }).click();
  await page.getByRole("button", { name: "إعادة محاولة الطلب نفسه" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "فتح المتجر" }).click();
  await page.getByRole("button", { name: "المنتجات والمخزون" }).click();
  await page.getByRole("button", { name: "إعادة محاولة الطلب نفسه" }).click();
  await page.getByText("تم تسجيل حركة المخزون.").waitFor();
  assert.equal(stockRequests.length, 2);
  assert.deepEqual(stockRequests[0], stockRequests[1]);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  // Owner never sees platform administration controls.
  assert.equal(
    await page.getByRole("region", { name: "إدارة المتاجر" }).count(),
    0,
  );
  admin = true;
  await page.reload();
  await page.getByLabel("متجر جديد", { exact: true }).fill("متجر إضافي");
  await page.getByRole("button", { name: "إضافة المتجر" }).click();
  await page.getByText("تعذر حفظ التغيير.", { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel("متجر جديد", { exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "إضافة المتجر" }).click();
  await page.getByRole("button", { name: "تعديل الاسم" }).nth(1).waitFor();
  assert.equal(stores.length, 2);
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0], creates[1]);
  await page.getByRole("button", { name: "تعديل الاسم" }).first().click();
  await page.getByLabel("تعديل اسم المتجر").fill("اسم محدث");
  await page.getByRole("button", { name: "حفظ الاسم" }).click();
  await page
    .getByRole("button", { name: "إيقاف", exact: true })
    .first()
    .click();
  assert.equal(patches.filter((p) => p.active === false).length, 0);
  await page.getByRole("button", { name: "تأكيد الإيقاف" }).click();
  await page.getByRole("button", { name: "تفعيل", exact: true }).waitFor();
  assert.equal(stores[0].active, false);
  await page.getByRole("button", { name: "تفعيل", exact: true }).click();
  await page
    .getByRole("button", { name: "إيقاف", exact: true })
    .nth(1)
    .waitFor();
  assert.equal(stores[0].active, true);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  const color = await page
    .getByRole("button", { name: "إضافة المتجر" })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(color, "rgba(0, 0, 0, 0)");
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/pos-admin-smoke.png", fullPage: true });
  console.log(
    "UI mock integration passed: sales/stock refresh retries, admin create retry, rename, pause confirmation, activation and 3 viewport widths. Not a live Supabase test.",
  );
} finally {
  await browser?.close();
  server.kill();
}
