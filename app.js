/* ============================================================
   점심 뭐먹지 — app.js
   - 카카오 로컬(장소 검색) API로 내 주변 음식점 수집
   - 카테고리별 목록 / 슬롯머신 뽑기 / 즐겨찾기 (localStorage)
   ============================================================ */
(function () {
  'use strict';

  // ---------- 상수 ----------
  var CATS = [
    { key: '한식', emoji: '🍚' },
    { key: '중식', emoji: '🥟' },
    { key: '일식', emoji: '🍣' },
    { key: '양식', emoji: '🍝' },
    { key: '분식', emoji: '🍢' },
    { key: '아시안', emoji: '🍜' },
    { key: '패스트푸드', emoji: '🍔' },
    { key: '기타', emoji: '🍽️' }
  ];
  var CAT_EMOJI = {};
  CATS.forEach(function (c) { CAT_EMOJI[c.key] = c.emoji; });
  // 카카오 category_name 2단계 → 앱 카테고리
  var CAT_MAP = {
    '한식': '한식', '중식': '중식', '일식': '일식', '양식': '양식', '분식': '분식',
    '아시아음식': '아시안', '패스트푸드': '패스트푸드', '치킨': '패스트푸드'
  };
  var RECENT_DAYS = 7;
  var WALK_M_PER_MIN = 67;
  var DEMO = /[?&]demo\b/.test(location.search);

  // ---------- 저장소 ----------
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('lunch.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('lunch.' + k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ }
    }
  };

  // ---------- 상태 ----------
  var state = {
    tab: 'list',
    center: null,
    regionName: '',
    radius: store.get('radius', 500),
    src: store.get('src', 'gps'),
    office: store.get('office', null),
    places: [],
    loading: false,
    error: null,
    activeCat: '전체',
    favs: store.get('favs', {}),
    visits: store.get('visits', {}),
    exclude: store.get('exclude', []),
    favOnly: store.get('favOnly', false),
    skipRecent: store.get('skipRecent', true),
    spinning: false,
    lastPick: null
  };

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    title: $('pageTitle'), refresh: $('refreshBtn'), locBar: $('locBar'), locText: $('locText'), radiusText: $('radiusText'),
    chips: $('chips'), listMeta: $('listMeta'), placeList: $('placeList'), favList: $('favList'),
    spinBtn: $('spinBtn'), spinLabel: $('spinLabel'), result: $('result'),
    excludeChips: $('excludeChips'), optFavOnly: $('optFavOnly'), optRecent: $('optRecent'), candidateCount: $('candidateCount'),
    sheet: $('sheet'), srcSeg: $('srcSeg'), radiusSeg: $('radiusSeg'), saveOfficeBtn: $('saveOfficeBtn'), officeHint: $('officeHint'),
    addrForm: $('addrForm'), addrInput: $('addrInput'), addrResults: $('addrResults'),
    toast: $('toast'), reels: [$('reel0'), $('reel1'), $('reel2')]
  };

  // ---------- 유틸 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function distM(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + 'km' : m + 'm'; }
  function walkMin(m) { return Math.max(1, Math.round(m / WALK_M_PER_MIN)); }
  function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function daysAgo(ts) { return Math.floor((Date.now() - ts) / 86400000); }
  function isRecent(id) { var t = state.visits[id]; return t && daysAgo(t) < RECENT_DAYS; }
  function withDist(p) {
    if (state.center) p.dist = distM(state.center, p);
    return p;
  }

  var toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 2200);
  }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 미지원 */ } }

  // 카카오 장소 → 앱 데이터
  function toPlace(d) {
    var parts = (d.category_name || '').split(' > ');
    var main = parts[1] || '기타';
    var cat = CAT_MAP[main] || '기타';
    var sub = parts[2] || main;
    return {
      id: d.id, name: d.place_name, cat: cat, sub: sub, catRaw: d.category_name,
      addr: d.road_address_name || d.address_name, phone: d.phone, url: d.place_url,
      lat: parseFloat(d.y), lng: parseFloat(d.x)
    };
  }

  // ---------- 카카오 SDK ----------
  var kakaoReady = null;
  function loadKakao() {
    if (kakaoReady) return kakaoReady;
    kakaoReady = new Promise(function (resolve, reject) {
      if (typeof KAKAO_JS_KEY === 'undefined' || !KAKAO_JS_KEY) { reject(new Error('NO_KEY')); return; }
      var s = document.createElement('script');
      s.src = 'https://dapi.kakao.com/v2/maps/sdk.js?autoload=false&libraries=services&appkey=' + encodeURIComponent(KAKAO_JS_KEY);
      s.onload = function () {
        if (!window.kakao || !kakao.maps) { reject(new Error('SDK')); return; }
        kakao.maps.load(function () { resolve(kakao); });
      };
      s.onerror = function () { reject(new Error('SDK')); };
      document.head.appendChild(s);
    });
    kakaoReady.catch(function () { kakaoReady = null; });
    return kakaoReady;
  }

  // 사각형 영역 음식점(FD6) 검색. 결과가 45개(API 한도)를 넘으면 4등분해서 다시 검색
  function searchRect(ps, sw, ne, depth, out) {
    function page(n) {
      return new Promise(function (resolve, reject) {
        ps.categorySearch('FD6', function (data, status, pg) {
          var S = kakao.maps.services.Status;
          if (status === S.OK) resolve({ data: data, pg: pg });
          else if (status === S.ZERO_RESULT) resolve({ data: [], pg: null });
          else reject(new Error('SEARCH'));
        }, { bounds: new kakao.maps.LatLngBounds(new kakao.maps.LatLng(sw.lat, sw.lng), new kakao.maps.LatLng(ne.lat, ne.lng)), page: n, size: 15 });
      });
    }
    return page(1).then(function (r) {
      r.data.forEach(function (d) { out[d.id] = d; });
      if (!r.pg) return;
      if (r.pg.totalCount > 45 && depth < 2) {
        var mid = { lat: (sw.lat + ne.lat) / 2, lng: (sw.lng + ne.lng) / 2 };
        return Promise.all([
          searchRect(ps, sw, mid, depth + 1, out),
          searchRect(ps, { lat: sw.lat, lng: mid.lng }, { lat: mid.lat, lng: ne.lng }, depth + 1, out),
          searchRect(ps, { lat: mid.lat, lng: sw.lng }, { lat: ne.lat, lng: mid.lng }, depth + 1, out),
          searchRect(ps, mid, ne, depth + 1, out)
        ]);
      }
      var rest = [];
      for (var n = 2; n <= Math.min(3, r.pg.last); n++) rest.push(page(n));
      return Promise.all(rest).then(function (rs) {
        rs.forEach(function (x) { x.data.forEach(function (d) { out[d.id] = d; }); });
      });
    });
  }

  function searchNearby(center, radius) {
    if (DEMO) return Promise.resolve(demoPlaces(center, radius));
    return loadKakao().then(function () {
      var ps = new kakao.maps.services.Places();
      var dLat = radius / 111320;
      var dLng = radius / (111320 * Math.cos(center.lat * Math.PI / 180));
      var out = {};
      return searchRect(ps, { lat: center.lat - dLat, lng: center.lng - dLng }, { lat: center.lat + dLat, lng: center.lng + dLng }, 0, out)
        .then(function () {
          return Object.keys(out).map(function (id) { return toPlace(out[id]); });
        });
    }).then(function (list) {
      return list.map(function (p) { p.dist = distM(center, p); return p; })
        .filter(function (p) { return p.dist <= radius; })
        .sort(function (a, b) { return a.dist - b.dist; });
    });
  }

  function regionName(center) {
    if (DEMO) return Promise.resolve('데모 지역');
    return loadKakao().then(function () {
      return new Promise(function (resolve) {
        new kakao.maps.services.Geocoder().coord2RegionCode(center.lng, center.lat, function (res, status) {
          if (status === kakao.maps.services.Status.OK && res.length) {
            var r = res.filter(function (x) { return x.region_type === 'H'; })[0] || res[0];
            resolve(r.region_3depth_name || r.region_2depth_name || '');
          } else resolve('');
        });
      });
    }).catch(function () { return ''; });
  }

  function getGps() {
    return new Promise(function (resolve, reject) {
      if (!window.isSecureContext) { reject(new Error('GEO_INSECURE')); return; }
      if (!navigator.geolocation) { reject(new Error('NO_GEO')); return; }
      function ask(high, timeout, onFail) {
        navigator.geolocation.getCurrentPosition(function (pos) {
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        }, function (err) {
          if (err && err.code === 1) reject(new Error('GEO_DENIED'));
          else if (onFail) onFail();
          else reject(new Error('GEO_FAIL'));
        }, { enableHighAccuracy: high, timeout: timeout, maximumAge: 120000 });
      }
      // 실내에서 정밀 위치가 안 잡히면 대략적인 위치로 한 번 더 시도
      ask(true, 10000, function () { ask(false, 15000); });
    });
  }

  // ---------- 데이터 로드 ----------
  function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    els.refresh.classList.add('is-spinning');
    renderLoc();
    renderList();

    var getCenter = state.src === 'office' && state.office
      ? Promise.resolve(state.office)
      : getGps().catch(function (e) {
          // GPS 실패 시 저장된 회사 위치가 있으면 그걸로 대신 검색
          if (!state.office) throw e;
          toast('현재 위치를 못 받아서 회사 위치로 찾았어요');
          state.src = 'office';
          store.set('src', 'office');
          return state.office;
        });

    getCenter.then(function (c) {
      state.center = c;
      regionName(c).then(function (n) { state.regionName = n; renderLoc(); });
      return searchNearby(c, state.radius);
    }).then(function (list) {
      state.places = list;
    }).catch(function (e) {
      state.error = e.message || 'UNKNOWN';
      state.places = [];
    }).then(function () {
      state.loading = false;
      els.refresh.classList.remove('is-spinning');
      renderAll();
    });
  }

  // ---------- 렌더: 상단 ----------
  function renderLoc() {
    var src = state.src === 'office' && state.office ? (state.office.name ? '회사(' + state.office.name + ')' : '회사') : '현재 위치';
    var txt = state.loading && !state.center ? '위치 확인 중…' : src + (state.regionName ? ' · ' + state.regionName : '');
    els.locText.textContent = txt;
    els.radiusText.textContent = fmtDist(state.radius);
  }

  // ---------- 렌더: 근처 맛집 ----------
  function counts() {
    var c = { '전체': state.places.length };
    state.places.forEach(function (p) { c[p.cat] = (c[p.cat] || 0) + 1; });
    return c;
  }

  function renderChips() {
    var c = counts();
    var keys = ['전체'].concat(CATS.map(function (x) { return x.key; }));
    els.chips.innerHTML = keys.map(function (k) {
      var n = c[k] || 0;
      if (k !== '전체' && !n && !state.loading) return '';
      return '<button type="button" class="chip" data-cat="' + k + '" aria-pressed="' + (state.activeCat === k) + '">' +
        (CAT_EMOJI[k] ? CAT_EMOJI[k] + ' ' : '') + k + (state.loading ? '' : '<small>' + n + '</small>') + '</button>';
    }).join('');
  }

  function placeItem(p) {
    var fav = !!state.favs[p.id];
    var visited = state.visits[p.id];
    var vTxt = visited ? (daysAgo(visited) === 0 ? '오늘 방문' : daysAgo(visited) + '일 전') : '';
    return '<li class="place"><span class="place__thumb" aria-hidden="true">' + (CAT_EMOJI[p.cat] || '🍽️') + '</span>' +
      '<a class="place__link" href="' + esc(p.url) + '" target="_blank" rel="noopener">' +
        '<span class="place__name">' + esc(p.name) + (vTxt ? '<span class="place__visited">' + vTxt + '</span>' : '') + '</span>' +
        '<span class="place__meta"><span>' + esc(p.cat) + ' · ' + esc(p.sub) + '</span>' +
          (p.dist != null ? '<span class="place__dist">' + fmtDist(p.dist) + ' · 도보 ' + walkMin(p.dist) + '분</span>' : '') + '</span>' +
        '<span class="place__addr">' + esc(p.addr) + '</span>' +
      '</a>' +
      '<button type="button" class="fav-btn" data-fav="' + esc(p.id) + '" aria-pressed="' + fav + '" aria-label="' + (fav ? '즐겨찾기 해제' : '즐겨찾기') + '">' +
        '<span class="icon icon-md icon-star"></span></button>' +
    '</li>';
  }

  function emptyHtml(icon, title, desc, btns) {
    btns = btns ? [].concat(btns) : [];
    return '<li class="empty"><span class="icon icon-xl ' + icon + '"></span><strong>' + title + '</strong><span>' + desc + '</span>' +
      btns.map(function (b, i) {
        return '<button type="button" class="btn ' + (i === 0 && btns.length > 1 ? 'btn--primary' : 'btn--ghost') + '" data-action="' + b.action + '">' + b.label + '</button>';
      }).join('') + '</li>';
  }

  var ADDR_BTN = { action: 'addr', label: '회사 주소로 위치 정하기' };
  var RETRY_BTN = { action: 'retry', label: '위치 다시 요청' };
  function errorHtml() {
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    switch (state.error) {
      case 'GEO_DENIED':
        return emptyHtml('icon-map-pin', '위치 권한이 막혀 있어요',
          (ios
            ? '아이폰 설정 → 앱 → Safari → 위치를 "묻기"로,<br>설정 → 개인정보 보호 및 보안 → 위치 서비스 → Safari 웹사이트를 "앱을 사용하는 동안"으로 바꿔주세요.'
            : '브라우저 설정에서 이 사이트의 위치 권한을 허용해 주세요.') +
          '<br><br>권한 없이 쓰려면 회사 주소로 위치를 정해두세요.', [ADDR_BTN, RETRY_BTN]);
      case 'GEO_FAIL': case 'NO_GEO':
        return emptyHtml('icon-map-pin', '위치를 찾지 못했어요', '실내에서는 위치가 잘 안 잡힐 수 있어요.<br>회사 주소로 위치를 정해두면 바로 쓸 수 있어요.', [ADDR_BTN, RETRY_BTN]);
      case 'GEO_INSECURE':
        return emptyHtml('icon-map-pin', 'https 주소에서만 위치를 쓸 수 있어요', 'https:// 로 시작하는 주소로 접속하거나, 회사 주소로 위치를 정해주세요.', [ADDR_BTN]);
      case 'NO_KEY': case 'SDK': case 'SEARCH':
        return emptyHtml('icon-alert-triangle', '카카오 지도에 연결하지 못했어요', 'config.js의 키, 카카오맵 사용 설정(ON), 이 사이트 주소가 Web 도메인에 등록됐는지 확인해 주세요.', { action: 'retry', label: '다시 시도' });
      default:
        return emptyHtml('icon-alert-circle', '문제가 생겼어요', '잠시 후 다시 시도해 주세요.', { action: 'retry', label: '다시 시도' });
    }
  }

  function renderList() {
    renderChips();
    if (state.loading) {
      els.listMeta.textContent = '근처 음식점을 찾는 중…';
      els.placeList.innerHTML = Array(6).join('<li class="skeleton"></li>') + '<li class="skeleton"></li>';
      return;
    }
    if (state.error) { els.listMeta.textContent = ''; els.placeList.innerHTML = errorHtml(); return; }
    var list = state.activeCat === '전체' ? state.places : state.places.filter(function (p) { return p.cat === state.activeCat; });
    els.listMeta.textContent = '반경 ' + fmtDist(state.radius) + ' 안에 ' + list.length + '곳 · 가까운 순';
    els.placeList.innerHTML = list.length
      ? list.map(placeItem).join('')
      : emptyHtml('icon-search', '음식점이 없어요', '반경을 넓혀보세요.', { action: 'sheet', label: '반경 바꾸기' });
  }

  // ---------- 렌더: 즐겨찾기 ----------
  function renderFavs() {
    var list = Object.keys(state.favs).map(function (id) { return withDist(state.favs[id]); })
      .sort(function (a, b) { return (a.dist || 0) - (b.dist || 0); });
    els.favList.innerHTML = list.length
      ? list.map(placeItem).join('')
      : emptyHtml('icon-star', '즐겨찾기가 비어 있어요', '자주 가는 가게의 별을 눌러 모아보세요.<br>뽑기에서 "즐겨찾기한 곳만" 돌릴 수도 있어요.');
  }

  // ---------- 렌더: 슬롯 ----------
  function candidates() {
    var pool = state.favOnly
      ? Object.keys(state.favs).map(function (id) { return withDist(state.favs[id]); })
      : state.places;
    return pool.filter(function (p) {
      if (state.exclude.indexOf(p.cat) >= 0) return false;
      if (state.skipRecent && isRecent(p.id)) return false;
      return true;
    });
  }

  function renderSlotOpts() {
    var c = counts();
    els.excludeChips.innerHTML = CATS.map(function (x) {
      var off = state.exclude.indexOf(x.key) >= 0;
      return '<button type="button" class="chip chip--off" data-ex="' + x.key + '" aria-pressed="' + off + '">' +
        x.emoji + ' ' + x.key + '<small>' + (c[x.key] || 0) + '</small></button>';
    }).join('');
    els.optFavOnly.checked = state.favOnly;
    els.optRecent.checked = state.skipRecent;
    var n = candidates().length;
    els.candidateCount.textContent = state.loading ? '불러오는 중' : '후보 ' + n + '곳';
    els.spinBtn.disabled = state.spinning || state.loading;
  }

  function reelItem(html, cls) { return '<div class="reel__item' + (cls ? ' ' + cls : '') + '">' + html + '</div>'; }

  function resetReels() {
    els.reels.forEach(function (r) { r.innerHTML = reelItem('?', 'reel__item--q'); r.style.transition = 'none'; r.style.transform = 'none'; });
  }

  function spin() {
    if (state.spinning) return;
    var pool = candidates();
    if (!pool.length) {
      toast(state.places.length || state.favOnly ? '조건에 맞는 가게가 없어요. 옵션을 바꿔보세요.' : '근처 음식점을 아직 못 불러왔어요.');
      return;
    }
    var pick = rand(pool);
    state.spinning = true;
    state.lastPick = pick;
    els.result.hidden = true;
    els.spinBtn.disabled = true;
    vibrate(20);

    var cats = pool.map(function (p) { return p.cat; });
    var subs = pool.map(function (p) { return p.sub; });
    var names = pool.map(function (p) { return p.name; });
    var finals = [
      reelItem('<span class="emoji">' + CAT_EMOJI[pick.cat] + '</span>' + esc(pick.cat)),
      reelItem(esc(pick.sub)),
      reelItem(esc(pick.name))
    ];
    var sources = [
      function () { var c = rand(cats); return reelItem('<span class="emoji">' + CAT_EMOJI[c] + '</span>' + esc(c)); },
      function () { return reelItem(esc(rand(subs))); },
      function () { return reelItem(esc(rand(names))); }
    ];
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var h = els.reels[0].parentNode.offsetHeight;
    var done = 0;

    els.reels.forEach(function (strip, i) {
      var n = 18 + i * 8;
      var html = '';
      for (var k = 0; k < n; k++) html += sources[i]();
      strip.innerHTML = html + finals[i];
      strip.parentNode.classList.remove('is-stopped');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      void strip.offsetHeight; // reflow
      var dur = reduced ? 1 : 1500 + i * 700;
      strip.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.15, 0.85, 0.25, 1)';
      strip.style.transform = 'translateY(' + (-n * h) + 'px)';
      setTimeout(function () {
        strip.parentNode.classList.add('is-stopped');
        vibrate(i === 2 ? [40, 40, 80] : 25);
        done++;
        if (done === 3) finishSpin();
      }, dur);
    });
  }

  function finishSpin() {
    state.spinning = false;
    els.spinLabel.textContent = '다시 돌리기';
    renderResult();
    renderSlotOpts();
  }

  function renderResult() {
    var p = state.lastPick;
    if (!p) { els.result.hidden = true; return; }
    var fav = !!state.favs[p.id];
    var going = state.visits[p.id] && daysAgo(state.visits[p.id]) === 0;
    els.result.innerHTML =
      '<p class="result__badge">🎉 오늘의 점심은</p>' +
      '<p class="result__name">' + esc(p.name) + '</p>' +
      '<p class="result__meta">' + esc(p.cat) + ' · ' + esc(p.sub) +
        (p.dist != null ? ' · 도보 ' + walkMin(p.dist) + '분 (' + fmtDist(p.dist) + ')' : '') + '</p>' +
      '<div class="result__actions">' +
        '<a class="btn btn--ghost" href="' + esc(p.url) + '" target="_blank" rel="noopener"><span class="icon icon-xs icon-external-link"></span>카카오맵</a>' +
        '<button type="button" class="btn btn--ghost" data-fav="' + esc(p.id) + '" aria-pressed="' + fav + '"><span class="icon icon-xs icon-star"></span>' + (fav ? '즐겨찾기됨' : '즐겨찾기') + '</button>' +
        '<button type="button" class="btn btn--primary btn--full" data-action="go"' + (going ? ' disabled' : '') + '>' +
          '<span class="icon icon-xs icon-check"></span>' + (going ? '오늘 여기 가기로 했어요' : '여기 갈게요!') + '</button>' +
      '</div>';
    els.result.hidden = false;
  }

  // ---------- 탭 ----------
  var TITLES = { list: '근처 맛집', slot: '점심 슬롯머신', fav: '즐겨찾기' };
  function setTab(t) {
    state.tab = t;
    document.querySelectorAll('.tabbar__item').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === t));
    });
    ['list', 'slot', 'fav'].forEach(function (k) { $('panel-' + k).hidden = k !== t; });
    els.title.textContent = TITLES[t];
    if (t === 'fav') renderFavs();
    if (t === 'slot') renderSlotOpts();
    window.scrollTo(0, 0);
  }

  // ---------- 시트 ----------
  function renderSheet() {
    els.srcSeg.querySelectorAll('button').forEach(function (b) {
      var s = b.getAttribute('data-src');
      b.setAttribute('aria-pressed', String(state.src === s));
      if (s === 'office') b.disabled = !state.office;
    });
    els.radiusSeg.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(+b.getAttribute('data-r') === state.radius));
    });
    els.officeHint.textContent = state.office
      ? '회사 위치가 저장돼 있어요' + (state.office.name ? ' (' + state.office.name + ')' : '') + '. 바꾸려면 다시 검색하세요.'
      : '회사 위치를 한 번 정해두면 위치 권한 없이도 회사 기준으로 찾아줘요.';
  }
  function openSheet() { renderSheet(); els.sheet.hidden = false; }
  function closeSheet() { els.sheet.hidden = true; }

  // ---------- 즐겨찾기/방문 ----------
  function findPlace(id) {
    if (state.favs[id]) return state.favs[id];
    for (var i = 0; i < state.places.length; i++) if (state.places[i].id === id) return state.places[i];
    return state.lastPick && state.lastPick.id === id ? state.lastPick : null;
  }
  function toggleFav(id) {
    if (state.favs[id]) { delete state.favs[id]; toast('즐겨찾기에서 뺐어요'); }
    else {
      var p = findPlace(id); if (!p) return;
      state.favs[id] = { id: p.id, name: p.name, cat: p.cat, sub: p.sub, catRaw: p.catRaw, addr: p.addr, phone: p.phone, url: p.url, lat: p.lat, lng: p.lng };
      toast('⭐ 즐겨찾기에 추가했어요');
      vibrate(15);
    }
    store.set('favs', state.favs);
    renderAll();
  }

  function renderAll() {
    renderLoc();
    renderList();
    renderSlotOpts();
    if (state.tab === 'fav') renderFavs();
    if (!state.spinning && state.lastPick) renderResult();
  }

  // ---------- 이벤트 ----------
  document.querySelector('.tabbar').addEventListener('click', function (e) {
    var b = e.target.closest('[data-tab]'); if (b) setTab(b.getAttribute('data-tab'));
  });
  els.chips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cat]'); if (!b) return;
    state.activeCat = b.getAttribute('data-cat');
    renderList();
  });
  els.excludeChips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ex]'); if (!b) return;
    var k = b.getAttribute('data-ex'), i = state.exclude.indexOf(k);
    if (i >= 0) state.exclude.splice(i, 1); else state.exclude.push(k);
    store.set('exclude', state.exclude);
    renderSlotOpts();
  });
  els.optFavOnly.addEventListener('change', function () { state.favOnly = this.checked; store.set('favOnly', state.favOnly); renderSlotOpts(); });
  els.optRecent.addEventListener('change', function () { state.skipRecent = this.checked; store.set('skipRecent', state.skipRecent); renderSlotOpts(); });
  els.spinBtn.addEventListener('click', spin);
  els.refresh.addEventListener('click', load);
  els.locBar.addEventListener('click', openSheet);

  // 목록/결과 안의 버튼들 (위임)
  document.addEventListener('click', function (e) {
    var f = e.target.closest('[data-fav]');
    if (f) { e.preventDefault(); toggleFav(f.getAttribute('data-fav')); return; }
    var a = e.target.closest('[data-action]');
    if (!a) return;
    var act = a.getAttribute('data-action');
    if (act === 'retry') load();
    else if (act === 'sheet') openSheet();
    else if (act === 'addr') { openSheet(); setTimeout(function () { els.addrInput.focus(); }, 350); }
    else if (act === 'go' && state.lastPick) {
      state.visits[state.lastPick.id] = Date.now();
      store.set('visits', state.visits);
      toast('맛있게 드세요! 🍽️ 일주일 동안은 뽑기에서 빠져요');
      renderAll();
    }
  });

  els.sheet.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    var s = e.target.closest('[data-src]');
    if (s && !s.disabled) {
      var v = s.getAttribute('data-src');
      if (v !== state.src) { state.src = v; store.set('src', v); state.regionName = ''; state.center = null; renderSheet(); load(); }
      return;
    }
    var ad = e.target.closest('[data-addr]');
    if (ad) {
      var hit = addrHits[+ad.getAttribute('data-addr')];
      setOffice({ lat: hit.lat, lng: hit.lng, name: hit.name });
      els.addrResults.innerHTML = '';
      els.addrInput.value = '';
      closeSheet();
      return;
    }
    var r = e.target.closest('[data-r]');
    if (r) {
      var rv = +r.getAttribute('data-r');
      if (rv !== state.radius) { state.radius = rv; store.set('radius', rv); renderSheet(); load(); }
    }
  });
  els.saveOfficeBtn.addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    getGps().then(function (c) {
      setOffice(c);
    }).catch(function () {
      toast('위치를 가져오지 못했어요. 아래에서 회사 주소를 검색해 보세요.');
      els.addrInput.focus();
    }).then(function () { btn.disabled = false; });
  });

  function setOffice(c) {
    state.office = c;
    store.set('office', c);
    state.src = 'office';
    store.set('src', 'office');
    state.center = null;
    state.regionName = '';
    renderSheet();
    toast('📍 회사 위치를 저장했어요');
    load();
  }

  // 회사 이름/주소 검색 → 회사 위치로 저장 (GPS 불필요)
  var addrHits = [];
  els.addrForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = els.addrInput.value.trim();
    if (!q) return;
    els.addrInput.blur();
    els.addrResults.innerHTML = '<li class="addr-results__msg">검색 중…</li>';
    searchAddr(q).then(function (hits) {
      addrHits = hits;
      els.addrResults.innerHTML = hits.length
        ? hits.map(function (h, i) {
            return '<li><button type="button" data-addr="' + i + '"><strong>' + esc(h.name) + '</strong><span>' + esc(h.addr) + '</span></button></li>';
          }).join('')
        : '<li class="addr-results__msg">검색 결과가 없어요. 건물 이름이나 도로명 주소로 다시 검색해 보세요.</li>';
    }).catch(function () {
      els.addrResults.innerHTML = '<li class="addr-results__msg">카카오 지도에 연결하지 못했어요. 카카오 개발자 사이트의 도메인 등록을 확인해 주세요.</li>';
    });
  });

  function searchAddr(q) {
    if (DEMO) return Promise.resolve([{ name: q + ' (데모)', addr: '데모시 데모구', lat: 37.5663, lng: 126.9779 }]);
    return loadKakao().then(function () {
      var S = kakao.maps.services.Status;
      var kw = new Promise(function (resolve) {
        new kakao.maps.services.Places().keywordSearch(q, function (data, status) {
          resolve(status === S.OK ? data.map(function (d) {
            return { name: d.place_name, addr: d.road_address_name || d.address_name, lat: +d.y, lng: +d.x };
          }) : []);
        }, { size: 6 });
      });
      var ad = new Promise(function (resolve) {
        new kakao.maps.services.Geocoder().addressSearch(q, function (data, status) {
          resolve(status === S.OK ? data.slice(0, 3).map(function (d) {
            return { name: d.address_name, addr: (d.road_address && d.road_address.building_name) || '주소', lat: +d.y, lng: +d.x };
          }) : []);
        });
      });
      return Promise.all([ad, kw]).then(function (r) { return r[0].concat(r[1]); });
    });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !els.sheet.hidden) closeSheet(); });

  // 헤더 높이 → 카테고리 칩 sticky 위치
  var header = document.querySelector('.app-header');
  function syncHeader() { document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px'); }
  if (window.ResizeObserver) new ResizeObserver(syncHeader).observe(header);
  syncHeader();

  // ---------- 데모 데이터 (?demo) ----------
  function demoPlaces(center, radius) {
    var sample = [
      ['한식', '순대국'], ['한식', '김치찌개'], ['한식', '국밥'], ['한식', '한정식'], ['한식', '냉면'], ['한식', '삼겹살'],
      ['중식', '중화요리'], ['중식', '마라탕'], ['일식', '라멘'], ['일식', '돈까스'], ['일식', '초밥,롤'], ['일식', '우동,소바'],
      ['양식', '파스타'], ['양식', '피자'], ['양식', '햄버거'], ['분식', '김밥'], ['분식', '떡볶이'],
      ['아시안', '쌀국수'], ['아시안', '태국음식'], ['패스트푸드', '버거'], ['기타', '샐러드']
    ];
    var out = [];
    for (var i = 0; i < 40; i++) {
      var s = sample[i % sample.length];
      var ang = Math.random() * Math.PI * 2, r = Math.random() * radius;
      var lat = center.lat + (r * Math.cos(ang)) / 111320;
      var lng = center.lng + (r * Math.sin(ang)) / (111320 * Math.cos(center.lat * Math.PI / 180));
      var p = { id: 'demo' + i, name: s[1] + ' ' + (i + 1) + '호점', cat: s[0], sub: s[1], catRaw: '음식점 > ' + s[0] + ' > ' + s[1],
        addr: '데모시 데모구 맛집로 ' + (i + 1), phone: '', url: 'https://map.kakao.com/', lat: lat, lng: lng };
      p.dist = distM(center, p);
      out.push(p);
    }
    return out.sort(function (a, b) { return a.dist - b.dist; });
  }

  // ---------- 시작 ----------
  resetReels();
  renderAll();
  load();

  // 앱처럼 설치 (홈 화면에 추가)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
})();
