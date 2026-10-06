const CACHE = "diet-os-v4";
const APP_SHELL = ["./","./index.html","./manifest.webmanifest","./favicon.svg"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const request = event.request;
  const url = new URL(request.url);

  // Never intercept cross-origin requests (Supabase/API/CDN/etc).
  // Let the browser handle those directly.
  if (url.origin !== self.location.origin) return;

  const isNavigation = request.mode === "navigate";
  const isHtml = request.headers.get("accept")?.includes("text/html");

  if (isNavigation || isHtml) {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const fallback = await caches.match("./index.html");
          return fallback || new Response("Offline", { status: 503, statusText: "Offline" });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async cached => {
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      } catch {
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })
  );
});