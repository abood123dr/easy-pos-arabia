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
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    timezoneId: "Asia/Riyadh",
  });
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
  const reports = [];
  const accounts = [];
  let accountFail = true;
  let memberRole = "cashier";
  let revoked = false;
  const memberId = "00000000-0000-0000-0000-000000000055";
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
    } else if (
      url.pathname.endsWith("/store_memberships") &&
      req.method() === "GET"
    )
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
    } else if (url.pathname.endsWith("/rpc/pos_account_members")) {
      data =
        accounts.length && !revoked
          ? [
              {
                user_id: memberId,
                email: "cashier@example.test",
                role: memberRole,
              },
            ]
          : [];
    } else if (url.pathname.endsWith("/functions/v1/pos-accounts")) {
      accounts.push(req.postDataJSON());
      if (accountFail) {
        accountFail = false;
        return route.abort("failed");
      }
      data = { completed: true, user_id: memberId };
    } else if (
      url.pathname.endsWith("/store_memberships") &&
      req.method() === "PATCH"
    ) {
      memberRole = req.postDataJSON().role;
      data = { user_id: memberId };
    } else if (
      url.pathname.endsWith("/store_memberships") &&
      req.method() === "DELETE"
    ) {
      revoked = true;
      data = { user_id: memberId };
    } else if (url.pathname.endsWith("/rpc/pos_sales_summary")) {
      reports.push(req.postDataJSON());
      data = [
        { sales_count: 121, total: 128.53, cash_total: 8.53, card_total: 120 },
      ];
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("http://127.0.0.1:4187");
  const manifest = await (
    await page.request.get("http://127.0.0.1:4187/manifest.webmanifest")
  ).json();
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.lang, "ar");
  assert.equal(manifest.dir, "rtl");
  for (const icon of manifest.icons) {
    const response = await page.request.get("http://127.0.0.1:4187" + icon.src);
    assert.equal(response.ok(), true);
    const png = await response.body();
    const [w, h] = icon.sizes.split("x").map(Number);
    assert.equal(png.readUInt32BE(16), w);
    assert.equal(png.readUInt32BE(20), h);
  }
  await page.getByText("تثبيت على الجهاز", { exact: true }).click();
  await page.getByText("على iPhone:", { exact: false }).waitFor();
  await page.context().setOffline(true);
  await page.getByText("الاتصال منقطع.", { exact: false }).waitFor();
  await page.context().setOffline(false);
  await page
    .getByText("الاتصال منقطع.", { exact: false })
    .waitFor({ state: "hidden" });
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt");
    Object.assign(event, {
      prompt: async () => {
        window.__installCalls = (window.__installCalls ?? 0) + 1;
      },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
  });
  await page
    .getByRole("button", { name: "تثبيت التطبيق", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تثبيت التطبيق", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => window.__installCalls), 1);
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
  await page
    .getByRole("button", { name: "ملخص المبيعات", exact: true })
    .click();
  await page.getByLabel("من تاريخ").fill("2026-01-01");
  await page.getByLabel("إلى تاريخ").fill("2026-01-01");
  await page.getByRole("button", { name: "عرض الملخص" }).click();
  await page.getByText("121", { exact: true }).waitFor();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    p_store_id: sid,
    p_from: "2025-12-31T21:00:00.000Z",
    p_until: "2026-01-01T21:00:00.000Z",
  });
  await page.getByLabel("إلى تاريخ").fill("2026-02-02");
  await page.getByRole("button", { name: "عرض الملخص" }).click();
  await page.getByText("اختر فترة صحيحة لا تتجاوز 31 يومًا.").waitFor();
  assert.equal(reports.length, 1);
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
  await page.getByRole("button", { name: "الحسابات", exact: true }).click();
  await page.getByLabel("بريد الحساب").fill("cashier@example.test");
  await page.getByLabel("الدور", { exact: true }).selectOption("cashier");
  await page.getByLabel("كلمة مرور الحساب الجديد").fill("SafePassword12345!");
  await page.getByRole("button", { name: "حفظ الحساب", exact: true }).click();
  await page.getByText("تعذر تأكيد حفظ الحساب.", { exact: false }).waitFor();
  const stored = await page.evaluate(() =>
    sessionStorage.getItem(
      "pos-account-pending:00000000-0000-0000-0000-000000000002",
    ),
  );
  assert.equal(stored.includes("SafePassword"), false);
  assert.equal(JSON.parse(stored).role, "cashier");
  await page.reload();
  await page.getByRole("button", { name: "الحسابات", exact: true }).click();
  assert.equal(
    await page.getByLabel("بريد الحساب").inputValue(),
    "cashier@example.test",
  );
  assert.equal(
    await page.getByLabel("كلمة مرور الحساب الجديد").inputValue(),
    "",
  );
  await page.getByLabel("كلمة مرور الحساب الجديد").fill("SafePassword12345!");
  await page
    .getByRole("button", { name: "إعادة محاولة الطلب نفسه", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تحويل إلى مالك", exact: true })
    .waitFor();
  assert.deepEqual(accounts[0], accounts[1]);
  await page
    .getByRole("button", { name: "تحويل إلى مالك", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تحويل إلى كاشير", exact: true })
    .waitFor();
  assert.equal(memberRole, "owner");
  await page.getByRole("button", { name: "إلغاء الوصول", exact: true }).click();
  assert.equal(revoked, false);
  await page
    .getByRole("button", { name: "تأكيد إلغاء الوصول", exact: true })
    .click();
  await page.getByText("لا توجد حسابات مرتبطة ظاهرة.").waitFor();
  assert.equal(revoked, true);
  assert.deepEqual(errors, []);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await page.screenshot({ path: "/tmp/pos-admin-smoke.png", fullPage: true });
  console.log(
    "Account creation refresh retry/no saved password/role change/revoke confirmation passed. PWA manifest/icons/install event/offline notice and sales summary timezone/limit passed. UI mock integration passed: sales/stock refresh retries, admin create retry, rename, pause confirmation, activation and 3 viewport widths. Not a live Supabase test.",
  );
} finally {
  await browser?.close();
  server.kill();
}
