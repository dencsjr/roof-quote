self.addEventListener("install", () => {
  // Take control immediately after install
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Become the active SW for all clients immediately
  event.waitUntil(self.clients.claim());
});

// (Optional) Add caching later if you want offline behavior.
// Template (commented) you can customize later:
// const CACHE = 'roof-quote-v1';
// self.addEventListener('fetch', (event) => {
//   if (event.request.method !== 'GET') return;
//   event.respondWith((async () => {
//     try {
//       return await fetch(event.request);
//     } catch (err) {
//       const cache = await caches.open(CACHE);
//       const cached = await cache.match(event.request);
//       return cached || Response.error();
//     }
//   })());
// });