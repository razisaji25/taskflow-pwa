/* =========================================================
   TASKFLOW — SERVICE WORKER
   Strategi: Cache First untuk asset app shell, agar aplikasi
   tetap berfungsi penuh tanpa koneksi internet setelah load
   pertama kali.
   ========================================================= */

"use strict";

const CACHE_NAME = "taskflow-cache-v1";

// seluruh asset app shell yang wajib di-cache agar offline 100% berfungsi
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json"
];

/* ---------- INSTALL: cache semua asset app shell ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

/* ---------- ACTIVATE: bersihkan cache versi lama ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------- FETCH: cache-first, fallback ke network ---------- */
self.addEventListener("fetch", (event) => {
  // hanya tangani request GET (IndexedDB tidak lewat fetch, jadi tidak terganggu)
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request)
        .then((networkResponse) => {
          // simpan salinan baru ke cache untuk akses offline berikutnya
          return caches.open(CACHE_NAME).then((cache) => {
            // hanya cache response yang valid (same-origin, status 200)
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === "basic") {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          });
        })
        .catch(() => {
          // jika offline dan tidak ada di cache, fallback ke index.html (untuk navigasi SPA)
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        });
    })
  );
});
