// Service worker minimal : nécessaire pour que Chrome propose "Installer l'application"
const CACHE_NAME = "studios-am-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

// Laisse passer toutes les requêtes normalement (pas de mode hors-ligne pour l'instant)
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
