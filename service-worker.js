// RecoverCar — Service Worker
// Estrategia: "app shell" cacheado -> el botón abre instantáneo aunque
// la red esté lenta. La orden en sí siempre requiere red (no se cachea).

const CACHE_NAME = "recovercar-shell-v1";
const APP_SHELL = [
  "/boton.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

// Instala y precarga el shell — esto es lo que hace que el botón
// aparezca instantáneo la próxima vez que se abra, incluso sin señal.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Cache-first para el shell (carga instantánea).
// Las llamadas a /api/* (la orden real) SIEMPRE van a red — nunca se cachean,
// porque un corte de motor no puede ejecutarse desde una respuesta vieja.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
