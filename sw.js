const CACHE_NAME = 'ericka-macro-ledger-v55';

// The app's own files. Fetched network-first so a deploy is picked up straight
// away, with the cache as the offline fallback.
const APP_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/config.js',
  '/app.js',
  '/icon.svg',
  '/manifest.json'
];

// Third-party code the app cannot boot without. These were never cached, which
// is why an installed app opened to a broken screen with no signal: Supabase and
// Chart.js simply were not there. Every URL here is version-pinned, so serving
// them cache-first is safe and also faster online.
const VENDOR_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

const isVendor = (url) =>
  url.startsWith('https://cdn.jsdelivr.net/') ||
  url.startsWith('https://fonts.googleapis.com/') ||
  url.startsWith('https://fonts.gstatic.com/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // One request per asset rather than addAll: a single CDN hiccup would
      // otherwise reject the whole install and leave the app with no cache.
      return Promise.all(
        [...APP_ASSETS, ...VENDOR_ASSETS].map((url) =>
          cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;

  // Never cache Supabase traffic - it is live data, and a stale reply here
  // would be worse than an honest failure the app can report.
  if (url.includes('.supabase.co') || url.includes('/api/')) return;

  if (isVendor(url)) {
    // Cache-first: pinned versions never change, and the font files the Google
    // stylesheet pulls in get picked up here the first time they are requested.
    event.respondWith(
      caches.match(event.request).then((hit) => {
        if (hit) return hit;
        return fetch(event.request).then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // The app's own files: network first, cache as the offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((hit) => {
          // A navigation that misses still has to land somewhere sensible.
          if (hit) return hit;
          if (event.request.mode === 'navigate') return caches.match('/index.html');
          return Response.error();
        });
      })
  );
});
