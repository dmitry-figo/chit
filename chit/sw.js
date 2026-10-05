/**
 * sw.js — Service Worker приложения «Чит» (PWA).
 * Стратегия: precache каркаса + runtime cache-first для статики, network-first для данных.
 */
'use strict';

const CACHE_NAME = 'chit-v1';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './app.js',
  './src/main.js',
  './src/domain/SyllableLoader.js',
  './src/domain/BlockSession.js',
  './speech/SpeechAdapter.js',
  './speech/WebSpeechAdapter.js',
  './data/syllables.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // сторонние ресурсы не трогаем

  // Данные методиста — network-first (методист правит JSON, ребёнок должен получить свежее)
  if (url.pathname.endsWith('/data/syllables.json')) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Остальная статика — cache-first с дозаполнением кэша
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.ok && (url.pathname.startsWith(self.registration.scope) || url.pathname === '/')) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return resp;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
