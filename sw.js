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

function networkFirst(request, url) {
  // 내비게이션 요청은 mode 가 "navigate" 라서 new Request(request, ...) 로 복제할 수 없다.
  // 그래서 URL 문자열로 새로 요청한다. cache:"no-store" 로 브라우저 HTTP 캐시까지 우회해
  // 항상 서버의 최신 HTML 을 먼저 시도한다.
  return fetch(url.href, { cache: "no-store", credentials: "same-origin" }).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); }).catch(function () {});
    }
    return response;
  }).catch(function () {
    return caches.match(request).then(function (cached) {
      if (cached) return cached;
      return caches.match("index.html").then(function (fallback) {
        if (fallback) return fallback;
        return new Response("오프라인 상태예요. 인터넷에 연결한 뒤 다시 열어 주세요.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      });
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
    event.respondWith(networkFirst(request, url));
  } else {
    event.respondWith(cacheFirstRevalidate(request));
  }
});
