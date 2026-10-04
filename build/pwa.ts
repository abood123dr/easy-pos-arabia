import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Plugin } from "vite";

// Only shipped public assets are cached. Business data and Auth never enter Cache Storage.
export default function pwa(): Plugin {
  let publicDir = "";
  return {
    name: "pos-static-pwa",
    apply: "build",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter(
          (name) => name.startsWith("assets/") && /\.(js|css)$/.test(name),
        )
        .map((name) => `/${name}`)
        .sort();
      const files = [
        ...assets,
        "/offline.html",
        "/offline-retry.js",
        "/icons/pos-192.png",
        "/icons/pos-512.png",
        "/icons/pos-180.png",
        "/manifest.webmanifest",
      ];
      const hash = createHash("sha256").update(JSON.stringify(files));
      for (const file of files.filter((file) => !file.startsWith("/assets/")))
        hash.update(readFileSync(join(publicDir, file.slice(1))));
      const version = hash.digest("hex").slice(0, 16);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `
const PREFIX = 'lamha-pos-public-v1-';
const CACHE = PREFIX + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(files)};
const ALLOWED = new Set(FILES);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
// A new worker waits for open tabs to close: no forced reload during checkout.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || request.headers.has('Authorization')) return;
  // Navigation is always network-first and never stored. Offline shows a public explanation.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('/offline.html')) || new Response('Offline', {status: 503});
    }));
    return;
  }
  // Exact allowlist; APIs, query parameters and arbitrary paths bypass this worker.
  if (url.search || !ALLOWED.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request)) || fetch(request)));
});
`,
      });
    },
  };
}
