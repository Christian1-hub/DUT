// CamunoLearn Service Worker
const CACHE_NAME = 'camunolearn-v1';
const OFFLINE_URL = '/indexAccueilPLATEFORME.html';

// Fichiers à mettre en cache pour fonctionner hors ligne
const CACHE_URLS = [
  './indexAccueilPLATEFORME.html',
  './indexconnexion.html',
  './indexInscription.html',
  './indexETUDIANT.html',
  './indexEnseignant.html',
  './indexADMIN.html',
  './indexSUPERADMIN.html',
  './indexCalendrier.html',
  './manifest.json',
];

// Installation — mise en cache des ressources essentielles
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      console.log('[SW] Cache ouvert');
      return Promise.allSettled(
        CACHE_URLS.map(url => cache.add(new Request(url, {cache: 'reload'})).catch(e => console.warn('[SW] Skip:', url, e)))
      );
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// Activation — suppression des anciens caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// Fetch — stratégie Network First, fallback cache
self.addEventListener('fetch', function(event) {
  // Ignorer les requêtes non-GET et les requêtes API
  if (event.request.method !== 'GET') return;
  if (event.request.url.includes('/api/')) return;
  if (event.request.url.includes('fonts.googleapis.com')) return;
  if (event.request.url.includes('cdn.tailwindcss.com')) return;

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Mettre en cache la réponse fraîche
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Réseau indisponible → utiliser le cache
        return caches.match(event.request).then(function(cached) {
          if (cached) return cached;
          // Page HTML non cachée → page d'accueil
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match(OFFLINE_URL);
          }
        });
      })
  );
});

// Notifications push (pour plus tard)
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'CamunoLearn', {
      body: data.body || '',
      icon: 'https://ui-avatars.com/api/?name=CL&background=00602a&color=fff&size=192',
      badge: 'https://ui-avatars.com/api/?name=CL&background=00602a&color=fff&size=96',
      data: data,
    })
  );
});