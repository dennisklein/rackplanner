/*
 * Rackplanner: service worker.
 *
 * Precaches the app shell so the planner opens without a network. Requests
 * go to the network first and fall back to the cache, so a new deploy shows
 * up on the next online load. Bump CACHE whenever SHELL changes.
 */
'use strict';

const CACHE = 'rackplanner-v3';
const PREFIX = 'rackplanner-';

const FONTS = [
  'barlow-latin-400-normal', 'barlow-latin-ext-400-normal',
  'barlow-latin-500-normal', 'barlow-latin-ext-500-normal',
  'barlow-latin-600-normal', 'barlow-latin-ext-600-normal',
  'barlow-condensed-latin-500-normal', 'barlow-condensed-latin-ext-500-normal',
  'barlow-condensed-latin-600-normal', 'barlow-condensed-latin-ext-600-normal',
  'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-ext-400-normal',
  'ibm-plex-mono-latin-500-normal', 'ibm-plex-mono-latin-ext-500-normal',
  'ibm-plex-mono-latin-600-normal', 'ibm-plex-mono-latin-ext-600-normal',
].map((name) => `fonts/${name}.woff2`);

// Relative to this script, so the app also works from a subpath (GitHub Pages).
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'css/fonts.css',
  'js/model.js',
  'js/io.js',
  'js/render.js',
  'js/library.js',
  'js/app.js',
  'manifest.webmanifest',
  'icon.svg',
].concat(FONTS);

// One missing file must not abort the install, so add entries one by one.
// cache: 'reload' skips the HTTP cache to avoid mixing old and new files.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

// Drop caches left by earlier versions, then take over open pages.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs inside our scope only; everything else bypasses the worker.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  if (!req.url.startsWith(self.registration.scope)) return;
  event.respondWith(networkFirst(event));
});

async function networkFirst(event) {
  const req = event.request;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(
        caches
          .open(CACHE)
          .then((cache) => cache.put(req, copy))
          .catch(() => {}) // quota or 206 partial content: just skip caching
      );
    }
    return res;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // Offline deep link or reload: serve the single page.
    if (req.mode === 'navigate') {
      const page = await cache.match(new URL('index.html', self.location).href);
      if (page) return page;
    }
    return Response.error();
  }
}
