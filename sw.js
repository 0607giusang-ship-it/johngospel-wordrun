/* 말씀런 서비스워커
 *
 * 최우선 목표: **이미 홈 화면에 추가해서 쓰고 있는 사람이 다음에 열 때 자동으로 최신 버전을
 * 받는다.** 캐시에 갇혀 낡은 화면이 계속 뜨는 상황을 절대 만들지 않는다. 그래서 세 겹으로
 * 잠갔다.
 *   (1) 캐시 이름에 버전 문자열(CACHE_VERSION)을 박는다 → 배포 때 이름이 바뀌면 옛 캐시는
 *       activate 에서 통째로 삭제된다.
 *   (2) install 에서 skipWaiting(), activate 에서 clients.claim() → 새 워커가 기존 탭이
 *       전부 닫히기를 기다리지 않고 즉시 인수한다.
 *   (3) HTML(내비게이션)은 **network-first** — 캐시는 오프라인일 때만 쓰는 폴백이다.
 *       그래서 네트워크만 되면 언제나 GitHub Pages 의 최신 leader/member.html 을 본다.
 *
 * ★새 버전을 배포할 때는 아래 CACHE_VERSION 문자열을 반드시 올려라.
 *
 * 개입 범위도 좁게 잡았다 — 동일 출처(GitHub Pages) GET 만 다룬다. Firebase SDK·QR 라이브러리
 * 같은 외부 CDN 요청과 2MB짜리 데모 mp4 는 서비스워커가 아예 손대지 않고 그대로 통과시킨다
 * (기존 Firebase 실시간 동기화 경로를 건드리지 않기 위함).
 */

var CACHE_VERSION = "wr21-2026-08-17-1";
var CACHE_NAME = "wordrun-" + CACHE_VERSION;

// HTML 을 네트워크에서 기다려 주는 시간. 이 시간을 넘기면 캐시 사본으로 먼저 화면을 띄운다
// (느린 회선에서 흰 화면이 오래 남는 것을 막는다).
var NETWORK_TIMEOUT_MS = 3500;

// 오프라인 폴백용 최소 자산. 하나가 실패해도 install 이 통째로 깨지지 않도록 개별 catch 한다.
var PRECACHE_URLS = [
  "./",
  "index.html",
  "leader.html",
  "member.html",
  "manifest-leader.json",
  "manifest-member.json",
  "icons/leader-192.png",
  "icons/leader-512.png",
  "icons/member-192.png",
  "icons/member-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(PRECACHE_URLS.map(function (url) {
        return cache.add(new Request(url, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        // 이 앱이 만든 옛 버전 캐시만 지운다.
        if (name.indexOf("wordrun-") === 0 && name !== CACHE_NAME) {
          return caches.delete(name);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function offlineResponse() {
  // 캐시에도 없고 네트워크도 안 될 때. 여기서 index.html(랜딩)을 대신 내주면 안 된다 —
  // 조원이 member.html 을 열었는데 링크 4개짜리 랜딩이 200 으로 뜨는 "조용히 엉뚱한 화면"이
  // 되기 때문이다. 차라리 정직하게 오프라인이라고 알린다.
  return new Response("오프라인 상태예요. 인터넷에 연결한 뒤 다시 열어 주세요.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

function networkFirst(event, request, url) {
  // 내비게이션 요청은 mode 가 "navigate" 라서 new Request(request, ...) 로 복제할 수 없다.
  // 그래서 URL 문자열로 새로 요청한다.
  // cache:"no-cache" — 항상 서버에 물어보되 ETag/If-Modified-Since 는 살려 둔다. no-store 로
  // 막아버리면 안 바뀐 leader.html(약 96KB)·member.html(약 68KB)을 열 때마다 통째로 다시
  // 받는다. no-cache 면 안 바뀐 경우 304 로 끝나 저속망에서 크게 이득이다.
  var network = fetch(url.href, { cache: "no-cache", credentials: "same-origin" })
    .then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        // ★캐시 키에서 쿼리를 뗀다. 조원 링크는 member.html?g=..&m=.. 처럼 사람마다 다른
        // 쿼리를 달고 오는데, 그대로 키로 쓰면 조원 수만큼 같은 HTML 사본이 쌓인다.
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(url.origin + url.pathname, copy);
        }).catch(function () {});
      }
      return response;
    });

  // 네트워크가 끊긴 경우보다 **느린 경우**(모바일 데이터·교회 와이파이)가 훨씬 흔하다.
  // 거부될 때까지 기다리면 그동안 흰 화면만 보이므로, 제한 시간을 넘기면 캐시 사본으로
  // 먼저 화면을 띄운다. 네트워크 요청은 취소하지 않고 계속 살려 둬서(waitUntil) 늦게라도
  // 응답이 오면 위 then 이 캐시를 갱신한다 → 다음에 열 때 최신본이 나온다.
  var settled = network.catch(function () { return null; });
  event.waitUntil(settled);

  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, NETWORK_TIMEOUT_MS);
  });

  return Promise.race([settled, timeout]).then(function (winner) {
    if (winner) return winner;
    // ignoreSearch — 프리캐시 키에는 쿼리가 없으므로 ?g=..&m=.. 가 붙은 요청도 맞물리게 한다.
    // 이게 없으면 QR 로 들어온 조원의 폴백 조회가 항상 빗나간다.
    return caches.match(request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return settled.then(function (late) { return late || offlineResponse(); });
    });
  });
}

function cacheFirstRevalidate(request) {
  return caches.match(request).then(function (cached) {
    var network = fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); }).catch(function () {});
      }
      return response;
    }).catch(function () { return cached || Response.error(); });
    return cached || network;
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // 외부 CDN(Firebase SDK·qrcode) 은 개입하지 않는다.
  if (url.origin !== self.location.origin) return;
  // 이 앱 폴더 밖도 개입하지 않는다.
  if (url.pathname.indexOf(self.registration.scope.replace(self.location.origin, "")) !== 0) return;
  // 데모 영상(2MB×2)은 캐시 용량만 잡아먹으므로 통과시킨다.
  if (/\.mp4$/i.test(url.pathname)) return;

  // HTML 판정은 넉넉하게 잡는다. Accept 헤더만 믿으면 accept:*/* 로 들어오는 요청이
  // 자산 취급(캐시 우선)을 받아 낡은 HTML 이 나갈 수 있다 — 실측에서 확인한 구멍이다.
  // 경로가 .html 이거나 디렉터리면 무조건 network-first 로 보낸다.
  var accept = request.headers.get("accept") || "";
  var isHtml = request.mode === "navigate" ||
    accept.indexOf("text/html") !== -1 ||
    /\.html?$/i.test(url.pathname) ||
    url.pathname.charAt(url.pathname.length - 1) === "/";

  if (isHtml) {
    event.respondWith(networkFirst(event, request, url));
  } else {
    event.respondWith(cacheFirstRevalidate(request));
  }
});
