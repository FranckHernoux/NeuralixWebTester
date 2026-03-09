/**
 * Neuralix Web Tester — Service Worker
 *
 * Stratégie : Cache-first avec vérification réseau en arrière-plan.
 * À chaque nouvelle version, incrémente CACHE_VERSION pour forcer le refresh.
 */

const CACHE_VERSION = 'neuralix-v2';

const FILES_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './sidebar.js',
    './multifile.js',
    './sections.js',
    './comparative.js',
    './compute-worker.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

// Install : pré-cache tous les fichiers
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => cache.addAll(FILES_TO_CACHE))
    );
    self.skipWaiting();
});

// Activate : supprime les anciens caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// Fetch : sert depuis le cache, met à jour en arrière-plan
self.addEventListener('fetch', (event) => {
    // Ignore les requêtes non-GET et les requêtes cross-origin
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            // Lancer une mise à jour réseau en arrière-plan (stale-while-revalidate)
            const networkFetch = fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cached);

            return cached || networkFetch;
        })
    );
});

// Écouter les messages pour forcer un update
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});
