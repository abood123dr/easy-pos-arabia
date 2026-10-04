// Built production PWA, real local HTTP and browser Service Worker; no Supabase access.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const root = resolve("dist");
let worker = await readFile(resolve(root, "sw.js"), "utf8");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
let apiCalls = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/icons/company-private.png"
  ) {
    apiCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ company: "private", call: apiCalls }));
    return;
  }
  if (url.pathname === "/sw.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(worker);
    return;
  }
  let path = resolve(root, `.${url.pathname}`);
  if (!path.startsWith(`${root}/`) && path !== root) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!extname(path)) path = resolve(root, "index.html");
  try {
    res.setHeader(
      "Content-Type",
      mime[extname(path)] || "application/octet-stream",
    );
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.POS_TEST_CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByText("النظام قيد التجهيز.", { exact: false }).waitFor();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((done) =>
        navigator.serviceWorker.addEventListener("controllerchange", done, {
          once: true,
        }),
      );
  });
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller.state),
    "activated",
  );
  await page.evaluate(async () => {
    await fetch("/api/company");
    await fetch("/api/checkout", { method: "POST", body: "private sale" });
    await fetch("/api/auth", {
      headers: { Authorization: "Bearer placeholder" },
    });
    await fetch("/icons/company-private.png");
  });
  assert.equal(apiCalls, 4);
  const keys = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        result.push(new URL(request.url).pathname);
    return result;
  });
  assert(keys.includes("/offline.html"));
  assert(keys.includes("/offline-retry.js"));
  assert(keys.some((key) => key.startsWith("/assets/") && key.endsWith(".js")));
  assert.equal(
    keys.some((key) => /api|company|auth|stores|super-admin/.test(key)),
    false,
  );
  assert.equal(keys.includes("/"), false);
  assert.equal(keys.includes("/index.html"), false);
  await context.setOffline(true);
  assert.equal(
    await page.evaluate(async () => (await fetch("/icons/pos-192.png")).ok),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("/api/company");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("/icons/pos-192.png?company=private");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("/icons/pos-192.png", {
          headers: { Authorization: "Bearer placeholder" },
        });
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.goto(`${origin}/stores/00000000-0000-0000-0000-000000000011`);
  await page
    .getByRole("heading", { name: "الاتصال منقطع", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({ path: "/tmp/pos-offline.png", fullPage: true });
  await context.setOffline(false);
  await page
    .getByRole("button", { name: "إعادة المحاولة", exact: true })
    .click();
  await page.getByText("النظام قيد التجهيز.", { exact: false }).waitFor();
  assert.equal(
    new URL(page.url()).pathname,
    "/stores/00000000-0000-0000-0000-000000000011",
  );
  const previous = await page.evaluate(() => caches.keys());
  await page.evaluate(() => caches.open("unrelated-project-cache"));
  worker = worker.replace(
    /const CACHE = PREFIX \+ "[a-f0-9]+";/,
    'const CACHE = PREFIX + "test-update";',
  );
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration.update();
    if (!registration.waiting)
      await new Promise((done) => {
        const check = () => {
          if (registration.waiting) done();
        };
        registration.installing?.addEventListener("statechange", check);
        check();
      });
  });
  assert.equal(
    await page.evaluate(
      async () => !!(await navigator.serviceWorker.getRegistration()).waiting,
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller.state),
    "activated",
  );
  await page.close();
  const next = await context.newPage();
  await next.goto(origin);
  await next.waitForFunction(async () => {
    const names = await caches.keys();
    return (
      names.includes("lamha-pos-public-v1-test-update") &&
      names.filter((name) => name.startsWith("lamha-pos-public-v1-")).length ===
        1
    );
  });
  const after = await next.evaluate(() => caches.keys());
  assert(after.includes("unrelated-project-cache"));
  assert.equal(
    after.some((name) => previous.includes(name)),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Built PWA passed: actual Service Worker, public-only cache, Auth/API/POST/query exclusion, offline navigation/asset/retry, 390px, waiting update, owned-cache cleanup and unrelated cache preservation. No live Supabase or physical device test.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
