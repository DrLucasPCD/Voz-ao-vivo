const CACHE_VERSION = "clara-offline-v2";
const APP_CACHE = `${CACHE_VERSION}-app`;
const CORE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/piper-voice.worker.js",
  "/local-transcription.worker.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(CORE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("clara-offline-") && key !== APP_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function shouldCache(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/__/auth/")) return false;
  if (url.pathname.startsWith("/_next/image")) return false;
  return (
    request.mode === "navigate" ||
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/offline-assets/") ||
    url.pathname.endsWith(".worker.js") ||
    /\.(?:css|js|svg|png|webp|woff2?|webmanifest)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!shouldCache(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(APP_CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? caches.match("/")),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(APP_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_URLS") return;
  const reply = event.ports?.[0];
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then(async (cache) => {
        for (const url of event.data.urls ?? []) {
          const parsed = new URL(url, self.location.origin);
          if (parsed.origin !== self.location.origin) continue;
          const response = await fetch(parsed.href, { credentials: "same-origin" });
          if (response.ok) await cache.put(parsed.href, response);
        }
      })
      .then(() => reply?.postMessage({ ok: true }))
      .catch((error) => reply?.postMessage({ ok: false, message: error.message })),
  );
});
