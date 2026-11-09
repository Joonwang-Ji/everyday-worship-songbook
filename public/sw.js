// Everyday Worship Songbook — 오프라인 지원 (서비스 워커)
// - 앱 파일(화면 코드): 인터넷이 되면 항상 새것을 받고, 안 되면 저장해 둔 것을 쓴다.
// - 곡·콘티 정보: 같은 방식. 한 번 열어 본 곡/콘티는 오프라인에서도 열린다.
// - 악보 이미지: 한 번 받으면 저장해 두고 그대로 쓴다. (파일 번호가 같으면 내용도 같음)
// 로그아웃하면 앱이 이 저장소(ews-data, ews-img)를 지운다.
const VER = 'v1';
const SHELL = `ews-shell-${VER}`;
const DATA = `ews-data-${VER}`;
const IMG = `ews-img-${VER}`;
const SHELL_FILES = ['/', '/index.html', '/style.css', '/chord.js', '/files.js', '/songform.js', '/chordedit.js', '/export.js', '/vendor/pdf-lib.min.js', '/app.js', '/manifest.webmanifest', '/icon-192.png'];
const MAX_IMG = 150;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => Promise.all(SHELL_FILES.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => ![SHELL, DATA, IMG].includes(k) && /^ews-/.test(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 저장해 둔 응답임을 화면이 알 수 있게 표시(X-From-Cache)를 붙여 돌려준다. (앱의 "오프라인" 배지에 쓰임)
function markCached(res) {
  const h = new Headers(res.headers);
  h.set('X-From-Cache', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// 인터넷이 되면 새것을 받아 저장하고, 안 되거나 너무 느리면(timeout) 저장해 둔 것을 쓴다.
async function networkFirst(req, cacheName, timeoutMs, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(req)) || (fallbackUrl ? await cache.match(fallbackUrl) : null);
    if (hit) return cacheName === DATA ? markCached(hit) : hit;
    throw err;
  }
}

async function trimImages() {
  const cache = await caches.open(IMG);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_IMG; i++) await cache.delete(keys[i]);
}

async function imageCacheFirst(req) {
  const cache = await caches.open(IMG);
  // 주소 뒤의 서명(?s=…)은 시간이 지나면 바뀌므로 무시하고 파일 번호로만 찾는다.
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.status === 200) {
    await cache.put(req, res.clone()).catch(() => {});
    trimImages().catch(() => {});
  }
  return res;
}

const DATA_PATHS = [/^\/api\/songs\/\d+$/, /^\/api\/setlists$/, /^\/api\/setlists\/\d+$/, /^\/api\/me$/, /^\/api\/tags$/, /^\/api\/team$/];

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;

  if (/^\/api\/files\/\d+$/.test(p)) {
    e.respondWith(imageCacheFirst(req));
    return;
  }
  if (p.startsWith('/api/')) {
    if (DATA_PATHS.some((re) => re.test(p))) e.respondWith(networkFirst(req, DATA, 6000));
    return; // 그 밖의 API(로그인·관리자·검색 목록 등)는 저장하지 않는다
  }
  // 앱 화면 파일
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, SHELL, 4000, '/index.html'));
    return;
  }
  if (SHELL_FILES.includes(p) || p === '/sw.js') {
    e.respondWith(networkFirst(req, SHELL, 4000));
  }
});
