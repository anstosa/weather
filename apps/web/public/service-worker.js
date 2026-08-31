const release = "__WEATHER_ASSET_VERSION__";
const cachePrefix = "ballydidean-weather-shell-";
const shellCache = `${cachePrefix}${release}`;
const shellPaths = [
  "/",
  "/logs",
  "/map",
  "/forecast",
  "/trends",
  "/settings",
  "/manifest.webmanifest",
  "/brand/ballydidean-weather-icon-192.png",
  "/brand/ballydidean-weather-icon-512.png",
  "/brand/ballydidean-weather-icon-maskable-512.png",
  "/brand/ballydidean-weather-icon-180.png",
  "/brand/ballydidean-weather-icon-32.png",
  "/fonts/google-sans-flex-latin.woff2",
  "/fonts/material-symbols-rounded-v4.woff2",
  `/assets/${release}/styles.css`,
  `/assets/${release}/client.js`,
  `/assets/${release}/index.js`,
  `/assets/${release}/units.js`
];
const shellPathSet = new Set(shellPaths);

// cache the versioned application shell
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellCache);
    await cache.addAll(shellPaths);
    await self.skipWaiting();
  })());
});

// retire only superseded weather shells
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();

    // remove prior release caches
    for (const cacheName of cacheNames) {
      // preserve unrelated and current caches
      if (cacheName.startsWith(cachePrefix) && cacheName !== shellCache) {
        await caches.delete(cacheName);
      }
    }

    await self.clients.claim();
  })());
});

// serve the offline shell without caching weather data
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // ignore mutations
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // ignore other origins
  if (url.origin !== self.location.origin) {
    return;
  }

  // leave live weather and map data on the network path
  if (
    url.pathname === "/admin" ||
    url.pathname === "/admin/" ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/maps/")
  ) {
    return;
  }

  // refresh navigations before using the offline shell
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // intercept only known shell assets
  if (shellPathSet.has(url.pathname)) {
    event.respondWith(cacheFirstShellAsset(request));
  }
});

// update one route while retaining an offline fallback
async function networkFirstNavigation(request) {
  const cache = await caches.open(shellCache);

  try {
    const response = await fetch(request);

    // retain successful route shells
    if (response.ok) {
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    const exact = await cache.match(request);

    // prefer the requested offline route
    if (exact !== undefined) {
      return exact;
    }

    return await cache.match("/") ?? Response.error();
  }
}

// use one immutable cached shell asset
async function cacheFirstShellAsset(request) {
  const cache = await caches.open(shellCache);
  const cached = await cache.match(request);

  // reuse the release shell
  if (cached !== undefined) {
    return cached;
  }

  return fetch(request);
}
