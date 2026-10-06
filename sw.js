// diet-os-v5
// Service Worker is intentionally pass-through.
// Diet OS depends on live Supabase data, so fetch requests are not intercepted.
self.addEventListener("install", event => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});
