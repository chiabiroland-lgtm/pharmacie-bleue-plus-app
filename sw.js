/**
 * Pharmacie Bleue Plus — Offline-First Clinical Service Worker (sw.js)
 * Branding: #1E3A8A (Navy) & #0891B2 (Clinical Cyan)
 * Compliance: Cameroon Law n° 90/035 & SOP-RH-FP-03 | Zero-Telemetry Local Vault
 * Target Environment: 3G / Offline resilience in Ngousso, Yaoundé
 */

const SHELL_CACHE_NAME = 'pbp-app-shell-v4';
const CLINICAL_CACHE_NAME = 'pbp-clinical-compendium-v3';
const CLINICAL_SNAPSHOT_URL = './offline-clinical-compendium.json';

const CORE_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './pbp-catalog.js',
  './js/supabase-bridge.js'
];

const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.17',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

// 1. INSTALL: Pre-cache App Shell & CDN dependencies with fault tolerance
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE_NAME);
      await shellCache.addAll(CORE_SHELL_ASSETS);

      // Cache external CDN assets resiliently so transient 3G hiccups never block SW installation
      await Promise.allSettled(
        CDN_ASSETS.map(async (url) => {
          try {
            const req = new Request(url, { mode: 'cors' });
            const res = await fetch(req);
            if (res && (res.ok || res.type === 'opaque')) {
              await shellCache.put(req, res);
            }
          } catch (_) {
            // Fallback to no-cors opaque caching if CORS header is absent
            try {
              const opaqueReq = new Request(url, { mode: 'no-cors' });
              const opaqueRes = await fetch(opaqueReq);
              await shellCache.put(url, opaqueRes);
            } catch (_err) {
              // Will be cached dynamically on first online fetch
            }
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

// 2. ACTIVATE: Clean up outdated caches and claim all open client tabs immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const validCaches = [SHELL_CACHE_NAME, CLINICAL_CACHE_NAME];
      const existingNames = await caches.keys();
      await Promise.all(
        existingNames.map((name) => {
          if (!validCaches.includes(name)) {
            return caches.delete(name);
          }
        })
      );
      await self.clients.claim();
    })()
  );
});

// 3. FETCH: Stale-While-Revalidate for assets & Offline-First fallback for navigation
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Serve virtual offline clinical compendium snapshot from Cache Storage
  if (url.pathname.endsWith('/offline-clinical-compendium.json') || url.pathname === '/offline-clinical-compendium.json') {
    event.respondWith(
      (async () => {
        const clinicalCache = await caches.open(CLINICAL_CACHE_NAME);
        const cached = await clinicalCache.match(CLINICAL_SNAPSHOT_URL);
        if (cached) return cached;
        return new Response(
          JSON.stringify({ status: 'initializing', pharmacy: 'Pharmacie Bleue Plus' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })()
    );
    return;
  }

  // Navigation requests (HTML pages): Network-first with instant Cache fallback for offline/3G
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const shellCache = await caches.open(SHELL_CACHE_NAME);
          shellCache.put('./index.html', networkResponse.clone());
          return networkResponse;
        } catch (_) {
          const shellCache = await caches.open(SHELL_CACHE_NAME);
          const cachedIndex = (await shellCache.match('./index.html')) || (await shellCache.match('./'));
          return cachedIndex;
        }
      })()
    );
    return;
  }

  // Static & CDN assets: Cache-First with background Stale-While-Revalidate refresh
  event.respondWith(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE_NAME);
      const cachedResponse = await shellCache.match(request, { ignoreVary: true });

      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            shellCache.put(request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => null);

      return cachedResponse || (await networkFetch) || new Response('', { status: 504, statusText: 'Offline' });
    })()
  );
});

// 4. MESSAGE: Sync Clinical Monographs, Interaction Matrices & Alarms into Cache Storage
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'SYNC_CLINICAL_CACHE' && data.payload) {
    event.waitUntil(
      (async () => {
        const clinicalCache = await caches.open(CLINICAL_CACHE_NAME);
        const response = new Response(JSON.stringify(data.payload, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Pharmacie-Bleue-Plus-Cache': 'Offline-Clinical-Vault-v1',
            'Cache-Control': 'max-age=31536000'
          }
        });
        await clinicalCache.put(CLINICAL_SNAPSHOT_URL, response);

        // Notify client tabs that Cache Storage sync succeeded
        const clientsList = await self.clients.matchAll({ type: 'window' });
        clientsList.forEach((client) => {
          client.postMessage({
            type: 'CLINICAL_CACHE_CONFIRMED',
            timestamp: new Date().toISOString(),
            counts: {
              monographs: (data.payload.monographs || []).length,
              interactions: (data.payload.interactions || []).length,
              alarms: Object.keys(data.payload.medsByProfile || {}).length
            }
          });
        });
      })()
    );
  }
});

// 5. NOTIFICATION CLICK: Focus client window and open alarm modal when patient taps notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  const doseData = event.notification.data || null;

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windowClients) {
        if ('focus' in client) {
          await client.focus();
          client.postMessage({
            type: 'NOTIFICATION_ALARM_ACTION',
            action,
            dose: doseData
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        await self.clients.openWindow('./index.html#dashboard');
      }
    })()
  );
});
