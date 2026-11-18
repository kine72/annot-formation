// Service worker : met toute l'appli en cache pour un fonctionnement 100 % hors ligne.
const VERSION = 'annotformation-v4';
const ASSETS = [
 "./",
 "app.css",
 "app.js",
 "fonts/LiberationSans-Bold.ttf",
 "fonts/LiberationSans-BoldItalic.ttf",
 "fonts/LiberationSans-Italic.ttf",
 "fonts/LiberationSans-Regular.ttf",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/icon-maskable-512.png",
 "icons/icon.svg",
 "index.html",
 "lib/pdf-lib.min.js",
 "lib/pdf.min.mjs",
 "lib/pdf.worker.min.mjs",
 "lib/standard_fonts/FoxitDingbats.pfb",
 "lib/standard_fonts/FoxitFixed.pfb",
 "lib/standard_fonts/FoxitFixedBold.pfb",
 "lib/standard_fonts/FoxitFixedBoldItalic.pfb",
 "lib/standard_fonts/FoxitFixedItalic.pfb",
 "lib/standard_fonts/FoxitSerif.pfb",
 "lib/standard_fonts/FoxitSerifBold.pfb",
 "lib/standard_fonts/FoxitSerifBoldItalic.pfb",
 "lib/standard_fonts/FoxitSerifItalic.pfb",
 "lib/standard_fonts/FoxitSymbol.pfb",
 "lib/standard_fonts/LiberationSans-Bold.ttf",
 "lib/standard_fonts/LiberationSans-BoldItalic.ttf",
 "lib/standard_fonts/LiberationSans-Italic.ttf",
 "lib/standard_fonts/LiberationSans-Regular.ttf",
 "lib/wasm/jbig2.wasm",
 "lib/wasm/jbig2_nowasm_fallback.js",
 "lib/wasm/openjpeg.wasm",
 "lib/wasm/openjpeg_nowasm_fallback.js",
 "lib/wasm/qcms_bg.wasm",
 "manifest.webmanifest"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match('./')))
  );
});
