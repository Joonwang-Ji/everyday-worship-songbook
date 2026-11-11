// Everyday Worship Songbook — 화면 (1차: 접속암호, 곡 목록/보기/편집, 이조 · 2차: 팀, 콘티, 관리자)
(function () {
  const $app = document.getElementById('app');
  const $top = document.getElementById('top');
  const $nav = document.getElementById('nav');
  const $toast = document.getElementById('toast');
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

  let me = { canEdit: false, adminRequired: false, isAdmin: false, team: null, inviteEnabled: false };
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($toast.hidden = true), 2600);
  }

  // ---------- 가입한 팀들 (9차: 팀 전환) ----------
  // 이 기기에 가입한 팀을 모두 기억해 두고(ews_teams), 그중 하나를 "지금 보는 팀"(ews_team_active)으로 쓴다.
  // 팀마다 팀원 열쇠(team)와 팀장 열쇠(leader)가 따로 저장된다. stale=true는 가입코드가 바뀌는 등으로 열쇠가 더 이상 안 통하는 팀.
  function teamsGet() {
    try {
      const a = JSON.parse(ls.get('ews_teams', '[]'));
      return Array.isArray(a) ? a.filter((x) => x && typeof x.team === 'string' && x.team) : [];
    } catch { return []; }
  }
  const teamsSet = (a) => ls.set('ews_teams', JSON.stringify(a));
  const activeIdGet = () => parseInt(ls.get('ews_team_active', ''), 10);
  function activeTeam() {
    const id = activeIdGet();
    return teamsGet().find((x) => x.id === id && !x.stale) || null;
  }
  // 지금 보는 팀이 없는데 쓸 수 있는 팀이 있으면 첫 번째 팀을 고른다.
  function ensureActive() {
    if (activeTeam()) return;
    const f = teamsGet().find((x) => !x.stale);
    if (f) ls.set('ews_team_active', String(f.id));
    else ls.del('ews_team_active');
  }
  // 팀에 가입했거나 만들었을 때: 목록에 넣고(같은 팀이면 열쇠만 갱신) 그 팀을 지금 보는 팀으로.
  function addTeam(team, teamToken, leaderToken) {
    const a = teamsGet();
    const old = a.find((x) => x.id === team.id);
    const rest = a.filter((x) => x.id !== team.id);
    rest.push({ id: team.id, name: team.name, team: teamToken, leader: leaderToken != null ? leaderToken : old && !old.stale ? old.leader || '' : '' });
    teamsSet(rest);
    ls.set('ews_team_active', String(team.id));
  }
  function updateActive(fn) {
    const id = activeIdGet();
    const a = teamsGet();
    const t = a.find((x) => x.id === id);
    if (!t) return;
    fn(t);
    teamsSet(a);
  }
  const setActiveLeader = (tok) => updateActive((t) => { t.leader = tok || ''; });
  const setActiveTeamToken = (tok) => updateActive((t) => { t.team = tok; t.stale = false; });
  function clearAllLeaders() {
    teamsSet(teamsGet().map((t) => ({ ...t, leader: '' })));
  }
  // 이 기기에서 이 팀을 지운다. 그 팀 때문에 저장해 둔 오프라인 자료도 함께 지운다.
  function removeTeam(id) {
    teamsSet(teamsGet().filter((x) => x.id !== id));
    purgeTeamCache(id);
    ensureActive();
  }
  // 예전(9차 이전)에는 팀 열쇠를 하나만 저장했다. 한 번만 새 방식으로 옮긴다 (팀 번호·이름은 /me가 알려 주면 채움).
  function migrateLegacy() {
    const old = ls.get('ews_team', '');
    if (old && !teamsGet().length) {
      teamsSet([{ id: 0, name: '', team: old, leader: ls.get('ews_leader', '') }]);
      ls.set('ews_team_active', '0');
    }
    ls.del('ews_team');
    ls.del('ews_leader');
  }
  // 오프라인용 저장본은 주소 기준이라, 요청에 팀 번호(_t)를 붙여 팀마다 따로 저장되게 한다. 팀을 나가면 그 팀 것만 지운다.
  function purgeTeamCache(id) {
    try {
      if (!window.caches) return;
      caches.keys().then((ks) => ks.filter((k) => k.startsWith('ews-data')).forEach((k) => caches.open(k).then((c) => c.keys().then((rs) => rs.forEach((r) => { try { if (new URL(r.url).searchParams.get('_t') === String(id)) c.delete(r); } catch {} })))));
    } catch {}
  }

  // ---------- API ----------
  // 이 기기에 저장된 열쇠들(접속암호·관리자·지금 보는 팀의 팀원/팀장)을 요청마다 함께 보낸다.
  function authHeaders() {
    const h = {};
    const t = ls.get('ews_token', '');
    if (t) h.Authorization = 'Bearer ' + t;
    const a = ls.get('ews_admin', '');
    if (a) h['X-Admin-Token'] = a;
    const tm = activeTeam();
    if (tm) {
      h['X-Team-Token'] = tm.team;
      if (tm.leader) h['X-Leader-Token'] = tm.leader;
    }
    return h;
  }
  function clearSession() {
    meAt = 0;
    ['ews_token', 'ews_admin', 'ews_teams', 'ews_team_active', 'ews_team', 'ews_leader', 'ews_team_skip'].forEach((k) => ls.del(k));
    // 오프라인용으로 저장해 둔 악보·콘티도 이 기기에서 지운다 (다른 사람이 같은 기기를 쓸 때를 위해)
    try { if (window.Ink) Ink.wipeLocal(); } catch {}
    try { if (window.caches) caches.keys().then((ks) => ks.filter((k) => k.startsWith('ews-data') || k.startsWith('ews-img')).forEach((k) => caches.delete(k))); } catch {}
  }
  // 검색: 띄어쓰기·기호·대소문자를 무시하고 비교 (서버의 검색과 같은 규칙)
  const searchKey = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function localMatch(hayParts, q) {
    const tokens = String(q || '').split(/\s+/).map(searchKey).filter(Boolean);
    if (!tokens.length) return true;
    const hay = hayParts.map(searchKey).join('');
    return hay.includes(tokens.join('')) || tokens.every((t) => hay.includes(t));
  }
  // 화면을 옮기면(route) 번호가 올라간다. 옛 화면이 보낸 요청의 응답은 버려서, 느린 옛 화면이 새 화면을 덮어쓰지 못하게 한다.
  let routeGen = 0;
  const forever = () => new Promise(() => {});
  async function api(path, { method = 'GET', body } = {}) {
    const gen = routeGen;
    const headers = { 'Content-Type': 'application/json', ...authHeaders() };
    // 읽기 요청에는 지금 보는 팀 번호를 붙인다. 서버는 무시하고, 서비스 워커의 저장본이 팀마다 따로 만들어진다.
    const at = method === 'GET' ? activeTeam() : null;
    if (at && at.id > 0) path += (path.includes('?') ? '&' : '?') + '_t=' + at.id;
    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      if (gen !== routeGen) return forever();
      throw Object.assign(new Error('인터넷 연결을 확인해 주세요.'), { status: 0 });
    }
    // 인터넷이 안 돼서 이 기기에 저장해 둔 내용으로 보여 주는 중인지 (서비스 워커가 표시를 붙여 준다)
    const cached = res.headers.get('X-From-Cache') === '1';
    if (cached !== servedFromCache) {
      servedFromCache = cached;
      window.dispatchEvent(new Event('ews-net'));
    }
    const data = await res.json().catch(() => ({}));
    if (gen !== routeGen) return forever();
    if (!res.ok) throw Object.assign(new Error(data.error || '오류가 발생했습니다.'), { status: res.status, data });
    return data;
  }
  let servedFromCache = false;
  if (window.Ink) Ink.init({ headers: () => authHeaders(), toast });

  // 이미지·PDF 한 장 올리기 (사진은 먼저 줄인다)
  async function uploadFile(songId, file) {
    const { blob, type } = await Files.prepare(file);
    const headers = { 'Content-Type': type, ...authHeaders() };
    let res;
    try {
      res = await fetch(`/api/songs/${songId}/files`, { method: 'POST', headers, body: blob });
    } catch {
      throw new Error('인터넷 연결을 확인해 주세요.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '업로드에 실패했습니다.');
    return data.file;
  }

  // 21차: 화면을 옮길 때마다 서버에 "나는 누구인가"(/me)를 물어보고 기다리던 것을 줄인다.
  // 열쇠(접속암호·관리자·팀·팀장)가 그대로이고 1분 안에 확인했다면 그 결과를 그대로 쓴다. 열쇠가 바뀌거나 1분이 지나면 다시 묻는다.
  // (PIN 입력·팀 가입·로그아웃은 열쇠가 바뀌므로 자동으로 새로 확인된다. 직접 새로 확인하고 싶을 땐 loadMe()를 부른다.)
  let meKey = '';
  let meAt = 0;
  const authKey = () => JSON.stringify(authHeaders());
  async function ensureMe() {
    if (meAt && meKey === authKey() && Date.now() - meAt < 60000 && !servedFromCache) return;
    await loadMe();
  }
  async function loadMe() {
    await loadMeNow();
    meKey = authKey();
    meAt = Date.now();
  }
  async function loadMeNow() {
    migrateLegacy();
    ensureActive();
    // 지금 보는 팀의 열쇠가 더 이상 안 통하면(가입코드 재발급·팀 삭제 등) "다시 입장 필요"로 표시하고 다른 팀으로 넘어간다.
    for (let guard = 0; guard < 12; guard++) {
      me = await api('/me');
      // 만료/무효가 된 열쇠는 이 기기에서 지운다
      if (!me.isAdmin && ls.get('ews_admin', '')) ls.del('ews_admin');
      const a = activeTeam();
      if (me.team) {
        const t = me.team;
        const all = teamsGet();
        const cur = all.find((x) => a && x.team === a.team); // 지금 쓰고 있는 줄
        if (cur) {
          cur.id = t.id; // 옛 방식에서 옮긴 줄은 번호·이름을 여기서 채운다
          cur.name = t.name;
          cur.stale = false;
          if (!t.isLeader) cur.leader = '';
        }
        // 같은 팀 번호가 두 줄이면 지금 쓰는 줄만 남긴다
        teamsSet(all.filter((x) => x === cur || x.id !== t.id));
        ls.set('ews_team_active', String(t.id));
        return;
      }
      if (!a) return;
      teamsSet(teamsGet().map((x) => (x.team === a.team ? { ...x, stale: true, leader: '' } : x)));
      ensureActive();
    }
  }

  // 화면 아래 메뉴: 오늘 / 곡 / 콘티 / 더보기 (팀·관리자·로그아웃은 더보기 안)
  const NAV_ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
    songs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  };
  function renderNav(hash) {
    const items = [
      ['#/', '오늘', 'home', hash === '/' || hash === ''],
      ['#/songs', '곡', 'songs', /^\/(songs|song|new|edit|history)/.test(hash)],
      ['#/setlists', '콘티', 'list', /^\/setlist/.test(hash)],
      ['#/more', '더보기', 'more', /^\/(more|team|admin|status)/.test(hash)],
    ];
    $nav.innerHTML = items.map(([href, label, ic, on]) => `<a href="${href}" class="${on ? 'on' : ''}">${NAV_ICON[ic]}<span>${label}</span></a>`).join('');
    $nav.hidden = false;
    fitNavSoon();
  }

  // 16차: 아이패드 홈 화면 앱에서 아래 메뉴 밑에 빈 띠가 생기는 문제 보정.
  // 실기기 진단(2026-11-10): 띠가 생긴 화면은 창 높이(innerHeight)와 보이는 영역(visualViewport)이 둘 다 992로, 실제 화면 높이 1024보다
  // 상태 막대 높이(안전영역 위쪽 32px)만큼 짧았다. 띠가 없는 화면은 창 높이가 1024. 그래서 아래 메뉴(fixed, bottom:0)가 짧아진 창의
  // 맨 아래에 붙어 그 밑 32px에 배경이 비친다. (사파리가 창 높이를 상태 막대만큼 빼고 기억하는 현상으로 보인다.)
  // 보정: ① 메뉴 아래끝이 보이는 영역 맨 아래보다 위에 있거나(16A), ② 홈 앱에서 창이 화면보다 "안전영역 위쪽 높이"만큼 짧으면(16C)
  // 그만큼 메뉴의 흰 배경을 아래로 늘려 채운다. 글자·아이콘 위치는 그대로다.
  const isStandalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
  function insetTop() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);
    const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return v;
  }
  let lastNav = { gap: 0, short: 0, why: '-' };
  function fitNav() {
    try {
      const root = document.documentElement;
      if ($nav.hidden || document.body.classList.contains('ink-open')) { root.style.removeProperty('--nav-gap'); return; }
      root.style.removeProperty('--nav-gap'); // 보정 없는 원래 위치에서 잰다 (같은 프레임 안이라 깜빡이지 않음)
      const vv = window.visualViewport;
      const seeBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      let gap = Math.round(seeBottom - $nav.getBoundingClientRect().bottom);
      let why = gap >= 2 ? '보이는 영역' : '-';
      // 화면 높이: 세로면 긴 쪽, 가로면 짧은 쪽 (iOS는 회전해도 screen 값이 그대로일 수 있어 방향으로 고른다)
      const full = window.innerHeight >= window.innerWidth ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
      const short = Math.round(full - window.innerHeight);
      if (gap < 2 && isStandalone() && short >= 2 && short <= 64 && (!vv || vv.height >= window.innerHeight - 1)) {
        const top = insetTop();
        if (top > 0 && Math.abs(short - top) <= 4) { gap = short; why = '창이 짧음'; }
      }
      lastNav = { gap, short, why };
      if (gap >= 2 && gap <= 160) root.style.setProperty('--nav-gap', gap + 'px');
      if (viewDbgOn()) viewDbgDraw();
    } catch {}
  }
  let navTimers = [];
  function fitNavSoon() {
    fitNav();
    navTimers.forEach(clearTimeout);
    // 키보드·회전 애니메이션이 끝난 뒤에 값이 바뀌는 경우가 있어 몇 번 다시 잰다
    navTimers = [120, 450, 1200].map((ms) => setTimeout(fitNav, ms));
  }
  const viewDbgOn = () => ls.get('ews_view_dbg', '') === '1';
  function viewDbgDraw() {
    let box = document.getElementById('viewdbg');
    if (!viewDbgOn()) { if (box) box.remove(); return; }
    if (!box) {
      box = document.createElement('div');
      box.id = 'viewdbg';
      box.className = 'ink-dbg';
      box.style.cssText = 'position:fixed;left:6px;top:90px;bottom:auto;z-index:200;max-width:92vw';
      document.body.appendChild(box);
    }
    const vv = window.visualViewport;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const inset = cs.paddingTop + ' / ' + cs.paddingBottom;
    probe.remove();
    const gap = lastNav.gap;
    const nb = $nav.hidden ? null : $nav.getBoundingClientRect();
    const f = (n) => (Math.round(n * 10) / 10);
    box.textContent = [
      '창 ' + innerWidth + '×' + innerHeight + ' · 문서 ' + document.documentElement.clientHeight,
      vv ? '보이는 영역 ' + f(vv.width) + '×' + f(vv.height) + ' 위 ' + f(vv.offsetTop) + ' 배율 ' + f(vv.scale) : '보이는 영역 정보 없음',
      '화면 ' + screen.width + '×' + screen.height + ' · 홈앱 ' + (navigator.standalone ? '예' : '아니오'),
      '메뉴 아래끝 ' + (nb ? f(nb.bottom) : '-') + ' · 남은 틈 ' + gap + ' · 보정 ' + (document.documentElement.style.getPropertyValue('--nav-gap') || '0') + ' (' + lastNav.why + ')',
      '창이 짧은 정도 ' + lastNav.short,
      '안전영역 위/아래 ' + inset + ' · 스크롤 ' + f(scrollY),
    ].join('\n');
  }

  // ---------- 라우터 ----------
  let teardown = null; // 연주 모드처럼 화면을 떠날 때 정리할 일(화면 꺼짐 방지 해제 등)
  async function route() {
    routeGen++;
    if (teardown) {
      try { teardown(); } catch {}
      teardown = null;
    }
    $app.classList.remove('wide');
    $app.onclick = null;
    const [hash, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
    const q = new URLSearchParams(qs || '');
    window.scrollTo(0, 0);
    document.querySelectorAll('.sheet-wrap').forEach((n) => n.remove()); // 열려 있던 아래 창은 닫는다
    document.querySelector('main').classList.remove('wide');
    try {
      if (!ls.get('ews_token', '')) return viewLogin();
      await ensureMe();
      $top.hidden = false;
      renderNav(hash);
      // 처음 들어오면 팀 가입 화면부터. ("팀 없이 곡만 보기"를 고르면 건너뜀)
      if (!me.team && ls.get('ews_team_skip', '') !== '1' && hash !== '/team' && hash !== '/admin' && hash !== '/more' && hash !== '/status') {
        location.hash = '#/team';
        return;
      }
      let m;
      if (hash === '/' || hash === '') return await viewHome();
      if (hash === '/songs') return await viewList(q);
      if (hash === '/more') return await viewMore();
      if (hash === '/status') return await viewStatus();
      if ((m = /^\/song\/(\d+)$/.exec(hash))) return await viewSong(+m[1], q);
      if ((m = /^\/play\/song\/(\d+)$/.exec(hash))) return await viewPlay({ songId: +m[1] }, q);
      if ((m = /^\/play\/(\d+)$/.exec(hash))) return await viewPlay({ sl: +m[1] }, q);
      if (hash === '/new') return viewEdit(null, q);
      if ((m = /^\/history\/(\d+)$/.exec(hash))) return await viewHistory(+m[1]);
      if ((m = /^\/edit\/(\d+)$/.exec(hash))) return await viewEdit(+m[1], q);
      if (hash === '/admin') return await viewAdmin();
      if (hash === '/team') return await viewTeam(q);
      if (hash === '/setlists') return await viewSetlists();
      if (hash === '/setlist/new') return await viewSetlistEdit(null, q);
      if ((m = /^\/setlist\/(\d+)$/.exec(hash))) return await viewSetlist(+m[1]);
      if ((m = /^\/setlist\/(\d+)\/edit$/.exec(hash))) return await viewSetlistEdit(+m[1]);
      location.hash = '#/';
    } catch (e) {
      if (e.status === 401) {
        clearSession();
        return viewLogin('다시 로그인해 주세요.');
      }
      $app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><a class="btn" href="#/">처음으로</a></div>`;
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- 로그인 ----------
  function viewLogin(msg) {
    $top.hidden = true;
    $nav.hidden = true;
    $app.innerHTML = `
      <div class="login">
        <div class="login-mark" aria-hidden="true"><svg viewBox="0 0 64 64" width="32" height="32"><path fill="currentColor" d="M26 14v26.5a7 7 0 1 1-4-6.3V20l22-5v21.5a7 7 0 1 1-4-6.3V18z"/></svg></div>
        <h1>Everyday Worship Songbook</h1>
        <p class="muted center">찬양 악보집</p>
        <form class="card" id="f">
          <label for="code">교회 접속암호</label>
          <input id="code" type="password" autocomplete="current-password" autofocus>
          <p class="error" id="err">${esc(msg || '')}</p>
          <p><button class="btn primary" style="width:100%">들어가기</button></p>
        </form>
        <p class="muted small center">교회 내부용 악보집입니다. 저작권 보호를 위해 외부 공유를 삼가 주세요.</p>
      </div>`;
    document.getElementById('f').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = document.getElementById('err');
      err.textContent = '';
      try {
        const r = await api('/login', { method: 'POST', body: { code: document.getElementById('code').value } });
        ls.set('ews_token', r.token);
        route();
      } catch (e) {
        err.textContent = e.message;
      }
    };
  }

  // ---------- 4차 공용: 추천 태그(주제·빠르기·절기), 외부 검색 링크, 날짜 표시 ----------
  // 곡 태그는 자유롭게 쓰되, 관리자가 정해 둔 추천 목록은 칩으로 보여 준다.
  const OTHER_KEY = SongFilter.OTHER_KEY;
  const groupTags = SongFilter.groupTags; // 추천 목록의 분류별 태그 + 곡에 쓰인 "기타" (songfilter.js)
  const extLinksHTML = (q) => {
    const e = encodeURIComponent;
    return [
      ['Google', `https://www.google.com/search?q=${e(q + ' 코드 악보')}`],
      ['YouTube', `https://www.youtube.com/results?search_query=${e(q + ' 찬양')}`],
      ['Ultimate Guitar', `https://www.ultimate-guitar.com/search.php?search_type=title&value=${e(q)}`],
    ]
      .map(([n, u]) => `<a class="btn small" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${n}</a>`)
      .join(' ');
  };
  const mmdd = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${+d.slice(5, 7)}/${+d.slice(8, 10)}` : '');
  const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  function agoText(d) {
    if (!d) return '';
    const days = Math.round((Date.parse(todayKst()) - Date.parse(d)) / 864e5);
    if (!Number.isFinite(days)) return '';
    if (days <= 0) return '오늘';
    if (days < 7) return `${days}일 전`;
    if (days < 60) return `${Math.floor(days / 7)}주 전`;
    if (days < 365) return `${Math.floor(days / 30)}개월 전`;
    return `${Math.floor(days / 365)}년 넘게 전`;
  }

  // ---------- 곡 목록 ----------
  // 필터(주제·키·악보 형식)와 정렬은 주소에도 저장된다: #/songs?tag=회개%26보혈&key=G,E&fmt=chord&sort=key
  // 같은 세션에서는 목록을 떠났다 돌아와도 그대로 유지된다. (listState)
  let listState = { q: '', f: SongFilter.newState(), sort: 'title' };
  async function viewList(q) {
    if (q && SongFilter.hasFilterParams(q)) {
      const r = SongFilter.fromQuery(q);
      listState = { q: r.q, f: r.st, sort: r.sort };
    }
    const teamSorts = me.team ? '<option value="old">오래 안 부른 순</option><option value="recent">최근 부른 순</option>' : '';
    $app.innerHTML = `
      <div class="row between"><h1>곡 목록</h1>${lockBtn('song', '+ 새 곡', '#/new', 'primary', true)}</div>
      <input type="search" id="q" placeholder="제목 · 원제 · 가사(후렴) · 아티스트 · 태그 검색" value="${esc(listState.q)}">
      <details class="filter" id="filter"><summary id="fsum">분류·키·박자로 찾기</summary><div id="chips"></div><p class="row" style="margin:8px 0 0"><button type="button" class="btn small" id="fclear">선택 모두 지우기</button></p></details>
      <div class="row sortrow"><span class="ctl-label">정렬</span><select id="sort" aria-label="정렬"><option value="title">제목순</option><option value="key">키순 (C→B, 단조는 뒤)</option>${teamSorts}</select></div>
      <ul class="songs" id="list"></ul>
      <div class="card" id="ext" hidden></div>
      <p class="muted center" id="empty" hidden></p>`;
    const $q = document.getElementById('q');
    const $list = document.getElementById('list');
    const $chips = document.getElementById('chips');
    const $empty = document.getElementById('empty');
    const $ext = document.getElementById('ext');
    const $sort = document.getElementById('sort');
    let songs = [];
    let groups = [];
    let kchips = [];
    let tchips = [];
    if (!me.team && (listState.sort === 'old' || listState.sort === 'recent')) listState.sort = 'title';
    $sort.value = listState.sort;
    const gen = routeGen;

    // 주소 표시줄에 지금 상태를 적어 둔다 (hashchange 를 일으키지 않는 replaceState)
    function syncUrl() {
      if (gen !== routeGen) return;
      const qs = SongFilter.toQuery(listState.f, { q: listState.q, sort: listState.sort });
      try { history.replaceState(null, '', '#/songs' + (qs ? '?' + qs : '')); } catch {}
    }
    function drawChips() {
      SongFilter.prune(listState.f, groups, kchips, tchips);
      $chips.innerHTML = SongFilter.chipsHTML(listState.f, groups, kchips, esc, tchips);
      const sum = SongFilter.summary(listState.f);
      document.getElementById('fsum').textContent = sum ? `분류·키·박자로 찾기 · ${sum}` : '분류·키·박자로 찾기';
      document.getElementById('fclear').hidden = !SongFilter.isActive(listState.f);
    }
    function draw() {
      drawChips();
      syncUrl();
      const filtered = songs.filter((s) => SongFilter.matches(s, listState.f));
      // 제목순일 때는 서버가 준 순서를 그대로 쓴다(검색 중이면 제목류 일치가 먼저).
      const shown = listState.sort === 'title' ? filtered : SongFilter.sortSongs(filtered, listState.sort);
      const anyUsed = songs.some((s) => s.last_used); // 팀 콘티가 아직 없으면 "안 불러 봄" 표시는 생략
      $list.innerHTML = shown
        .map((s) => {
          const used = me.team && anyUsed ? (s.last_used ? `<span class="tag used" title="우리 팀이 가장 최근에 부른 날">최근 ${mmdd(s.last_used)}</span>` : '<span class="tag unused">안 불러 봄</span>') : '';
          return `<li class="song-item"><a href="#/song/${s.id}">
            <div class="song-title">${esc(s.title)}${s.orig_title ? `<span class="orig"> · ${esc(s.orig_title)}</span>` : ''}</div>
            ${s.snippet ? `<div class="snip"><span class="tag">${esc(s.snippet.label)}</span> ${esc(s.snippet.text)}</div>` : ''}
            <div class="song-meta">${SongFilter.keyTsigHTML(s, esc)}${SongFilter.badgesHTML(s, esc)}${s.artist ? `<span>${esc(s.artist)}</span>` : ''}${s.tempo ? `<span>♩${s.tempo}</span>` : ''}${used}</div>
            ${SongFilter.tagsLineHTML(s.tags, esc)}
          </a></li>`;
        })
        .join('');
      $empty.hidden = shown.length > 0;
      if (!shown.length) {
        $empty.textContent = listState.q || SongFilter.isActive(listState.f) ? '찾는 곡이 없습니다.' : me.canEdit ? '아직 등록된 곡이 없습니다. “+ 새 곡”으로 첫 곡을 등록해 보세요.' : '아직 등록된 곡이 없습니다.';
      }
      // 검색어가 있으면 외부에서도 찾아볼 수 있게 링크를 보여 준다 (악보 자체를 가져오는 기능은 없고, 검색 페이지로만 연결)
      if (listState.q) {
        $ext.hidden = false;
        $ext.innerHTML = `<p class="small" style="margin:0 0 8px">${shown.length ? '다른 곡도 찾고 있나요?' : '앱에 없는 곡이에요.'} 외부에서 “${esc(listState.q)}” 검색하기</p>
          <div class="row">${extLinksHTML(listState.q)}</div>
          ${me.canEdit ? `<p style="margin:10px 0 0"><a class="btn small primary" href="#/new?title=${encodeURIComponent(listState.q)}">+ “${esc(listState.q.slice(0, 20))}” 새 곡으로 등록</a></p>` : ''}
          <p class="hint" style="margin-bottom:0">외부 사이트의 악보는 저작권이 있을 수 있으니, 교회 내부 용도로만 확인해 주세요.</p>`;
      } else {
        $ext.hidden = true;
      }
    }
    let tagInfo = null; // 추천 태그 목록은 화면을 연 뒤 한 번만 받는다 (검색어를 칠 때마다 다시 받지 않음)
    async function load() {
      const [r, info] = await Promise.all([api('/songs?q=' + encodeURIComponent(listState.q)), tagInfo ? Promise.resolve(tagInfo) : api('/tags')]);
      tagInfo = info;
      songs = r.songs;
      groups = groupTags(info);
      kchips = SongFilter.keyChips(songs);
      tchips = SongFilter.tsigChips(songs);
      draw();
    }
    let timer;
    $q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { listState.q = $q.value.trim(); load().catch((e) => toast(e.message)); }, 250);
    };
    $chips.onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button.chip');
      if (!b) return;
      SongFilter.toggle(listState.f, groups, b.dataset);
      draw();
    };
    document.getElementById('fclear').onclick = () => { listState.f = SongFilter.newState(); draw(); };
    $sort.onchange = () => { listState.sort = $sort.value; draw(); };
    // 처음엔 접어 둔다(작은 화면에서 곡 목록이 아래로 밀리지 않게). 고른 조건은 접힌 제목 줄에 그대로 보인다.
    await load();
  }

  // ---------- 곡 보기 ----------
  const KEYS_MAJOR = Chord.MAJOR_NAMES;
  const KEYS_MINOR = Chord.MINOR_NAMES.map((n) => n + 'm');
  // 우리 팀 콘티에서 이 곡을 언제 불렀는지 (팀에 가입한 경우만)
  function usageHTML(u) {
    if (!u) return '';
    if (!u.count && !u.next) return '<p class="usage muted small">우리 팀 콘티에는 아직 쓴 적이 없어요.</p>';
    const link = (l) => `<a href="#/setlist/${l.id}">${esc(mmdd(l.date))}</a>`;
    const head = u.count ? `우리 팀 최근 <b>${esc(u.recent[0].date)}</b> (${esc(agoText(u.recent[0].date))}) · 지금까지 ${u.count}번` : '우리 팀 콘티에는 아직 쓴 적이 없어요';
    const next = u.next ? ` · 예정 ${link(u.next)}` : '';
    const more = u.recent.length > 1 ? `<details><summary>최근 사용한 콘티</summary><div class="small">${u.recent.map((l) => `${link(l)} ${esc(l.title || '')}`).join('<br>')}</div></details>` : '';
    return `<div class="usage small">${head}${next}${more}</div>`;
  }
  // q: 콘티에서 열었을 때 넘어오는 값 (key=그날의 키, view=chord|image, sl=콘티 번호)
  async function viewSong(id, q) {
    q = q || new URLSearchParams();
    const { song } = await api('/songs/' + id);
    document.title = song.title + ' · Everyday Worship Songbook';
    const parsed = Chord.parseChordPro(song.chordpro);
    const gk = Chord.guessKey(parsed, song.original_key);
    const origKey = gk.key;
    const hasKey = !!Chord.parseKey(origKey);
    const kobj = Chord.parseKey(origKey);
    const files = song.files || [];
    const hasText = /\S/.test(song.chordpro || '');

    const prefs = { cols: ls.get('ews_cols', 'auto') === '1' ? '1' : 'auto', size: +ls.get('ews_size', '18'), chords: ls.get('ews_chords', '1') === '1', acc: ls.get('ews_acc', 'auto'), names: ls.get('ews_names', 'full') === 'abbr' ? 'abbr' : 'full', refs: ls.get('ews_refs', 'mark') === 'all' ? 'all' : 'mark' };
    let saved = {};
    try { saved = JSON.parse(ls.get('ews_song_' + id, '{}')) || {}; } catch {}
    const st = { shift: Number.isInteger(saved.shift) ? saved.shift : 0, capo: Number.isInteger(saved.capo) ? saved.capo : 0 };

    const keyList = hasKey ? (kobj.minor ? KEYS_MINOR : KEYS_MAJOR) : [];
    const yt = safeUrl(song.youtube_url);

    // 시작 키: ① 콘티에서 열었다면 그날의 키 ② 이 기기에서 바꿔 둔 키 ③ 우리 팀 기본 키 ④ 원래 키
    // ①·③은 이 기기의 "내 키"로 저장하지 않는다. (직접 바꿀 때부터 저장)
    const startFrom = (keyName) => {
      const k = Chord.parseKey(keyName);
      return hasKey && k ? (((k.idx - kobj.idx) % 12) + 12) % 12 : null;
    };
    let persist = true;
    const fromSetlist = startFrom(q.get('key'));
    if (fromSetlist !== null) {
      st.shift = fromSetlist;
      persist = false;
    } else if (!Number.isInteger(saved.shift) && startFrom(song.team_key) !== null) {
      st.shift = startFrom(song.team_key);
      persist = false;
    }
    const slId = /^\d+$/.test(q.get('sl') || '') ? q.get('sl') : '';
    // 콘티에서 열었다면 필기는 "콘티용"(곡 기본 필기 위에 겹쳐 보인다)
    const slInk = slId && /^[0-9a-f]{12}$/.test(q.get('u') || '') ? { uid: q.get('u'), setlistId: +slId } : null;
    const isLeader = !!(me.team && me.team.isLeader);

    const playHref = '#/play/' + (slId ? slId + '?song=' + id : 'song/' + id + (q.toString() ? '?' + q.toString() : ''));
    // ⋯ 메뉴: 편집(권한이 없으면 🔒 PIN) · 수정 이력
    const menuRows = [
      me.canEdit ? `<a class="menu-row" href="#/edit/${id}">곡 편집</a>` : me.adminRequired ? `<button type="button" class="menu-row" data-lock="song" data-go="#/edit/${id}">🔒 곡 편집 <span class="muted small">PIN 필요</span></button>` : '',
      me.canEdit ? `<a class="menu-row" href="#/history/${id}">수정 이력</a>` : '',
      hasText ? `<button type="button" class="menu-row" id="m-lyr">가사 복사</button>` : '',
    ].filter(Boolean);

    // 키·박자 줄: 우리 팀 키가 있으면 팀 키를 먼저(바로 오른쪽에 박자), 원키는 다를 때만 작게. 팀 키가 없으면 원키가 그 자리. (14차)
    let curTeamKey = song.team_key || '';
    const keyMetaHTML = () => {
      const tsig = SongFilter.tsigHTML(song.time_sig, esc);
      const guess = gk.guessed ? ' (추정)' : '';
      if (curTeamKey) {
        const differs = hasKey && SongFilter.keyDiffers(curTeamKey, origKey);
        return `<span>우리 팀 <span class="keybadge" id="tkbadge">${esc(curTeamKey)}</span></span>${tsig}${differs ? `<span class="origkey" title="원래 키">원키 ${esc(origKey)}${guess}</span>` : ''}`;
      }
      return `${hasKey ? `<span>원키 <span class="keybadge">${esc(origKey)}</span>${guess}</span>` : ''}${tsig}`;
    };
    const refreshKeyMeta = (k) => {
      curTeamKey = k || '';
      const m = document.getElementById('keymeta');
      if (m) m.innerHTML = keyMetaHTML();
    };
    $app.innerHTML = `
      <div class="row between"><a href="${slId ? '#/setlist/' + slId : '#/songs'}" class="small">← ${slId ? '콘티' : '목록'}</a>${menuRows.length ? '<button class="btn small" id="smore" type="button" aria-label="더보기 메뉴">⋯</button>' : ''}</div>
      <h1>${esc(song.title)}</h1>
      ${song.orig_title ? `<div class="orig-line">원제 ${esc(song.orig_title)}</div>` : ''}
      <div class="row actions"><a class="btn primary big grow" href="${playHref}">▶ 연주 모드</a>${hasText ? '<button class="btn big" id="keychip" type="button" aria-label="키와 표시 설정"></button>' : ''}</div>
      <div class="song-meta" style="margin-bottom:8px">
        ${song.artist ? `<span>${esc(song.artist)}</span>` : ''}
        <span id="keymeta" class="keymeta">${keyMetaHTML()}</span>
        ${song.tempo ? `<span>♩${song.tempo}</span>` : ''}
        ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener noreferrer">▶ 유튜브</a>` : ''}
      </div>
      ${SongFilter.tagsLineHTML(song.tags, esc)}
      ${usageHTML(song.usage)}
      ${hasText && files.length ? '<div class="tabs" id="tabs"><button class="tab" data-tab="chord">코드 악보</button><button class="tab" data-tab="img">이미지 악보</button></div>' : ''}
      ${isLeader && files.length && !hasText ? `<div class="row" id="imgkeyrow" style="margin:6px 0"><span class="ctl-label">우리 팀 키</span><select id="imgkey" aria-label="우리 팀 기본 키">${['', ...(Chord.parseKey(origKey) && Chord.parseKey(origKey).minor ? KEYS_MINOR : KEYS_MAJOR)].map((k) => `<option value="${k}">${k || '선택'}</option>`).join('')}</select><button class="btn small" id="imgkeysave" type="button">팀 기본 키로 저장</button></div><p class="hint" style="margin-top:0">이미지 악보는 화면에서 키가 바뀌지 않아요. 우리 팀이 부르는 키를 기록해 두면 콘티에 곡을 넣을 때 기본값이 됩니다.</p>` : ''}
      ${!hasText && !files.length ? `<p class="muted">등록된 악보가 아직 없습니다.${me.canEdit ? ' 편집에서 코드 악보를 입력하거나 이미지·PDF를 올려 주세요.' : ''}</p>` : ''}
      <div id="pane-chord"><div class="score" id="score"></div></div>
      <div id="pane-img" hidden></div>
      ${song.memo ? `<h2>메모</h2><div class="memo">${esc(song.memo)}</div>` : ''}
      <div class="sheet-wrap" id="ksheet" hidden>
        <div class="sheet-card">
          <h2 style="margin-top:0">키 · 표시 설정</h2>
          <div class="controls inline">
            <div class="row">
              <span class="ctl-label">키</span>
              <span class="keybox">
                <button class="btn small" id="down" aria-label="반음 내리기">−</button>
                ${hasKey ? `<select id="keysel" aria-label="목표 키">${keyList.map((k) => `<option>${k}</option>`).join('')}</select>` : '<span id="shiftlbl" class="keybadge">0</span>'}
                <button class="btn small" id="up" aria-label="반음 올리기">+</button>
              </span>
              <button class="btn small" id="reset">원래 키</button>
              ${isLeader && hasKey ? '<button class="btn small" id="teamkey">팀 기본 키로 저장</button>' : ''}
            </div>
            <div class="row">
              <span class="ctl-label">카포</span>
              <select id="capo">${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${n === 0 ? '없음' : n}</option>`).join('')}</select>
              <span class="ctl-label">표기</span>
              <select id="acc"><option value="auto">자동</option><option value="sharp">♯</option><option value="flat">♭</option></select>
            </div>
            <div class="row">
              <span class="ctl-label">글자</span>
              <button class="btn small" id="fdown">가−</button><button class="btn small" id="fup">가+</button>
              <button class="btn small" id="chtoggle"></button>
              <button class="btn small" id="coltoggle"></button>
            </div>
            <div class="row">
              <span class="ctl-label">구간</span>
              <button class="btn small" id="nametoggle"></button>
              <button class="btn small" id="reftoggle"></button>
            </div>
            <div class="capo-note" id="note"></div>
          </div>
          <p class="hint">키 변경은 이 기기에만 저장됩니다.</p>
          <button class="btn primary" id="kclose" type="button" style="width:100%">닫기</button>
        </div>
      </div>`;
    const $ks = document.getElementById('ksheet');
    const $kc = document.getElementById('keychip');
    if ($kc) $kc.onclick = () => { $ks.hidden = false; };
    document.getElementById('kclose').onclick = () => { $ks.hidden = true; };
    $ks.onclick = (ev) => { if (ev.target === $ks) $ks.hidden = true; };
    const $sm = document.getElementById('smore');
    if ($sm) $sm.onclick = () => {
      const sh = showSheet(`<div class="menu-list">${menuRows.join('')}</div><button type="button" class="btn" id="mcancel" style="width:100%;margin-top:8px">닫기</button>`);
      sh.q('#mcancel').onclick = () => sh.close();
      const $ml = sh.q('#m-lyr');
      if ($ml) $ml.onclick = () => {
        sh.close();
        // 콘티에서 열었다면 그 콘티에 적힌 송폼도 쓸 수 있게 한다
        lyricsSheet('가사 복사', async () => {
          let form = '';
          if (slId) {
            try { const it = ((await api('/setlists/' + slId)).setlist.items || []).find((x) => String(x.song_id) === String(id)); form = (it && it.form) || ''; } catch {}
          }
          return [{ title: song.title, form, song }];
        }, { numbered: false, noForm: !slId });
      };
    };

    const $score = document.getElementById('score');
    const $note = document.getElementById('note');
    const $key = document.getElementById('keysel');
    const $capo = document.getElementById('capo');
    const $acc = document.getElementById('acc');
    const $chtoggle = document.getElementById('chtoggle');
    $capo.value = String(st.capo);
    $acc.value = prefs.acc;

    // 넓은 화면(아이패드 등)에서는 코드 악보를 두 단으로 보여 준다. 사용자가 끌 수 있다.
    function applyCols() {
      const on = prefs.cols === 'auto' && window.innerWidth >= 900;
      $score.classList.toggle('cols2', on);
      $app.classList.toggle('wide', on);
    }
    const onWinResize = () => { if (document.body.contains($score)) applyCols(); else window.removeEventListener('resize', onWinResize); };
    window.addEventListener('resize', onWinResize);
    const viewOpen = new Set(); // 탭해서 펼친 자리표시({ref}) 줄 번호
    function draw() {
      document.documentElement.style.setProperty('--song-size', prefs.size + 'px');
      $chtoggle.textContent = prefs.chords ? '코드 숨기기' : '코드 보기';
      document.getElementById('coltoggle').textContent = prefs.cols === 'auto' ? '2단: 자동' : '2단: 끔';
      document.getElementById('nametoggle').textContent = prefs.names === 'full' ? '이름: 풀네임' : '이름: 약어';
      document.getElementById('reftoggle').textContent = prefs.refs === 'all' ? '반복 구간: 모두 펼침' : '반복 구간: 표시만';
      applyCols();
      const p = Chord.plan(origKey, st.shift, st.capo, prefs.acc);
      $score.innerHTML = Chord.renderHTML(parsed, { originalKey: origKey, shift: st.shift, capo: st.capo, acc: prefs.acc, showChords: prefs.chords, names: prefs.names, refs: prefs.refs === 'all' ? 'all' : viewOpen });
      if (hasKey) {
        $key.value = p.soundKey;
        $note.textContent = st.capo ? `카포 ${st.capo}프렛 · 실제 키 ${p.soundKey} · ${p.shapeKey} 코드로 연주` : '';
      } else {
        document.getElementById('shiftlbl').textContent = (st.shift > 0 ? '+' : '') + st.shift;
        $note.textContent = '원래 키 정보가 없어 반음 단위로만 표시합니다. 편집에서 키를 입력해 보세요.';
      }
      if ($kc) $kc.innerHTML = '키 <b>' + esc(hasKey ? p.soundKey : (st.shift > 0 ? '+' : '') + st.shift) + '</b>' + (st.capo ? ' · 카포 ' + st.capo : '') + ' ▾';
      if (persist) ls.set('ews_song_' + id, JSON.stringify(st));
    }
    const wrap = (n) => ((n % 12) + 12) % 12;
    const setShift = (n) => { persist = true; st.shift = wrap(n); if (!hasKey) st.shift = Math.max(-11, Math.min(11, n)); draw(); };
    document.getElementById('up').onclick = () => setShift(st.shift + 1);
    document.getElementById('down').onclick = () => setShift(st.shift - 1);
    document.getElementById('reset').onclick = () => { persist = true; st.shift = 0; st.capo = 0; $capo.value = '0'; draw(); };
    if ($key) $key.onchange = () => {
      // 목록은 C부터 반음 순서 → 인덱스가 곧 음높이
      setShift(keyList.indexOf($key.value) - kobj.idx);
    };
    $capo.onchange = () => { persist = true; st.capo = +$capo.value; draw(); };

    // 팀장: 지금 보고 있는 키를 "우리 팀 기본 키"로 저장 (콘티에 곡을 넣을 때 기본값, 팀원이 처음 열 때 시작 키)
    const $tk = document.getElementById('teamkey');
    if ($tk) $tk.onclick = async () => {
      const k = Chord.transposeKey(origKey, st.shift);
      $tk.disabled = true;
      try {
        await api('/team/keys/' + id, { method: 'PUT', body: { key: k } });
        refreshKeyMeta(k);
        toast(`우리 팀 기본 키를 ${k}(으)로 저장했습니다.`);
      } catch (e) {
        toast(e.message);
      } finally {
        $tk.disabled = false;
      }
    };
    // 팀장: 이미지·PDF만 있는 곡의 팀 기본 키(기록용). 비워서 저장하면 지워진다.
    const $ik = document.getElementById('imgkey');
    const $iks = document.getElementById('imgkeysave');
    if ($ik && $iks) {
      $ik.value = song.team_key || '';
      $iks.onclick = async () => {
        const k = $ik.value;
        $iks.disabled = true;
        try {
          await api('/team/keys/' + id, { method: 'PUT', body: { key: k } });
          refreshKeyMeta(k);
          toast(k ? `우리 팀 기본 키를 ${k}(으)로 저장했습니다.` : '우리 팀 기본 키를 지웠습니다.');
        } catch (e) {
          toast(e.message);
        } finally {
          $iks.disabled = false;
        }
      };
    }
    $acc.onchange = () => { prefs.acc = $acc.value; ls.set('ews_acc', prefs.acc); draw(); };
    document.getElementById('fup').onclick = () => { prefs.size = Math.min(40, prefs.size + 2); ls.set('ews_size', prefs.size); draw(); };
    document.getElementById('fdown').onclick = () => { prefs.size = Math.max(12, prefs.size - 2); ls.set('ews_size', prefs.size); draw(); };
    document.getElementById('coltoggle').onclick = () => { prefs.cols = prefs.cols === 'auto' ? '1' : 'auto'; ls.set('ews_cols', prefs.cols); draw(); };
    $chtoggle.onclick = () => { prefs.chords = !prefs.chords; ls.set('ews_chords', prefs.chords ? '1' : '0'); draw(); };
    document.getElementById('nametoggle').onclick = () => { prefs.names = prefs.names === 'full' ? 'abbr' : 'full'; ls.set('ews_names', prefs.names); draw(); };
    document.getElementById('reftoggle').onclick = () => { prefs.refs = prefs.refs === 'all' ? 'mark' : 'all'; ls.set('ews_refs', prefs.refs); viewOpen.clear(); draw(); };
    // 자리표시("↻ Chorus")를 탭하면 그 자리에서 원본을 펼치고, 펼쳐진 구간 이름을 탭하면 다시 접는다
    $score.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-ri]');
      if (!t || !$score.contains(t) || t.classList.contains('orphan') || prefs.refs === 'all') return;
      const ri = +t.dataset.ri;
      if (viewOpen.has(ri)) viewOpen.delete(ri); else viewOpen.add(ri);
      draw();
    });
    draw();

    // 코드 악보 / 이미지 악보 전환 (둘 다 있을 때만 탭 표시, 선택은 이 기기에 기억)
    const $pc = document.getElementById('pane-chord');
    const $pi = document.getElementById('pane-img');
    // 콘티에서 열었는데 이미지 악보의 원래 키와 부르는 키가 다르면, 이미지 위에 알려 준다.
    const wantKey = q.get('key') || '';
    const keyBanner = wantKey && origKey && wantKey !== origKey ? `<div class="memo" style="margin-bottom:10px">이 콘티에서는 <b>${esc(wantKey)}</b> 키로 부릅니다. 이미지 악보는 원래 키(<b>${esc(origKey)}</b>) 기준입니다.</div>` : '';
    const hasImgFile = files.some((f) => f.kind === 'image');
    $pi.innerHTML = (files.length ? keyBanner : '') + (hasImgFile ? '<div class="row ink-entry"><button class="btn small" id="inkbtn" type="button">' + (slInk ? '✎ 콘티용 필기하기' : '✎ 필기하기') + '</button><span class="muted small">' + (slInk ? '이 콘티에서만 보여요 · 내 필기는 나만 보여요' : '내 필기는 나만 보여요') + '</span></div>' : '') + Files.renderPane(files);
    Files.bindPane($pi, files);
    if (hasImgFile) {
      Ink.decorate($pi, files, slInk);
      Ink.pull(song.id);
      if (slInk) Ink.pullSetlist(slInk.setlistId);
      const ib = document.getElementById('inkbtn');
      if (ib) ib.onclick = () => Ink.edit({ files, start: 0, songId: song.id, title: song.title, sl: slInk || undefined });
    }
    function showTab(t, remember) {
      $pc.hidden = t !== 'chord';
      $pi.hidden = t !== 'img';
      if ($kc) $kc.hidden = t !== 'chord';
      document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      if (remember && hasText && files.length) ls.set('ews_tab_' + id, t);
    }
    const $tabs = document.getElementById('tabs');
    if ($tabs) $tabs.onclick = (ev) => ev.target.dataset.tab && showTab(ev.target.dataset.tab, true);
    // 처음 보여 줄 탭: 콘티에서 정해 준 악보 ▶ 이 기기에서 마지막으로 고른 탭 ▶ 코드 악보
    let startTab = hasText && !(files.length && ls.get('ews_tab_' + id, '') === 'img') ? 'chord' : files.length ? 'img' : 'chord';
    if (hasText && files.length && (q.get('view') === 'chord' || q.get('view') === 'image')) startTab = q.get('view') === 'image' ? 'img' : 'chord';
    showTab(startTab, false);
    if (!hasText) $pc.hidden = true;
  }

  // ---------- 곡 편집 ----------
  const SAMPLE = `{title: 곡 제목}
{key: G}
{comment: V1}
[G]주님은 [C]나의 [G]목자
[Em]부족함이 [D]없으리
{comment: C}
{soc}
[C]찬양해 [D]찬양해 [G]주님을
{eoc}`;

  // ---------- 악보 참고 창 도우미 (23차) ----------
  // files: [{kind:'image'|'pdf', url}] → box 안에 이미지 악보를 한 장씩(‹ ›) 보여 주고, 누르면 전체 화면으로 확대. PDF는 열기 링크.
  function mountImagePane(box, getFiles) {
    let n = 0;
    function draw() {
      const files = getFiles() || [];
      const imgs = files.filter((f) => f.kind === 'image');
      const pdfs = files.filter((f) => f.kind !== 'image');
      if (n >= imgs.length) n = Math.max(0, imgs.length - 1);
      box.innerHTML =
        (imgs.length
          ? `<div class="ipbar"><button type="button" class="btn small" data-ip="-1" ${imgs.length > 1 ? '' : 'disabled'} aria-label="이전 쪽">‹</button><span class="small">${n + 1} / ${imgs.length}</span><button type="button" class="btn small" data-ip="1" ${imgs.length > 1 ? '' : 'disabled'} aria-label="다음 쪽">›</button><span class="muted small">누르면 크게 봐요</span></div><img class="sheet ipimg" src="${esc(imgs[n].url)}" alt="악보 ${n + 1}">`
          : '<p class="muted">이미지 악보가 아직 없어요.</p>') +
        pdfs.map((f) => `<a class="pdf-link" href="${esc(f.url)}" target="_blank" rel="noopener">📄 PDF 악보 열기</a>`).join('');
    }
    box.onclick = (ev) => {
      const files = (getFiles() || []).filter((f) => f.kind === 'image');
      const b = ev.target.closest && ev.target.closest('button[data-ip]');
      if (b) { n = (n + +b.dataset.ip + files.length) % files.length; draw(); return; }
      if (ev.target.closest && ev.target.closest('img.ipimg')) Files.lightbox(files.map((f) => f.url), n);
    };
    draw();
    return { redraw: draw };
  }

  // ---------- 송폼 만들기 창 (23차): 곡 악보를 보면서 송폼을 쌓는다 ----------
  // it: 콘티 항목 {song_id, key, form, _undo}, song: GET /api/songs/:id 의 song(없으면 null → 미리보기 없이 입력만), lastForms: 곡별 지난번 송폼
  // 위(넓은 화면은 왼쪽): 송폼 순서 미리보기 · 원래 악보 · 이미지 탭. 아래(오른쪽): 송폼 입력기. 칩을 넣을 때마다 미리보기가 바로 바뀐다.
  // 취소하면 열기 전 송폼으로 돌아간다. onDone은 완료·취소 모두 닫힐 때 불린다.
  function openFormWindow(it, song, lastForms, onDone) {
    const before = { form: it.form, undo: (it._undo || []).slice() };
    const hasChord = !!(song && /\S/.test(song.chordpro || ''));
    const parsed = hasChord ? Chord.parseChordPro(song.chordpro) : null;
    const files = song && song.files ? song.files : [];
    const origKey = parsed ? Chord.guessKey(parsed, song.original_key).key : (song && song.original_key) || '';
    const startShift = () => {
      const a = Chord.parseKey(origKey), k = Chord.parseKey(it.key);
      return a && k ? (((k.idx - a.idx) % 12) + 12) % 12 : 0;
    };
    const soundKey = () => (parsed && Chord.parseKey(origKey) ? Chord.transposeKey(origKey, startShift()) : it.key || origKey || '');
    const avail = parsed ? new Set((parsed.sections || []).filter((x) => !x.isRef && x.id).map((x) => x.id)) : null;
    const tabs = [];
    if (parsed) { tabs.push(['form', '송폼 순서']); tabs.push(['score', '원래 악보']); }
    if (files.length) tabs.push(['img', '이미지·PDF']);
    let tab = tabs.length ? tabs[0][0] : '';
    const ov = document.createElement('div');
    ov.className = 'fwin';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', '송폼 만들기');
    ov.innerHTML = `<div class="fw-bar"><button type="button" class="btn small" data-x="cancel">취소</button><b class="fw-title">${esc((song && song.title) || '송폼 만들기')}</b><button type="button" class="btn primary small" data-x="ok">완료</button></div>
      <div class="fw-body">
        <section class="fw-ref"><div class="fw-tabs">${tabs.map(([v, t]) => `<button type="button" class="chip" data-tab="${v}">${t}</button>`).join('')}${tabs.length ? '' : '<span class="muted small">이 곡에는 보여 줄 악보가 아직 없어요</span>'}</div><div class="fw-view"></div></section>
        <section class="fw-work"><div class="formed" data-i="0"></div></section>
      </div>`;
    document.body.appendChild(ov);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const view = ov.querySelector('.fw-view');
    const kopt = () => ({ originalKey: origKey, shift: startShift(), parts: false, names: 'full', refs: 'mark', hint: false });
    let ip = null;
    function drawView() {
      ov.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
      if (tab === 'img') {
        view.className = 'fw-view';
        ip = mountImagePane(view, () => files);
        return;
      }
      view.onclick = null;
      view.className = 'fw-view score';
      if (!parsed) { view.innerHTML = '<p class="muted">코드 악보가 없어요.</p>'; return; }
      if (tab === 'form') {
        const arr = SongForm.arrangeByForm(parsed, it.form, soundKey(), Chord);
        view.innerHTML = arr
          ? Chord.renderHTML(arr, kopt()) + (arr.omitted.length ? `<p class="muted small">송폼에 없는 구간: ${esc(arr.omitted.join(', '))}</p>` : '') + (arr.missing.length ? `<p class="muted small">악보에 없는 구간: ${esc(arr.missing.join(', '))}</p>` : '')
          : '<p class="muted">구간 버튼을 눌러 송폼을 쌓으면 여기에 송폼 순서대로 악보가 나타나요.</p>';
      } else view.innerHTML = Chord.renderHTML(parsed, kopt());
    }
    const fe = createFormEditor(ov.querySelector('.fw-work'), { items: [it] }, lastForms, { avail, onChange: () => { if (tab === 'form') drawView(); } });
    ov.querySelector('.fw-work').addEventListener('click', (ev) => {
      const fb = ev.target.closest && ev.target.closest('button[data-fa]');
      if (fb) fe.action(fb.dataset.fa, 0, fb);
    });
    function close(cancel) {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (cancel) { it.form = before.form; it._undo = before.undo; }
      ov.remove();
      if (onDone) onDone(!cancel);
    }
    function onKey(e) { if (e.key === 'Escape') close(true); }
    ov.querySelector('.fw-bar').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-x]');
      if (b) close(b.dataset.x === 'cancel');
    };
    ov.querySelector('.fw-tabs').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-tab]');
      if (b) { tab = b.dataset.tab; drawView(); }
    };
    document.addEventListener('keydown', onKey);
    fe.draw(0);
    drawView();
  }

  // ---------- 송폼 입력기 (6차 구간 버튼 · 22차 전조 칩, 콘티 편집과 곡 편집의 "기본 송폼"이 같이 쓴다) ----------
  // host 안의 .formed[data-i] 칸마다 입력기를 그린다. data.items[i] = {form, key | original_key, song_id, _undo}.
  // lastForms: 곡별 "지난번 송폼"(없으면 빈 객체). 반환: {inner(i), draw(i), action(a,i,btn), reset(), bind()}
  //  · bind()는 host 안의 송폼 버튼 클릭과 Enter 입력을 연결한다(콘티 편집은 자기 클릭 처리기에서 action을 직접 부른다).
  function formHtml(form, key) {
    if (!SongForm.hasKeyChange(form)) return esc(form);
    const steps = SongForm.keySteps(form, key);
    let k = 0;
    return SongForm.parse(form).map((t) => (SongForm.isKeyChange(t) ? `<span class="kc">${esc(SongForm.keyStepText(steps[k++]))}</span>` : esc(t))).join('-');
  }
  function createFormEditor(host, data, lastForms, opts) {
    opts = opts || {};
    let formSel = {}; // 카드별로 선택된 구간 번호
    const kst = {};   // 카드별 전조 패널 상태 {open, d, to, chords}
    const startKey = (it) => it.key || it.original_key || '';
    const KEYOPTS = [...SongForm.KEY_NAMES, ...SongForm.KEY_NAMES_MINOR.map((n) => n + 'm')];
    const boxOf = (i) => host.querySelector(`.formed[data-i="${i}"]`);

    function inner(i) {
      const it = data.items[i];
      const toks = SongForm.parse(it.form);
      const steps = SongForm.keySteps(it.form, startKey(it));
      const sel = formSel[i];
      let ks = 0;
      const seq = toks.length
        ? toks
            .map((t, k) => {
              const kc = SongForm.isKeyChange(t);
              return `<button type="button" class="fchip ${kc ? 'kc' : ''} ${k === sel ? 'sel' : ''}" data-fa="sel" data-i="${i}" data-k="${k}">${esc(kc ? SongForm.keyStepText(steps[ks++]) : t)}</button>`;
            })
            .join('<span class="farrow" aria-hidden="true">›</span>')
        : '<span class="muted small">아래 버튼을 눌러 순서대로 쌓아 보세요</span>';
      const hasSel = sel !== undefined && toks[sel] !== undefined;
      const selKc = hasSel && SongForm.isKeyChange(toks[sel]);
      const tools = hasSel
        ? `<div class="ftools on"><span class="small"><b>${esc(selKc ? '전조' : toks[sel])}</b> 선택됨 · 아래 버튼은 이 뒤에 들어가요</span>
             <button type="button" class="btn small" data-fa="left" data-i="${i}" ${sel === 0 ? 'disabled' : ''} aria-label="앞으로">◀</button>
             <button type="button" class="btn small" data-fa="right" data-i="${i}" ${sel === toks.length - 1 ? 'disabled' : ''} aria-label="뒤로">▶</button>
             <button type="button" class="btn small" data-fa="dup" data-i="${i}">복제</button>
             ${selKc ? '' : `<button type="button" class="btn small" data-fa="rep" data-i="${i}">×반복</button>`}
             <button type="button" class="btn small danger" data-fa="del" data-i="${i}">삭제</button></div>`
        : toks.length || (it._undo && it._undo.length)
          ? `<div class="ftools"><button type="button" class="btn small" data-fa="undo" data-i="${i}" ${it._undo && it._undo.length ? '' : 'disabled'}>↶ 되돌리기</button>${toks.length ? `<button type="button" class="btn small" data-fa="clear" data-i="${i}">모두 지우기</button>` : ''}</div>`
          : '';
      const last = !toks.length && lastForms[it.song_id] ? `<button type="button" class="btn small" data-fa="last" data-i="${i}">↺ 지난번 송폼 불러오기 <span class="muted">${esc(lastForms[it.song_id])}</span></button>` : '';
      const st = kst[i] || {};
      // 곡 악보에 실제 있는 구간(opts.avail)을 먼저 보여 주고, 나머지는 "더 보기"로 접는다. 구간을 알 수 없으면(이미지 곡) 전부 보인다.
      const av = opts.avail && opts.avail.size ? opts.avail : null;
      const palMain = av ? SongForm.PALETTE.filter((q) => av.has(q.code)) : SongForm.PALETTE;
      const palRest = av ? SongForm.PALETTE.filter((q) => !av.has(q.code)) : [];
      const palBtn = (q) => `<button type="button" class="pchip" data-fa="add" data-i="${i}" data-c="${esc(q.code)}">${esc(q.code)}${q.hint ? `<small>${esc(q.hint)}</small>` : ''}</button>`;
      const kpanel = st.open
        ? `<div class="fkey">
             <div class="fkrow"><span class="small">올리거나 내릴 반음</span>${[-2, -1, 1, 2, 3, 4].map((d) => `<button type="button" class="pchip kd ${st.d === d ? 'on' : ''}" data-fa="kd" data-i="${i}" data-d="${d}">${d > 0 ? '+' : ''}${d}</button>`).join('')}</div>
             <div class="fkrow"><label class="small" for="kto-${i}">또는 도착 키</label><select id="kto-${i}" data-kto="${i}"><option value="">고르지 않음</option>${KEYOPTS.map((k) => `<option value="${esc(k)}" ${st.to === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div>
             <div class="fkrow"><input type="text" data-kch="${i}" maxlength="30" placeholder="연결 코드 (선택) 예: D7 E" enterkeyhint="done" value="${esc(st.chords || '')}"></div>
             <div class="fkrow"><button type="button" class="btn small primary" data-fa="kadd" data-i="${i}">전조 칩 넣기</button><button type="button" class="btn small" data-fa="kclose" data-i="${i}">닫기</button></div>
           </div>`
        : '';
      return `<label>송폼</label>
        <div class="fseq">${seq}</div>${tools}${last}
        <div class="fpal">${palMain.map(palBtn).join('')}${st.more ? palRest.map(palBtn).join('') : ''}${palRest.length ? `<button type="button" class="pchip morebtn" data-fa="kmore" data-i="${i}">${st.more ? '접기' : '더 보기'}<small>${palRest.length}개</small></button>` : ''}<button type="button" class="pchip kcbtn ${st.open ? 'on' : ''}" data-fa="kopen" data-i="${i}">♯ 전조<small>키 변경</small></button></div>
        ${kpanel}
        <div class="fcustom"><input type="text" data-fcustom="${i}" maxlength="30" placeholder="그 밖의 구간 (예: 2절반복)" enterkeyhint="done"><button type="button" class="btn small" data-fa="addcustom" data-i="${i}">추가</button></div>`;
    }
    function draw(i) {
      const box = boxOf(i);
      if (!box) return;
      const old = box.querySelector('[data-fcustom]');
      const typed = old ? old.value : '';
      box.innerHTML = inner(i); // (전조 패널 값은 action 시작에서 이미 상태로 옮겨 두었다)
      const nu = box.querySelector('[data-fcustom]');
      if (nu && typed) nu.value = typed;
    }
    // 전조 패널의 도착 키·연결 코드는 다시 그리기 전에 상태로 옮겨 둔다
    function readK(i) {
      const box = boxOf(i);
      if (!box || !kst[i]) return;
      const t = box.querySelector('[data-kto]');
      const c = box.querySelector('[data-kch]');
      if (t) kst[i].to = t.value;
      if (c) kst[i].chords = c.value;
    }
    // tokens로 송폼을 바꾼다. 너무 길면 거부. 바꾸기 전 값은 되돌리기용으로 보관.
    function setForm(i, str) {
      const it = data.items[i];
      if (str.length > SongForm.MAX) {
        toast(`송폼이 너무 길어요. (최대 ${SongForm.MAX}자)`);
        return false;
      }
      it._undo = it._undo || [];
      it._undo.push(it.form);
      if (it._undo.length > 30) it._undo.shift();
      it.form = str;
      return true;
    }
    function action(a, i, b) {
      const it = data.items[i];
      if (!it) return;
      readK(i);
      const toks = SongForm.parse(it.form);
      let sel = formSel[i];
      if (sel !== undefined && toks[sel] === undefined) sel = undefined;
      if (a === 'sel') {
        const k = +b.dataset.k;
        if (sel === k) delete formSel[i];
        else formSel[i] = k;
      } else if (a === 'add' || a === 'addcustom' || a === 'kadd') {
        let add;
        if (a === 'add') add = [b.dataset.c];
        else if (a === 'kadd') {
          const st = kst[i] || {};
          const tok = SongForm.makeKeyChange({ delta: st.d, to: st.to, chords: st.chords });
          if (!tok) return toast('올릴 반음 수나 도착 키를 골라 주세요.');
          add = [tok];
        } else {
          const inp = host.querySelector(`[data-fcustom="${i}"]`);
          add = SongForm.parse(inp ? inp.value : '');
          if (!add.length) return;
          inp.value = '';
        }
        const at = sel !== undefined ? sel + 1 : toks.length;
        toks.splice(at, 0, ...add);
        if (!setForm(i, SongForm.format(toks))) return;
        if (a === 'kadd') kst[i] = { open: false, more: kst[i] && kst[i].more };
        if (sel !== undefined) formSel[i] = at + add.length - 1; // 선택이 새로 넣은 구간으로 따라가서 연달아 누르면 이어 붙는다
      } else if (a === 'kopen') {
        kst[i] = kst[i] && kst[i].open ? Object.assign(kst[i], { open: false }) : Object.assign(kst[i] || {}, { open: true });
      } else if (a === 'kmore') {
        kst[i] = Object.assign(kst[i] || {}, { more: !(kst[i] && kst[i].more) });
      } else if (a === 'kclose') {
        kst[i] = Object.assign(kst[i] || {}, { open: false });
      } else if (a === 'kd') {
        const d = +b.dataset.d;
        kst[i] = Object.assign(kst[i] || { open: true }, { d: kst[i] && kst[i].d === d ? undefined : d });
      } else if (a === 'left' || a === 'right') {
        const j = a === 'left' ? sel - 1 : sel + 1;
        if (sel === undefined || j < 0 || j >= toks.length) return;
        [toks[sel], toks[j]] = [toks[j], toks[sel]];
        if (!setForm(i, SongForm.format(toks))) return;
        formSel[i] = j;
      } else if (a === 'dup') {
        if (sel === undefined) return;
        toks.splice(sel + 1, 0, toks[sel]);
        if (!setForm(i, SongForm.format(toks))) return;
        formSel[i] = sel + 1;
      } else if (a === 'rep') {
        if (sel === undefined) return;
        toks[sel] = SongForm.cycleRepeat(toks[sel]);
        if (!setForm(i, SongForm.format(toks))) return;
      } else if (a === 'del') {
        if (sel === undefined) return;
        toks.splice(sel, 1);
        if (!setForm(i, SongForm.format(toks))) return;
        delete formSel[i];
      } else if (a === 'undo') {
        if (!it._undo || !it._undo.length) return;
        it.form = it._undo.pop();
        delete formSel[i];
      } else if (a === 'clear') {
        if (!setForm(i, '')) return;
        delete formSel[i];
      } else if (a === 'last') {
        if (!lastForms[it.song_id] || !setForm(i, lastForms[it.song_id])) return;
        delete formSel[i];
      }
      draw(i);
      if (opts.onChange) opts.onChange(i);
    }
    // 직접 입력칸·연결 코드 칸에서 Enter 를 누르면 "추가"
    host.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (ev.key !== 'Enter' || !t.dataset) return;
      if (t.dataset.fcustom !== undefined) { ev.preventDefault(); action('addcustom', +t.dataset.fcustom, t); }
      else if (t.dataset.kch !== undefined) { ev.preventDefault(); action('kadd', +t.dataset.kch, t); }
    });
    return {
      inner,
      draw,
      action,
      reset() { formSel = {}; },
      bind() {
        host.addEventListener('click', (ev) => {
          const fb = ev.target.closest && ev.target.closest('button[data-fa]');
          if (fb) action(fb.dataset.fa, +fb.dataset.i, fb);
        });
      },
    };
  }

  async function viewEdit(id, q) {
    if (!me.canEdit) {
      $app.innerHTML = `<div class="card"><p>악보를 편집할 권한이 없습니다.</p>
        <p class="muted small">관리자이거나, 관리자가 악보 편집 권한을 켜 준 팀의 팀장만 악보를 등록·수정할 수 있습니다.</p>
        ${me.adminRequired ? lockBtn('song', 'PIN 입력', location.hash || '#/songs', 'primary') + ' ' : '<p class="error">관리자 PIN(ADMIN_PIN)이 설정되어 있지 않아 아무도 편집할 수 없습니다. 설치 안내를 확인해 주세요.</p>'}<a class="btn" href="#/songs">목록</a></div>`;
      return;
    }
    document.querySelector('main').classList.add('wide');
    let song = { title: '', orig_title: '', lyrics_extra: '', artist: '', original_key: '', tempo: '', time_sig: '', base_form: '', youtube_url: '', tags: '', chordpro: '', memo: '' };
    if (id) song = (await api('/songs/' + id)).song;
    else if (q && q.get('title')) song.title = q.get('title').slice(0, 200); // 목록에서 "새 곡으로 등록"으로 넘어온 검색어
    const tagInfo = await api('/tags');
    document.title = (id ? '편집 · ' + song.title : '새 곡') + ' · Everyday Worship Songbook';
    const keyOptions = ['', ...KEYS_MAJOR, ...KEYS_MINOR];

    $app.innerHTML = `
      <div class="editbar"><a href="${id ? '#/song/' + id : '#/songs'}" class="small">← ${id ? '곡 보기' : '목록'}</a><h2>${id ? '악보 편집' : '새 곡 등록'}</h2><button class="btn primary small" id="save2" type="button">저장</button></div>
      <div class="edit-wrap">
        <div class="refdock" id="refdock" hidden>
          <div class="rd-bar"><b>원본 악보</b><span class="muted small">보면서 가사·코드를 입력해요</span><button type="button" class="btn small" id="rdclose">닫기</button></div>
          <div class="rd-body" id="rdbody"></div>
        </div>
        <div>
          <div class="card">
            <label for="title">제목</label><input id="title" type="text" value="${esc(song.title)}">
            <div class="hint" id="extfind" style="margin:6px 0 0"></div>
            <label for="otitle">원제 (원곡이 영어 등일 때 · 선택)</label><input id="otitle" type="text" placeholder="예: The Heart of Worship" value="${esc(song.orig_title)}">
            <div class="grid2">
              <div><label for="artist">아티스트</label><input id="artist" type="text" value="${esc(song.artist)}"></div>
              <div><label for="key">원래 키</label><select id="key">${keyOptions.map((k) => `<option value="${k}" ${k === song.original_key ? 'selected' : ''}>${k || '(모름)'}</option>`).join('')}</select></div>
            </div>
            <label for="tsig-o">박자 <span class="hint" style="margin:0">때에 따라 다르면 여러 개 고를 수 있어요</span></label>
            <div class="chips tsig-chips" id="tsigchips"></div>
            <input id="tsig" type="hidden" value="${esc(song.time_sig || '')}">
            <details class="moreinfo" id="bfdet" ${song.base_form ? 'open' : ''}>
              <summary>기본 송폼 · 전조 <span class="muted small">콘티에 곡을 넣을 때 미리 채워져요</span></summary>
              <div class="hint" style="margin:6px 0 0">늘 같은 순서로 부르는 곡이면 송폼을 적어 두세요. 언제나 전조되는 곡은 ♯ 전조 칩을 넣어 두면 됩니다. 콘티마다 따로 고칠 수도 있어요.</div>
              <div id="bformhost"><div class="formed" data-i="0"></div></div>
              <input id="bform" type="hidden" value="${esc(song.base_form || '')}">
            </details>
            <label for="tags">태그 (쉼표로 구분 · 아래 추천 칩을 눌러도 돼요)</label><input id="tags" type="text" placeholder="경배, 빠른곡" value="${esc(song.tags)}">
            <div id="tagchips"></div>
            <details class="moreinfo" id="moreinfo" ${song.tempo || song.youtube_url || song.memo || song.lyrics_extra ? 'open' : ''}>
              <summary>더 적을 정보 <span class="muted small">템포 · 유튜브 · 메모 · 검색용 가사</span></summary>
              <label for="tempo">템포(BPM)</label><input id="tempo" type="number" inputmode="numeric" min="20" max="300" value="${esc(song.tempo || '')}">
              <label for="yt">유튜브 링크</label><input id="yt" type="url" placeholder="https://" value="${esc(song.youtube_url)}">
              <label for="memo">메모</label><textarea id="memo" rows="2">${esc(song.memo)}</textarea>
              <label for="lx">검색용 가사 · 후렴 (선택)</label><textarea id="lx" rows="3" placeholder="후렴 한두 줄을 적어 두면 가사로 검색돼요">${esc(song.lyrics_extra)}</textarea>
              <div class="hint">코드 악보 본문의 가사는 자동으로 검색됩니다. <b>이미지·PDF 악보만 있는 곡</b>은 가사가 글자로 없어서 검색되지 않으니, 후렴 몇 줄을 여기에 적어 주세요. (악보 화면에는 보이지 않고 검색에만 쓰입니다)</div>
            </details>
          </div>
          <div class="card">
            <div id="draftbar" class="draftbar" hidden></div>
            <div class="row between" style="margin-bottom:8px"><span class="lbl-like">악보 본문</span></div>
            <div class="row" style="margin:0 0 8px;flex-wrap:wrap"><button type="button" class="btn small" id="refbtn">📖 원본 악보 옆에 놓기</button><button type="button" class="btn small" id="pastebtn">📋 가사 붙여넣기로 시작</button><button type="button" class="btn small" id="convbtn">🪄 이미지에서 코드 악보 만들기</button><button type="button" class="btn small" id="repbtn">↻ 반복 구간 정리</button></div>
            <div id="cv-note" class="cv-note hint" hidden></div>
            <div id="tabpane" class="te">
              <div id="te-lines" class="te-lines"></div>
              <div class="te-pal" id="te-pal"></div>
            </div>
            <textarea id="cp" hidden aria-hidden="true">${esc(song.chordpro)}</textarea>
            <div id="cpcheck" class="cpcheck" hidden></div>
          </div>
          <div class="card">
            <h2>이미지·PDF 악보</h2>
            <p class="hint">악보 사진이나 PDF를 그대로 올릴 수 있습니다. 코드 악보와 함께 두거나, 이것만 올려도 됩니다. 사진은 올리기 전에 자동으로 줄여서 저장합니다. 여러 장은 올린 순서대로 보입니다.</p>
            <div class="file-list" id="files"></div>
            <p class="hint" id="fnote" hidden>새 곡은 <b>저장</b>할 때 함께 올라갑니다.</p>
            <input type="file" id="fi" accept="image/*,application/pdf" multiple hidden>
            <div class="row"><button class="btn" id="addfile" type="button">+ 이미지·PDF 추가</button><span class="muted small" id="fstat"></span></div>
          </div>
          <p class="error" id="err"></p>
          <div class="row">
            <button class="btn primary" id="save">저장</button>
            <a class="btn" href="${id ? '#/song/' + id : '#/songs'}">취소</a>
            ${id ? '<button class="btn danger" id="del" style="margin-left:auto">삭제</button>' : ''}
          </div>
        </div>
        <div>
          <h2>미리보기</h2>
          <div class="preview"><div class="score" id="pv" style="padding-bottom:10px"></div></div>
        </div>
      </div>`;

    const $ = (s) => document.getElementById(s);
    const pvKey = () => $('key').value;
    function preview() {
      document.documentElement.style.setProperty('--song-size', '17px');
      const parsed = Chord.parseChordPro($('cp').value);
      const gk = Chord.guessKey(parsed, pvKey());
      $('pv').innerHTML = Chord.renderHTML(parsed, { originalKey: gk.key, showChords: true, names: 'full', refs: 'mark' }) || '<p class="muted">본문을 입력하면 여기에 악보가 나타납니다.</p>';
    }
    $('cp').addEventListener('input', preview);
    $('key').addEventListener('change', preview);
    preview();

    const ta = $('cp'); // 숨은 글자 칸: 악보 본문(ChordPro)의 진짜 내용. 탭 편집기가 읽고 다시 써 넣는다.

    // ----- 저장 전 점검(실시간 표시) -----
    function runCheck() {
      if (!ta.isConnected) return [];
      const r = ChordEdit.check(ta.value, $('key').value);
      const el = $('cpcheck');
      if (!r.length) { el.hidden = true; el.innerHTML = ''; return r; }
      const shown = r.slice(0, 8);
      el.hidden = false;
      el.innerHTML =
        `<b>점검 결과</b> <span class="muted small">(저장은 막지 않아요)</span><ul>` +
        shown.map((x) => `<li class="${x.level}">${x.line ? `<button type="button" class="linkish" data-line="${x.line}">${x.line}줄</button> ` : ''}${esc(x.msg)}</li>`).join('') +
        (r.length > shown.length ? `<li class="muted">… 외 ${r.length - shown.length}건</li>` : '') + '</ul>';
      return r;
    }
    $('cpcheck').onclick = (ev) => {
      const b = ev.target.closest('button[data-line]');
      if (!b) return;
      const rows = $('te-lines').querySelectorAll('.te-row');
      const row = rows[Math.min(+b.dataset.line, rows.length) - 1];
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1600);
    };
    let checkTimer;
    const scheduleCheck = () => { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 500); };
    ta.addEventListener('input', scheduleCheck);
    $('key').addEventListener('change', scheduleCheck);
    runCheck();

    // ----- 탭 편집기 (7차 B단계): 가사를 악보 모양으로 보여 주고, 글자를 탭해 코드를 얹는다. 저장 형식은 ChordPro 글자 그대로 -----
    // 글자 칸(#cp)이 항상 "진짜 내용"이다. 탭 편집은 그 글자를 읽어 고친 뒤 다시 써 넣는다. (손대지 않은 줄은 원문 그대로)
    let tm = TabEdit.parse(ta.value);
    let tsel = null; // {li, pos, ci}  ci>=0 이면 코드가 선택된 것, -1이면 빈 자리
    let undoS = [], redoS = [];
    ls.del('ews_edit_mode'); // 예전의 "글자로 보기" 선택값은 더 쓰지 않는다
    const keyNow = () => Chord.guessKey(Chord.parseChordPro(ta.value), $('key').value);
    const fireInput = () => ta.dispatchEvent(new Event('input', { bubbles: true }));
    function setBody(text, nextSel, noUndo) {
      if (!noUndo) { undoS.push(ta.value); if (undoS.length > 60) undoS.shift(); redoS = []; }
      ta.value = text;
      fireInput();
      tm = TabEdit.parse(text);
      tsel = nextSel || null;
      teRender();
    }
    const apply = (res, sel) => { if (res) setBody(TabEdit.serialize(res.model || res), sel); };
    function tabRefresh() { tm = TabEdit.parse(ta.value); tsel = null; teRender(); }

    function teRender() {
      if (!ta.isConnected) return;
      const box = $('te-lines');
      let html = '';
      if (!ta.value.trim()) {
        html = `<div class="te-empty"><p><b>아직 악보가 없어요.</b></p><p class="muted small">가사를 붙여넣어 구간을 나누거나, 줄을 하나씩 추가해서 시작하세요.</p></div>`;
      } else {
        let inCh = false;
        tm.lines.forEach((l, li) => {
          const gut = `<button type="button" class="te-gut" data-gut="${li}" aria-label="${li + 1}번째 줄 메뉴">⋯</button>`;
          if (l.kind === 'soc') inCh = true;
          const ch = inCh && l.kind !== 'soc' && l.kind !== 'eoc' ? ' chorus' : '';
          let body;
          if (l.kind === 'lyric') {
            const byPos = new Map();
            l.chords.forEach((c, ci) => { if (!byPos.has(c.pos)) byPos.set(c.pos, []); byPos.get(c.pos).push({ c: c.c, ci }); });
            const cell = (p, glyph, extra) => {
              const cs = byPos.get(p) || [];
              const sel = tsel && tsel.li === li && tsel.pos === p;
              return `<span class="tc${extra || ''}${cs.length ? ' has' : ''}${sel && tsel.ci < 0 ? ' sel' : ''}" data-li="${li}" data-p="${p}"><span class="tch">${cs
                .map((x) => `<b class="tk${sel && tsel.ci === x.ci ? ' sel' : ''}" data-ci="${x.ci}">${esc(x.c || '·')}</b>`)
                .join('')}</span><span class="tl">${glyph}</span></span>`;
            };
            let cells = '';
            [...l.text].forEach((c, i) => { cells += cell(i, c === ' ' ? '&nbsp;' : esc(c), c === ' ' ? ' sp' : ''); });
            cells += cell(l.text.length, '＋', ' tend');
            body = `<div class="te-ln">${cells}</div>`;
          } else if (l.kind === 'comment') {
            const lc = Sections.canon(l.label);
            body = `<div class="te-lab">${lc ? `${esc(Sections.display(lc.id, 'full'))}${lc.rest ? ' ' + esc(lc.rest) : ''}<small>${esc(lc.id)}</small>` : esc(l.label || '(이름 없음)')}</div>`;
          } else if (l.kind === 'ref') {
            const rc = Sections.canon(l.id);
            const ok = !!rc && !!TabEdit.refSource(tm, li);
            body = `<div class="te-ref${ok ? '' : ' orphan'}">↻ ${esc(rc ? Sections.display(rc.id, 'full') : l.id || '(이름 없음)')}${l.rest ? ' ' + esc(l.rest) : ''}<small>${ok ? '위와 같음 · ⋯에서 펼쳐서 따로 쓸 수 있어요' : rc ? '같은 이름의 구간이 없어요' : '이름을 알아볼 수 없어요'}</small></div>`;
          } else if (l.kind === 'soc' || l.kind === 'eoc') {
            body = `<div class="te-soc">${l.kind === 'soc' ? '후렴 시작' : '후렴 끝'}</div>`;
          } else if (l.kind === 'colb') {
            body = `<div class="te-colb">↦ 여기서 오른쪽 단으로 (2단 보기)</div>`;
          } else if (l.kind === 'blank') {
            body = `<div class="te-gap"></div>`;
          } else {
            body = `<div class="te-raw">${esc(l.raw)}<small> · 줄 메뉴(⋯)에서 고칠 수 있어요</small></div>`;
          }
          html += `<div class="te-row${ch}${l.kind === 'blank' ? ' blank' : ''}">${gut}${body}</div>`;
          if (l.kind === 'eoc') inCh = false;
        });
      }
      html += `<div class="row" style="margin-top:8px"><button type="button" class="btn small" data-op="addend">＋ 맨 끝에 가사 줄 추가</button><button type="button" class="btn small" data-op="addsec">＋ 맨 끝에 구간 · 자리표시</button></div>`;
      box.innerHTML = html;
      tePalette();
      // 고른 글자가 아래 고정 팔레트에 가려지지 않게, 가려지면 화면을 살짝 올린다
      if (tsel) requestAnimationFrame(() => {
        const el = box.querySelector('.tk.sel, .tc.sel');
        const pal = $('te-pal');
        if (!el || !pal) return;
        const r = el.getBoundingClientRect(), pr = pal.getBoundingClientRect();
        if (r.bottom > pr.top - 10 && r.top < pr.bottom) window.scrollBy({ top: r.bottom - pr.top + 14 });
      });
    }

    function tePalette() {
      const pal = $('te-pal');
      if (!pal) return;
      const l = tsel ? tm.lines[tsel.li] : null;
      const chordSel = l && l.kind === 'lyric' && tsel.ci >= 0 ? l.chords[tsel.ci] : null;
      const gk = keyNow();
      const dia = ChordEdit.diatonic(gk.key);
      const roots = dia || ['C', 'D', 'E', 'F', 'G', 'A', 'B'].map((c) => ({ label: '', chord: c }));
      let status;
      if (chordSel) status = `<b>${esc(chordSel.c || '·')}</b> 선택 · 코드를 누르면 바뀌어요`;
      else if (l && l.kind === 'lyric') {
        const ch = l.text[tsel.pos];
        status = `${ch ? '“' + esc(ch.trim() ? ch : '띄어쓰기') + '” 앞' : '줄 끝'} · 코드를 고르세요`;
      } else status = '코드를 붙일 글자를 탭하세요';
      let h = `<div class="te-pal-row te-top"><button type="button" class="chip ctb sm" data-act="undo" aria-label="되돌리기" ${undoS.length ? '' : 'disabled'}>↶</button><button type="button" class="chip ctb sm" data-act="redo" aria-label="다시 하기" ${redoS.length ? '' : 'disabled'}>↷</button><span class="te-status">${status}</span></div>`;
      h += `<div class="te-pal-row">${roots.map((d) => `<button type="button" class="chip ctb" data-pc="${esc(d.chord)}"><b>${esc(d.chord)}</b>${d.label ? `<small>${esc(d.label)}</small>` : ''}</button>`).join('')}<button type="button" class="chip ctb" data-pc="?" title="불확실한 코드">?</button><button type="button" class="chip ctb sm" data-act="direct">다른 코드…</button></div>`;
      if (chordSel) {
        const chordOnly = !l.text.trim();
        h += `<div class="te-pal-row"><button type="button" class="chip ctb sm" data-act="left">◀</button><button type="button" class="chip ctb sm" data-act="right">▶</button><button type="button" class="chip ctb sm" data-act="more">${chordOnly ? '＋ 코드 이어 붙이기' : '＋ 같은 자리에 하나 더'}</button><button type="button" class="chip ctb sm danger" data-act="del">코드 삭제</button></div>`;
        const bn = ChordEdit.bassNotes(gk.key);
        h += `<div class="te-pal-row"><span class="ctl-label">모양</span>${ChordEdit.QUALITIES.map(([q, lab]) => `<button type="button" class="chip ctb sm" data-pq="${esc(q)}">${esc(lab)}</button>`).join('')}${bn ? `<span class="ctl-label">베이스</span>${bn.map((n) => `<button type="button" class="chip ctb sm" data-pb="${esc(n)}">/${esc(n)}</button>`).join('')}<button type="button" class="chip ctb sm" data-pb="">없음</button>` : ''}</div>`;
      }
      pal.innerHTML = h;
    }

    // 코드 하나 적용: 선택된 것이 코드면 바꾸고, 빈 자리면 넣는다
    function putChord(chord) {
      if (!tsel) { toast('먼저 코드를 붙일 글자를 탭하세요.'); return; }
      if (!TabEdit.parseLyric('[' + chord + ']')) return;
      const l = tm.lines[tsel.li];
      if (!l || l.kind !== 'lyric') { toast('가사 줄에서 글자를 탭해 주세요.'); return; }
      const r = tsel.ci >= 0 ? TabEdit.replaceChord(tm, tsel.li, tsel.ci, chord) : TabEdit.addChord(tm, tsel.li, tsel.pos, chord);
      if (r) apply(r, { li: tsel.li, pos: tsel.ci >= 0 ? l.chords[tsel.ci].pos : tsel.pos, ci: r.ci });
    }
    function selectedChord() {
      const l = tsel && tm.lines[tsel.li];
      return l && l.kind === 'lyric' && tsel.ci >= 0 ? l.chords[tsel.ci] : null;
    }

    $('tabpane').addEventListener('click', (ev) => {
      const t = ev.target;
      const gut = t.closest('[data-gut]');
      if (gut) { lineSheet(+gut.dataset.gut); return; }
      const op = t.closest('[data-op]');
      if (op && op.dataset.op === 'addend') { newLinesSheet(tm.lines.length - 1); return; }
      if (op && op.dataset.op === 'addsec') { endSheet(); return; }
      const tc = t.closest('.tc');
      if (tc && $('te-lines').contains(tc)) {
        const li = +tc.dataset.li, pos = +tc.dataset.p;
        const l = tm.lines[li];
        const k = t.closest('.tk');
        let ci = -1;
        if (k) ci = +k.dataset.ci;
        else if (tc.classList.contains('has')) ci = l.chords.findIndex((c) => c.pos === pos);
        tsel = { li, pos, ci };
        teRender();
        return;
      }
      const pc = t.closest('[data-pc]');
      if (pc) { putChord(pc.dataset.pc); return; }
      const pq = t.closest('[data-pq]');
      const pb = t.closest('[data-pb]');
      if (pq || pb) {
        const cur = selectedChord();
        const nc = cur && TabEdit.reshape(cur.c, pq ? { quality: pq.dataset.pq } : { bass: pb.dataset.pb });
        if (!nc) { toast('코드 모양이 아니라서 바꿀 수 없어요. 다른 코드를 눌러 바꿔 주세요.'); return; }
        const r = TabEdit.replaceChord(tm, tsel.li, tsel.ci, nc);
        apply(r, { li: tsel.li, pos: tsel.pos, ci: r.ci });
        return;
      }
      const act = t.closest('[data-act]');
      if (!act || act.disabled) return;
      const a = act.dataset.act;
      if (a === 'undo' || a === 'redo') {
        const from = a === 'undo' ? undoS : redoS, to = a === 'undo' ? redoS : undoS;
        if (!from.length) return;
        to.push(ta.value);
        setBody(from.pop(), null, true);
        return;
      }
      if (a === 'direct') { directSheet(); return; }
      const cur = selectedChord();
      if (!cur) return;
      const l = tm.lines[tsel.li];
      if (a === 'left' || a === 'right') {
        const r = TabEdit.moveChord(tm, tsel.li, tsel.ci, a === 'left' ? -1 : 1);
        if (!r || !r.moved) { toast(a === 'left' ? '줄 맨 앞이에요.' : '줄 맨 끝이에요.'); return; }
        apply(r, { li: tsel.li, pos: cur.pos + (a === 'left' ? -1 : 1), ci: r.ci });
      } else if (a === 'del') {
        apply(TabEdit.deleteChord(tm, tsel.li, tsel.ci), { li: tsel.li, pos: cur.pos, ci: -1 });
      } else if (a === 'more') {
        const chordOnly = !l.text.trim();
        const r = chordOnly ? TabEdit.appendChord(tm, tsel.li, '?') : TabEdit.addChord(tm, tsel.li, cur.pos, '?');
        if (r) apply(r, { li: tsel.li, pos: r.model.lines[tsel.li].chords[r.ci].pos, ci: r.ci });
      }
    });

    // 직접 고르는 코드 창(키 밖의 코드, 복잡한 코드)
    function directSheet() {
      if (!tsel) { toast('먼저 코드를 붙일 글자를 탭하세요.'); return; }
      const flats = Chord.keyUsesFlats(keyNow().key);
      const roots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => Chord.noteName(i, flats));
      const st = { root: '', q: '', bass: '' };
      const sh = showSheet(`
        <h2 style="margin-top:0">다른 코드</h2>
        <div class="te-pal-row wrap"><span class="ctl-label">음</span>${roots.map((r) => `<button type="button" class="chip ctb sm" data-r="${r}">${r}</button>`).join('')}</div>
        <div class="te-pal-row wrap"><span class="ctl-label">모양</span>${ChordEdit.QUALITIES.map(([q, lab]) => `<button type="button" class="chip ctb sm" data-q="${esc(q)}">${esc(lab)}</button>`).join('')}</div>
        <div class="te-pal-row wrap"><span class="ctl-label">베이스</span>${roots.map((r) => `<button type="button" class="chip ctb sm" data-b="${r}">/${r}</button>`).join('')}<button type="button" class="chip ctb sm" data-b="">없음</button></div>
        <label for="dc-in">만들어진 코드 (직접 고쳐도 돼요)</label><input id="dc-in" type="text" autocapitalize="off" autocomplete="off" spellcheck="false">
        <p class="error" id="dc-err"></p>
        <div class="row"><button type="button" class="btn primary" id="dc-ok">넣기</button><button type="button" class="btn" id="dc-no">닫기</button></div>`);
      const inp = sh.q('#dc-in');
      const compose = () => { inp.value = st.root ? st.root + st.q + (st.bass ? '/' + st.bass : '') : ''; };
      sh.wrap.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.r !== undefined) st.root = b.dataset.r;
        else if (b.dataset.q !== undefined) st.q = b.dataset.q;
        else if (b.dataset.b !== undefined) st.bass = b.dataset.b;
        else if (b.id === 'dc-no') { sh.close(); return; }
        else if (b.id === 'dc-ok') {
          const v = inp.value.trim();
          if (!v || !ChordEdit.isChord(v)) { sh.q('#dc-err').textContent = '코드 모양이 아니에요. 예: G, Am7, D/F#, Csus4'; return; }
          sh.close();
          putChord(v);
          return;
        } else return;
        sh.wrap.querySelectorAll('[data-r],[data-q],[data-b]').forEach((x) => {
          const on = (x.dataset.r !== undefined && x.dataset.r === st.root) || (x.dataset.q !== undefined && x.dataset.q === st.q && st.root) || (x.dataset.b !== undefined && x.dataset.b === st.bass && st.root);
          x.classList.toggle('on', !!on);
        });
        compose();
      });
    }

    // 앱이 모르는 모양의 줄(주석·특수 지시어 등)을 글자 그대로 고치는 창
    function rawSheet(li) {
      const l = tm.lines[li];
      if (!l) return;
      const sh = showSheet(`<h2 style="margin-top:0">${li + 1}번째 줄 글자 고치기</h2>
        <input id="rw-in" type="text" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(l.raw)}">
        <p class="hint">한 줄만 고칠 수 있어요. 비우고 저장하면 빈 줄이 됩니다.</p>
        <div class="row"><button type="button" class="btn primary" id="rw-ok">저장</button><button type="button" class="btn" id="rw-no">닫기</button></div>`);
      const inp = sh.q('#rw-in');
      sh.q('#rw-no').onclick = () => sh.close();
      sh.q('#rw-ok').onclick = () => { const v = inp.value; sh.close(); apply(TabEdit.replaceLine(tm, li, v)); };
    }

    const secChips = () => `<div class="te-pal-row wrap">${TabEdit.SECTION_NAMES.map((n) => `<button type="button" class="chip ctb sm" data-sec="${esc(n)}">${esc(n)}${Sections.display(n, 'full') !== n ? `<small>${esc(Sections.display(n, 'full'))}</small>` : ''}</button>`).join('')}</div>`;
    // 앞 구간 자리표시 칩: 이미 나온 구간 이름 중에서 고른다
    const refChips = () => {
      const used = TabEdit.usedSectionIds(tm);
      return used.length ? `<p class="mlabel">↻ 앞 구간 자리표시 <small class="muted">(같은 구간을 다시 쓰지 않고 위치만 표시)</small></p><div class="te-pal-row wrap">${used.map((n) => `<button type="button" class="chip ctb sm" data-refsec="${esc(n)}">↻ ${esc(n)}</button>`).join('')}</div>` : '';
    };
    // 곡 맨 끝에 구간 이름표나 자리표시 넣기 (마지막 가사 아래에는 빈 줄이 없어서 줄 메뉴로는 못 넣던 자리)
    function endSheet() {
      const sh = showSheet(`<h2 style="margin-top:0">맨 끝에 넣기</h2>
        <p class="hint" style="margin:0 0 4px">구간 이름 <small class="muted">(이어서 가사 줄을 추가하세요)</small></p>${secChips()}${refChips()}
        <div class="row" style="margin-top:12px"><button type="button" class="btn" data-op="close">닫기</button></div>`);
      sh.wrap.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        const end = tm.lines.length;
        if (b.dataset.refsec !== undefined) { sh.close(); apply(TabEdit.insertRef(tm, end, b.dataset.refsec)); return; }
        if (b.dataset.sec !== undefined) { sh.close(); apply(TabEdit.insertSection(tm, end, b.dataset.sec)); toast('구간 이름을 넣었어요. “＋ 맨 끝에 가사 줄 추가”로 이어서 쓰세요.'); return; }
        if (b.dataset.op === 'close') sh.close();
      });
    }

    // 줄 메뉴(왼쪽 ⋯)
    function lineSheet(li) {
      const l = tm.lines[li];
      if (!l) return;
      let below = false; // 구간·자리표시를 이 줄 아래에 넣을지(기본: 위)
      // "이 구간을 자리표시로": 같은 이름의 구간이 앞에 있을 때만
      const toRefOk = (() => { const r = TabEdit.sectionToRef(tm, li); return !!(r && (r.model || r.diff)); })();
      const inCh = TabEdit.isInChorus(tm, li);
      // 반복 구간 코드 복사: 같은 가사 줄이 있으면 줄 복사, 코드가 달린 다른 구간이 있으면 구간 복사를 보여 준다
      const sameLi = TabEdit.findSameLyric(tm, li);
      const allBlocks = TabEdit.bodyBlocks(tm);
      const myBlock = allBlocks.find((b) => li >= b.a && li <= b.b);
      const colAt = TabEdit.colBreakAt(tm, li);
      const colTile = (T) => (colAt >= 0 ? T('colb-off', '↤', '단 나누기 지우기') : T('colb', '↦', '여기부터 다음 단<small>2단 보기</small>'));
      const canCopyBlock = !!myBlock && allBlocks.some((b) => b !== myBlock && b.chordLines > 0);
      let h = `<h2 style="margin-top:0">${li + 1}번째 줄</h2>`;
      if (l.kind === 'lyric') {
        const T = (op, ic, txt, cls) => `<button type="button" class="btn mtile ${cls || ''}" data-op="${op}"><span class="mi">${ic}</span><span>${txt}</span></button>`;
        h += `<div class="mgrid">
          ${T('edit', '✏️', '가사 고치기')}
          ${T('chorus', '🔁', inCh ? '후렴 끄기' : '후렴으로 표시')}
          ${sameLi >= 0 ? T('copy-same', '↺', `같은 가사 코드 복사<small>${sameLi + 1}번째 줄에서</small>`) : ''}
          ${canCopyBlock ? T('copy-block', '↺', '구간 코드 복사<small>다른 구간에서</small>') : ''}
        </div>
        <p class="mlabel">추가</p>
        <div class="mgrid">
          ${T('add', '＋', '아래에 가사 줄')}
          ${T('gap', '＋', '위에 빈 줄')}
          ${T('instr-up', '🎸', '위에 코드 줄<small>간주·인트로</small>')}
          ${T('instr-dn', '🎸', '아래에 코드 줄<small>간주·인트로</small>')}
          ${colTile(T)}
        </div>
        ${toRefOk ? `<div class="mgrid">${T('to-ref', '↻', '이 구간을 자리표시로<small>앞 구간과 같을 때</small>')}</div>` : ''}
        <details class="mdet"><summary>구간 이름 · 자리표시 넣기 (V1 · C · B …)</summary>
          <p class="mlabel">넣을 자리</p>
          <div class="row" style="gap:6px"><button type="button" class="seg on" data-pos="up">이 줄 위</button><button type="button" class="seg" data-pos="dn">이 줄 아래</button></div>
          ${secChips()}${refChips()}</details>
        <p class="mlabel">정리</p>
        <div class="mgrid">
          ${l.chords.length ? T('clear', '🧹', '코드 모두 지우기') : ''}
          ${T('del', '🗑', '이 줄 삭제', 'danger')}
        </div>`;
      } else if (l.kind === 'comment') {
        h += `<p class="hint" style="margin:0 0 4px">이름 바꾸기</p>${secChips()}
          ${toRefOk ? `<div class="mgrid" style="margin-top:6px">${(() => { const T = (op, ic, txt) => `<button type="button" class="btn mtile" data-op="${op}"><span class="mi">${ic}</span><span>${txt}</span></button>`; return T('to-ref', '↻', '이 구간을 자리표시로<small>앞 구간과 같을 때</small>'); })()}</div>` : ''}
          <div class="menu-col" style="margin-top:8px"><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button><button type="button" class="btn" data-op="${colAt >= 0 ? 'colb-off' : 'colb'}">${colAt >= 0 ? '↤ 단 나누기 지우기' : '↦ 이 구간부터 다음 단'}</button><button type="button" class="btn danger" data-op="del">이 이름표 삭제</button></div>`;
      } else if (l.kind === 'colb') {
        h += `<p class="hint">2단 보기에서 이 줄 아래부터 오른쪽 단에 나와요. 1단으로 볼 때는 보이지 않아요.</p>
          <div class="menu-col"><button type="button" class="btn danger" data-op="del">단 나누기 지우기</button></div>`;
      } else if (l.kind === 'soc' || l.kind === 'eoc') {
        h += `<div class="menu-col"><button type="button" class="btn" data-op="chorus">후렴 표시 끄기</button><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button></div>`;
      } else if (l.kind === 'ref') {
        const hasSrc = !!TabEdit.refSource(tm, li);
        h += `<p class="hint" style="margin:0 0 6px">앞에 나온 <b>${esc(l.id)}</b> 구간을 여기서 다시 보여 주는 자리표시예요. 원본을 고치면 여기도 함께 바뀌어요.</p>
          <div class="menu-col">${hasSrc ? '<button type="button" class="btn" data-op="ref-expand">✂ 펼쳐서 따로 쓰기 (원본과 따로 고치기)</button>' : ''}<button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button><button type="button" class="btn danger" data-op="del">자리표시 삭제</button></div>
          <p class="hint" style="margin:8px 0 4px">다른 구간 이름으로 바꾸기</p>${secChips()}`;
      } else if (l.kind === 'blank') {
        h += `<p class="hint" style="margin:0 0 4px">여기 아래에 구간 이름 넣기</p>${secChips()}${refChips()}
          <div class="menu-col" style="margin-top:8px"><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button><button type="button" class="btn danger" data-op="del">이 빈 줄 삭제</button></div>`;
      } else {
        h += `<p class="hint">앱이 모르는 모양의 줄이라 그대로 두었어요. 글자를 직접 고칠 수 있어요.</p>
          <div class="menu-col"><button type="button" class="btn" data-op="raw">줄 글자 직접 고치기</button><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button><button type="button" class="btn danger" data-op="del">이 줄 삭제</button></div>`;
      }
      h += `<div class="row" style="margin-top:12px"><button type="button" class="btn" data-op="close">닫기</button></div>`;
      const sh = showSheet(h);
      sh.wrap.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.pos) {
          below = b.dataset.pos === 'dn';
          sh.wrap.querySelectorAll('[data-pos]').forEach((x) => x.classList.toggle('on', x === b));
          return;
        }
        const refsec = b.dataset.refsec;
        if (refsec !== undefined) {
          sh.close();
          const at = l.kind === 'blank' ? li + 1 : below ? TabEdit.belowAt(tm, li) : li;
          apply(TabEdit.insertRef(tm, at, refsec));
          return;
        }
        const sec = b.dataset.sec;
        if (sec !== undefined) {
          sh.close();
          if (l.kind === 'comment') apply(TabEdit.replaceLine(tm, li, '{comment: ' + sec + '}'));
          else if (l.kind === 'ref') apply(TabEdit.replaceLine(tm, li, '{ref: ' + sec + '}'));
          else {
            const at = l.kind === 'blank' ? li + 1 : below ? TabEdit.belowAt(tm, li) : li;
            const r = TabEdit.insertSection(tm, at, sec);
            apply(r);
          }
          return;
        }
        const op = b.dataset.op;
        if (!op) return;
        sh.close();
        if (op === 'close') return;
        if (op === 'edit') lyricSheet(li, false);
        else if (op === 'add') newLinesSheet(li);
        else if (op === 'raw') rawSheet(li);
        else if (op === 'copy-same') {
          const r = TabEdit.copyLineChords(tm, li, sameLi, { overwrite: true });
          if (r) { apply(r); toast('코드를 복사했어요.'); }
        } else if (op === 'copy-block') blockCopySheet(li);
        else if (op === 'del') apply(TabEdit.deleteLine(tm, li));
        else if (op === 'to-ref') toRefSheet(li);
        else if (op === 'ref-expand') { const r = TabEdit.refToSection(tm, li); if (r) { apply(r); toast('펼쳐서 따로 쓸 수 있게 했어요. 이제 이 구간은 원본과 따로 고쳐져요.'); } }
        else if (op === 'clear') apply(TabEdit.clearChords(tm, li));
        else if (op === 'colb') { apply(TabEdit.setColBreak(tm, li)); toast('2단 보기에서 여기부터 오른쪽 단으로 넘어가요. (한 곡에 한 곳만 적용돼요)'); }
        else if (op === 'colb-off') { const ci = TabEdit.colBreakAt(tm, li); if (ci >= 0) apply(TabEdit.deleteLine(tm, ci)); }
        else if (op === 'gap') apply(TabEdit.insertLines(tm, li, ['']));
        else if (op === 'chorus') { const r = TabEdit.toggleChorus(tm, li); if (r) apply(r); else toast('후렴으로 표시할 가사 줄이 아니에요.'); }
        else if (op === 'instr-up' || op === 'instr-dn') {
          const at = op === 'instr-up' ? li : li + 1;
          const m2 = TabEdit.insertLines(tm, at, ['[?]']);
          setBody(TabEdit.serialize(m2), { li: at, pos: 0, ci: 0 });
          toast('아래 코드 중 하나를 누르면 바뀌어요. “＋ 코드 이어 붙이기”로 뒤에 더 붙일 수 있어요.');
        }
      });
    }
    // 이 구간을 자리표시로: 코드·가사가 같으면 바로, 다르면 무엇이 사라지는지 알려 주고 확인받는다
    function toRefSheet(li) {
      const r = TabEdit.sectionToRef(tm, li);
      if (r.model) { apply(r); toast('자리표시로 바꿨어요. 되돌리기(↶)로 취소할 수 있어요.'); return; }
      if (r.need === 'name') { toast('구간 이름(V1·C·B …)을 먼저 붙여 주세요.'); return; }
      if (r.need) { toast('앞에 같은 이름의 구간이 없어서 바꿀 수 없어요.'); return; }
      const sh = showSheet(`<h2 style="margin-top:0">자리표시로 바꿀까요?</h2>
        <p class="hint" style="margin:0 0 8px">이 구간의 코드·가사가 앞의 같은 이름 구간(${r.srcA + 1}번째 줄)과 달라요. 바꾸면 <b>이 구간에만 있는 코드·가사는 사라지고</b> 앞 구간과 같게 보여요. (되돌리기 ↶ 가능)</p>
        <div class="row"><button type="button" class="btn danger" id="tr-ok">그래도 바꾸기</button><button type="button" class="btn" id="tr-no">취소</button></div>`);
      sh.q('#tr-no').onclick = () => sh.close();
      sh.q('#tr-ok').onclick = () => { sh.close(); const r2 = TabEdit.sectionToRef(tm, li, { force: true }); if (r2.model) apply(r2); };
    }
    // 반복 구간 정리: 같은 이름 구간이 또 나오면 두 번째부터 자리표시로 바꾸자고 제안한다. 바뀔 곳을 미리 보여 준다.
    function repeatSheet() {
      const rows = TabEdit.repeatCandidates(tm);
      if (!rows.length) { toast('앞 구간과 이름이 같은 반복 구간이 없어요. (구간 이름이 있어야 찾을 수 있어요)'); return; }
      const sh = showSheet(`<h2 style="margin-top:0">반복 구간 정리</h2>
        <p class="hint" style="margin:0 0 8px">앞에 나온 구간과 이름이 같은 구간이에요. <b>두 번째부터 자리표시로 바꾸면</b> 한 번만 쓰고 고치면 돼요. 코드·가사가 달라 바꾸면 내용이 사라지는 곳은 처음엔 꺼져 있어요.</p>
        <div class="ps-blocks">${rows.map((r, i) => `<label class="ps-block rep"><input type="checkbox" data-i="${i}" ${r.same ? 'checked' : ''}><span class="grow"><b>${esc(Sections.display(r.id, 'full'))}</b> · ${r.a + 1}번째 줄 ${r.same ? '<span class="muted small">앞 구간과 똑같아요</span>' : `<span class="error small" style="margin:0">${esc(r.why)}</span>`}</span></label>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="rp-ok">선택한 구간을 자리표시로</button><button type="button" class="btn" id="rp-no">닫기</button></div>`);
      sh.q('#rp-no').onclick = () => sh.close();
      sh.q('#rp-ok').onclick = () => {
        const pick = [...sh.wrap.querySelectorAll('input[data-i]:checked')].map((c) => rows[+c.dataset.i]);
        sh.close();
        if (!pick.length) return;
        const r = TabEdit.collapseRepeats(tm, pick);
        apply(r);
        toast(`${r.n}곳을 자리표시로 바꿨어요. 되돌리기(↶)로 취소할 수 있어요.`);
      };
    }

    // 구간 코드 복사: 이 줄이 들어 있는 구간(덩어리)에, 코드가 달린 다른 구간의 코드를 줄 순서대로 복사한다
    function blockCopySheet(li) {
      const bl = TabEdit.bodyBlocks(tm);
      const dst = bl.find((b) => li >= b.a && li <= b.b);
      if (!dst) return;
      const name = (b) => b.label || '구간 ' + (bl.indexOf(b) + 1);
      // 줄 수가 같은 구간을 위로 (보통 1절 ↔ 2절)
      const srcs = bl.filter((b) => b !== dst && b.chordLines > 0).sort((x, y) => Math.abs(x.lines - dst.lines) - Math.abs(y.lines - dst.lines) || x.a - y.a);
      if (!srcs.length) { toast('코드가 달린 다른 구간이 아직 없어요.'); return; }
      const sh = showSheet(`<h2 style="margin-top:0">코드 복사</h2>
        <p class="hint" style="margin:0 0 8px"><b>${esc(name(dst))}</b>(${dst.lines}줄)에 어느 구간의 코드를 복사할까요? 줄 순서대로 대응하고, 글자 수가 다른 줄은 낱말 시작에 맞춰 얹어요.</p>
        ${srcs.map((b) => `<div class="team-row"><button type="button" class="team-pick" data-src="${b.a}"><span class="grow">${esc(name(b))} · ${b.lines}줄<br><small class="muted">${esc(b.first.slice(0, 18))}${b.first.length > 18 ? '…' : ''}</small></span></button></div>`).join('')}
        <label class="chk-row"><input type="checkbox" id="bc-ow"> 이미 코드가 있는 줄도 덮어쓰기</label>
        <p class="hint">복사한 뒤 어긋난 곳은 코드를 눌러 ◀ ▶로 한 글자씩 옮기면 돼요. 되돌리기(↶)로 취소할 수도 있어요.</p>
        <div class="row" style="margin-top:8px"><button type="button" class="btn" id="bc-no">닫기</button></div>`);
      sh.q('#bc-no').onclick = () => sh.close();
      sh.wrap.querySelectorAll('[data-src]').forEach(
        (b) =>
          (b.onclick = () => {
            const src = bl.find((x) => x.a === +b.dataset.src);
            const ow = sh.q('#bc-ow').checked;
            sh.close();
            const r = TabEdit.copyBlock(tm, src, dst, { overwrite: ow });
            if (!r.filled) { toast(r.skipped ? '이미 코드가 있는 줄이라 건너뛰었어요. “덮어쓰기”를 켜면 바꿔 줘요.' : '복사할 코드가 없었어요.'); return; }
            apply(r);
            toast(`${r.filled}줄에 코드를 복사했어요.${r.skipped ? ` (${r.skipped}줄은 이미 코드가 있어 건너뜀)` : ''}${r.extra ? ` (${r.extra}줄은 짝이 없어 비워 둠)` : ''}`);
          })
      );
    }
    // 가사 고치기(한 줄)
    function lyricSheet(li) {
      const l = tm.lines[li];
      const sh = showSheet(`<h2 style="margin-top:0">가사 고치기</h2>
        <p class="hint" style="margin:0 0 6px">코드는 글자를 따라가요. 바뀐 한가운데 있던 코드는 고친 자리 앞으로 모여요.</p>
        <textarea id="ly-in" rows="2" spellcheck="false">${esc(l.text)}</textarea>
        <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="ly-ok">고치기</button><button type="button" class="btn" id="ly-no">닫기</button></div>`);
      const inp = sh.q('#ly-in');
      setTimeout(() => inp.focus(), 50);
      sh.q('#ly-no').onclick = () => sh.close();
      sh.q('#ly-ok').onclick = () => {
        sh.close();
        apply(TabEdit.setLyricText(tm, li, inp.value.replace(/\n/g, ' ')));
      };
    }
    // 새 가사 줄 추가(여러 줄 한꺼번에 붙여넣어도 줄마다 나뉨). 기준 줄 li의 아래에 들어간다.
    function newLinesSheet(li) {
      const sh = showSheet(`<h2 style="margin-top:0">가사 줄 추가</h2>
        <p class="hint" style="margin:0 0 6px">여러 줄을 붙여넣으면 줄마다 나뉘어 들어가요.</p>
        <textarea id="nl-in" rows="4" spellcheck="false" placeholder="가사"></textarea>
        <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="nl-ok">추가</button><button type="button" class="btn" id="nl-no">닫기</button></div>`);
      const inp = sh.q('#nl-in');
      setTimeout(() => inp.focus(), 50);
      sh.q('#nl-no').onclick = () => sh.close();
      sh.q('#nl-ok').onclick = () => {
        const lines = inp.value.replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/[\[\]{}]/g, '').replace(/\s+$/, ''));
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        sh.close();
        if (!lines.length) return;
        const empty = !ta.value.trim();
        if (empty) setBody(lines.join('\n'));
        else apply(TabEdit.insertLines(tm, li + 1, lines));
      };
    }

    // 가사 붙여넣기 (19차): 구간을 나누고 이름을 추측한 뒤 한 화면에서 확인한다.
    //  · 이름 바꾸기 = 이름 칩을 탭 → 아래에 뜨는 이름 칩 하나 탭. 같은 가사의 다른 덩어리도 같은 이름으로 함께 바뀐다.
    //  · 같은 가사가 반복되면 자동으로 자리표시(↻ Chorus · 위와 같음). 카드마다 "펼쳐서 넣기"로 바꿀 수 있다.
    //  · 경계가 틀리면 카드 ⋯에서 줄 사이를 탭해 나누거나 위와 합친다. 위 "추정 송폼"은 보여 주고 복사만 한다.
    function pasteSheet() {
      const sh = showSheet(`<h2 style="margin-top:0">가사 붙여넣기</h2>
        <div id="ps-step1">
          <p class="hint" style="margin:0 0 6px">가사를 통째로 붙여넣으세요. 빈 줄을 기준으로 구간을 나누고, <b>V1 · Chorus · 1절 · [후렴]</b> 같은 이름만 적힌 줄이 있으면 이름표로 읽어요. 빈 줄이 없어도 반복되는 줄을 보고 나눠 봐요.</p>
          <textarea id="ps-in" rows="8" spellcheck="false" placeholder="여기에 가사를 붙여넣기"></textarea>
          <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="ps-next">구간 나누기</button><button type="button" class="btn" id="ps-no">닫기</button></div>
        </div>
        <div id="ps-step2" hidden></div>`);
      const inp = sh.q('#ps-in');
      sh.q('#ps-no').onclick = () => sh.close();
      let blocks = [];
      let selI = -1; // 이름을 바꾸려고 누른 카드
      let cutI = -1; // 줄 나누기를 열어 둔 카드
      let brkNote = false;
      const s2 = sh.q('#ps-step2');
      const nameOf = (id) => (id ? Sections.display(id, 'full') : '이름 없음');
      function render2() {
        const keep = s2.querySelector('.ps-blocks');
        const sc = keep ? keep.scrollTop : 0;
        const form = TabEdit.estimateForm(blocks);
        const nref = blocks.filter((b) => b.ref).length;
        s2.innerHTML = `
          <div class="ps-form"><span class="small"><b>추정 송폼</b></span> <code>${esc(form) || '(이름이 없어요)'}</code> ${form ? '<button type="button" class="btn small" id="ps-fcopy">복사</button>' : ''}</div>
          <p class="hint" style="margin:4px 0 6px">${brkNote ? '빈 줄이 없어서 <b>반복되는 줄로 나눠 봤어요.</b> ' : ''}${blocks.length}개 구간${nref ? ` · 반복 ${nref}곳은 자리표시(↻)로 넣어요` : ''}. 노란 이름은 추측이라 한 번 확인해 주세요. 이름 칩을 누르면 바꿀 수 있어요.</p>
          <div class="ps-blocks">${blocks
            .map((b, i) => {
              const prev = b.lines.slice(0, 2).join(' / ') + (b.lines.length > 2 ? ` … (${b.lines.length}줄)` : '');
              const cut = cutI === i
                ? `<div class="ps-lines">${b.lines.map((ln, k) => `${k > 0 ? `<button type="button" class="ps-cut" data-a="cut" data-i="${i}" data-k="${k}">✂ 여기서 나누기</button>` : ''}<div class="ps-ln">${esc(ln)}</div>`).join('')}</div>`
                : '';
              return `<div class="ps-card ${b.guess ? 'guess' : ''} ${b.ref ? 'isref' : ''} ${selI === i ? 'sel' : ''}">
                <div class="ps-head"><button type="button" class="ps-chip" data-a="name" data-i="${i}" aria-label="${i + 1}번째 구간 이름 바꾸기">${esc(b.label || '이름 없음')}</button><span class="ps-nm">${esc(nameOf(b.label))}${b.ref ? ' <small>↻ 위와 같음</small>' : ''}</span><button type="button" class="btn small" data-a="more" data-i="${i}" aria-label="줄 나누기·합치기">⋯</button></div>
                <div class="ps-prev">${esc(prev)}</div>
                ${b.ref || b.expand ? `<label class="chk-row small"><input type="checkbox" data-a="expand" data-i="${i}" ${b.expand ? 'checked' : ''}> 자리표시 말고 펼쳐서 넣기</label>` : ''}
                ${cutI === i ? `${cut}${i > 0 ? `<button type="button" class="btn small" data-a="merge" data-i="${i}">↑ 위 구간과 합치기</button>` : ''}` : ''}
              </div>`;
            })
            .join('')}</div>
          <div class="ps-pal" id="ps-pal" ${selI >= 0 ? '' : 'hidden'}><div class="small" style="margin-bottom:4px">${selI >= 0 ? `${selI + 1}번째 구간 이름` : ''}</div><div class="te-pal-row wrap">${['', ...Sections.PICKS].map((n) => `<button type="button" class="chip ctb sm" data-a="pick" data-v="${esc(n)}">${n ? esc(n) : '이름 없음'}${n && Sections.display(n, 'full') !== n ? `<small>${esc(Sections.display(n, 'full'))}</small>` : ''}</button>`).join('')}</div></div>
          <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="ps-ok">악보에 넣기</button><button type="button" class="btn" id="ps-back">← 다시 붙여넣기</button></div>`;
        const nb = s2.querySelector('.ps-blocks');
        if (nb) nb.scrollTop = sc;
      }
      sh.q('#ps-next').onclick = () => {
        blocks = TabEdit.splitLyrics(inp.value);
        if (!blocks.length) { toast('가사가 비어 있어요.'); return; }
        brkNote = !!blocks.guessedBreaks;
        selI = -1; cutI = -1;
        s2.hidden = false;
        sh.q('#ps-step1').hidden = true;
        render2();
      };
      s2.addEventListener('click', (ev) => {
        const t = ev.target.closest('[data-a], #ps-ok, #ps-back, #ps-fcopy');
        if (!t) return;
        if (t.id === 'ps-back') { s2.hidden = true; sh.q('#ps-step1').hidden = false; return; }
        if (t.id === 'ps-fcopy') { copyText(TabEdit.estimateForm(blocks)); return; }
        if (t.id === 'ps-ok') {
          const built = TabEdit.buildFromBlocks(blocks);
          const cur = ta.value.replace(/\s+$/, '');
          sh.close();
          setBody(cur ? cur + '\n\n' + built : built);
          toast('가사를 넣었습니다. 글자를 탭해서 코드를 얹어 보세요.');
          return;
        }
        const a = t.dataset.a;
        const i = +t.dataset.i;
        if (a === 'name') { selI = selI === i ? -1 : i; render2(); }
        else if (a === 'pick') {
          if (selI >= 0) { blocks = TabEdit.renameBlock(blocks, selI, t.dataset.v); selI = -1; render2(); }
        } else if (a === 'more') { cutI = cutI === i ? -1 : i; render2(); }
        else if (a === 'cut') { blocks = TabEdit.splitBlockAt(blocks, i, +t.dataset.k); cutI = -1; render2(); }
        else if (a === 'merge') { blocks = TabEdit.mergeBlockUp(blocks, i); cutI = -1; render2(); }
        else if (a === 'expand') { blocks[i].expand = t.checked; TabEdit.markRefs(blocks); render2(); }
      });
    }
    // ----- 이미지 → 코드 악보 변환 (25차) -----
    // 올려 둔 이미지·PDF 쪽을 AI가 읽어 코드 악보 초안을 만든다. 결과는 아래 탭 편집기에 넣고, 원본 악보 패널을 옆에 열어 검수하게 한다.
    // 초안은 틀릴 수 있다(특히 코드 위치와 한글 가사). 그래서 바로 저장하지 않고 항상 편집기에 넣는다. 되돌리기로 넣기 전으로 돌아간다.
    const CV_EDGE = 1568; // 보내는 이미지의 긴 변(px)
    const CV_MAX = 8; // 한 번에 변환할 최대 쪽 수
    let pdfjsLoading = null;
    function loadPdfJs() {
      if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
      if (pdfjsLoading) return pdfjsLoading;
      pdfjsLoading = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'vendor/pdf.min.js';
        s.onload = () => {
          if (!window.pdfjsLib) { rej(new Error('PDF 읽기 도구를 불러오지 못했습니다.')); return; }
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
          res(window.pdfjsLib);
        };
        s.onerror = () => { pdfjsLoading = null; rej(new Error('PDF 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.')); };
        document.head.appendChild(s);
      });
      return pdfjsLoading;
    }
    const canvasToJpeg = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    async function pageBlob(it) {
      if (it.kind === 'image') {
        const bmp = await createImageBitmap(await (await fetch(it.url)).blob(), { imageOrientation: 'from-image' });
        const sc = Math.min(1, CV_EDGE / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * sc));
        c.height = Math.max(1, Math.round(bmp.height * sc));
        const x = c.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(bmp, 0, 0, c.width, c.height);
        return canvasToJpeg(c);
      }
      const page = await it.pdf.getPage(it.page);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: CV_EDGE / Math.max(v1.width, v1.height) });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const x = c.getContext('2d');
      x.fillStyle = '#fff';
      x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport: vp }).promise;
      return canvasToJpeg(c);
    }
    async function transcribeOne(blob, signal) {
      let res;
      try {
        res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...authHeaders() }, body: blob, signal });
      } catch (e) {
        throw new Error(e && e.name === 'AbortError' ? '시간이 너무 오래 걸려 멈췄습니다.' : '인터넷 연결을 확인해 주세요.');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '변환에 실패했습니다.');
      return data.text || '';
    }
    // 변환 결과를 편집기에 넣는다. 이미 본문이 있으면 뒤에 이어 붙일지 묻는다.
    function applyConv(r) {
      const cur = ta.value.replace(/\s+$/, '');
      if (cur && !confirm('지금 악보 본문이 있어요.\n[확인] 뒤에 이어 붙이기\n[취소] 넣지 않기')) return false;
      setBody(cur ? cur + '\n\n' + r.text : r.text);
      const kel = $('key');
      if (r.key && !kel.value && [...kel.options].some((o) => o.value === r.key)) {
        kel.value = r.key;
        kel.dispatchEvent(new Event('change'));
      }
      const nt = ImgConv.notes(r);
      const note = $('cv-note');
      note.innerHTML = '<b>AI가 만든 초안이에요.</b> 코드 위치와 가사가 틀릴 수 있으니 원본 악보와 비교해서 고쳐 주세요.' + (r.key ? ` 읽은 키: <b>${esc(r.key)}</b>.` : '') + (nt.length ? '<br>' + nt.map(esc).join(' ') : '') + ' <button type="button" class="btn small" id="cv-note-x">닫기</button>';
      note.hidden = false;
      $('cv-note-x').onclick = () => { note.hidden = true; };
      if (dockFiles().length && !dockOpen()) setDock(true);
      return true;
    }
    function convSheet() {
      if (!dockFiles().length) { toast('아래 "이미지·PDF 악보"에 악보 사진이나 PDF를 먼저 올려 주세요.'); return; }
      let items = []; // {label, kind, url, page, pdf, on}
      let running = false;
      let ctl = null;
      let gone = false;
      const sh = showSheet(
        `<h2 style="margin-top:0">이미지에서 코드 악보 만들기</h2>
        <p class="hint" style="margin:0 0 8px">AI가 악보 사진을 읽어 <b>초안</b>을 만들어요. 코드 위치와 한글 가사는 틀릴 수 있어서, 결과는 편집기에 넣고 <b>원본 악보를 옆에 열어</b> 확인하게 됩니다. 한 쪽에 10~30초쯤 걸려요.</p>
        <div id="cv-pages" class="cv-pages"><span class="muted small">쪽을 확인하는 중…</span></div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="cv-go" disabled>변환 시작</button><button type="button" class="btn" id="cv-no">닫기</button></div>
        <div id="cv-stat" class="small" style="margin-top:6px" aria-live="polite"></div>
        <details class="cv-man" style="margin-top:12px"><summary class="small">AI가 잘 못 읽을 때: 직접 변환 (프롬프트 복사)</summary>
          <p class="hint" style="margin:6px 0">① 프롬프트를 복사해서 Claude 앱에 악보 사진과 함께 붙여넣고 ② 돌아온 결과를 아래에 붙여넣으세요.</p>
          <div class="row"><button type="button" class="btn small" id="cv-copy">프롬프트 복사</button></div>
          <textarea id="cv-paste" rows="5" spellcheck="false" placeholder="Claude가 돌려준 결과를 여기에 붙여넣기" style="margin-top:6px"></textarea>
          <div class="row" style="margin-top:6px"><button type="button" class="btn small primary" id="cv-ins">붙여넣은 결과 넣기</button></div>
        </details>`,
        () => { gone = true; if (ctl) ctl.abort(); }
      );
      const stat = sh.q('#cv-stat');
      const go = sh.q('#cv-go');
      sh.q('#cv-no').onclick = () => sh.close();
      sh.q('#cv-copy').onclick = () => copyText(ImgConv.MANUAL_PROMPT);
      sh.q('#cv-ins').onclick = () => {
        const r = ImgConv.clean(sh.q('#cv-paste').value);
        if (!r.text) { stat.textContent = '붙여넣은 내용이 비어 있어요.'; return; }
        if (applyConv(r)) sh.close();
      };
      const box = sh.q('#cv-pages');
      const drawPages = () => {
        const n = items.filter((i) => i.on).length;
        box.innerHTML = items.length
          ? items.map((it, k) => `<label class="chk-row"><input type="checkbox" data-k="${k}" ${it.on ? 'checked' : ''} ${running ? 'disabled' : ''}> ${esc(it.label)}</label>`).join('') +
            `<div class="muted small">${n}쪽 선택${items.length > CV_MAX ? ` · 한 번에 ${CV_MAX}쪽까지` : ''}</div>`
          : '<span class="muted small">변환할 이미지·PDF 쪽이 없어요.</span>';
        go.disabled = running || !n || n > CV_MAX;
      };
      box.onchange = (ev) => {
        const k = ev.target.dataset && ev.target.dataset.k;
        if (k !== undefined) { items[+k].on = ev.target.checked; drawPages(); }
      };
      (async () => {
        let ni = 0;
        let np = 0;
        for (const f of dockFiles()) {
          if (f.kind === 'image') { ni++; items.push({ label: `악보 이미지 ${ni}`, kind: 'image', url: f.url, on: true }); continue; }
          np++;
          try {
            const lib = await loadPdfJs();
            const pdf = await lib.getDocument({ data: await (await fetch(f.url)).arrayBuffer() }).promise;
            const cnt = Math.min(pdf.numPages, 12);
            for (let p = 1; p <= cnt; p++) items.push({ label: `PDF ${np} · ${p}쪽`, kind: 'pdf', pdf, page: p, on: true });
          } catch (e) {
            items.push({ label: `PDF ${np} (읽지 못함: ${e.message})`, kind: 'bad', on: false });
          }
          if (gone) return;
        }
        let left = CV_MAX;
        for (const it of items) { if (it.kind === 'bad') continue; it.on = left > 0; if (it.on) left--; }
        if (gone) return;
        drawPages();
      })();
      go.onclick = async () => {
        const sel = items.filter((i) => i.on && i.kind !== 'bad');
        if (!sel.length || running) return;
        running = true;
        ctl = new AbortController();
        drawPages();
        const done = [];
        let fail = '';
        for (let i = 0; i < sel.length; i++) {
          if (gone) return;
          stat.textContent = `변환 중… (${i + 1}/${sel.length}) ${sel[i].label}`;
          try {
            const blob = await pageBlob(sel[i]);
            if (!blob) throw new Error('이미지를 준비하지 못했습니다.');
            const t = setTimeout(() => ctl.abort(), 120000);
            let text;
            try { text = await transcribeOne(blob, ctl.signal); } finally { clearTimeout(t); }
            done.push(ImgConv.clean(text));
            ctl = new AbortController();
          } catch (e) {
            if (gone) return;
            fail = `${sel[i].label}: ${e.message}`;
            break;
          }
        }
        if (gone) return;
        running = false;
        drawPages();
        const r = ImgConv.merge(done);
        if (!r.text) {
          stat.innerHTML = `<span class="error">${esc(fail || '읽어 낸 내용이 없어요. 사진이 선명한지 확인하거나 아래 직접 변환을 써 보세요.')}</span>`;
          return;
        }
        if (applyConv(r)) {
          sh.close();
          if (fail) toast('일부 쪽은 변환하지 못했어요: ' + fail);
        } else {
          stat.textContent = '넣지 않았어요. 다시 변환하려면 시작을 누르세요.';
        }
      };
    }
    $('convbtn').onclick = convSheet;
    $('repbtn').onclick = repeatSheet;
    $('pastebtn').onclick = pasteSheet;
    // 키(원래 키)를 바꾸면 코드 칩도 그 키에 맞춰 다시 그린다
    $('key').addEventListener('change', tePalette);
    tabRefresh();

    // ----- 태그: 추천 칩(주제·빠르기·절기 …) 누르면 넣고 빼기 -----
    const tagList = () => $('tags').value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    // ----- 박자: 자주 쓰는 박자를 눌러 고르고, 다시 누르면 해제. 곡마다 때에 따라 다르게 부르면 여러 개(최대 4개)를 함께 고를 수 있다.
    //       그 밖의 박자는 "기타"에 직접 적는다(여러 개면 쉼표로). 값은 숨은 칸 #tsig 에 "3/4,4/4"처럼 쉼표로 이어 저장한다 -----
    const TSIG_PRESETS = ['4/4', '3/4', '6/8', '2/4', '12/8'];
    const TSIG_MAX = 4;
    const normTsig = (v) => {
      const m = /^\s*(\d{1,2})\s*[\/／]\s*(\d{1,2})\s*$/.exec(String(v || ''));
      return m && +m[1] >= 1 && +m[1] <= 16 && [2, 4, 8, 16].includes(+m[2]) ? `${+m[1]}/${+m[2]}` : '';
    };
    const tsigs = () => [...new Set(String($('tsig').value || '').split(/[,，]/).map(normTsig).filter(Boolean))].slice(0, TSIG_MAX);
    const tsigCustoms = () => tsigs().filter((t) => !TSIG_PRESETS.includes(t));
    // 칩을 다시 그리지 않고 켜짐 표시만 바꾼다. ("기타" 칸에 쓰다가 다른 칩을 바로 누를 때, 칸이 빠져나가며 칩이 새로 그려지면 그 눌림이 사라지기 때문)
    function syncTsig() {
      const cur = tsigs();
      $('tsigchips').querySelectorAll('button[data-ts]').forEach((b) => b.classList.toggle('on', cur.includes(b.dataset.ts)));
      const o = $('tsig-o');
      const customs = tsigCustoms();
      o.value = customs.join(', ');
      o.classList.toggle('on', customs.length > 0);
    }
    function drawTsig() {
      $('tsigchips').innerHTML = TSIG_PRESETS.map((t) => `<button type="button" class="chip" data-ts="${t}">${t}</button>`).join('')
        + '<input id="tsig-o" class="tsig-o" type="text" inputmode="text" maxlength="14" size="8" placeholder="기타 5/4" aria-label="기타 박자">';
      syncTsig();
    }
    function setTsigs(list) {
      $('tsig').value = [...new Set(list)].slice(0, TSIG_MAX).join(',');
      syncTsig();
      $('tsig').dispatchEvent(new Event('input', { bubbles: true }));
    }
    $('tsigchips').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-ts]');
      if (!b) return;
      const cur = tsigs();
      if (cur.includes(b.dataset.ts)) return setTsigs(cur.filter((t) => t !== b.dataset.ts));
      if (cur.length >= TSIG_MAX) return toast(`박자는 ${TSIG_MAX}개까지 고를 수 있어요.`);
      setTsigs([...cur, b.dataset.ts]);
    };
    $('tsigchips').onchange = (ev) => {
      if (!ev.target || ev.target.id !== 'tsig-o') return;
      const parts = ev.target.value.split(/[\s,，]+/).filter(Boolean);
      const presetsOn = tsigs().filter((t) => TSIG_PRESETS.includes(t));
      if (!parts.length) { if (tsigCustoms().length) setTsigs(presetsOn); return; } // 칸을 비우면 직접 쓴 박자만 해제(칩으로 고른 박자는 그대로)
      const norm = parts.map(normTsig);
      if (norm.some((t) => !t)) { toast('박자는 5/4처럼 적어 주세요. (아래 숫자는 2·4·8·16)'); ev.target.value = tsigCustoms().join(', '); return; }
      if (new Set([...presetsOn, ...norm]).size > TSIG_MAX) { toast(`박자는 ${TSIG_MAX}개까지 고를 수 있어요.`); ev.target.value = tsigCustoms().join(', '); return; }
      setTsigs([...presetsOn, ...norm]);
    };
    drawTsig();
    function drawTagChips() {
      const on = new Set(tagList());
      $('tagchips').innerHTML = tagInfo.presets
        .filter((g) => g.items.length)
        .map((g) => `<div class="chipgroup"><span class="ctl-label">${esc(g.group)}</span><div class="chips">${g.items.map((t) => `<button type="button" class="chip ${on.has(t) ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`)
        .join('');
    }
    $('tagchips').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-t]');
      if (!b) return;
      const t = b.dataset.t;
      const list = tagList();
      const next = list.includes(t) ? list.filter((x) => x !== t) : [...list, t];
      // 입력칸도 추천 목록 순서로 정리한다 (추천에 없는 태그는 끝에 가나다순). 서버도 저장할 때 같은 순서로 맞춘다.
      const rank = new Map(tagInfo.presets.flatMap((g) => g.items).map((x, i) => [x, i]));
      next.sort((a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9) || a.localeCompare(b, 'ko'));
      $('tags').value = next.join(', ');
      drawTagChips();
      $('tags').dispatchEvent(new Event('input', { bubbles: true }));
    };
    $('tags').oninput = drawTagChips;
    drawTagChips();
    // ----- 외부에서 악보 찾기 (검색 페이지로만 연결) -----
    const drawExt = () => {
      const t = $('title').value.trim();
      $('extfind').innerHTML = t ? `외부에서 찾아보기: ${extLinksHTML(t)}` : '제목을 입력하면 Google · YouTube · Ultimate Guitar 검색 링크가 나옵니다.';
    };
    $('title').oninput = drawExt;
    drawExt();

    // ----- 이미지·PDF 악보 관리 -----
    const files = song.files || [];
    const pending = []; // 새 곡일 때, 저장과 함께 올릴 파일
    // ----- 원본 악보 옆에 놓기 (23차): 아래 "이미지·PDF 악보"에 올린 파일을 입력하는 동안 위(넓은 화면은 오른쪽)에 계속 띄워 둔다 -----
    const objUrls = new Map(); // 아직 올리지 않은 새 곡의 파일 → 미리보기 주소
    const dockFiles = () => [
      ...files.map((f) => ({ kind: f.kind, url: f.url })),
      ...pending.map((f) => ({ kind: /pdf/i.test(f.type) ? 'pdf' : 'image', url: objUrls.get(f) || (objUrls.set(f, URL.createObjectURL(f)), objUrls.get(f)) })),
    ];
    let dockPane = null;
    const dockOpen = () => !$('refdock').hidden;
    function setDock(on) {
      if (on && !dockFiles().length) { toast('아래 "이미지·PDF 악보"에 악보 사진이나 PDF를 먼저 올려 주세요.'); return; }
      $('refdock').hidden = !on;
      document.querySelector('.edit-wrap').classList.toggle('dock-on', on);
      $('refbtn').textContent = on ? '📖 원본 악보 닫기' : '📖 원본 악보 옆에 놓기';
      if (on) dockPane = mountImagePane($('rdbody'), dockFiles);
    }
    $('refbtn').onclick = () => setDock(!dockOpen());
    $('rdclose').onclick = () => setDock(false);
    function drawFiles() {
      $('files').innerHTML =
        files
          .map((f) => `<div class="file-item">${f.kind === 'image' ? `<img class="thumb" src="${esc(f.url)}" alt="">` : '<div class="thumb">📄</div>'}<button class="btn small danger" type="button" data-del="${f.id}">삭제</button></div>`)
          .join('') +
        pending
          .map((p, i) => `<div class="file-item"><div class="thumb">⏳</div><div>${esc(p.name.slice(0, 12))}</div><button class="btn small" type="button" data-rm="${i}">빼기</button></div>`)
          .join('');
      $('fnote').hidden = !pending.length;
      if (dockPane && dockOpen()) { if (dockFiles().length) dockPane.redraw(); else setDock(false); }
    }
    // 여러 장을 차례로 올린다. 문제가 생기면 그 메시지를 돌려준다.
    async function uploadMany(songId, list) {
      for (let i = 0; i < list.length; i++) {
        $('fstat').textContent = `올리는 중… (${i + 1}/${list.length})`;
        try {
          files.push(await uploadFile(songId, list[i]));
          drawFiles();
        } catch (e) {
          $('fstat').textContent = '';
          return e.message;
        }
      }
      $('fstat').textContent = '';
      return '';
    }
    $('addfile').onclick = () => $('fi').click();
    $('fi').onchange = async () => {
      const picked = [...$('fi').files];
      $('fi').value = '';
      if (!picked.length) return;
      $('err').textContent = '';
      if (!id) {
        pending.push(...picked);
        drawFiles();
        return;
      }
      const msg = await uploadMany(id, picked);
      if (msg) $('err').textContent = msg;
    };
    $('files').onclick = async (ev) => {
      const d = ev.target.dataset;
      if (d.rm !== undefined) {
        pending.splice(+d.rm, 1);
        drawFiles();
      } else if (d.del !== undefined) {
        if (!confirm('이 악보 파일을 삭제할까요?')) return;
        try {
          await api('/files/' + d.del, { method: 'DELETE' });
          files.splice(files.findIndex((f) => String(f.id) === d.del), 1);
          drawFiles();
        } catch (e) {
          $('err').textContent = e.message;
        }
      }
    };
    drawFiles();
    // 오늘 화면의 보완 제안 [채우기]로 들어왔으면 비어 있는 칸으로 바로 내려간다
    if (q && (q.get('fix') === 'image' || q.get('fix') === 'chord')) {
      setTimeout(() => {
        const t = q.get('fix') === 'image' ? $('files') : $('tabpane');
        const card = t && t.closest('.card');
        if (card) { card.scrollIntoView({ block: 'start', behavior: 'smooth' }); card.classList.add('fixflash'); setTimeout(() => card.classList.remove('fixflash'), 2200); }
      }, 150);
    }

    // ----- 기본 송폼 (22차): 콘티의 송폼 입력기와 같은 것을 쓴다. 값은 숨은 칸 #bform 에 글자로 넣어 두고, 저장·임시저장은 다른 칸과 똑같이 처리된다 -----
    const bfData = { items: [{ form: song.base_form || '', original_key: song.original_key || '', song_id: id || 0 }] };
    const bfEd = createFormEditor($('bformhost'), bfData, {});
    bfEd.bind();
    const bfDraw = () => { bfData.items[0].form = $('bform').value; bfData.items[0].original_key = $('key').value; bfEd.draw(0); };
    $('bformhost').addEventListener('click', () => { $('bform').value = bfData.items[0].form; $('bform').dispatchEvent(new Event('input', { bubbles: true })); });
    $('key').addEventListener('change', () => { bfData.items[0].original_key = $('key').value; bfEd.draw(0); });
    bfDraw();

    // ----- 입력 중 자동 임시저장 (이 기기 안에만 저장. 앱이 닫히거나 새로고침돼도 이어서 쓸 수 있다) -----
    const draftKey = 'ews_draft_' + (id || 'new');
    const FIELDS = { title: 'title', orig_title: 'otitle', artist: 'artist', original_key: 'key', tempo: 'tempo', time_sig: 'tsig', base_form: 'bform', tags: 'tags', youtube_url: 'yt', memo: 'memo', lyrics_extra: 'lx', chordpro: 'cp' };
    const readForm = () => Object.fromEntries(Object.entries(FIELDS).map(([k, i]) => [k, $(i).value]));
    const baseline = JSON.stringify(readForm());
    let draftTimer;
    function saveDraft() {
      if (!ta.isConnected) return;
      const f = readForm();
      if (JSON.stringify(f) === baseline) ls.del(draftKey);
      else ls.set(draftKey, JSON.stringify({ t: Date.now(), f }));
    }
    const scheduleDraft = () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 600); };
    document.querySelector('.edit-wrap').addEventListener('input', scheduleDraft);
    document.querySelector('.edit-wrap').addEventListener('change', scheduleDraft);
    (function offerDraft() {
      let d = null;
      try { d = JSON.parse(ls.get(draftKey, 'null')); } catch { d = null; }
      if (!d || !d.f || JSON.stringify(Object.assign(readForm(), d.f)) === baseline) { if (d) ls.del(draftKey); return; }
      const bar = $('draftbar');
      bar.hidden = false;
      bar.innerHTML = `<span>저장하지 않은 작업이 있어요. (${esc(fmtTime(new Date(d.t).toISOString()))})</span> <button type="button" class="btn small primary" id="dr-use">이어서 작업</button> <button type="button" class="btn small" id="dr-drop">버리기</button>`;
      $('dr-use').onclick = () => {
        for (const [k, i] of Object.entries(FIELDS)) if (typeof d.f[k] === 'string') $(i).value = d.f[k];
        bar.hidden = true;
        preview(); drawTagChips(); drawTsig(); drawExt(); runCheck(); bfDraw();
        undoS = []; redoS = []; tabRefresh();
        toast('저장하지 않았던 작업을 불러왔습니다. 저장을 눌러야 반영돼요.');
      };
      $('dr-drop').onclick = () => { ls.del(draftKey); bar.hidden = true; };
    })();

    async function save(force, checked) {
      const err = $('err');
      err.textContent = '';
      if (!checked) {
        const warns = runCheck().filter((x) => x.level === 'warn');
        if (warns.length) {
          const list = warns.slice(0, 6).map((x) => '· ' + (x.line ? x.line + '줄: ' : '') + x.msg).join('\n');
          if (!confirm(`악보에 확인할 곳이 ${warns.length}곳 있습니다.\n\n${list}${warns.length > 6 ? '\n· …' : ''}\n\n그래도 저장할까요?`)) return;
        }
      }
      const body = {
        title: $('title').value, orig_title: $('otitle').value, lyrics_extra: $('lx').value, artist: $('artist').value, original_key: $('key').value, tempo: $('tempo').value, time_sig: $('tsig').value, base_form: $('bform').value,
        youtube_url: $('yt').value, tags: $('tags').value, chordpro: $('cp').value, memo: $('memo').value, force: !!force,
      };
      const btn = $('save');
      const btn2 = $('save2');
      btn.disabled = true;
      btn2.disabled = true;
      try {
        const r = id ? await api('/songs/' + id, { method: 'PUT', body }) : await api('/songs', { method: 'POST', body });
        clearTimeout(draftTimer);
        ls.del(draftKey);
        if (!id && pending.length) {
          const msg = await uploadMany(r.id, pending);
          if (msg) {
            toast('곡은 저장했지만 파일을 다 올리지 못했습니다: ' + msg);
            location.hash = '#/edit/' + r.id;
            return;
          }
        }
        toast('저장했습니다.');
        location.hash = '#/song/' + r.id;
      } catch (e) {
        if (e.status === 409 && confirm(`"${e.data.duplicate.title}" 곡이 이미 있습니다.\n그래도 새 곡으로 저장할까요?`)) return save(true, true);
        if (e.status === 403) { await loadMe(); }
        err.textContent = e.message;
      } finally {
        btn.disabled = false;
        btn2.disabled = false;
      }
    }
    $('save').onclick = () => save(false);
    $('save2').onclick = () => save(false);
    const del = $('del');
    if (del) del.onclick = async () => {
      if (!confirm(`"${song.title}" 곡을 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
      try {
        await api('/songs/' + id, { method: 'DELETE' });
        toast('삭제했습니다.');
        location.hash = '#/songs';
      } catch (e) {
        $('err').textContent = e.message;
      }
    };
  }

  // ---------- 수정 이력 (4차) ----------
  // 줄 단위로 비교해서 어디가 바뀌었는지 보여 준다. (너무 큰 악보는 비교 생략)
  function lineDiff(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    if (A.length * B.length > 4000000) return null;
    const n = A.length, m = B.length;
    const w = m + 1;
    const L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', A[i++]]);
      else out.push(['+', B[j++]]);
    }
    while (i < n) out.push(['-', A[i++]]);
    while (j < m) out.push(['+', B[j++]]);
    return out;
  }
  const fmtTime = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const k = new Date(d.getTime() + 9 * 3600 * 1000).toISOString(); // 한국 시간
    return `${k.slice(0, 10)} ${k.slice(11, 16)}`;
  };

  async function viewHistory(id) {
    if (!me.canEdit) {
      $app.innerHTML = noteBox('<p>수정 이력은 악보를 편집할 수 있는 사람만 볼 수 있습니다.</p><a class="btn" href="#/song/' + id + '">곡 보기</a>');
      return;
    }
    const r = await api(`/songs/${id}/versions`);
    document.title = '수정 이력 · ' + r.title;
    $app.innerHTML = `
      <div class="row between"><a href="#/song/${id}" class="small">← 곡 보기</a><h2 style="margin:0">수정 이력</h2></div>
      <h1 style="font-size:20px">${esc(r.title)}</h1>
      <p class="hint">코드 악보 본문을 고칠 때마다, 바뀌기 전 본문이 자동으로 보관됩니다(곡마다 최근 50번). 제목·태그·메모·이미지 변경은 이력에 남지 않습니다.</p>
      <div class="card"><div class="song-title">지금 본문</div><div class="song-meta"><span>마지막 수정 ${esc(fmtTime(r.current.updated_at))}</span><span>${r.current.chars}자</span></div></div>
      <div id="vers">
        ${
          r.versions
            .map(
              (v) => `<a class="card verrow" href="#/history/${id}?v=${v.id}" data-v="${v.id}">
              <div class="song-title">${esc(fmtTime(v.created_at))} 이전 본문</div>
              <div class="song-meta"><span>고친 사람: ${esc(v.edited_by)}</span><span>${v.chars}자</span>${v.first_line ? `<span>${esc(v.first_line)}</span>` : ''}</div>
            </a>`
            )
            .join('') || '<p class="muted">아직 보관된 이력이 없습니다. 코드 악보를 한 번 고치면 여기에 쌓입니다.</p>'
        }
      </div>
      <div id="detail"></div>`;
    el('vers').onclick = async (ev) => {
      const a = ev.target.closest && ev.target.closest('a[data-v]');
      if (!a) return;
      ev.preventDefault();
      const vid = a.dataset.v;
      el('detail').innerHTML = '<p class="muted">불러오는 중…</p>';
      try {
        const d = await api(`/songs/${id}/versions/${vid}`);
        const diff = lineDiff(d.version.chordpro, d.current.chordpro);
        // 이 이력(왼쪽, 이전)과 지금 본문(오른쪽) 비교: 이력에만 있는 줄은 빨강(−), 지금에만 있는 줄은 초록(+)
        const diffHTML = diff
          ? diff.map(([t, line]) => `<div class="dl ${t === '+' ? 'add' : t === '-' ? 'del' : ''}"><span class="dm">${t === ' ' ? '' : t}</span>${esc(line) || '&nbsp;'}</div>`).join('')
          : '<p class="muted small">본문이 너무 길어 비교는 생략했어요. 아래 “이 본문 전체”를 확인해 주세요.</p>';
        el('detail').innerHTML = `
          <div class="card" id="dcard">
            <h2 style="margin-top:0">${esc(fmtTime(d.version.created_at))} 이전 본문 <span class="muted small">(고친 사람: ${esc(d.version.edited_by)})</span></h2>
            <p class="hint">지금 본문과 비교: <span class="legend del">− 이 이력에만 있던 줄</span> <span class="legend add">+ 지금 본문에 새로 생긴 줄</span></p>
            <div class="difflist">${diffHTML}</div>
            <details><summary>이 본문 전체 보기</summary><pre class="help" style="white-space:pre-wrap">${esc(d.version.chordpro) || '(비어 있음)'}</pre></details>
            <p class="error" id="rerr"></p>
            <div class="row"><button class="btn primary" id="restore">이 본문으로 되돌리기</button><button class="btn" id="dclose">닫기</button></div>
            <p class="hint">되돌리기 전의 지금 본문도 이력에 보관되니, 잘못 되돌려도 다시 되돌릴 수 있어요.</p>
          </div>`;
        el('dcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        el('dclose').onclick = () => (el('detail').innerHTML = '');
        el('restore').onclick = async () => {
          if (!confirm('이 본문으로 되돌릴까요?\n지금 본문은 이력에 보관됩니다.')) return;
          el('restore').disabled = true;
          try {
            await api(`/songs/${id}/versions/${vid}/restore`, { method: 'POST' });
            toast('되돌렸습니다.');
            route();
          } catch (e) {
            el('rerr').textContent = e.message;
            el('restore').disabled = false;
          }
        };
      } catch (e) {
        el('detail').innerHTML = `<p class="error">${esc(e.message)}</p>`;
      }
    };
  }

  // =====================================================================
  // 2차: 팀 · 콘티 · 관리자
  // =====================================================================
  const el = (id) => document.getElementById(id);
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('복사했습니다.');
    } catch {
      toast('복사하지 못했습니다. 직접 선택해서 복사해 주세요.');
    }
  }
  const fmtDate = (d) => {
    if (!d) return '';
    const [y, m, dd] = d.split('-').map(Number);
    return `${m}/${dd}(${'일월화수목금토'[new Date(y, m - 1, dd).getDay()]})`;
  };
  function nextSunday() {
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // 16차: 예배 종류의 기본 요일(0=일 … 6=토). 오늘이 그 요일이면 오늘, 아니면 가장 가까운 다음 날.
  const DAY_NAMES = '일월화수목금토';
  function nextWeekday(n) {
    const d = new Date();
    d.setDate(d.getDate() + ((n - d.getDay() + 7) % 7));
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const svcDay = (o) => (o && /^[0-6]$/.test(String(o.extra == null ? '' : o.extra)) ? Number(o.extra) : -1);
  const noteBox = (html) => `<div class="card">${html}</div>`;

  // ---------- 11차: 콘티 제목 · 인도자 · 예배 종류 ----------
  // 제목 → "예배 종류 M/D" → "M/D 콘티" 순으로 보여 준다. (withDate=false 면 날짜는 뺀다: 날짜를 따로 보여 주는 화면·내보내기용)
  const setlistTitle = (l, withDate = true) => {
    const t = (l.title || '').trim();
    if (t) return t;
    const md = mmdd(l.date);
    if (l.service_name) return withDate && md ? `${l.service_name} ${md}` : l.service_name;
    return md && withDate ? `${md} 콘티` : '콘티';
  };
  const leadersOf = (l) => SongForm.leaderList(l && l.leaders);
  const leaderTag = (l) => {
    const w = leadersOf(l);
    return w.length ? `<span class="who" title="인도자">🎤 ${esc(w.join(', '))}</span>` : '';
  };
  const tempTag = (l) => (l && l.is_temp ? '<span class="tag temp" title="급하게 만든 임시 콘티">⚡ 임시</span>' : '');

  // 예배 종류 / 인도자 목록을 관리하는 아래 창 (팀장). 닫을 때 onChange 로 화면을 다시 그리게 한다.
  const dayOptions = (cur, none = '없음') => `<option value="" ${cur < 0 ? 'selected' : ''}>${none}</option>` + [...DAY_NAMES].map((c, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${c}요일</option>`).join('');
  async function manageOptions(kind, onChange) {
    const label = kind === 'service' ? '예배 종류' : '인도자';
    const eg = kind === 'service' ? '예: 주일오전예배' : '예: 홍길동';
    const key = kind === 'service' ? 'services' : 'leaders';
    let changed = false;
    const sh = showSheet('<p class="muted">불러오는 중…</p>', () => { if (changed && onChange) onChange(); });
    let list = [];
    const load = async () => { list = (await api('/team/options'))[key]; };
    const say = (m) => { const e = sh.q('#oerr'); if (e) e.textContent = m || ''; };
    const draw = () => {
      sh.q('.sheet-card').innerHTML = `<h2 style="margin-top:0">${label} 관리</h2>
        <ul class="opt-list">${
          list.length
            ? list.map((o, i) => `<li data-id="${o.id}"><span class="grow">${esc(o.name)}</span>
                <button type="button" class="btn small" data-oa="up" ${i === 0 ? 'disabled' : ''} aria-label="위로">↑</button>
                <button type="button" class="btn small" data-oa="down" ${i === list.length - 1 ? 'disabled' : ''} aria-label="아래로">↓</button>
                <button type="button" class="btn small" data-oa="ren">이름</button>
                <button type="button" class="btn small danger" data-oa="del">삭제</button>${kind === 'service' ? `
                <label class="opt-day">기본 요일 <select data-day aria-label="${esc(o.name)} 기본 요일">${dayOptions(svcDay(o))}</select></label>` : ''}</li>`).join('')
            : `<li class="muted">아직 없어요. 아래에서 추가해 보세요.</li>`
        }</ul>
        <form id="oadd" class="row"><input id="oname" type="text" maxlength="20" placeholder="${eg}" enterkeyhint="done" aria-label="${label} 이름" style="flex:1 1 140px">${kind === 'service' ? `<select id="oday" aria-label="기본 요일">${dayOptions(-1, '요일 없음')}</select>` : ''}<button class="btn primary small">추가</button></form>
        <p class="hint">${kind === 'service' ? '기본 요일을 정해 두면 새 콘티에서 이 예배 종류를 고를 때 날짜가 그 요일로 맞춰져요. 예배 종류를 지우면 그 콘티들은 “미분류”로 남아요.' : '인도자 이름을 고치면 이 팀의 지난 콘티에 적힌 이름도 같이 바뀌어요.'}</p>
        <p class="error" id="oerr"></p>
        <button class="btn" id="oclose" type="button" style="width:100%">닫기</button>`;
      sh.q('#oclose').onclick = () => sh.close();
      sh.q('#oadd').onsubmit = async (ev) => {
        ev.preventDefault();
        const name = sh.q('#oname').value.trim();
        if (!name) return;
        try {
          const body = { kind, name };
          if (kind === 'service' && sh.q('#oday') && sh.q('#oday').value !== '') body.extra = sh.q('#oday').value;
          await api('/team/options', { method: 'POST', body });
          changed = true;
          await load();
          draw();
        } catch (e) { say(e.message); }
      };
    };
    sh.wrap.addEventListener('change', async (ev) => {
      const sel = ev.target.closest && ev.target.closest('select[data-day]');
      if (!sel) return;
      const li = sel.closest('li[data-id]');
      try {
        await api('/team/options/' + li.dataset.id, { method: 'PUT', body: { extra: sel.value } });
        changed = true;
        await load();
        draw();
      } catch (e) { say(e.message); }
    });
    sh.wrap.addEventListener('click', async (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-oa]');
      if (!b) return;
      const li = b.closest('li[data-id]');
      const idx = list.findIndex((o) => String(o.id) === li.dataset.id);
      const o = list[idx];
      try {
        if (b.dataset.oa === 'ren') {
          const nn = prompt(`${label} 이름`, o.name);
          if (nn === null || !nn.trim() || nn.trim() === o.name) return;
          await api('/team/options/' + o.id, { method: 'PUT', body: { name: nn.trim() } });
        } else if (b.dataset.oa === 'del') {
          if (!confirm(`"${o.name}"을(를) 지울까요?`)) return;
          await api('/team/options/' + o.id, { method: 'DELETE' });
        } else {
          const j = b.dataset.oa === 'up' ? idx - 1 : idx + 1;
          if (j < 0 || j >= list.length) return;
          const next = list.slice();
          [next[idx], next[j]] = [next[j], next[idx]];
          await Promise.all(next.map((x, n) => (x.position === n + 1 ? null : api('/team/options/' + x.id, { method: 'PUT', body: { position: n + 1 } }))).filter(Boolean));
        }
        changed = true;
        await load();
        draw();
      } catch (e) { say(e.message); }
    });
    try {
      await load();
      draw();
    } catch (e) {
      sh.q('.sheet-card').innerHTML = `<p class="error">${esc(e.message)}</p><button class="btn" id="oclose" type="button">닫기</button>`;
      sh.q('#oclose').onclick = () => sh.close();
    }
  }

  // ---------- 권한 열기: 필요한 순간에 그 자리에서 PIN 묻기 (6차 전 개편) ----------
  // kind: 'leader' = 콘티 편집(팀장 PIN) · 'song' = 악보 편집(관리자 PIN, 또는 악보 권한이 있는 팀장 PIN)
  // 권한이 있으면 보통 버튼, 없지만 열 수 있으면 🔒 버튼(누르면 PIN 창), 열 방법이 없으면 보이지 않는다.
  // quiet=true: 권한이 아직 안 열려 있으면 버튼 자체를 숨긴다. (21차: 한 화면에 🔒 버튼이 여러 개 줄지어 보이던 것을 줄이려고,
  // 잠긴 상태에서는 그 화면의 대표 버튼 하나만 🔒로 보여 주고 나머지는 숨긴다. 권한은 더보기 > 편집 권한에서도 열 수 있다.)
  function lockBtn(kind, label, go, cls, quiet) {
    const allowed = kind === 'leader' ? !!(me.team && me.team.isLeader) : !!me.canEdit;
    const c = cls || '';
    if (allowed) return `<a class="btn ${c}" href="${go}">${label}</a>`;
    const lockable = kind === 'leader' ? !!me.team : !!me.adminRequired;
    if (!lockable || quiet) return '';
    return `<button type="button" class="btn locked ${c.replace('primary', '').trim()}" data-lock="${kind}" data-go="${esc(go)}">🔒 ${label}</button>`;
  }
  // 아래에서 올라오는 창. 바깥을 누르거나 Esc로 닫는다.
  function showSheet(html, onClose) {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet-card">${html}</div>`;
    const onEsc = (e) => { if (e.key === 'Escape') close(); };
    function close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      document.removeEventListener('keydown', onEsc);
      if (onClose) onClose();
    }
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onEsc);
    document.body.appendChild(wrap);
    return { wrap, close, q: (sel) => wrap.querySelector(sel) };
  }
  function askPin(kind) {
    return new Promise((resolve) => {
      let who = kind === 'leader' ? 'leader' : me.adminRequired ? 'admin' : 'leader';
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let sh = null;
      const draw = () => {
        const html = `
          <h2 style="margin-top:0">${kind === 'leader' ? '콘티 편집은 팀장 PIN이 필요해요' : '악보 편집은 PIN이 필요해요'}</h2>
          ${kind === 'song' && me.adminRequired && me.team ? `<div class="row" style="margin-bottom:8px"><button type="button" class="seg ${who === 'admin' ? 'on' : ''}" data-who="admin">관리자 PIN</button><button type="button" class="seg ${who === 'leader' ? 'on' : ''}" data-who="leader">팀장 PIN</button></div>` : ''}
          <form id="pinform">
            <input id="pinin" type="password" autocomplete="off" aria-label="${who === 'admin' ? '관리자 PIN' : '팀장 PIN'}" placeholder="${who === 'admin' ? '관리자 PIN' : '팀장 PIN'}">
            <p class="error" id="pinerr"></p>
            <div class="row" style="margin-top:8px"><button class="btn primary" style="flex:1">확인</button><button type="button" class="btn" id="pincancel">취소</button></div>
          </form>
          <p class="hint">한 번 입력하면 이 기기에 30일간 기억돼요. 다른 사람이 쓰는 기기라면 더보기에서 “편집 권한 닫기”를 눌러 주세요.</p>`;
        if (!sh) sh = showSheet(html, () => finish(false));
        else sh.wrap.firstChild.innerHTML = html;
        const input = sh.q('#pinin');
        input.focus();
        sh.q('#pincancel').onclick = () => sh.close();
        sh.wrap.querySelectorAll('[data-who]').forEach((b) => (b.onclick = () => { who = b.dataset.who; draw(); }));
        sh.q('#pinform').onsubmit = async (ev) => {
          ev.preventDefault();
          const err = sh.q('#pinerr');
          err.textContent = '';
          const pin = input.value;
          try {
            if (who === 'admin') {
              const r = await api('/admin', { method: 'POST', body: { pin } });
              ls.set('ews_admin', r.adminToken);
            } else {
              const r = await api('/team/leader-login', { method: 'POST', body: { pin } });
              setActiveLeader(r.leaderToken);
            }
            await loadMe();
            const ok = kind === 'leader' ? !!(me.team && me.team.isLeader) : !!me.canEdit;
            if (!ok) { err.textContent = '로그인은 됐지만 이 PIN으로는 악보를 편집할 수 없어요. 팀장은 관리자가 악보 편집 권한을 켜 줘야 합니다.'; return; }
            toast(who === 'admin' ? '관리자로 로그인했습니다.' : '팀장으로 로그인했습니다.');
            finish(true);
            sh.close();
          } catch (e) {
            err.textContent = e.message;
          }
        };
      };
      draw();
    });
  }
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-lock]');
    if (!b) return;
    ev.preventDefault();
    const go = b.dataset.go || '';
    if (await askPin(b.dataset.lock)) {
      if (go && go !== location.hash) location.hash = go;
      else route();
    }
  });

  // ---------- 팀 전환 칩 (오늘·콘티 화면 위) ----------
  // 팀에 가입했거나, 다시 입장해야 하는 팀이 남아 있을 때 보인다. 누르면 아래 창에서 팀을 바꾸거나 추가한다.
  function teamChip() {
    const saved = teamsGet();
    if (!me.team && !saved.length) return '';
    const stale = saved.some((x) => x.stale);
    return `<div class="teambar"><button type="button" class="team-chip" data-teamsw aria-label="팀 전환">${me.team ? esc(me.team.name) : '팀 선택'} ▾${stale ? '<span class="dot" aria-hidden="true"></span>' : ''}</button></div>`;
  }
  function openTeamSheet() {
    const saved = teamsGet();
    const cur = me.team ? me.team.id : null;
    const rows = saved
      .map((t) => {
        const on = t.id === cur && !t.stale;
        const tag = t.stale ? '<span class="pill">다시 입장 필요</span>' : on ? '<span class="pill ok">보는 중</span>' : t.leader ? '<span class="pill">팀장</span>' : '';
        return `<div class="team-row"><button type="button" class="team-pick ${on ? 'on' : ''}" data-pick="${t.id}"><span class="grow">${esc(t.name || '팀')}</span>${tag}</button>${t.stale ? `<button type="button" class="btn small" data-rm="${t.id}">지우기</button>` : ''}</div>`;
      })
      .join('');
    const sh = showSheet(
      `<h2 style="margin-top:0">팀 전환</h2>${rows || '<p class="muted">가입한 팀이 없어요.</p>'}<p style="margin:12px 0 0"><button type="button" class="btn" id="tadd" style="width:100%">+ 다른 팀 추가</button></p><p class="hint">팀을 바꾸면 그 팀의 콘티·최근 사용·팀 기본 키가 보여요. 팀장 PIN은 팀마다 따로 입력해요.</p>`
    );
    sh.wrap.querySelectorAll('[data-pick]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = +b.dataset.pick;
          const t = teamsGet().find((x) => x.id === id);
          if (!t) return;
          sh.close();
          if (t.stale) {
            location.hash = '#/team?add=1&re=' + encodeURIComponent(t.name || '');
            return;
          }
          ls.set('ews_team_active', String(id));
          ls.del('ews_team_skip');
          toast(`"${t.name}" 팀으로 바꿨습니다.`);
          route();
        })
    );
    sh.wrap.querySelectorAll('[data-rm]').forEach(
      (b) =>
        (b.onclick = () => {
          const t = teamsGet().find((x) => x.id === +b.dataset.rm);
          if (!t || !confirm(`"${t.name || '팀'}"을(를) 이 기기의 팀 목록에서 지울까요?`)) return;
          removeTeam(t.id);
          sh.close();
          route();
        })
    );
    sh.q('#tadd').onclick = () => {
      sh.close();
      location.hash = '#/team?add=1';
    };
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-teamsw]');
    if (!b) return;
    ev.preventDefault();
    openTeamSheet();
  });

  // ---------- 오늘 (처음 화면): 이번 주 콘티와 바로 연주 ----------
  // 21차: 순서를 "콘티 → 검색 → 이어지는 콘티 → (편집자) 보완 제안"으로 정리하고, 아래 메뉴와 겹치던 버튼(콘티 전체·곡 목록)을 없앴다.
  // 보완 제안은 화면이 먼저 뜬 뒤에 따로 불러온다(곡 목록 전체를 읽느라 첫 화면이 늦어지지 않게).
  async function viewHome() {
    const search = `<form class="card home-search" id="hs"><input type="search" id="hq" placeholder="곡 검색 (제목 · 가사 · 원제)" enterkeyhint="search" aria-label="곡 검색"></form>`;
    const bindSearch = () => {
      el('hs').onsubmit = (ev) => {
        ev.preventDefault();
        listState.q = el('hq').value.trim();
        location.hash = '#/songs';
      };
    };
    if (!me.team) {
      $app.innerHTML = `
        ${teamChip()}
        <div class="card hero">
          <div class="hero-label">우리 팀 콘티</div>
          <h2 class="hero-title">팀에 가입하면 여기에 이번 주 콘티가 나와요</h2>
          <p class="muted" style="margin:0 0 12px">팀장에게 받은 가입코드로 입장하면 콘티를 보고 바로 연주할 수 있어요.</p>
          <a class="btn primary big" href="#/team">팀 가입하기</a>
        </div>
        ${search}`;
      bindSearch();
      return;
    }
    // 곡 목록(보완 제안용)은 콘티 목록과 동시에 요청해 둔다. 결과는 화면이 뜬 뒤에 쓴다.
    const songsP = me.canEdit ? api('/songs').catch(() => null) : null;
    const { setlists } = await api('/setlists');
    const today = todayKst();
    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
    const upcoming = setlists.filter((l) => l.date && l.date >= today).sort(byDate);
    const past = setlists.filter((l) => !l.date || l.date < today).sort((a, b) => byDate(b, a));
    const featured = upcoming[0] || past[0] || null;
    let hero;
    let heroItems = null;
    if (!featured) {
      hero = `<div class="card hero">
        <div class="hero-label">${esc(me.team.name)}</div>
        <h2 class="hero-title">아직 콘티가 없어요</h2>
        <p class="muted" style="margin:0 0 12px">콘티를 만들면 이번 주 곡이 여기에 나타나고, 한 번에 연주 모드로 들어갈 수 있어요.</p>
        <div class="row">${lockBtn('leader', '+ 새 콘티', '#/setlist/new', 'primary big')}${lockBtn('leader', '⚡ 빠른 콘티', '#/setlist/new?quick=1', 'big', true)}</div>
      </div>`;
    } else {
      const { setlist: s } = await api('/setlists/' + featured.id);
      heroItems = { id: s.id, items: s.items };
      const label = featured.date === today ? '오늘 콘티' : upcoming[0] ? '다가오는 콘티' : '가장 최근 콘티';
      const shown = s.items.slice(0, 8);
      hero = `<div class="card hero">
        <div class="hero-label">${label}${s.date ? ' · ' + esc(fmtDate(s.date)) : ''}</div>
        <h2 class="hero-title">${esc(setlistTitle(s))}</h2>
        ${s.is_temp || leadersOf(s).length ? `<div class="song-meta" style="margin:-4px 0 8px">${tempTag(s)}${leaderTag(s)}</div>` : ''}
        ${shown.length ? `<ol class="mini">${shown.map((it, i) => `<li><span class="num">${i + 1}</span><span class="grow">${esc(it.title)}</span>${(it.key || it.original_key) ? `<span class="keybadge">${esc(it.key || it.original_key)}</span>` : ''}${SongFilter.tsigHTML(it.time_sig, esc)}</li>`).join('')}</ol>${s.items.length > shown.length ? `<p class="muted small" style="margin:4px 0 0">외 ${s.items.length - shown.length}곡</p>` : ''}` : '<p class="muted">이 콘티에는 아직 곡이 없어요.</p>'}
        <div class="row" style="margin-top:12px">${shown.length ? `<a class="btn primary big grow" href="#/play/${s.id}">▶ 연주 모드</a>` : ''}<a class="btn big" href="#/setlist/${s.id}">콘티 보기</a></div>
      </div>`;
    }
    const others = upcoming.slice(1, 3);
    const quick = featured ? lockBtn('leader', '⚡ 빠른 콘티', '#/setlist/new?quick=1', 'small', true) : '';
    $app.innerHTML = `
      ${teamChip()}
      ${hero}
      ${search}
      ${others.length ? `<h2>이어지는 콘티</h2><ul class="songs">${others.map((l) => `<li class="song-item"><a href="#/setlist/${l.id}"><div class="row between"><div class="song-title">${esc(setlistTitle(l))}</div>${l.date ? `<span class="keybadge">${esc(fmtDate(l.date))}</span>` : ''}</div><div class="song-meta">${tempTag(l)}${leaderTag(l)}<span>${l.item_count}곡</span></div></a></li>`).join('')}</ul>` : ''}
      <div id="fixslot"></div>
      ${quick ? `<div class="row">${quick}</div>` : ''}`;
    bindSearch();
    // 오늘의 보완 제안 (악보 편집 권한이 있는 사람에게만): 코드·이미지 악보 중 빈 곡을 하루 3곡까지 — 화면이 뜬 뒤에 채운다
    if (songsP) {
      const gen = routeGen;
      loadFixCard(upcoming, songsP, heroItems)
        .then((fx) => {
          const slot = el('fixslot');
          if (gen !== routeGen || !slot || !fx.html) return;
          slot.innerHTML = fx.html;
          fx.bind();
        })
        .catch(() => {});
    }
  }

  // ---------- 악보 보완 제안 (13차) ----------
  const FIX_HIDE_KEY = 'ews_fix_hide'; // {곡번호: 이 시각(ms)까지 숨김} — "나중에"를 누른 곡은 7일 동안 제안에서 뺀다 (이 기기에만 저장)
  function fixHidden() {
    let h = {};
    try { h = JSON.parse(ls.get(FIX_HIDE_KEY, '{}')) || {}; } catch { h = {}; }
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(h)) if (!(h[k] > now)) { delete h[k]; changed = true; }
    if (changed) ls.set(FIX_HIDE_KEY, JSON.stringify(h));
    return h;
  }
  async function loadFixCard(upcoming, songsP, known) {
    const lists = upcoming.slice(0, 3);
    const [songsRes, details] = await Promise.all([
      songsP || api('/songs'),
      Promise.all(lists.map((l) => (known && known.id === l.id ? Promise.resolve(known.items) : api('/setlists/' + l.id).then((r) => r.setlist.items).catch(() => [])))),
    ]);
    if (!songsRes) return { html: '', bind() {} };
    const { songs } = songsRes;
    const soon = new Set(details.flat().map((it) => it.song_id));
    const stat = SongFilter.stats(songs);
    const pick = SongFilter.suggest(songs, { upcoming: soon, hidden: fixHidden(), max: 3 });
    if (!pick.length) return { html: '', bind() {} };
    const row = (r) => {
      const why = r.soon ? '다가오는 콘티에 있는 곡' : r.s.use_count ? `우리 팀이 ${r.s.use_count}번 쓴 곡` : '';
      return `<li class="fixrow" data-id="${r.s.id}"><div class="grow"><b>${esc(r.s.title)}</b><div class="small muted"><span class="tag warn">${esc(SongFilter.missingText(r.s))}</span>${why ? ' ' + esc(why) : ''}</div></div><a class="btn small primary" href="#/edit/${r.s.id}?fix=${SongFilter.fixTarget(r.s)}">채우기</a><button type="button" class="btn small" data-later="${r.s.id}">나중에</button></li>`;
    };
    const html = `<div class="card fixcard" id="fixcard">
      <div class="row between"><h2 style="margin:0">오늘의 보완 제안</h2><a class="small" href="#/status">악보 현황 ${stat.full}/${stat.total}곡 완성</a></div>
      <p class="muted small" style="margin:4px 0 8px">코드 악보와 이미지·PDF 악보가 둘 다 있으면 가장 좋아요. 하루에 한두 곡씩 채워 보세요.</p>
      <ul class="fixlist">${pick.map(row).join('')}</ul>
    </div>`;
    return {
      html,
      bind() {
        const card = el('fixcard');
        if (!card) return;
        card.onclick = (ev) => {
          const b = ev.target.closest && ev.target.closest('button[data-later]');
          if (!b) return;
          const h = fixHidden();
          h[b.dataset.later] = Date.now() + 7 * 24 * 3600 * 1000;
          ls.set(FIX_HIDE_KEY, JSON.stringify(h));
          const li = b.closest('li');
          if (li) li.remove();
          if (!card.querySelector('li')) card.remove();
          toast('이 곡은 7일 동안 제안에서 뺐어요.');
        };
      },
    };
  }

  // ---------- 악보 현황 (더보기 > 악보 현황, 편집 권한자) ----------
  async function viewStatus() {
    if (!me.canEdit) {
      $app.innerHTML = `<div class="row between"><a href="#/more" class="small">← 더보기</a></div><div class="card"><p>악보를 편집할 수 있는 사람만 볼 수 있어요.</p>${me.adminRequired ? lockBtn('song', 'PIN 입력', '#/status', 'primary') : ''}</div>`;
      return;
    }
    const { songs } = await api('/songs');
    const st = SongFilter.stats(songs);
    const pct = st.total ? Math.round((st.full / st.total) * 100) : 0;
    const GROUPS = [
      ['none', '악보가 하나도 없는 곡'],
      ['chord', '코드 악보만 있고 이미지·PDF가 없는 곡'],
      ['file', '이미지·PDF만 있고 코드 악보가 없는 곡'],
    ];
    const byUse = (a, b) => (b.use_count || 0) - (a.use_count || 0) || String(a.title).localeCompare(String(b.title), 'ko');
    const list = (state) => songs.filter((x) => SongFilter.completeness(x) === state).sort(byUse);
    $app.innerHTML = `
      <div class="row between"><a href="#/more" class="small">← 더보기</a></div>
      <h1>악보 현황</h1>
      <div class="card">
        <div class="row between"><b>완성 ${st.full} / ${st.total}곡</b><span class="muted">${pct}%</span></div>
        <div class="bar" role="img" aria-label="완성 ${pct}%"><span style="width:${pct}%"></span></div>
        <p class="muted small" style="margin:8px 0 0">완성 = 코드 악보 + 이미지·PDF 악보가 둘 다 있는 곡 · 코드만 ${st.chord} · 이미지·PDF만 ${st.file} · 하나도 없음 ${st.none}</p>
      </div>
      ${GROUPS.map(([k, label]) => {
        const rows = list(k);
        if (!rows.length) return '';
        return `<h2>${label} <span class="muted small">${rows.length}곡</span></h2><ul class="songs">${rows.map((x) => `<li class="song-item"><a href="#/edit/${x.id}?fix=${SongFilter.fixTarget(x)}"><div class="row between"><div class="song-title">${esc(x.title)}</div><span class="small muted">채우기 ▶</span></div><div class="song-meta">${x.original_key ? `<span class="keybadge">${esc(x.original_key)}</span>` : ''}${SongFilter.badgesHTML(x, esc)}${x.use_count ? `<span>우리 팀 ${x.use_count}번</span>` : ''}</div></a></li>`).join('')}</ul>`;
      }).join('') || '<p class="muted center">모든 곡이 완성되어 있어요. 🎉</p>'}
      <p><a class="btn" href="#/songs?fmt=missing">곡 목록에서 빠진 것만 보기</a></p>`;
  }

  // ---------- 더보기: 우리 팀 · 내 필기 · 편집 권한 · 관리 · 기기 정보 · 로그아웃 ----------
  // 21차: 자주 쓰는 것(팀·내 필기)을 위에, 권한·관리는 아래에 묶고, 진단·저장 공간 같은 기기 정보는 접어 둔다.
  async function viewMore() {
    const t = me.team;
    const leader = !!(t && t.isLeader);
    const saved = teamsGet();
    const stale = saved.some((x) => x.stale);
    const perm = (name, ok, hint, kind) =>
      `<div class="perm"><div class="grow"><b>${name}</b><div class="small muted">${hint}</div></div>${ok ? '<span class="pill ok">가능</span>' : lockBtn(kind, '열기', '', 'small') || '<span class="pill">불가</span>'}</div>`;
    const link = (href, title, sub) => `<a class="rowlink" href="${href}"><span class="grow"><b>${title}</b><span class="small muted">${sub}</span></span><span class="chev" aria-hidden="true">›</span></a>`;
    const showPerm = !!t || me.adminRequired;
    const adminRows = [
      me.canEdit ? link('#/status', '악보 현황', '코드·이미지 악보가 빠진 곡 보기') : '',
      me.adminRequired ? link('#/admin', '앱 관리', me.isAdmin ? '팀 · 초대코드 · 추천 태그 · 백업' : '관리자 PIN 필요') : '',
    ].filter(Boolean);
    $app.innerHTML = `
      <h1>더보기</h1>
      <h2 class="grp">우리 팀</h2>
      <div class="card rows">
        ${link('#/team', t ? esc(t.name) : '팀 가입', t ? '가입코드 · 팀장 PIN · 팀 나가기' : '팀장에게 받은 가입코드로 입장하기')}
        ${saved.length ? `<button type="button" class="rowlink" data-teamsw><span class="grow"><b>팀 전환 · 추가</b><span class="small muted">가입한 팀 ${saved.length}개${stale ? ' · 다시 입장이 필요한 팀이 있어요' : ''}</span></span><span class="chev" aria-hidden="true">›</span></button>` : ''}
      </div>
      <div class="card" id="vaultcard"></div>
      ${showPerm ? `<h2 class="grp">편집 · 관리</h2>
      <div class="card">
        ${t ? perm('콘티 편집', leader, leader ? '팀장 PIN으로 열려 있어요' : '팀장 PIN을 입력하면 열려요', 'leader') : ''}
        ${perm('악보 편집', !!me.canEdit, me.canEdit ? '이 기기에서 열려 있어요' : me.adminRequired ? '관리자 PIN을 입력하면 열려요' : '관리자 PIN이 설정되지 않았어요', 'song')}
        ${me.isAdmin || leader ? '<p style="margin:10px 0 0"><button class="btn small" id="closeperm" type="button">이 기기에서 편집 권한 닫기</button></p>' : ''}
      </div>` : ''}
      ${adminRows.length ? `<div class="card rows">${adminRows.join('')}</div>` : ''}
      <details class="card fold"><summary>기기 · 앱 정보</summary>
        <p class="muted small" id="persistnote" style="margin-top:0"></p>
        <p class="muted small">교회 내부용 악보집입니다. 저작권 보호를 위해 외부 공유를 삼가 주세요.</p>
        <div class="row"><button class="btn small" id="viewdbgbtn" type="button">화면 진단 ${viewDbgOn() ? '끄기' : '켜기'}</button></div>
      </details>
      <div class="footer"><button id="logout" type="button">로그아웃</button></div>`;
    el('viewdbgbtn').onclick = () => {
      ls.set('ews_view_dbg', viewDbgOn() ? '0' : '1');
      el('viewdbgbtn').textContent = '화면 진단 ' + (viewDbgOn() ? '끄기' : '켜기');
      if (viewDbgOn()) fitNav(); else viewDbgDraw();
    };
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((on) => {
        const n = el('persistnote');
        if (n) n.textContent = on
          ? '이 기기의 저장 공간 보호: 켜짐 (오프라인 악보와 곡별 키 설정이 함부로 지워지지 않아요)'
          : '이 기기의 저장 공간 보호: 꺼짐 — 기기 공간이 부족하면 브라우저가 오프라인 악보와 곡별 키 설정을 지울 수 있어요. 홈 화면에 추가해서 쓰면 더 안전합니다.';
      }).catch(() => {});
    }
    if (window.Ink) Ink.mountVaultCard(el('vaultcard'));
    const cp = el('closeperm');
    if (cp) cp.onclick = () => {
      ls.del('ews_admin');
      clearAllLeaders(); // 가입한 모든 팀의 팀장 열쇠를 닫는다
      toast('이 기기의 편집 권한을 닫았습니다.');
      route();
    };
    el('logout').onclick = () => {
      clearSession();
      route();
    };
  }

  // ---------- 팀 ----------
  const goHash = (h) => { if (location.hash === h) route(); else location.hash = h; };
  async function viewTeam(q) {
    // 팀이 없거나(또는 "다른 팀 추가"로 들어왔으면): 가입코드로 입장 / 새 팀 만들기 / 팀 없이 보기
    const adding = !!(q && q.get('add') === '1');
    if (!me.team || adding) {
      const reName = (q && q.get('re')) || '';
      const staleTeams = teamsGet().filter((x) => x.stale);
      const note = reName
        ? `<p class="muted"><b>${esc(reName)}</b> 팀은 가입코드가 바뀌어 다시 입장해야 해요. 팀장에게 새 가입코드를 받아 입력해 주세요.</p>`
        : staleTeams.length && !me.team
          ? `<p class="muted"><b>${esc(staleTeams.map((x) => x.name || '팀').join(', '))}</b> 팀은 가입코드가 바뀌어 다시 입장해야 해요. 새 가입코드를 입력하면 돼요.</p>`
          : '';
      $app.innerHTML = `
        ${me.team ? '<div class="row between"><a href="#/more" class="small">← 더보기</a></div>' : ''}
        <h1>${me.team ? '다른 팀 추가' : '팀 가입'}</h1>
        ${note}
        <p class="muted">콘티는 팀 단위로 공유됩니다. 팀장에게 받은 <b>가입코드</b>로 입장하세요.${me.team ? ' 여러 팀에 가입해 두고 팀 이름 칩으로 바꿔 볼 수 있어요.' : ''}</p>
        <form class="card" id="jf">
          <label for="jc" style="margin-top:0">팀 가입코드</label>
          <input id="jc" type="text" autocapitalize="characters" autocomplete="off" autofocus placeholder="예: AB12CD34">
          <p class="error" id="jerr"></p>
          <p><button class="btn primary">팀 입장</button></p>
        </form>
        <details class="card">
          <summary>새 팀 만들기</summary>
          ${
            me.inviteEnabled
              ? `<form id="cf">
                  <label for="ci">초대코드</label><input id="ci" type="password" autocomplete="off">
                  <label for="cn">팀 이름</label><input id="cn" type="text" maxlength="40" placeholder="예: 청년부 찬양팀">
                  <label for="cp">팀장 PIN (4자 이상)</label><input id="cp" type="password" autocomplete="new-password">
                  <p class="hint">만든 사람이 팀장이 됩니다. 콘티를 만들고 고칠 때 필요하니 잊지 마세요.</p>
                  <p class="error" id="cerr"></p>
                  <p><button class="btn primary">팀 만들기</button></p>
                </form>`
              : '<p class="muted small">팀 만들기는 관리자가 초대코드를 열어 줘야 사용할 수 있습니다.</p>'
          }
        </details>
        ${me.team ? '' : '<p><button class="btn" id="skip">팀 없이 곡만 볼게요</button></p><p class="muted small">팀 없이도 곡 목록과 악보는 볼 수 있습니다. 콘티는 팀에 가입해야 볼 수 있어요.</p>'}`;
      el('jf').onsubmit = async (ev) => {
        ev.preventDefault();
        el('jerr').textContent = '';
        try {
          const r = await api('/teams/join', { method: 'POST', body: { code: el('jc').value } });
          addTeam(r.team, r.teamToken); // 같은 팀이면 열쇠만 새로 바뀌고, 이 팀이 지금 보는 팀이 된다
          ls.del('ews_team_skip');
          toast(`"${r.team.name}" 팀에 입장했습니다.`);
          goHash('#/setlists');
        } catch (e) {
          el('jerr').textContent = e.message;
        }
      };
      const cf = el('cf');
      if (cf)
        cf.onsubmit = async (ev) => {
          ev.preventDefault();
          el('cerr').textContent = '';
          try {
            const r = await api('/teams', { method: 'POST', body: { invite: el('ci').value, name: el('cn').value, pin: el('cp').value } });
            addTeam(r.team, r.teamToken, r.leaderToken);
            ls.del('ews_team_skip');
            toast(`"${r.team.name}" 팀을 만들었습니다. 가입코드를 팀원에게 알려 주세요.`);
            goHash('#/team');
          } catch (e) {
            el('cerr').textContent = e.message;
          }
        };
      const sk = el('skip');
      if (sk)
        sk.onclick = () => {
          ls.set('ews_team_skip', '1');
          location.hash = '#/';
        };
      return;
    }

    const { team } = await api('/team');
    const leader = !!team.isLeader;
    $app.innerHTML = `
      <div class="row between"><a href="#/more" class="small">← 더보기</a><button type="button" class="btn small" data-teamsw>팀 전환 · 추가</button></div>
      <h1>${esc(team.name)}</h1>
      <p class="muted">${leader ? '팀장으로 열려 있습니다.' : '팀원으로 입장했습니다.'}</p>
      ${
        leader
          ? `<div class="card">
              <h2>팀 가입코드</h2>
              <div class="bigcode" id="jcode">${esc(team.join_code)}</div>
              <div class="row"><button class="btn small" id="cpy">복사</button><button class="btn small danger" id="reissue">재발급</button></div>
              <p class="hint">팀원에게 알려 주세요. 재발급하면 이전 코드는 쓸 수 없고, 기존 팀원은 새 코드로 다시 입장해야 합니다.</p>
            </div>
            <p class="muted small">${team.canEditSongs ? '이 팀 팀장은 악보도 등록·수정할 수 있습니다.' : '이 팀 팀장은 콘티만 편집할 수 있습니다. 악보 편집이 필요하면 관리자에게 요청해 주세요.'}</p>
            <details class="card fold"><summary>팀장 PIN 변경</summary>
              <form id="pf">
                <label for="pc" style="margin-top:0">현재 PIN</label><input id="pc" type="password" autocomplete="current-password">
                <label for="pn">새 PIN (4자 이상)</label><input id="pn" type="password" autocomplete="new-password">
                <p class="error" id="perr"></p>
                <p><button class="btn">PIN 변경</button></p>
              </form>
            </details>
            <p><button class="btn" id="lout">팀장 권한 닫기</button></p>`
          : `<div class="card"><h2>콘티 편집</h2><p class="muted small" style="margin-top:0">콘티를 만들고 고치려면 팀장 PIN이 필요해요.</p>${lockBtn('leader', '팀장 PIN 입력', '', '')}</div>`
      }
      <div class="footer"><button id="leave">이 기기에서 팀 나가기</button></div>`;
    if (leader) {
      el('cpy').onclick = () => copyText(team.join_code);
      el('reissue').onclick = async () => {
        if (!confirm('가입코드를 다시 발급할까요?\n기존 팀원은 새 코드로 다시 입장해야 합니다.')) return;
        try {
          const r = await api('/team/join-code', { method: 'POST' });
          setActiveTeamToken(r.teamToken);
          toast('새 가입코드를 발급했습니다.');
          route();
        } catch (e) {
          toast(e.message);
        }
      };
      el('pf').onsubmit = async (ev) => {
        ev.preventDefault();
        el('perr').textContent = '';
        try {
          const r = await api('/team/leader-pin', { method: 'POST', body: { current: el('pc').value, pin: el('pn').value } });
          setActiveLeader(r.leaderToken);
          toast('PIN을 바꿨습니다. 다른 기기에서는 새 PIN으로 다시 로그인해야 합니다.');
          route();
        } catch (e) {
          el('perr').textContent = e.message;
        }
      };
      el('lout').onclick = () => {
        setActiveLeader('');
        toast('팀장 권한을 닫았습니다.');
        route();
      };
    }
    el('leave').onclick = () => {
      if (!confirm(`이 기기에서 "${team.name}" 팀을 나갈까요?\n(다시 들어오려면 가입코드가 필요합니다)`)) return;
      removeTeam(team.id); // 이 팀만 지운다. 가입한 다른 팀은 그대로
      route();
    };
  }

  // ---------- 콘티 목록 ----------
  async function viewSetlists() {
    if (!me.team) {
      $app.innerHTML = `<h1>콘티</h1>${noteBox('<p>콘티는 팀 단위로 공유됩니다. 팀에 가입하면 이 팀의 콘티를 볼 수 있어요.</p><a class="btn primary" href="#/team">팀 가입하기</a>')}`;
      return;
    }
    const [{ setlists, canEdit }, opts] = await Promise.all([api('/setlists'), api('/team/options').catch(() => ({ services: [] }))]);
    let services = opts.services || [];
    let sel = ls.get('ews_sl_svc', ''); // '' 전체 · 'none' 미분류 · 예배 종류 번호
    let pickMode = false;
    const picked = new Set();
    const tmpCount = () => setlists.filter((l) => l.is_temp).length;
    const draw = () => {
      if (sel && sel !== 'none' && !services.some((x) => String(x.id) === sel)) sel = '';
      const hasNone = setlists.some((l) => !l.service_id);
      const shown = setlists.filter((l) => (sel === '' ? true : sel === 'none' ? !l.service_id : String(l.service_id) === sel));
      const chip = (v, text, n) => `<button type="button" class="chip ${sel === v ? 'on' : ''}" data-svc="${v}">${esc(text)}${n !== undefined ? ` <small>${n}</small>` : ''}</button>`;
      const svcRow = services.length || canEdit
        ? `<div class="chips svc-row">${chip('', '전체', setlists.length)}${services.map((x) => chip(String(x.id), x.name, setlists.filter((l) => l.service_id === x.id).length)).join('')}${hasNone && services.length ? chip('none', '미분류', setlists.filter((l) => !l.service_id).length) : ''}${canEdit ? '<button type="button" class="chip" id="svcmgr" aria-label="예배 종류 관리">⚙ 종류 관리</button>' : ''}</div>`
        : '';
      const row = (l) => {
        const inner = `<div class="row between"><div class="song-title">${esc(setlistTitle(l))}</div>${l.date ? `<span class="keybadge">${esc(fmtDate(l.date))}</span>` : ''}</div>
          <div class="song-meta">${tempTag(l)}${l.service_name && (l.title || '').trim() ? `<span class="tag">${esc(l.service_name)}</span>` : ''}${leaderTag(l)}<span>${l.item_count}곡</span></div>`;
        return pickMode
          ? `<li class="song-item"><label class="pickrow"><input type="checkbox" data-pk="${l.id}" ${picked.has(l.id) ? 'checked' : ''}><span class="grow">${inner}</span></label></li>`
          : `<li class="song-item"><a href="#/setlist/${l.id}">${inner}</a></li>`;
      };
      $app.innerHTML = `
        ${teamChip()}
        <div class="row between"><h1>콘티</h1>${lockBtn('leader', '+ 새 콘티', '#/setlist/new', 'primary')}</div>
        <div class="row" style="margin-bottom:6px">${lockBtn('leader', '⚡ 빠른 콘티', '#/setlist/new?quick=1', '', true)}${canEdit && setlists.length ? `<button type="button" class="btn" id="pickmode">${pickMode ? '정리 끝' : '여러 개 정리'}</button>` : ''}</div>
        ${svcRow}
        ${pickMode ? `<div class="row card" style="padding:8px 10px;margin:6px 0"><span class="small grow">${picked.size}개 선택</span>${tmpCount() ? '<button type="button" class="btn small" id="picktmp">⚡ 임시 모두 선택</button>' : ''}<button type="button" class="btn small danger" id="pickdel" ${picked.size ? '' : 'disabled'}>삭제</button></div>` : ''}
        ${shown.length ? `<ul class="songs">${shown.map(row).join('')}</ul>` : `<p class="muted center">${setlists.length ? '이 종류의 콘티가 없습니다.' : '아직 콘티가 없습니다.'}${canEdit && !setlists.length ? ' “+ 새 콘티”로 만들어 보세요.' : ''}</p>`}`;
      const mgr = el('svcmgr');
      if (mgr) mgr.onclick = () => manageOptions('service', async () => { services = (await api('/team/options')).services; draw(); });
      const pm = el('pickmode');
      if (pm) pm.onclick = () => { pickMode = !pickMode; picked.clear(); draw(); };
      const pt = el('picktmp');
      if (pt) pt.onclick = () => { setlists.filter((l) => l.is_temp).forEach((l) => picked.add(l.id)); draw(); };
      const pd = el('pickdel');
      if (pd) pd.onclick = async () => {
        if (!picked.size || !confirm(`선택한 콘티 ${picked.size}개를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
        try {
          await api('/setlists/delete', { method: 'POST', body: { ids: [...picked] } });
          for (let i = setlists.length - 1; i >= 0; i--) if (picked.has(setlists[i].id)) setlists.splice(i, 1);
          toast('삭제했습니다.');
          picked.clear();
          pickMode = false;
          draw();
        } catch (e) { toast(e.message); }
      };
    };
    draw();
    $app.onclick = (ev) => {
      const c = ev.target.closest && ev.target.closest('button[data-svc]');
      if (c) { sel = c.dataset.svc; ls.set('ews_sl_svc', sel); draw(); return; }
      const k = ev.target.closest && ev.target.closest('input[data-pk]');
      if (k) {
        const id = +k.dataset.pk;
        if (k.checked) picked.add(id); else picked.delete(id);
        const y = window.scrollY;
        draw();
        window.scrollTo(0, y);
      }
    };
  }

  // ---------- 콘티 보기 ----------
  async function viewSetlist(id) {
    const { setlist: s, canEdit } = await api('/setlists/' + id);
    const shownTitle = setlistTitle(s);
    document.title = shownTitle + ' · Everyday Worship Songbook';
    // 내보내기(카톡 텍스트·표지·PDF)에는 날짜가 따로 들어가므로, 제목이 비었으면 예배 종류 이름만 쓴다
    const exp = { ...s, title: (s.title || '').trim() || s.service_name || '' };
    const rows = s.items.map((it, i) => {
      const key = it.key || it.original_key || '';
      const imageOnly = it.view === 'image' || (!it.has_chords && it.file_count > 0);
      const p = new URLSearchParams();
      if (it.key) p.set('key', it.key);
      if (it.view !== 'auto') p.set('view', it.view);
      p.set('sl', id);
      if (it.uid) p.set('u', it.uid);
      const imgKeyNote = imageOnly && it.key && it.original_key && it.key !== it.original_key;
      return `<li class="song-item"><a href="#/song/${it.song_id}?${p.toString()}">
        <div class="row between"><div class="song-title"><span class="num">${i + 1}</span>${esc(it.title)}</div>${key || it.time_sig ? `<span class="row" style="gap:6px">${key ? `<span class="keybadge">${esc(key)}</span>` : ''}${SongFilter.tsigHTML(it.time_sig, esc)}</span>` : ''}</div>
        <div class="song-meta">
          ${it.form ? `<span>송폼 ${formHtml(it.form, key)}</span>` : ''}
          ${imageOnly ? '<span class="fmt img" title="이미지 악보" aria-label="이미지 악보">🎼</span>' : it.has_chords ? '<span class="fmt chord" title="코드 악보" aria-label="코드 악보"><b class="cmk">Chord</b></span>' : ''}
          ${it.memo ? `<span>${esc(it.memo)}</span>` : ''}
        </div>
        ${imgKeyNote ? `<div class="hint" style="margin:2px 0 0">이미지 악보는 원래 키(${esc(it.original_key)}) 기준 · 이 콘티에서는 ${esc(it.key)}로 부름</div>` : ''}
      </a></li>`;
    });
    $app.innerHTML = `
      <div class="row between"><a href="#/setlists" class="small">← 콘티 목록</a><span class="row" style="gap:6px">${lockBtn('leader', '복사', '#/setlist/new?copy=' + id, 'small', true)}${lockBtn('leader', '편집', '#/setlist/' + id + '/edit', 'small')}</span></div>
      <h1>${esc(shownTitle)}</h1>
      <div class="song-meta" style="margin-bottom:10px">${tempTag(s)}${s.date ? `<span class="keybadge">${esc(fmtDate(s.date))}</span>` : ''}${s.service_name && (s.title || '').trim() ? `<span class="tag">${esc(s.service_name)}</span>` : ''}${leaderTag(s)}<span>${s.items.length}곡</span></div>
      ${s.is_temp && canEdit ? '<div class="card tempbar"><span class="small grow">⚡ 급하게 만든 임시 콘티예요. 정리가 끝나면 확정해 두세요.</span><button class="btn small primary" id="confirmtmp" type="button">확정</button></div>' : ''}
      ${s.memo ? `<div class="memo" style="margin-bottom:12px">${esc(s.memo)}</div>` : ''}
      ${rows.length ? `<div class="row actions"><a class="btn primary big grow" href="#/play/${id}">▶ 연주 모드</a><button class="btn big" id="share" type="button">공유·저장</button></div>` : ''}
      ${rows.length ? `<ul class="songs">${rows.join('')}</ul>` : '<p class="muted">아직 곡이 없습니다.</p>'}
      <p class="muted small">곡을 누르면 이 콘티의 키로 악보가 열립니다.</p>`;

    const $ct = document.getElementById('confirmtmp');
    if ($ct) $ct.onclick = async () => {
      $ct.disabled = true;
      try {
        await api('/setlists/' + id + '/confirm', { method: 'POST' });
        toast('확정했습니다.');
        route();
      } catch (e) {
        if (e.status === 403) await loadMe();
        toast(e.message);
        $ct.disabled = false;
      }
    };

    // ----- 공유·저장 창: 카톡용 텍스트 · 표지 이미지 · PDF · 오프라인 준비 -----
    const $share = document.getElementById('share');
    if (!$share) return;
    $share.onclick = () => {
      const sh = showSheet(`<h2 style="margin-top:0">공유·저장</h2>
        <div class="share-list">
          <button class="share-item" id="x-text" type="button"><b>💬 카톡용 텍스트 복사</b><span>곡 순서·키·송폼·메모를 글자로 복사해요</span></button>
          <button class="share-item" id="x-lyr" type="button"><b>🎤 가사 복사</b><span>콘티의 가사를 글자로 복사해요 (자막·문서용, 3가지 모양)</span></button>
          <button class="share-item" id="x-png" type="button"><b>🖼 표지 이미지</b><span>콘티 한 장짜리 그림(PNG)으로 저장·공유해요</span></button>
          <button class="share-item" id="x-pdf" type="button"><b>📄 PDF 만들기</b><span>표지 + 곡별 악보를 PDF 한 파일로 만들어요</span></button>
          <button class="share-item" id="x-off" type="button"><b>⬇ 오프라인 준비</b><span>인터넷이 없는 곳에서도 이 콘티를 열 수 있게 저장해요</span></button>
        </div>
        <button class="btn" id="xclose0" type="button" style="width:100%;margin-top:10px">닫기</button>`);
      sh.q('#xclose0').onclick = () => sh.close();
      const $off = sh.q('#x-off');
      $off.onclick = async () => {
        $off.disabled = true;
        try { await prepareOffline(s.items); } finally { $off.disabled = false; }
      };

    
    const baseName = [s.date, (exp.title || '콘티').trim()].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || '콘티';
    const $xl = sh.q('#x-lyr');
    if ($xl) $xl.onclick = () => {
      sh.close();
      lyricsSheet('가사 복사', () => fetchLyricEntries(s.items));
    };
    const $xt = sh.q('#x-text');
    if ($xt) $xt.onclick = async () => {
      const text = SongForm.kakaoText(exp);
      try {
        await navigator.clipboard.writeText(text);
        sh.close();
        toast('복사했습니다. 카카오톡에 붙여넣기 하세요.');
      } catch {
        // 복사가 막힌 환경: 글자를 보여 주고 직접 복사하게 한다
        const sh = showSheet(`<h2 style="margin-top:0">카톡용 텍스트</h2><textarea id="xta" rows="12" readonly style="font-size:16px">${esc(text)}</textarea><p class="hint">글자를 길게 눌러 전체 선택 후 복사해 주세요.</p><button class="btn primary" id="xclose" type="button" style="width:100%">닫기</button>`);
        sh.q('#xclose').onclick = () => sh.close();
        const ta = sh.q('#xta');
        ta.focus();
        ta.select();
      }
    };
    const guarded = async (btn, label, fn) => {
      const orig = btn.innerHTML;
      btn.disabled = true;
      try {
        await loadExporter();
        await fn((t) => { btn.textContent = t; });
      } catch (e) {
        toast(e.message || `${label}을 만들지 못했습니다.`);
      } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    };
    const $xp = sh.q('#x-png');
    if ($xp) $xp.onclick = () => guarded($xp, '이미지', async () => {
      const blob = await Exporter.coverPng(exp);
      sh.close();
      showFileResult(blob, baseName + '.png', 'png');
    });
    const $xd = sh.q('#x-pdf');
    if ($xd) $xd.onclick = () => guarded($xd, 'PDF', async (setLabel) => {
      const r = await Exporter.buildPdf(exp, {
        getSong: async (sid) => (await api('/songs/' + sid)).song,
        getBytes: async (url) => {
          const res = await fetch(url);
          if (!res.ok) throw new Error('file');
          return res.arrayBuffer();
        },
        onProgress: (d, t, label) => setLabel(`만드는 중… ${Math.min(d + 1, t)}/${t} ${label}`),
      });
      sh.close();
      showFileResult(r.blob, baseName + '.pdf', 'pdf', r.warnings);
    });
    };
  }

  // 내보내기 도구는 필요할 때만 불러온다 (PDF 도구 + export.js)
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('내보내기 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
      document.head.appendChild(s);
    });
  }
  async function loadExporter() {
    if (!window.PDFLib) await loadScript('vendor/pdf-lib.min.js');
    if (!window.Exporter) await loadScript('export.js');
  }
  // 만든 파일을 바로 공유·저장할 수 있게 창을 띄운다. (오래 걸린 작업 뒤에는 브라우저가 공유를 막을 수 있어서, 새로 한 번 더 누르게 한다)
  function showFileResult(blob, name, kind, warnings) {
    const url = URL.createObjectURL(blob);
    let canShare = false;
    let file = null;
    try {
      file = new File([blob], name, { type: blob.type });
      canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
    } catch {}
    const kb = blob.size / 1024;
    const size = kb > 1024 ? (kb / 1024).toFixed(1) + 'MB' : Math.round(kb) + 'KB';
    const warn = warnings && warnings.length ? `<div class="memo" style="margin:8px 0">${warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : '';
    const sh = showSheet(
      `<h2 style="margin-top:0">${kind === 'pdf' ? 'PDF' : '표지 이미지'}가 준비됐어요</h2>
       ${kind === 'png' ? `<div class="exp-result"><img src="${url}" alt="콘티 표지 미리보기"></div>` : ''}
       <p class="muted small">${esc(name)} · ${size}</p>${warn}
       <div class="row">
         ${canShare ? '<button class="btn primary big" id="xshare" type="button">공유하기</button>' : ''}
         <a class="btn ${canShare ? '' : 'primary big'}" href="${url}" download="${esc(name)}">저장</a>
         <a class="btn" href="${url}" target="_blank" rel="noopener">열어 보기</a>
       </div>
       <button class="btn" id="xclose" type="button" style="width:100%;margin-top:8px">닫기</button>`,
      () => setTimeout(() => URL.revokeObjectURL(url), 120000)
    );
    sh.q('#xclose').onclick = () => sh.close();
    const $s = sh.q('#xshare');
    if ($s) $s.onclick = async () => {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (e) {
        if (e && e.name !== 'AbortError') toast('공유하지 못했습니다. "저장"을 눌러 주세요.');
      }
    };
  }

  // ---------- 연주 모드 (5차) ----------
  // 전체 화면 악보. 위쪽 한 줄(곡 이름·키·송폼·메모)만 남기고 나머지는 모두 악보다.
  // 이미지 악보는 확대 없이 한 장이 화면(위아래·좌우)에 통째로 들어오게 맞추고, 좌우로 밀어 쪽·곡을 넘긴다.
  // src: { sl: 콘티 번호 } 또는 { songId: 곡 번호 }  ·  q: ?i=시작 순서 / ?song=곡 번호 / (곡 하나일 때) key, view
  async function viewPlay(src, q) {
    q = q || new URLSearchParams();
    let items;
    if (src.sl) {
      items = (await api('/setlists/' + src.sl)).setlist.items;
    } else {
      items = [{ song_id: src.songId, title: '', key: q.get('key') || '', form: '', memo: '', view: ['chord', 'image'].includes(q.get('view')) ? q.get('view') : 'auto' }];
    }
    if (!items.length) {
      $app.innerHTML = noteBox(`<p>이 콘티에는 아직 곡이 없습니다.</p><a class="btn" href="#/setlist/${src.sl}">콘티로 돌아가기</a>`);
      return;
    }
    let idx = 0;
    if (src.sl) {
      if (/^\d+$/.test(q.get('i') || '')) idx = Math.min(items.length - 1, +q.get('i'));
      else if (/^\d+$/.test(q.get('song') || '')) idx = Math.max(0, items.findIndex((it) => it.song_id === +q.get('song')));
    }
    const multi = items.length > 1;
    const P = {
      size: Math.min(48, Math.max(14, +ls.get('ews_play_size', '22') || 22)),
      chords: ls.get('ews_chords', '1') === '1',
      acc: ls.get('ews_acc', 'auto'),
      theme: ls.get('ews_play_theme', 'auto'),
      wake: ls.get('ews_play_wake', '1') === '1',
      cols: ['auto', '1', '2'].includes(ls.get('ews_play_cols', 'auto')) ? ls.get('ews_play_cols', 'auto') : 'auto',
      pages: ls.get('ews_play_pages', '1') !== '0', // 긴 코드 악보: 쪽 넘기기(기본) / 세로 스크롤
      names: ls.get('ews_names', 'full') === 'abbr' ? 'abbr' : 'full', // 구간 이름: 풀네임 / 약어
    };
    const exitHref = src.sl ? '#/setlist/' + src.sl : '#/song/' + src.songId + (q.toString() ? '?' + q.toString() : '');

    $app.innerHTML = `
      <div class="play" id="play">
        <div class="play-top">
          <div class="play-row">
            <a class="pbtn" id="pexit" href="${exitHref}" aria-label="연주 모드 나가기">✕</a>
            <button class="play-title" id="ptitle" type="button"></button>
            <span class="play-off" id="poff" hidden>오프라인</span>
            <button class="pbtn" id="pink" type="button" aria-label="악보에 필기" hidden>✎</button>
            <button class="pbtn" id="pgear" type="button" aria-label="설정">⚙</button>
          </div>
          <div class="play-info" id="pinfo"></div>
        </div>
        <div class="play-main">
          <div class="play-body" id="pbody"></div>
          <div class="play-edge l" id="pel" hidden></div>
          <div class="play-edge r" id="per" hidden></div>
          <div class="play-dots" id="pdots"></div>
        </div>
        <div class="play-sheet" id="psheet" hidden></div>
        <div class="play-sheet" id="plsheet" hidden></div>
      </div>`;
    const g = (id) => document.getElementById(id);
    const $play = g('play');
    const $pb = g('pbody');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 콘티에서 연 연주 모드: 곡 칸마다 콘티용 필기가 따로 붙는다
    const slOf = (it) => (src.sl && it && it.uid ? { uid: it.uid, setlistId: +src.sl } : undefined);
    if (src.sl && window.Ink) Ink.pullSetlist(+src.sl);
    g('pink').onclick = () => {
      if (!cur || !cur.pages.length) return;
      Ink.edit({ files: cur.pages, start: cur.page, songId: cur.song.id, title: cur.song.title, sl: slOf(cur.it), onClose: (pg) => { if (cur) { cur.page = Math.min(pg, cur.pages.length - 1); draw(); } } });
    };

    // ----- 곡 불러오기 (한 번 불러온 곡은 이 화면 안에서 다시 쓴다. 악보 이미지 주소는 오래되면 만료되니 40분 뒤엔 새로 받는다) -----
    const songCache = new Map();
    const readySongs = new Map(); // 이미 받아 둔 곡(옆으로 밀 때 이웃 곡을 바로 보여 주는 데 쓴다)
    function loadSong(sid) {
      const hit = songCache.get(sid);
      if (hit && Date.now() - hit.t < 40 * 60 * 1000) return hit.p;
      const p = api('/songs/' + sid).then((r) => { readySongs.set(sid, r.song); if (window.Ink) Ink.pull(sid); return r.song; });
      songCache.set(sid, { t: Date.now(), p });
      p.catch(() => songCache.delete(sid));
      return p;
    }
    function prefetch(i) {
      if (i < 0 || i >= items.length) return;
      loadSong(items[i].song_id)
        .then((s) => (s.files || []).filter((f) => f.kind === 'image').slice(0, 2).forEach((f) => { new Image().src = f.url; }))
        .catch(() => {});
    }

    // ----- 곡마다 시작 상태: 키는 콘티 ▶ 이 기기에서 바꿔 둔 키 ▶ 팀 기본 키 ▶ 원래 키 -----
    function buildState(song, it) {
      const parsed = Chord.parseChordPro(song.chordpro);
      const gk = Chord.guessKey(parsed, song.original_key);
      const origKey = gk.key;
      const kobj = Chord.parseKey(origKey);
      const hasKey = !!kobj;
      const files = song.files || [];
      const pages = files.filter((f) => f.kind === 'image');
      const hasText = /\S/.test(song.chordpro || '');
      let saved = {};
      try { saved = JSON.parse(ls.get('ews_song_' + song.id, '{}')) || {}; } catch {}
      const startFrom = (name) => {
        const k = Chord.parseKey(name);
        return hasKey && k ? (((k.idx - kobj.idx) % 12) + 12) % 12 : null;
      };
      let shift = startFrom(it.key);
      if (shift === null) shift = Number.isInteger(saved.shift) ? saved.shift : startFrom(song.team_key);
      if (shift === null) shift = 0;
      // 24차: 연주 모드에서 임시로 바꾼 키(반음). 이 연주 화면 안에서만 유지되고, 나가면 사라진다.
      const base = shift;
      const delta = kdGet(it);
      shift = hasKey ? (((base + delta) % 12) + 12) % 12 : base + delta;
      const capo = Number.isInteger(saved.capo) ? saved.capo : 0;
      let tab = 'none';
      if (hasText && files.length) tab = it.view === 'image' ? 'img' : it.view === 'chord' ? 'chord' : ls.get('ews_tab_' + song.id, '') === 'img' ? 'img' : 'chord';
      else if (hasText) tab = 'chord';
      else if (files.length) tab = 'img';
      return { song, it, parsed, origKey, hasKey, files, pages, hasText, shift, base, delta, capo, tab, page: 0 };
    }
    // 곡 칸마다(같은 곡이 두 번 있어도 따로) 임시 키 변화량을 메모리에만 둔다
    const kd = new Map();
    const kdGet = (it) => kd.get(items.indexOf(it)) || 0;

    let cur = null;
    let nav = 0;
    function applyLook() {
      $play.classList.toggle('dark', P.theme === 'dark');
      $play.classList.toggle('light', P.theme === 'light');
      $play.style.setProperty('--song-size', P.size + 'px');
    }
    // keepPlace: 글자 크기·키·표시를 바꿔 다시 그릴 때, 화면 맨 위에 있던 줄이 있는 쪽으로 돌아온다
    function draw(keepPlace) {
      if (!cur) return;
      const { song, it, parsed, origKey, hasKey, files, pages, hasText } = cur;
      const isImg = cur.tab === 'img';
      const top = $pb.scrollTop;
      const anchor = keepPlace && cur.tab === 'chord' ? anchorOf($pb) : null;
      let keyTxt = '';
      let extra = '';
      if (!isImg) {
        const p = Chord.plan(origKey, cur.shift, cur.capo, P.acc);
        keyTxt = hasKey ? p.soundKey : it.key || '';
        if (cur.capo) extra = `카포 ${cur.capo} · ${p.shapeKey} 코드`;
      } else {
        // 이미지 악보는 코드가 안 바뀐다. 임시로 키를 바꿨으면 키 표시(와 송폼 전조 흐름)만 새 키로 보여 준다.
        keyTxt = cur.delta && hasKey ? Chord.plan(origKey, cur.shift, 0, P.acc).soundKey : it.key || origKey || '';
        if ((it.key && origKey && it.key !== origKey) || (cur.delta && hasKey && origKey)) extra = `악보는 원키 ${origKey} 기준`;
      }
      // 키 −/+ : 코드 악보, 또는 키를 아는 이미지 악보에서만
      const canKey = (!isImg && hasText) || (isImg && hasKey);
      const baseKeyTxt = hasKey ? Chord.plan(origKey, cur.base, 0, P.acc).soundKey : '';
      const kLabel = keyTxt || (cur.shift ? (cur.shift > 0 ? '+' : '') + cur.shift : '원키');
      const keyHtml = canKey
        ? `<span class="kstep"><button class="pbtn mini" id="kdn" type="button" aria-label="반음 내리기">−</button><span class="keybadge big">${esc(kLabel)}</span><button class="pbtn mini" id="kup" type="button" aria-label="반음 올리기">+</button></span>`
          + (cur.delta ? `<button class="pbtn mini" id="kreset" type="button">원래대로${baseKeyTxt ? ' ' + esc(baseKeyTxt) : ''}</button>` : '')
        : keyTxt ? `<span class="keybadge big">${esc(keyTxt)}</span>` : '';
      g('ptitle').textContent = (multi ? `${idx + 1}. ` : '') + song.title;
      // 다음 곡 미리보기: 제목 · 키 · 메모 (길면 말줄임). 누르면 다음 곡으로.
      const nx = items[idx + 1];
      const nextHtml = !multi ? '' : nx
        ? `<button class="play-next" id="pnext" type="button">다음 ▶ ${idx + 2}. ${esc(nx.title || '')}${nx.key ? ' · <b>' + esc(nx.key) + '</b>' : ''}${nx.memo ? ' · ' + esc(nx.memo) : ''}</button>`
        : '<span class="play-next">마지막 곡</span>';
      g('pinfo').innerHTML = [
        keyHtml,
        song.time_sig ? `<span class="pi tsig" title="박자"><b>${esc(SongFilter.tsigText(song.time_sig))}</b></span>` : '',
        it.form ? `<span class="pi"><b>송폼</b> ${formHtml(it.form, keyTxt)}</span>` : '',
        SongForm.keyPathText(it.form, keyTxt) ? `<span class="pi kcpath" title="전조"><b>♯ 키</b> ${esc(SongForm.keyPathText(it.form, keyTxt))}</span>` : '',
        it.memo ? `<span class="pi"><b>메모</b> ${esc(it.memo)}</span>` : '',
        extra ? `<span class="pi muted">${esc(extra)}</span>` : '',
        hasText && files.length ? `<button class="pbtn mini" id="pswap" type="button">${isImg ? '코드 악보로' : '이미지 악보로'}</button>` : '',
        !isImg && hasText && it.form && arrangedFor(cur) ? `<button class="pbtn mini" id="pform" type="button">${formViewOn(cur) ? '악보 순서로' : '송폼 순서로'}</button>` : '',
        !isImg && formViewOn(cur) && arrangedFor(cur) && arrangedFor(cur).omitted.length ? `<span class="pi muted">송폼에 없는 구간 ${esc(arrangedFor(cur).omitted.join(', '))}</span>` : '',
        nextHtml,
      ].join('');
      $pb.classList.toggle('img', isImg);
      if (!isImg) {
        $pb.innerHTML = '<div class="score"></div>'; // 코드 악보는 아래 drawChord가 그리고 배치한다
        $pb.scrollTop = top;
      } else if (pages.length) {
        $pb.innerHTML = `<img class="sheet" src="${esc(pages[cur.page].url)}" alt="악보 ${cur.page + 1}">`;
        if (window.Ink) Ink.attachImg($pb.querySelector('img.sheet'), pages[cur.page].id, slOf(cur.it));
        if (pages[cur.page + 1]) new Image().src = pages[cur.page + 1].url;
      } else {
        $pb.innerHTML = Files.renderPane(files); // PDF만 있는 곡: 열기 링크
      }
      if (cur.tab === 'none') $pb.innerHTML = `<p class="muted center" style="margin-top:40px">등록된 악보가 아직 없습니다.</p>`;
      if (cur.tab === 'chord') {
        const want = cur.wantLast ? Infinity : cur.page;
        delete cur.wantLast;
        const info = drawChord($pb, $play, cur, want);
        if (info && anchor !== null && anchor !== undefined) setChordPage($pb, pageOfAnchor($pb, anchor));
        syncChordPage(info);
      } else {
        fitCols();
        cur.pageCount = cur.tab === 'img' ? Math.max(1, pages.length) : 1;
      }
      g('pink').hidden = !(cur.tab === 'img' && pages.length);
      updateEdges();
      updateDots();
    }
    // 코드 악보 배치.
    //  · 쪽 넘기기(기본): 화면에 보이는 단 수 v(좁으면 1, 넓으면 2)로 높이를 고정해 다단으로 깔고, 한 화면(쪽)씩 옆으로 민다.
    //    넓은 화면은 먼저 글자를 최소 14px까지 줄여 한 쪽에 다 들어가는지 본다. 안 되면 설정한 글자 크기로 돌아가 구간(1절·후렴…)을 끊지 않고 여러 쪽으로 나눈다.
    //    좁은 화면(아이폰)은 글자를 줄이지 않고 쪽으로 나눈다.
    //  · 세로 스크롤: 예전 방식(넓은 화면은 2단 한 화면에 맞추고, 안 되면 1단 스크롤).
    // body/varEl을 바꿔 쓰면 옆으로 밀려 들어오는 이웃 화면(ghost)도 같은 규칙으로 맞출 수 있다.
    // 쪽 넘기기로 배치했으면 {pages, page, step, v}를 돌려준다(아니면 null). wantPage는 보여 줄 쪽(Infinity=마지막 쪽).
    const COL_GAP = 36;
    // 코드 악보를 그리고 배치한다. 구간 자리표시({ref})는 먼저 "↻ Chorus"로만 놓고,
    //  · 쪽 넘기기: 자리표시가 놓인 쪽에 원본 구간이 안 보이면 그 자리표시만 펼친다. 펼치면 뒤가 밀리므로 다시 배치해 보되,
    //    한 번 펼친 것은 접지 않아서 최대 4번 안에 끝난다.
    //  · 세로 스크롤: 곡이 한 화면에 들어가면 표시만, 아니면 모두 펼친다.
    // st = {parsed, origKey, shift, capo}
    function pageOfEl(sc, el) {
      return Math.floor((el.getBoundingClientRect().left - sc.getBoundingClientRect().left + 2) / (+sc.dataset.step || 1));
    }
    // 23차: 송폼이 있으면 기본은 송폼 순서로 다시 배열한 악보(전조 뒤는 새 키 코드). 곡마다 악보 순서로 바꿔 볼 수 있다(ews_fv_<곡번호>=score).
    const formViewOn = (st) => !!(st.it && st.it.form && st.song && ls.get('ews_fv_' + st.song.id, '') !== 'score');
    function arrangedFor(st) {
      if (!st.it || !st.it.form || !st.parsed) return null;
      const sound = Chord.plan(st.origKey, st.shift, 0, P.acc).soundKey || st.origKey;
      const k = st.it.form + '|' + sound;
      if (!st._arr || st._arr.k !== k) st._arr = { k, v: SongForm.arrangeByForm(st.parsed, st.it.form, sound, Chord) };
      return st._arr.v;
    }
    function drawChord(body, varEl, st0, wantPage) {
      const arr = formViewOn(st0) ? arrangedFor(st0) : null;
      const st = arr ? Object.assign({}, st0, { parsed: arr }) : st0;
      const base = { originalKey: st.origKey, shift: st.shift, capo: st.capo, acc: P.acc, showChords: P.chords, parts: true, names: P.names, hint: false };
      const refLines = st.parsed.lines.map((l, i) => (l.type === 'ref' && l.src >= 0 ? i : -1)).filter((i) => i >= 0);
      const open = new Set();
      let info = null;
      for (let pass = 0; pass < 4; pass++) {
        body.innerHTML = `<div class="score">${Chord.renderHTML(st.parsed, Object.assign({ refs: open }, base))}</div>`;
        info = fitCols(body, varEl, wantPage);
        if (!refLines.length) break;
        const sc = body.querySelector('.score');
        let fresh = [];
        if (info && sc && sc.dataset.step) {
          if (info.pages > 1) {
            sc.querySelectorAll('.part.refp').forEach((rp) => {
              const src = sc.querySelector('.part[data-s="' + rp.dataset.src + '"]:not(.refp):not([data-ri])');
              if (!src || pageOfEl(sc, src) !== pageOfEl(sc, rp)) fresh.push(+rp.dataset.ri);
            });
          }
        } else if (!P.pages) {
          const fits = body.classList.contains('cols') || body.scrollHeight <= body.clientHeight + 2;
          if (!fits) fresh = refLines.filter((i) => !open.has(i));
        } else if (sc && !body.classList.contains('paged')) {
          // 쪽 넘기기인데 쪽 배치가 안 된 좁은 칸(대기 화면 등): 펼치지 않는다
        }
        fresh = fresh.filter((i) => !open.has(i));
        if (!fresh.length) break;
        fresh.forEach((i) => open.add(i));
      }
      return info;
    }
    function fitCols(body, varEl, wantPage) {
      body = body || $pb;
      varEl = varEl || $play;
      varEl.style.setProperty('--song-size', P.size + 'px');
      const sc = body.querySelector('.score');
      body.classList.remove('cols', 'paged', 'keepparts');
      if (!sc) return null;
      ['height', 'columnWidth', 'columnCount', 'columnGap', 'transform'].forEach((k) => { sc.style[k] = ''; });
      delete sc.dataset.step; delete sc.dataset.page; delete sc.dataset.pages;
      const narrow = P.cols === '1' || (P.cols === 'auto' && body.clientWidth < 700);
      const cs = getComputedStyle(body);
      const H = Math.max(100, body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
      const avail = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (!P.pages) {
        if (narrow) return null;
        body.classList.add('cols');
        sc.style.height = H + 'px';
        let size = P.size;
        for (;;) {
          varEl.style.setProperty('--song-size', size + 'px');
          if (sc.scrollWidth <= avail + 2) return null;
          if (size <= 14) break;
          size -= 1;
        }
        // 글자를 가장 작게 줄여도 두 단에 다 안 들어가면 1단으로 되돌린다
        body.classList.remove('cols');
        sc.style.height = '';
        varEl.style.setProperty('--song-size', P.size + 'px');
        return null;
      }
      if (!(avail > 80)) return null;
      const v = narrow ? 1 : 2;
      const colW = Math.floor((avail - COL_GAP * (v - 1)) / v);
      body.classList.add('paged');
      sc.style.height = H + 'px';
      sc.style.columnWidth = colW + 'px';
      sc.style.columnCount = 'auto';
      sc.style.columnGap = COL_GAP + 'px';
      const cols = () => Math.max(1, Math.round((sc.scrollWidth + COL_GAP) / (colW + COL_GAP)));
      let fitted = false;
      if (v === 2) {
        for (let size = P.size; ; size -= 1) {
          varEl.style.setProperty('--song-size', size + 'px');
          if (cols() <= 2) { fitted = true; break; }
          if (size <= 14) break;
        }
        if (!fitted) varEl.style.setProperty('--song-size', P.size + 'px');
      }
      let pages = 1;
      if (!fitted) {
        body.classList.add('keepparts'); // 쪽을 나눌 때는 구간을 가운데서 끊지 않는다
        pages = Math.max(1, Math.ceil(cols() / v));
      }
      const step = v * (colW + COL_GAP);
      sc.dataset.step = String(step);
      sc.dataset.pages = String(pages);
      sc.dataset.v = String(v);
      setChordPage(body, Math.min(pages - 1, Math.max(0, Number.isFinite(wantPage) ? wantPage | 0 : wantPage === Infinity ? pages - 1 : 0)));
      return { pages, page: +sc.dataset.page, step, v };
    }
    function setChordPage(body, p) {
      const sc = body.querySelector('.score');
      if (!sc || !sc.dataset.step) return;
      const pages = +sc.dataset.pages || 1;
      p = Math.min(pages - 1, Math.max(0, p | 0));
      sc.dataset.page = String(p);
      sc.style.transform = p ? `translate3d(${-p * +sc.dataset.step}px,0,0)` : '';
    }
    // 지금 쪽 맨 앞(왼쪽 위)에 있는 줄의 번호. 글자 크기·키를 바꿔 쪽이 다시 나뉘어도 같은 줄이 있는 쪽으로 돌아가는 데 쓴다.
    function anchorOf(body) {
      const sc = body.querySelector('.score');
      if (!sc || !sc.dataset.step) return null;
      const start = (+sc.dataset.page || 0) * +sc.dataset.step;
      const els = sc.querySelectorAll('.ln, .cm');
      const left = sc.getBoundingClientRect().left;
      for (let i = 0; i < els.length; i++) if (els[i].getBoundingClientRect().left - left >= start - 2) return i;
      return els.length ? els.length - 1 : null;
    }
    function pageOfAnchor(body, idx) {
      const sc = body.querySelector('.score');
      if (!sc || !sc.dataset.step) return 0;
      const el = sc.querySelectorAll('.ln, .cm')[idx];
      if (!el) return 0;
      return Math.floor((el.getBoundingClientRect().left - sc.getBoundingClientRect().left + 2) / +sc.dataset.step);
    }
    function syncChordPage(info) {
      cur.pageCount = info ? info.pages : 1;
      cur.page = info ? info.page : 0;
    }
    // 쪽 넘기기를 쓰는 화면(이미지 여러 쪽 · 긴 코드 악보)에서만 화면 양옆을 눌러 넘길 수 있다
    function updateEdges() {
      const on = !!cur && ((cur.tab === 'img' && cur.pageCount > 1) || (cur.tab === 'chord' && cur.pageCount > 1));
      g('pel').hidden = g('per').hidden = !on;
    }
    function updateDots() {
      const parts = [];
      if (multi) parts.push(`곡 ${idx + 1}/${items.length}`);
      if (cur && cur.pageCount > 1) parts.push(`쪽 ${cur.page + 1}/${cur.pageCount}`);
      g('pdots').textContent = parts.join(' · ');
      g('pdots').hidden = !parts.length;
    }
    let loading = false;
    async function show(i, startPage) {
      idx = i;
      const my = ++nav;
      loading = true;
      const it = items[i];
      g('ptitle').textContent = (multi ? `${i + 1}. ` : '') + '불러오는 중…';
      g('pinfo').innerHTML = '';
      $pb.innerHTML = '';
      $pb.scrollTop = 0;
      if (src.sl) history.replaceState(null, '', '#/play/' + src.sl + '?i=' + i);
      let song;
      try {
        song = await loadSong(it.song_id);
      } catch (e) {
        if (my !== nav) return;
        loading = false;
        cur = null;
        g('ptitle').textContent = (multi ? `${i + 1}. ` : '') + (it.title || '');
        $pb.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><p class="muted small">인터넷이 없다면, 미리 “오프라인 준비”를 해 둔 곡만 열 수 있어요.</p><button class="btn" id="pretry" type="button">다시 시도</button></div>`;
        g('pretry').onclick = () => show(i, startPage);
        return;
      }
      if (my !== nav) return;
      cur = buildState(song, it);
      if (startPage === 'last' && cur.tab === 'img') cur.page = Math.max(0, cur.pages.length - 1);
      if (startPage === 'last' && cur.tab === 'chord') cur.wantLast = true;
      document.title = song.title + ' · Everyday Worship Songbook';
      loading = false;
      draw();
      prefetch(i + 1);
      prefetch(i - 1);
    }
    // 이미지 악보가 여러 쪽이면 쪽을 먼저 넘기고, 끝에서 다음(이전) 곡으로 넘어간다.
    // d(+1 다음 / -1 이전)로 갔을 때 어디가 나오는지: 같은 곡의 다른 쪽, 다른 곡, 또는 null(끝)
    function target(d) {
      if (cur && (cur.tab === 'img' || cur.tab === 'chord') && cur.pageCount > 1) {
        const n = cur.page + d;
        if (n >= 0 && n < cur.pageCount) return { type: 'page', page: n };
      }
      const n = idx + d;
      if (n < 0 || n >= items.length) return null;
      return { type: 'song', i: n, start: d < 0 ? 'last' : 0 };
    }
    function apply(tg) {
      if (tg.type === 'page') { cur.page = tg.page; draw(); return Promise.resolve(); }
      return show(tg.i, tg.start);
    }

    // ----- 손가락을 따라 옆으로 넘기기 (아이폰·아이패드 기본 앱처럼) -----
    // 지금 화면 옆에 이웃 화면(ghost)을 붙여 두고 함께 움직인다. 놓으면 충분히 넘겼는지에 따라 넘어가거나 제자리로 돌아온다.
    const REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const SLIDE_MS = 260;
    const SLIDE_EASE = 'cubic-bezier(.22,.8,.3,1)';
    let busy = false;
    let ghost = null;
    let ghostDir = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bodyW = () => $pb.clientWidth || 1;
    function dropGhost() {
      if (ghost) ghost.remove();
      ghost = null;
      ghostDir = 0;
    }
    function makeGhost(d) {
      const tg = target(d);
      if (!tg) return null;
      let st = null;
      let page = 0;
      if (tg.type === 'page') {
        st = cur;
        page = tg.page;
      } else {
        const s = readySongs.get(items[tg.i].song_id);
        if (s) {
          st = buildState(s, items[tg.i]);
          page = tg.start === 'last' ? Math.max(0, st.pages.length - 1) : 0;
        }
      }
      const el = document.createElement('div');
      el.className = 'play-body play-ghost';
      el.setAttribute('aria-hidden', 'true');
      let chordShown = false;
      let chordPage = 0;
      if (!st) {
        el.innerHTML = '<p class="muted center" style="margin-top:40px">불러오는 중…</p>';
      } else if (st.tab === 'img' && st.pages.length) {
        el.classList.add('img');
        el.innerHTML = `<img class="sheet" src="${esc(st.pages[page].url)}" alt="">`;
      } else if (st.tab === 'img') {
        el.innerHTML = Files.renderPane(st.files);
      } else if (st.tab === 'chord') {
        el.innerHTML = '<div class="score"></div>';
        chordShown = true;
        chordPage = tg.type === 'page' ? tg.page : tg.start === 'last' ? Infinity : 0;
      } else {
        el.innerHTML = '<p class="muted center" style="margin-top:40px">등록된 악보가 아직 없습니다.</p>';
      }
      g('pbody').parentNode.insertBefore(el, g('pel'));
      if (chordShown) drawChord(el, el, st, chordPage);
      else el.style.setProperty('--song-size', P.size + 'px');
      return el;
    }
    // dx: 지금 화면이 움직인 거리(px). 이웃 화면은 그 옆(±너비)에서 같이 움직인다.
    function setX(dx) {
      $pb.style.transform = `translate3d(${dx}px,0,0)`;
      if (ghost) ghost.style.transform = `translate3d(${dx + (ghostDir > 0 ? bodyW() : -bodyW())}px,0,0)`;
    }
    function setTransition(on) {
      const t = on && !REDUCE ? `transform ${SLIDE_MS}ms ${SLIDE_EASE}` : 'none';
      $pb.style.transition = t;
      if (ghost) ghost.style.transition = t;
    }
    async function settleBack() {
      busy = true;
      setTransition(true);
      setX(0);
      await sleep(REDUCE ? 0 : SLIDE_MS + 30);
      setTransition(false);
      $pb.style.transform = '';
      dropGhost();
      busy = false;
    }
    async function settleForward(dir) {
      busy = true;
      const w = bodyW();
      setTransition(true);
      $pb.style.transform = `translate3d(${-dir * w}px,0,0)`;
      ghost.style.transform = 'translate3d(0,0,0)';
      await sleep(REDUCE ? 0 : SLIDE_MS + 30);
      // 이웃 화면이 덮고 있는 동안 실제 화면을 바꾼다 → 다 그려지면 이웃 화면을 걷는다
      setTransition(false);
      $pb.style.transform = '';
      const tg = target(dir);
      try {
        if (tg) await apply(tg);
        const im = $pb.querySelector('img.sheet');
        if (im && !im.complete) await new Promise((r) => { im.onload = im.onerror = r; setTimeout(r, 1500); });
      } finally {
        dropGhost();
        busy = false;
      }
    }
    // 버튼·가장자리 탭·방향키: 손가락 없이도 같은 방식으로 슬라이드
    function slide(d) {
      if (busy || loading) return;
      if (!cur) { const n = idx + d; if (n >= 0 && n < items.length) show(n, d < 0 ? 'last' : 0); return; }
      if (!target(d)) {
        if (multi) toast(d > 0 ? '마지막 곡입니다.' : '첫 곡입니다.');
        return;
      }
      dropGhost();
      ghost = makeGhost(d);
      ghostDir = d;
      setTransition(false);
      setX(0);
      void $pb.offsetWidth;
      settleForward(d);
    }

    function bindSwipe(el) {
      let sx = 0, sy = 0, lx = 0, lt = 0, vx = 0, mode = ''; // mode: '' 아직 모름 / 'h' 가로 넘기기 / 'x' 무시(세로 스크롤·여러 손가락·펜)
      el.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (e.touches.length > 1 && mode === 'h') settleBack(); // 넘기는 중에 두 번째 손가락이 닿으면 제자리로
        if (busy || loading || e.touches.length !== 1 || t.touchType === 'stylus') { mode = 'x'; return; } // Apple Pencil은 넘기기에 쓰지 않는다
        sx = lx = t.clientX; sy = t.clientY; lt = Date.now(); vx = 0; mode = '';
      }, { passive: true });
      el.addEventListener('touchmove', (e) => {
        if (mode === 'x') return;
        if (e.touches.length > 1) { if (mode === 'h') settleBack(); mode = 'x'; return; }
        const t = e.touches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (!mode) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'x';
          if (mode === 'x') return;
          setTransition(false);
        }
        e.preventDefault(); // 가로로 넘기는 동안은 화면이 같이 스크롤되지 않게
        const dir = dx < 0 ? 1 : -1;
        if (dir !== ghostDir) { dropGhost(); ghost = makeGhost(dir); ghostDir = dir; if (ghost) setTransition(false); }
        const now = Date.now();
        if (now > lt) vx = 0.7 * vx + 0.3 * ((t.clientX - lx) / (now - lt));
        lx = t.clientX; lt = now;
        setX(ghost ? dx : dx * 0.3); // 더 갈 곳이 없으면 고무줄처럼 뻑뻑하게
      }, { passive: false });
      const end = (e, cancelled) => {
        if (mode !== 'h') { mode = ''; return; }
        mode = '';
        const t = e.changedTouches[0];
        const dx = t.clientX - sx;
        const w = bodyW();
        const fast = Math.abs(vx) > 0.4 && Math.abs(dx) > 24 && vx * dx > 0;
        const far = Math.abs(dx) > w * 0.28 && !(Math.abs(vx) > 0.3 && vx * dx < 0);
        if (!cancelled && ghost && (fast || far)) settleForward(ghostDir);
        else {
          if (!cancelled && !ghost && multi) toast(dx < 0 ? '마지막 곡입니다.' : '첫 곡입니다.');
          settleBack();
        }
      };
      el.addEventListener('touchend', (e) => end(e, false), { passive: true });
      el.addEventListener('touchcancel', (e) => end(e, true), { passive: true });
    }

    // ----- 화면 꺼짐 방지 -----
    let wl = null;
    async function acquireWake() {
      if (!P.wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible' || wl) return;
      try {
        wl = await navigator.wakeLock.request('screen');
        wl.addEventListener('release', () => { wl = null; });
      } catch { wl = null; }
    }
    function releaseWake() {
      try { if (wl) wl.release(); } catch {}
      wl = null;
    }
    const onVis = () => { if (document.visibilityState === 'visible') acquireWake(); };

    bindSwipe($pb);
    bindSwipe(g('pel'));
    bindSwipe(g('per'));
    g('pel').onclick = () => slide(-1);
    g('per').onclick = () => slide(1);

    // ----- 위쪽 버튼, 설정·곡 목록 창 -----
    g('pinfo').onclick = (ev) => {
      if (ev.target.closest && ev.target.closest('#pnext')) { if (idx + 1 < items.length) { if (cur && cur.pageCount > 1) { busy || loading || show(idx + 1, 0); } else slide(1); } return; }
      // 24차: 반음 단위 임시 키 변경 (이 화면 안에서만, 나가면 원래 키로)
      const kb = ev.target.closest && ev.target.closest('#kdn, #kup, #kreset');
      if (cur && kb) {
        const i = items.indexOf(cur.it);
        const d = kb.id === 'kreset' ? 0 : (kd.get(i) || 0) + (kb.id === 'kup' ? 1 : -1);
        const nd = cur.hasKey ? ((d % 12) + 12) % 12 : Math.max(-11, Math.min(11, d));
        if (nd) kd.set(i, nd); else kd.delete(i);
        cur.delta = nd;
        cur.shift = cur.hasKey ? (((cur.base + nd) % 12) + 12) % 12 : cur.base + nd;
        draw(true);
        return;
      }
      if (cur && ev.target.closest && ev.target.closest('#pform')) {
        ls.set('ews_fv_' + cur.song.id, formViewOn(cur) ? 'score' : 'form');
        cur.page = 0;
        $pb.scrollTop = 0;
        draw();
        return;
      }
      if (!cur || !ev.target.closest || !ev.target.closest('#pswap')) return;
      cur.tab = cur.tab === 'chord' ? 'img' : 'chord';
      cur.page = 0;
      ls.set('ews_tab_' + cur.song.id, cur.tab);
      $pb.scrollTop = 0;
      draw();
    };
    const closeSheets = () => { g('psheet').hidden = true; g('plsheet').hidden = true; };
    function openSettings() {
      const seg = (name, opts, val) => opts.map(([v, t]) => `<button type="button" class="seg ${val === v ? 'on' : ''}" data-a="${name}" data-v="${v}">${t}</button>`).join('');
      g('psheet').innerHTML = `
        <div class="sheet-card">
          ${multi ? '<button type="button" class="btn" data-a="list" style="width:100%;margin-bottom:6px">곡 목록 열기</button>' : ''}
          <div class="srow"><span>화면 색</span><span class="row">${seg('theme', [['auto', '자동'], ['light', '밝게'], ['dark', '어둡게']], P.theme)}</span></div>
          <div class="srow"><span>화면 꺼짐 방지</span><span class="row">${seg('wake', [['1', '켜기'], ['0', '끄기']], P.wake ? '1' : '0')}</span></div>
          ${'wakeLock' in navigator ? '' : '<p class="hint">이 브라우저는 화면 꺼짐 방지를 지원하지 않아요. 기기 설정의 자동 잠금 시간을 길게 바꿔 두세요.</p>'}
          <p class="hint" style="margin-top:10px">코드 악보일 때만:</p>
          <div class="srow"><span>글자 크기</span><span class="row"><button type="button" class="seg" data-a="fdown">가−</button><b>${P.size}</b><button type="button" class="seg" data-a="fup">가+</button></span></div>
          <div class="srow"><span>2단 보기</span><span class="row">${seg('cols', [['auto', '자동'], ['1', '1단'], ['2', '2단']], P.cols)}</span></div>
          <div class="srow"><span>긴 악보</span><span class="row">${seg('pages', [['1', '쪽 넘기기'], ['0', '세로 스크롤']], P.pages ? '1' : '0')}</span></div>
          <div class="srow"><span>구간 이름</span><span class="row">${seg('names', [['full', '풀네임'], ['abbr', '약어']], P.names)}</span></div>
          <div class="srow"><span>코드 표시</span><span class="row">${seg('chords', [['1', '보기'], ['0', '숨기기']], P.chords ? '1' : '0')}</span></div>
          <div class="srow"><span>코드 표기</span><span class="row">${seg('acc', [['auto', '자동'], ['sharp', '♯'], ['flat', '♭']], P.acc)}</span></div>
          <p class="hint">키는 위쪽 −/+ 버튼으로 반음씩 바꿀 수 있어요. 연주 모드를 나가면 콘티의 키로 돌아옵니다. (콘티에 저장하려면 콘티에서 키를 고치세요.)</p>
          <button type="button" class="btn primary" data-a="close" style="width:100%">닫기</button>
        </div>`;
      g('psheet').hidden = false;
    }
    function openList() {
      g('plsheet').innerHTML = `
        <div class="sheet-card">
          <h2 style="margin-top:0">곡 목록</h2>
          ${items.map((it, i) => `<button type="button" class="pick ${i === idx ? 'now' : ''}" data-i="${i}"><span class="song-title"><span class="num">${i + 1}</span>${esc(it.title)}</span><span class="song-meta">${it.key ? `<span class="keybadge">${esc(it.key)}</span>` : ''}${it.form ? `<span>송폼 ${formHtml(it.form, it.key || it.original_key || '')}</span>` : ''}</span></button>`).join('')}
          <button type="button" class="btn" data-a="close" style="width:100%;margin-top:6px">닫기</button>
        </div>`;
      g('plsheet').hidden = false;
    }
    g('pgear').onclick = openSettings;
    if (multi) g('ptitle').onclick = openList; // 곡 이름을 누르면 곡 목록
    g('plsheet').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      if (ev.target === g('plsheet') || (b && b.dataset.a === 'close')) return closeSheets();
      if (b && b.dataset.i !== undefined) { closeSheets(); show(+b.dataset.i, 0); }
    };
    g('psheet').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button');
      if (ev.target === g('psheet')) return closeSheets();
      if (!b || !b.dataset.a) return;
      const a = b.dataset.a;
      const v = b.dataset.v;
      if (a === 'close') return closeSheets();
      if (a === 'list') { closeSheets(); return openList(); }
      if (a === 'fup') P.size = Math.min(48, P.size + 2);
      else if (a === 'fdown') P.size = Math.max(14, P.size - 2);
      else if (a === 'chords') { P.chords = v === '1'; ls.set('ews_chords', v); }
      else if (a === 'acc') { P.acc = v; ls.set('ews_acc', v); }
      else if (a === 'names') { P.names = v; ls.set('ews_names', v); }
      else if (a === 'cols') { P.cols = v; ls.set('ews_play_cols', v); }
      else if (a === 'pages') { P.pages = v === '1'; ls.set('ews_play_pages', v); }
      else if (a === 'theme') { P.theme = v; ls.set('ews_play_theme', v); }
      else if (a === 'wake') { P.wake = v === '1'; ls.set('ews_play_wake', v); if (P.wake) acquireWake(); else releaseWake(); }
      ls.set('ews_play_size', String(P.size));
      applyLook();
      draw(true);
      openSettings();
    };

    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
      if (e.key === 'ArrowLeft') slide(-1);
      else if (e.key === 'ArrowRight') slide(1);
      else if (e.key === 'Escape') closeSheets();
    };
    const onNet = () => { g('poff').hidden = !(navigator.onLine === false || servedFromCache); };
    const onOnline = () => { servedFromCache = false; onNet(); }; // 인터넷이 돌아오면 배지를 끈다 (다음 요청에서 다시 확인)
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    // 기기를 돌리면 화면 크기가 늦게 확정되는 기기(아이폰 등)가 있어서, 돌린 직후와 잠시 뒤에 두 번 화면을 다시 계산시킨다.
    let rt1 = 0, rt2 = 0;
    const relayout = () => {
      window.scrollTo(0, 0);
      $play.style.display = 'none';
      void $play.offsetHeight;
      $play.style.display = '';
      if (cur && cur.tab === 'chord') {
        const a = anchorOf($pb);
        const info = drawChord($pb, $play, cur, cur.page);
        if (info && a !== null) setChordPage($pb, pageOfAnchor($pb, a));
        syncChordPage(info);
        updateEdges();
        updateDots();
      } else fitCols();
    };
    const onResize = () => {
      clearTimeout(rt1); clearTimeout(rt2);
      rt1 = setTimeout(relayout, 80);
      rt2 = setTimeout(relayout, 450);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onNet);
    window.addEventListener('ews-net', onNet);
    teardown = () => {
      releaseWake();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(rt1); clearTimeout(rt2);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onNet);
      window.removeEventListener('ews-net', onNet);
      document.body.style.overflow = prevOverflow;
    };

    applyLook();
    onNet();
    acquireWake();
    await show(idx, 0);
  }

  // 콘티의 곡들을 오프라인에서도 열 수 있게 미리 받아 둔다. (서비스 워커가 받은 내용을 이 기기에 저장한다)
  // ---------- 가사 복사 (12차): 콘티 전체 또는 곡 하나의 가사를 글자로 복사 ----------
  // 콘티의 곡들을 4곡씩 동시에 불러온다. 한 곡이 실패해도 나머지는 계속한다.
  async function fetchLyricEntries(items) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const it = items[i];
        try {
          out[i] = { title: it.title, form: it.form, song: (await api('/songs/' + it.song_id)).song };
        } catch {
          out[i] = { title: it.title, form: it.form, song: null, failed: true };
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }
  // getEntries: async () => [{title, form, song|null, failed?}]
  // opt.numbered=false 면 제목 앞 번호를 빼고, opt.noForm=true 면 "송폼 순서대로"를 숨긴다(곡 하나만 열었을 때 송폼을 모르는 경우)
  function lyricsSheet(heading, getEntries, opt) {
    opt = opt || {};
    const FMT = [
      ['labeled', '제목 + 가사', '곡 제목 아래에 구간 이름([V1]·[C])과 가사가 나와요. 반복 구간(자리표시)은 가사로 채워져요.'],
      ['form', '송폼 순서대로', '콘티에 적은 송폼(V1-C-V2-C…) 순서대로 가사를 펼쳐요. 반복되는 구간은 그만큼 다시 나와요.'],
      ['plain', '가사만', '제목·구간 이름 없이 가사만 이어서 나와요. 곡 사이는 빈 줄 두 개예요.'],
    ].filter((f) => !(opt.noForm && f[0] === 'form'));
    let fmt = ls.get('ews_lyr_fmt', 'labeled');
    if (!FMT.some((f) => f[0] === fmt)) fmt = 'labeled';
    const sh = showSheet(`<h2 style="margin-top:0">${esc(heading)}</h2>
      <div class="row" id="lyfmt" style="flex-wrap:wrap;gap:6px">${FMT.map((f) => `<button type="button" class="seg" data-f="${f[0]}">${f[1]}</button>`).join('')}</div>
      <p class="hint" id="lyhelp" style="margin:6px 0"></p>
      <textarea id="lyta" rows="12" readonly spellcheck="false" style="font-size:16px">가사를 불러오는 중…</textarea>
      <p class="hint" id="lynote" hidden></p>
      <div class="row" style="margin-top:10px"><button type="button" class="btn primary grow" id="lycopy" disabled>복사</button><button type="button" class="btn" id="lyclose">닫기</button></div>`);
    const ta = sh.q('#lyta');
    const $copy = sh.q('#lycopy');
    const $note = sh.q('#lynote');
    sh.q('#lyclose').onclick = () => sh.close();
    let entries = null;
    const names = (arr) => arr.slice(0, 3).join(', ') + (arr.length > 3 ? ` 외 ${arr.length - 3}곡` : '');
    function render() {
      sh.wrap.querySelectorAll('[data-f]').forEach((b) => b.classList.toggle('on', b.dataset.f === fmt));
      sh.q('#lyhelp').textContent = (FMT.find((f) => f[0] === fmt) || FMT[0])[2];
      if (!entries) return;
      const failed = entries.filter((e) => e.failed).map((e) => e.title);
      const r = SongForm.lyricsText(
        entries.map((e) => ({ title: e.title, form: e.form, parsed: e.song ? Chord.parseChordPro(e.song.chordpro) : null })),
        fmt,
        { numbered: opt.numbered !== false }
      );
      ta.value = r.text;
      const notes = [];
      if (failed.length) notes.push(`${names(failed)}은(는) 불러오지 못했어요. 인터넷을 확인하고 다시 열어 주세요.`);
      const noText = r.noText.filter((t) => !failed.includes(t));
      if (noText.length) notes.push(fmt === 'plain' ? `이미지·PDF 악보만 있는 곡(${names(noText)})은 가사가 없어 뺐어요.` : `이미지·PDF 악보만 있는 곡(${names(noText)})은 가사가 없어요.`);
      if (fmt === 'form' && r.noForm.length) notes.push(`송폼이 없는 곡(${names(r.noForm)})은 악보에 적힌 순서대로 넣었어요.`);
      if (fmt === 'form' && r.missing.length) notes.push(r.missing.slice(0, 2).map((m) => `${m.title}: 송폼의 ${m.tokens.join(', ')}은(는) 악보에서 찾지 못해 건너뛰었어요.`).join(' '));
      $note.textContent = notes.join(' ');
      $note.hidden = !notes.length;
      $copy.disabled = !r.text.trim();
    }
    sh.wrap.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { fmt = b.dataset.f; ls.set('ews_lyr_fmt', fmt); render(); }));
    render();
    $copy.onclick = async () => {
      const text = ta.value;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch {
        // 복사가 막힌 환경: 글자를 선택해 두고 직접 복사하게 한다
        try { ta.readOnly = false; ta.focus(); ta.select(); ok = document.execCommand('copy'); ta.readOnly = true; } catch {}
      }
      if (ok) { sh.close(); toast('가사를 복사했어요.'); } else { ta.focus(); ta.select(); toast('글자를 길게 눌러 전체 선택 후 복사해 주세요.'); }
    };
    Promise.resolve()
      .then(getEntries)
      .then((e) => { entries = e; if (sh.wrap.isConnected) render(); })
      .catch((e) => { ta.value = ''; $note.textContent = (e && e.message) || '가사를 불러오지 못했어요.'; $note.hidden = false; });
  }

  async function prepareOffline(items) {
    if (!(navigator.serviceWorker && navigator.serviceWorker.controller)) {
      toast('처음 한 번은 앱을 새로 고친 뒤 다시 눌러 주세요.');
      return;
    }
    let done = 0;
    let fail = 0;
    for (const it of items) {
      try {
        const { song } = await api('/songs/' + it.song_id);
        for (const f of song.files || []) if (f.kind === 'image') await fetch(f.url).then((r) => r.blob());
      } catch {
        fail++;
      }
      toast(`오프라인 준비 중… ${++done}/${items.length}`);
    }
    toast(fail ? `${fail}곡은 저장하지 못했어요. 인터넷을 확인하고 다시 눌러 주세요.` : '이 콘티를 오프라인에서도 열 수 있어요. (PDF 악보는 제외)');
  }

  // ---------- 콘티 편집 (팀장) ----------
  async function viewSetlistEdit(id, q) {
    if (!me.team || !me.team.isLeader) {
      $app.innerHTML = noteBox('<p>콘티는 팀장만 만들고 고칠 수 있습니다.</p>' + lockBtn('leader', '팀장 PIN 입력', location.hash || '#/setlists', 'primary') + ' <a class="btn" href="#/setlists">콘티 목록</a>');
      return;
    }
    q = q || new URLSearchParams();
    const quick = !id && q.get('quick') === '1'; // 빠른 콘티: 곡부터 고르고, 정보는 접어 둔다
    const copyId = !id ? parseInt(q.get('copy') || '', 10) : NaN; // 지난 콘티를 복사해서 새로 만들기
    const srcId = id || (Number.isInteger(copyId) ? copyId : null);
    const [songRes, listRes, tagRes, optRes, allLists] = await Promise.all([
      api('/songs'),
      srcId ? api('/setlists/' + srcId) : null,
      api('/tags'),
      api('/team/options').catch(() => ({ services: [], leaders: [] })),
      id ? null : api('/setlists').catch(() => ({ setlists: [] })),
    ]);
    const songs = songRes.songs;
    let services = optRes.services || [];
    let leaderOpts = optRes.leaders || [];
    const pickGroups = groupTags(tagRes);
    const pickF = SongFilter.newState(); // 곡 추가할 때 주제·키·악보 형식으로 좁히기 (곡 목록과 같은 규칙)
    const pickKeys = SongFilter.keyChips(songs);
    const pickTs = SongFilter.tsigChips(songs);
    const byId = Object.fromEntries(songs.map((s) => [s.id, s]));
    // keepUid: 콘티를 고칠 때만 곡 칸 번호(uid)를 이어 간다 → 콘티용 필기가 따라간다. 복사·다른 콘티에서 가져오기는 새 칸이다.
    const itemsOf = (setlist, keepUid) => setlist.items.filter((it) => byId[it.song_id]).map((it) => ({ song_id: it.song_id, key: it.key, form: it.form, memo: it.memo, view: it.view, ...(keepUid && it.uid ? { uid: it.uid } : {}) }));
    const startDate = (sid) => {
      const o = services.find((x) => String(x.id) === String(sid));
      return svcDay(o) >= 0 ? nextWeekday(svcDay(o)) : nextSunday();
    };
    const data = listRes
      ? {
          date: id ? listRes.setlist.date || '' : startDate(listRes.setlist.service_id), // 복사하면 날짜만 다음 날짜(예배 종류의 기본 요일, 없으면 일요일)로 바뀐다
          title: listRes.setlist.title,
          memo: listRes.setlist.memo,
          service_id: listRes.setlist.service_id || '',
          leaders: SongForm.leaderList(listRes.setlist.leaders),
          is_temp: id ? !!listRes.setlist.is_temp : false,
          items: itemsOf(listRes.setlist, !!id),
        }
      : { date: quick ? todayKst() : nextSunday(), title: '', memo: '', service_id: '', leaders: [], is_temp: quick, items: [] };
    // 새 콘티에서 목록의 예배 종류 필터가 하나로 골라져 있으면 그 종류로 시작한다 (기본 요일이 있으면 날짜도 그 요일로)
    if (!id && !quick && !copyId) {
      const f = ls.get('ews_sl_svc', '');
      if (/^\d+$/.test(f) && services.some((x) => String(x.id) === f)) { data.service_id = f; data.date = startDate(f); }
    }
    document.title = (id ? '콘티 편집' : quick ? '빠른 콘티' : '새 콘티') + ' · Everyday Worship Songbook';
    // 송폼 탭 입력(6차): formSel = 카드별로 선택된 구간 번호, lastForms = 곡별 "지난번 송폼"
    const lastForms = {};
    const backHref = id ? '#/setlist/' + id : '#/setlists';
    const heading = id ? '콘티 편집' : quick ? '⚡ 빠른 콘티' : copyId ? '콘티 복사' : '새 콘티';

    // 곡 추가 칸 (빠른 콘티에서는 맨 위)
    const recentSongs = songs.filter((x) => x.last_used).sort((a, b) => (b.last_used || '').localeCompare(a.last_used || '')).slice(0, 10);
    const prevLists = ((allLists && allLists.setlists) || []).filter((l) => l.item_count > 0).slice(0, 8);
    const pickCard = `
      <div class="card" id="pickcard">
        <h2>곡 추가</h2>
        ${!id && prevLists.length ? `<select id="prevsl" aria-label="지난 콘티에서 곡 가져오기"><option value="">↺ 지난 콘티의 곡 전부 가져오기…</option>${prevLists.map((l) => `<option value="${l.id}">${esc(setlistTitle(l))}${l.date ? ' · ' + esc(mmdd(l.date)) : ''} (${l.item_count}곡)</option>`).join('')}</select>` : ''}
        ${recentSongs.length ? `<div class="small muted" style="margin:8px 0 2px">최근 부른 곡</div><div class="chips" id="recentchips">${recentSongs.map((x) => `<button type="button" class="chip" data-add="${x.id}">${esc(x.title)}</button>`).join('')}</div>` : ''}
        <input type="search" id="sq" placeholder="제목 · 아티스트 · 태그로 찾기">
        <details class="filter" id="pfilter"><summary id="pfsum">분류·키·박자로 찾기</summary><div id="pchips"></div></details>
        <div id="res" class="pick-list"></div>
      </div>`;
    const itemsCard = `<h2>곡 순서</h2><div id="items"></div>`;
    const infoCard = `
      <details class="card infocard" id="info" ${quick || id ? '' : 'open'}>
        <summary id="infosum">정보</summary>
        <div class="grid2">
          <div><label for="sd" style="margin-top:0">날짜</label><input id="sd" type="date" value="${esc(data.date)}"></div>
          <div><label for="ssvc" style="margin-top:0">예배 종류</label><select id="ssvc"></select></div>
        </div>
        <div class="small"><button type="button" class="linkbtn" id="svcmgr2">예배 종류 관리</button></div>
        <label for="st">제목 <span class="muted small">(비워도 돼요)</span></label><input id="st" type="text" maxlength="100" placeholder="비우면 예배 종류와 날짜로 보여 줘요" value="${esc(data.title)}">
        <label>인도자</label>
        <div class="chips" id="lchips"></div>
        <form id="ladd" class="row"><input id="lname" type="text" maxlength="20" placeholder="+ 새 인도자 이름" enterkeyhint="done" aria-label="새 인도자 이름"><button class="btn small">추가</button></form>
        <div class="small"><button type="button" class="linkbtn" id="lmgr">인도자 목록 관리</button></div>
        <label for="sm">메모</label><textarea id="sm" rows="2" placeholder="예: 입례 찬양은 2절까지">${esc(data.memo)}</textarea>
        <label class="check"><input type="checkbox" id="stemp" ${data.is_temp ? 'checked' : ''}> ⚡ 임시 콘티 <span class="muted small">급하게 만든 것 — 나중에 정리하고 확정해요</span></label>
      </details>`;

    $app.innerHTML = `
      <div class="row between"><a href="${backHref}" class="small">← ${id ? '콘티 보기' : '콘티 목록'}</a><h2 style="margin:0">${heading}</h2></div>
      ${quick ? pickCard + itemsCard + infoCard : infoCard + itemsCard + pickCard}
      <p class="error" id="err"></p>
      <div class="row savebar">
        <button class="btn primary" id="save">저장</button>
        <button class="btn" id="saveplay" type="button">저장하고 ▶ 연주</button>
        <a class="btn" href="${backHref}">취소</a>
        ${id ? '<button class="btn danger" id="del" style="margin-left:auto">삭제</button>' : ''}
      </div>`;

    // ----- 정보 칸: 예배 종류 · 인도자 -----
    const svcName = () => { const o = services.find((x) => String(x.id) === String(data.service_id)); return o ? o.name : ''; };
    const drawInfoSum = () => {
      const d = el('sd').value;
      const parts = [d ? fmtDate(d) : '날짜 없음', svcName(), data.leaders.length ? '🎤 ' + data.leaders.join(', ') : '', data.is_temp ? '⚡임시' : ''].filter(Boolean);
      el('infosum').textContent = '정보 · ' + parts.join(' · ');
    };
    const drawService = () => {
      if (data.service_id && !services.some((x) => String(x.id) === String(data.service_id))) data.service_id = '';
      el('ssvc').innerHTML = `<option value="">(미분류)</option>${services.map((x) => `<option value="${x.id}" ${String(x.id) === String(data.service_id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`;
      drawInfoSum();
    };
    const drawLeaders = () => {
      const names = [...leaderOpts.map((o) => o.name), ...data.leaders.filter((n) => !leaderOpts.some((o) => o.name === n))];
      el('lchips').innerHTML = names.length ? names.map((n) => `<button type="button" class="chip ${data.leaders.includes(n) ? 'on' : ''}" data-ld="${esc(n)}">${esc(n)}</button>`).join('') : '<span class="muted small">아직 인도자가 없어요. 아래에서 이름을 추가해 보세요.</span>';
      drawInfoSum();
    };
    drawService();
    drawLeaders();
    let dateTouched = false; // 날짜를 직접 고쳤으면 예배 종류를 바꿔도 날짜를 건드리지 않는다
    el('ssvc').onchange = () => {
      data.service_id = el('ssvc').value;
      const o = services.find((x) => String(x.id) === String(data.service_id));
      if (!id && !quick && !dateTouched && svcDay(o) >= 0) el('sd').value = nextWeekday(svcDay(o));
      drawInfoSum();
    };
    el('sd').onchange = () => { dateTouched = true; drawInfoSum(); };
    el('stemp').onchange = () => { data.is_temp = el('stemp').checked; drawInfoSum(); };
    el('lchips').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-ld]');
      if (!b) return;
      const n = b.dataset.ld;
      data.leaders = data.leaders.includes(n) ? data.leaders.filter((x) => x !== n) : [...data.leaders, n];
      drawLeaders();
    };
    el('ladd').onsubmit = async (ev) => {
      ev.preventDefault();
      const n = el('lname').value.replace(/[,\n]/g, ' ').trim().slice(0, 20);
      if (!n) return;
      try {
        if (!leaderOpts.some((o) => o.name === n)) {
          await api('/team/options', { method: 'POST', body: { kind: 'leader', name: n } });
          leaderOpts = (await api('/team/options')).leaders;
        }
        if (!data.leaders.includes(n)) data.leaders.push(n);
        el('lname').value = '';
        drawLeaders();
      } catch (e) { toast(e.message); }
    };
    el('svcmgr2').onclick = () => manageOptions('service', async () => { services = (await api('/team/options')).services; drawService(); });
    el('lmgr').onclick = () => manageOptions('leader', async () => {
      const before = leaderOpts.map((o) => o.name);
      leaderOpts = (await api('/team/options')).leaders;
      // 이름이 바뀌거나 지워진 인도자는 이 콘티의 선택에서도 정리한다
      const now = leaderOpts.map((o) => o.name);
      data.leaders = data.leaders.filter((n) => now.includes(n) || !before.includes(n));
      drawLeaders();
    });

    const keyOptionsFor = (s, current) => {
      const ok = Chord.parseKey(s.original_key);
      const list = ok ? (ok.minor ? KEYS_MINOR : KEYS_MAJOR) : [...KEYS_MAJOR, ...KEYS_MINOR];
      const opts = list.map((k) => [k, k]);
      if (!current || !list.includes(current)) opts.unshift([current || '', current || '(키 미정)']);
      return opts;
    };
    function drawItems() {
      const box = el('items');
      if (!data.items.length) {
        box.innerHTML = '<p class="muted">아래에서 곡을 찾아 추가해 주세요.</p>';
        return;
      }
      box.innerHTML = data.items
        .map((it, i) => {
          const s = byId[it.song_id];
          const hasBoth = s.has_chords && s.file_count > 0;
          // 이미지 악보는 화면에서 키가 바뀌지 않는다. 대신 "실제로 부르는 키"를 직접 기록해 둘 수 있다.
          const keyUI = `<div><label>${s.has_chords ? '키' : '부르는 키 (기록용)'}</label><select data-f="key" data-i="${i}">${keyOptionsFor(s, it.key).map(([v, t]) => `<option value="${esc(v)}" ${v === it.key ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>${s.has_chords ? '' : `<div class="hint" style="margin:4px 0 0">이미지 악보는 키가 바뀌지 않아요${s.original_key ? ` (악보는 원래 키 ${esc(s.original_key)} 기준)` : ''}. 키를 올리거나 내려 부른다면 직접 계산해서 기록해 두세요.</div>`}</div>`;
          const viewUI = hasBoth
            ? `<div><label>보여 줄 악보</label><select data-f="view" data-i="${i}">
                <option value="auto" ${it.view === 'auto' ? 'selected' : ''}>자동 (코드 악보 우선)</option>
                <option value="chord" ${it.view === 'chord' ? 'selected' : ''}>코드 악보</option>
                <option value="image" ${it.view === 'image' ? 'selected' : ''}>이미지 악보</option></select></div>`
            : '';
          return `<div class="card si">
            <div class="row between">
              <div class="song-title"><span class="num">${i + 1}</span>${esc(s.title)}</div>
              <span class="row" style="gap:4px"><button class="btn small" data-a="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="위로">↑</button><button class="btn small" data-a="down" data-i="${i}" ${i === data.items.length - 1 ? 'disabled' : ''} aria-label="아래로">↓</button><button class="btn small danger" data-a="rm" data-i="${i}" aria-label="빼기">빼기</button></span>
            </div>
            <div class="grid2">${keyUI}${viewUI}</div>
            <div class="formed" data-i="${i}">${formInner(i)}</div>
            <label>메모</label><input type="text" data-f="memo" data-i="${i}" maxlength="500" placeholder="예: 천천히 시작" value="${esc(it.memo)}">
          </div>`;
        })
        .join('');
    }

    // ----- 송폼: 글자를 쓰지 않고 버튼을 눌러 순서대로 쌓는다 (입력기는 createFormEditor, 22차에 곡 편집과 공용화) -----
    // 23차: 카드에는 송폼 한 줄과 "송폼 만들기" 버튼만 두고, 버튼을 누르면 곡 악보를 보면서 만드는 창(openFormWindow)이 열린다.
    const songDetail = {}; // 곡 번호 → 상세(악보 본문·이미지). 창을 처음 열 때 한 번 받는다
    function formInner(i) {
      const it = data.items[i];
      const html = it.form ? formHtml(it.form, it.key || (byId[it.song_id] && byId[it.song_id].original_key) || '') : '<span class="muted small">송폼이 아직 없어요</span>';
      return `<label>송폼</label><div class="fsum">${html}</div><div class="row"><button type="button" class="btn small primary" data-fa="openform" data-i="${i}">✎ 송폼 만들기</button>${!it.form && lastForms[it.song_id] ? `<button type="button" class="btn small" data-fa="last" data-i="${i}">↺ 지난번 송폼 <span class="muted">${esc(lastForms[it.song_id])}</span></button>` : ''}</div>`;
    }
    function drawForm(i) {
      const box = el('items').querySelector(`.formed[data-i="${i}"]`);
      if (box) box.innerHTML = formInner(i);
    }
    async function formAction(a, i) {
      const it = data.items[i];
      if (!it) return;
      if (a === 'last') {
        if (lastForms[it.song_id]) { it.form = lastForms[it.song_id]; drawForm(i); }
        return;
      }
      if (a !== 'openform') return;
      if (!(it.song_id in songDetail)) {
        try { songDetail[it.song_id] = (await api('/songs/' + it.song_id)).song; } catch { songDetail[it.song_id] = null; toast('악보를 불러오지 못했어요. 송폼만 입력할 수 있어요.'); }
      }
      openFormWindow(it, songDetail[it.song_id], lastForms, () => drawForm(i));
    }
    // 입력칸은 다시 그리지 않고 값만 저장해서, 타이핑 중에 커서가 튀지 않게 한다.
    const onField = (ev) => {
      const t = ev.target;
      if (t.dataset && t.dataset.f !== undefined && data.items[+t.dataset.i]) data.items[+t.dataset.i][t.dataset.f] = t.value;
    };
    el('items').addEventListener('input', onField);
    el('items').addEventListener('change', onField);
    el('items').onclick = (ev) => {
      const fb = ev.target.closest && ev.target.closest('button[data-fa]');
      if (fb) return formAction(fb.dataset.fa, +fb.dataset.i, fb);
      const b = ev.target.closest && ev.target.closest('button[data-a]');
      if (!b) return;
      const i = +b.dataset.i;
      const a = b.dataset.a;
      if (a === 'rm') data.items.splice(i, 1);
      else {
        const j = a === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= data.items.length) return;
        [data.items[i], data.items[j]] = [data.items[j], data.items[i]];
      }
      drawItems();
    };
    // 우리 팀이 지난번에 쓴 송폼 (불러오지 못해도 입력에는 지장 없음)
    api('/team/last-forms' + (id ? '?exclude=' + id : ''))
      .then((r) => {
        Object.assign(lastForms, r.forms || {});
        data.items.forEach((_, i) => drawForm(i));
      })
      .catch(() => {});

    function drawPickChips() {
      el('pchips').innerHTML = SongFilter.chipsHTML(pickF, pickGroups, pickKeys, esc, pickTs);
      const sum = SongFilter.summary(pickF);
      el('pfsum').textContent = sum ? `분류·키·박자로 찾기 · ${sum}` : '분류·키·박자로 찾기';
    }
    el('pchips').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button.chip');
      if (!b) return;
      SongFilter.toggle(pickF, pickGroups, b.dataset);
      drawPickChips();
      drawResults();
    };
    drawPickChips();
    function drawResults() {
      const q = el('sq').value.trim();
      const found = songs
        .filter((s) => localMatch([s.title, s.orig_title, s.artist, s.tags], q))
        .filter((s) => SongFilter.matches(s, pickF))
        .slice(0, 30);
      const used = {};
      data.items.forEach((it) => (used[it.song_id] = (used[it.song_id] || 0) + 1));
      el('res').innerHTML =
        found
          .map(
            (s) => `<button class="pick" type="button" data-add="${s.id}">
              <span class="song-title">${esc(s.title)}${s.orig_title ? `<span class="orig"> · ${esc(s.orig_title)}</span>` : ''}</span>
              <span class="song-meta">${SongFilter.keyTsigHTML(s, esc)}${s.last_used ? `<span class="tag used">최근 ${mmdd(s.last_used)}</span>` : ''}${SongFilter.badgesHTML(s, esc)}${used[s.id] ? `<span class="tag">✓ 추가됨${used[s.id] > 1 ? ' ×' + used[s.id] : ''}</span>` : ''}</span>
            </button>`
          )
          .join('') || '<p class="muted">찾는 곡이 없습니다.</p>';
    }
    el('sq').oninput = drawResults;
    const addSong = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-add]');
      if (!b) return;
      const s = byId[+b.dataset.add];
      if (!s) return;
      if (data.items.length >= 60) return toast('콘티에는 곡을 60개까지 넣을 수 있습니다.');
      // 기본 키: 우리 팀 기본 키 ▶ 원래 키
      data.items.push({ song_id: s.id, key: s.team_key || s.original_key || '', form: s.base_form || '', memo: '', view: 'auto' }); // 22차: 곡의 기본 송폼(전조 포함)을 미리 채운다
      drawItems();
      drawResults();
      toast(`"${s.title}" 추가`);
    };
    el('res').onclick = addSong;
    if (el('recentchips')) el('recentchips').onclick = addSong;
    // 지난 콘티의 곡을 통째로 가져오기 (키·송폼·메모까지)
    if (el('prevsl'))
      el('prevsl').onchange = async () => {
        const v = el('prevsl').value;
        if (!v) return;
        el('prevsl').disabled = true;
        try {
          const r = await api('/setlists/' + v);
          const add = itemsOf(r.setlist);
          const room = 60 - data.items.length;
          data.items.push(...add.slice(0, Math.max(0, room)));
          drawItems();
          drawResults();
          toast(add.length > room ? `곡 ${Math.max(0, room)}개만 가져왔어요. (최대 60곡)` : `${add.length}곡을 가져왔어요.`);
        } catch (e) { toast(e.message); }
        el('prevsl').value = '';
        el('prevsl').disabled = false;
      };
    drawItems();
    drawResults();

    const doSave = async (play) => {
      el('err').textContent = '';
      if (play && !data.items.length) return toast('곡을 먼저 넣어 주세요.');
      const body = {
        date: el('sd').value,
        title: el('st').value,
        memo: el('sm').value,
        service_id: data.service_id ? +data.service_id : null,
        leaders: data.leaders,
        is_temp: data.is_temp,
        items: data.items.map((it) => {
          return { song_id: it.song_id, key: it.key, form: it.form, memo: it.memo, view: it.view, ...(it.uid ? { uid: it.uid } : {}) };
        }),
      };
      el('save').disabled = true;
      el('saveplay').disabled = true;
      try {
        const r = id ? await api('/setlists/' + id, { method: 'PUT', body }) : await api('/setlists', { method: 'POST', body });
        toast('저장했습니다.');
        location.hash = (play ? '#/play/' : '#/setlist/') + r.id;
      } catch (e) {
        if (e.status === 403) await loadMe();
        el('err').textContent = e.message;
      } finally {
        el('save').disabled = false;
        el('saveplay').disabled = false;
      }
    };
    el('save').onclick = () => doSave(false);
    el('saveplay').onclick = () => doSave(true);
    if (id)
      el('del').onclick = async () => {
        if (!confirm(`"${setlistTitle({ title: data.title, date: data.date, service_name: svcName() })}" 콘티를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
        try {
          await api('/setlists/' + id, { method: 'DELETE' });
          toast('삭제했습니다.');
          location.hash = '#/setlists';
        } catch (e) {
          el('err').textContent = e.message;
        }
      };
  }

  // ---------- 관리자 ----------
  async function viewAdmin() {
    if (!me.adminRequired) {
      $app.innerHTML = noteBox('<p class="error">관리자 PIN이 설정되어 있지 않습니다.</p><p class="muted small">Cloudflare 환경변수 <b>ADMIN_PIN</b>을 설정한 뒤 다시 배포해 주세요. (설치 안내 참고)</p><a class="btn" href="#/">처음으로</a>');
      return;
    }
    if (!me.isAdmin) {
      $app.innerHTML = `
        <div class="row between"><a href="#/more" class="small">← 더보기</a></div>
        <h1>관리자</h1>
        <form class="card" id="f">
          <label for="pin" style="margin-top:0">관리자 PIN</label>
          <input id="pin" type="password" autocomplete="off" autofocus>
          <p class="error" id="err"></p>
          <div class="row"><button class="btn primary">확인</button><a class="btn" href="#/more">취소</a></div>
        </form>
        <p class="muted small">악보 등록·수정, 팀 관리에 필요합니다. (이 기기에 30일간 보관됩니다)</p>`;
      el('f').onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          const r = await api('/admin', { method: 'POST', body: { pin: el('pin').value } });
          ls.set('ews_admin', r.adminToken);
          toast('관리자로 로그인했습니다.');
          route();
        } catch (e) {
          el('err').textContent = e.message;
        }
      };
      return;
    }

    const [inv, tr, tg] = await Promise.all([api('/admin/invite'), api('/admin/teams'), api('/tags')]);
    const teams = tr.teams;
    // 21차: 한 줄로 길게 이어지던 관리 화면을 세 칸으로 나눈다 — 팀·초대 / 추천 태그 / 백업·정리. 마지막에 보던 칸을 기억한다.
    const nTags = Object.keys(tg.usage).length;
    $app.innerHTML = `
      <div class="row between"><a href="#/more" class="small">← 더보기</a></div>
      <h1>앱 관리</h1>
      <div class="seg-tabs" id="atabs" role="tablist">
        <button type="button" data-tab="teams" role="tab">팀 · 초대 <small>${teams.length}</small></button>
        <button type="button" data-tab="tags" role="tab">추천 태그 <small>${nTags}</small></button>
        <button type="button" data-tab="data" role="tab">백업 · 정리</button>
      </div>

      <section data-pane="teams">
        <div class="card">
          <h2>팀 만들기 초대코드</h2>
          ${inv.code ? `<div class="bigcode" id="invcode">${esc(inv.code)}</div>` : '<p class="muted">초대코드가 없습니다. 재발급하면 팀 만들기가 열립니다.</p>'}
          <div class="row">${inv.code ? '<button class="btn small" id="invcopy">복사</button>' : ''}<button class="btn small danger" id="invnew">${inv.code ? '재발급' : '초대코드 만들기'}</button></div>
          <p class="hint">새 팀을 만들 사람에게만 알려 주세요. 재발급하면 이전 코드는 바로 쓸 수 없습니다.${inv.source === 'env' ? ' (지금은 Cloudflare 환경변수 값이며, 재발급하면 앱 안의 값으로 바뀝니다.)' : ''}</p>
        </div>
        <h2>팀 목록 (${teams.length})</h2>
        <div id="teams">
          ${
            teams
              .map(
                (t) => `<div class="card tcard" data-t="${t.id}">
                <div class="row between"><div class="song-title">${esc(t.name)}</div><span class="song-meta" style="margin:0"><span>콘티 ${t.setlist_count}개</span>${t.has_leader ? '' : '<span class="error" style="margin:0">팀장 없음</span>'}${t.can_edit_songs ? '<span class="tag">악보 편집 가능</span>' : ''}</span></div>
                <div class="row" style="margin-top:6px"><span class="muted small">가입코드</span><span class="bigcode small">${esc(t.join_code)}</span><button class="btn small" data-a="copy" data-code="${esc(t.join_code)}">복사</button></div>
                <details class="tmore"><summary>팀 관리</summary>
                  <label class="check"><input type="checkbox" data-a="edit" ${t.can_edit_songs ? 'checked' : ''}> 이 팀 팀장에게 악보 편집 권한 주기</label>
                  <div class="row" style="margin-top:8px">
                    <button class="btn small" data-a="code">가입코드 재발급</button>
                    <button class="btn small" data-a="pin">팀장 PIN 재지정</button>
                    <button class="btn small" data-a="rename">이름 변경</button>
                    <button class="btn small danger" data-a="del" style="margin-left:auto">팀 삭제</button>
                  </div>
                </details>
              </div>`
              )
              .join('') || '<p class="muted">아직 팀이 없습니다.</p>'
          }
        </div>
        <details class="card fold"><summary>팀 직접 만들기</summary>
        <form id="nf">
          <div class="grid2">
            <div><label for="nn" style="margin-top:0">팀 이름</label><input id="nn" type="text" maxlength="40"></div>
            <div><label for="np" style="margin-top:0">팀장 PIN (4자 이상)</label><input id="np" type="password" autocomplete="new-password"></div>
          </div>
          <p class="error" id="nerr"></p>
          <p><button class="btn">팀 만들기</button></p>
        </form></details>
      </section>

      <section data-pane="tags" hidden>
        <div class="card">
          <h2>추천 태그 (주제 · 빠르기 · 절기)</h2>
          <p class="hint" style="margin-top:0">곡 편집 화면과 곡 목록 필터에 칩으로 나오는 목록이에요. 곡에는 이 목록에 없는 태그도 자유롭게 쓸 수 있어요. ◀ ▶ ▲ ▼ 로 순서를 바꾸면 곡에 표시되는 태그 순서도 따라가요. 고친 뒤 <b>추천 목록 저장</b>을 눌러야 반영돼요.</p>
          <div id="presets"></div>
          <p class="error" id="perr"></p>
          <div class="row"><button class="btn small" id="pnew" type="button">+ 분류 추가</button><button class="btn primary" id="psave" type="button">추천 목록 저장</button></div>
        </div>
        <details class="card fold"><summary>곡에 쓰인 태그 정리 (${nTags})</summary>
          <p class="hint" style="margin-top:0">이름을 바꾸면 모든 곡의 태그가 함께 바뀌어요. 이미 있는 태그 이름으로 바꾸면 하나로 합쳐져요.</p>
          <div id="usedtags"></div>
        </details>
      </section>

      <section data-pane="data" hidden>
        <div class="card">
          <h2>데이터 백업</h2>
          <p class="hint" style="margin-top:0">곡 · 콘티 · 태그 · 팀 설정을 파일 하나로 내려받아요. 큰 정리를 하기 전이나 가끔 한 번씩 받아 두면 안전해요.</p>
          <div class="row"><button class="btn primary" id="mgbak" type="button">백업 파일 받기</button></div>
        </div>
        <div class="card">
          <h2>구간 이름 영어 통일</h2>
          <p class="hint" style="margin-top:0">악보 구간 이름표와 콘티 송폼의 한글 이름(1절·후렴·간주 …)을 영어 약어(V1 · C · Inter …)로 바꿔요. 곡은 바꾸기 전 내용이 <b>수정 이력</b>에 남고, 콘티 송폼은 이전 글자를 따로 보관해요. 몇 번 눌러도 결과는 같아요. 알아보지 못하는 이름(예: Hook)은 건드리지 않고 목록으로 보여 드려요. <b>① 백업 → ② 미리 보기 → ③ 변환 실행</b> 순서로 하세요.</p>
          <div id="mgres" class="small"></div>
          <div class="row"><button class="btn small" id="mgprev" type="button">② 미리 보기</button><button class="btn small danger" id="mgrun" type="button" disabled>③ 변환 실행</button></div>
        </div>
      </section>

      <div class="footer"><button id="aout">관리자 권한 닫기</button></div>`;
    const showTab = (t) => {
      if (!['teams', 'tags', 'data'].includes(t)) t = 'teams';
      ls.set('ews_admin_tab', t);
      document.querySelectorAll('#atabs button').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      document.querySelectorAll('[data-pane]').forEach((x) => { x.hidden = x.dataset.pane !== t; });
    };
    el('atabs').onclick = (ev) => { const b = ev.target.closest && ev.target.closest('button[data-tab]'); if (b) { showTab(b.dataset.tab); window.scrollTo(0, 0); } };
    showTab(ls.get('ews_admin_tab', 'teams'));

    // 팀 코드 재발급·이름 변경 같은 동작 뒤에 화면을 다시 그릴 때 스크롤 위치를 그대로 둔다
    const refresh = async () => { const y = window.scrollY; await route(); window.scrollTo(0, y); };
    const act = async (fn) => {
      try {
        await fn();
        refresh();
      } catch (e) {
        toast(e.message);
      }
    };
    // 구간 이름 영어 통일: 백업 → 미리 보기 → 실행
    {
      const box = el('mgres');
      const show = (r) => {
        const un = r.unknown.length ? `<div style="margin-top:6px">알아보지 못한 이름(그대로 둠): ${r.unknown.map((u) => `<code>${esc(u.name)}</code>×${u.count}`).join(' ')}</div>` : '';
        box.innerHTML = `<div>곡 <b>${r.songs.changed}</b>곡 / ${r.songs.total}곡에서 이름표 ${r.lines}줄이 바뀌어요 · 콘티 송폼 <b>${r.items.changed}</b>칸 / ${r.items.total}칸</div>${un}${r.done_at ? `<div class="muted" style="margin-top:6px">마지막 변환: ${esc(String(r.done_at).replace('T', ' ').slice(0, 16))} (UTC)</div>` : ''}`;
        el('mgrun').disabled = !(r.songs.changed || r.items.changed);
      };
      el('mgbak').onclick = async () => {
        try {
          const d = await api('/admin/backup');
          const blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'everyday-worship-backup-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1500);
          toast(`백업을 내려받았어요. (곡 ${d.songs.length}개 · 콘티 ${d.setlists.length}개)`);
        } catch (e) { toast(e.message); }
      };
      el('mgprev').onclick = async () => { try { show(await api('/admin/migrate-sections')); } catch (e) { toast(e.message); } };
      el('mgrun').onclick = async () => {
        if (!confirm('구간 이름을 영어로 변환할까요?\n(곡은 수정 이력에 이전 내용이 남아요. 백업을 먼저 받아 두면 더 안전해요.)')) return;
        try {
          const r = await api('/admin/migrate-sections', { method: 'POST' });
          show(await api('/admin/migrate-sections'));
          toast(`변환했어요. 곡 ${r.songs.changed}곡 · 콘티 송폼 ${r.items.changed}칸`);
        } catch (e) { toast(e.message); }
      };
    }
    if (inv.code) el('invcopy').onclick = () => copyText(inv.code);
    el('invnew').onclick = () => {
      if (inv.code && !confirm('초대코드를 다시 발급할까요?\n이전 코드는 바로 쓸 수 없게 됩니다.')) return;
      act(() => api('/admin/invite', { method: 'POST' }));
    };
    el('teams').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('[data-a]');
      if (!b || b.tagName === 'INPUT') return;
      const card = b.closest('[data-t]');
      const tid = card.dataset.t;
      const t = teams.find((x) => String(x.id) === tid);
      const a = b.dataset.a;
      if (a === 'copy') return copyText(b.dataset.code);
      if (a === 'code') {
        if (!confirm(`"${t.name}" 팀의 가입코드를 다시 발급할까요?\n기존 팀원은 새 코드로 다시 입장해야 합니다.`)) return;
        return act(() => api(`/admin/teams/${tid}/join-code`, { method: 'POST' }));
      }
      if (a === 'pin') {
        const pin = prompt(`"${t.name}" 팀의 새 팀장 PIN을 입력하세요. (4자 이상)\n저장하면 이전 팀장은 새 PIN으로 다시 로그인해야 합니다.`);
        if (pin === null) return;
        return act(() => api(`/admin/teams/${tid}/leader-pin`, { method: 'POST', body: { pin } }));
      }
      if (a === 'rename') {
        const name = prompt('새 팀 이름', t.name);
        if (name === null) return;
        return act(() => api('/admin/teams/' + tid, { method: 'PUT', body: { name } }));
      }
      if (a === 'del') {
        if (!confirm(`"${t.name}" 팀을 삭제할까요?\n이 팀의 콘티와 팀 기본 키가 모두 사라지며 되돌릴 수 없습니다.`)) return;
        return act(() => api('/admin/teams/' + tid, { method: 'DELETE' }));
      }
    };
    el('teams').onchange = (ev) => {
      const c = ev.target;
      if (c.dataset.a !== 'edit') return;
      const tid = c.closest('[data-t]').dataset.t;
      api('/admin/teams/' + tid, { method: 'PUT', body: { can_edit_songs: c.checked } })
        .then(() => toast(c.checked ? '악보 편집 권한을 켰습니다.' : '악보 편집 권한을 껐습니다.'))
        .catch((e) => {
          c.checked = !c.checked;
          toast(e.message);
        });
    };
    el('nf').onsubmit = (ev) => {
      ev.preventDefault();
      el('nerr').textContent = '';
      api('/admin/teams', { method: 'POST', body: { name: el('nn').value, pin: el('np').value } })
        .then(() => {
          toast('팀을 만들었습니다.');
          refresh();
        })
        .catch((e) => (el('nerr').textContent = e.message));
    };
    // ----- 추천 태그 목록 편집 -----
    let presets = JSON.parse(JSON.stringify(tg.presets));
    const inPresets = () => new Set(presets.flatMap((g) => g.items));
    function drawPresets() {
      el('presets').innerHTML =
        presets
          .map(
            (g, gi) => `<div class="pgroup" data-gi="${gi}">
              <div class="row"><input class="gname" type="text" maxlength="12" value="${esc(g.group)}" aria-label="분류 이름"><button class="btn small" type="button" data-a="gup" aria-label="분류 위로" ${gi === 0 ? 'disabled' : ''}>▲</button><button class="btn small" type="button" data-a="gdn" aria-label="분류 아래로" ${gi === presets.length - 1 ? 'disabled' : ''}>▼</button><button class="btn small danger" type="button" data-a="gdel">분류 삭제</button></div>
              <div class="chips">${g.items.map((t, ti) => `<span class="chip on edit">${ti > 0 ? `<button type="button" class="x mv" data-a="tl" data-ti="${ti}" aria-label="${esc(t)} 앞으로">◀</button>` : ''}${esc(t)}${ti < g.items.length - 1 ? `<button type="button" class="x mv" data-a="tr" data-ti="${ti}" aria-label="${esc(t)} 뒤로">▶</button>` : ''}<button type="button" class="x" data-a="tdel" data-ti="${ti}" aria-label="${esc(t)} 빼기">✕</button></span>`).join('') || '<span class="muted small">비어 있음</span>'}</div>
              <div class="row"><input class="gadd" type="text" maxlength="20" placeholder="태그 추가 (예: 경배)"><button class="btn small" type="button" data-a="tadd">추가</button></div>
            </div>`
          )
          .join('') || '<p class="muted">분류가 없습니다. “+ 분류 추가”로 만들어 보세요.</p>';
    }
    const addTag = (box) => {
      const gi = +box.dataset.gi;
      const inp = box.querySelector('.gadd');
      const t = inp.value.replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) return;
      if (!presets[gi].items.includes(t)) presets[gi].items.push(t);
      drawPresets();
    };
    el('presets').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-a]');
      const box = ev.target.closest && ev.target.closest('.pgroup');
      if (!b || !box) return;
      const gi = +box.dataset.gi;
      const move = (arr, i, j) => { if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; drawPresets(); };
      if (b.dataset.a === 'tdel') { presets[gi].items.splice(+b.dataset.ti, 1); drawPresets(); }
      else if (b.dataset.a === 'tl') move(presets[gi].items, +b.dataset.ti, +b.dataset.ti - 1);
      else if (b.dataset.a === 'tr') move(presets[gi].items, +b.dataset.ti, +b.dataset.ti + 1);
      else if (b.dataset.a === 'gup') move(presets, gi, gi - 1);
      else if (b.dataset.a === 'gdn') move(presets, gi, gi + 1);
      else if (b.dataset.a === 'tadd') addTag(box);
      else if (b.dataset.a === 'gdel') {
        if (!confirm(`"${presets[gi].group}" 분류를 목록에서 뺄까요?\n(곡에 붙은 태그는 그대로 남아요)`)) return;
        presets.splice(gi, 1);
        drawPresets();
      }
    };
    el('presets').onchange = (ev) => {
      const t = ev.target;
      const box = t.closest && t.closest('.pgroup');
      if (!box) return;
      if (t.classList.contains('gname')) presets[+box.dataset.gi].group = t.value;
    };
    el('presets').onkeydown = (ev) => {
      if (ev.key === 'Enter' && ev.target.classList && ev.target.classList.contains('gadd')) { ev.preventDefault(); addTag(ev.target.closest('.pgroup')); }
    };
    el('pnew').onclick = () => { presets.push({ group: '새 분류', items: [] }); drawPresets(); };
    el('psave').onclick = async () => {
      el('perr').textContent = '';
      try {
        await api('/admin/tags', { method: 'PUT', body: { presets } });
        toast('추천 태그 목록을 저장했습니다.');
        route();
      } catch (e) {
        el('perr').textContent = e.message;
      }
    };
    drawPresets();

    // ----- 곡에 쓰인 태그 정리 (이름 바꾸기·합치기·지우기) -----
    const used = Object.entries(tg.usage).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
    el('usedtags').innerHTML =
      used
        .map(([t, n]) => `<div class="row between utag" data-t="${esc(t)}"><span><b>${esc(t)}</b> <span class="muted small">${n}곡${inPresets().has(t) ? '' : ' · 추천 목록에 없음'}</span></span><span class="row" style="gap:4px"><button class="btn small" type="button" data-a="ren">이름 변경</button><button class="btn small danger" type="button" data-a="rmtag">모든 곡에서 지우기</button></span></div>`)
        .join('') || '<p class="muted">아직 곡에 붙은 태그가 없습니다.</p>';
    el('usedtags').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-a]');
      if (!b) return;
      const from = b.closest('.utag').dataset.t;
      if (b.dataset.a === 'ren') {
        const to = prompt(`"${from}" 태그의 새 이름\n(이미 있는 태그 이름을 쓰면 하나로 합쳐집니다)`, from);
        if (to === null || !to.trim() || to.trim() === from) return;
        return act(() => api('/admin/tags/rename', { method: 'POST', body: { from, to } }));
      }
      if (!confirm(`"${from}" 태그를 모든 곡에서 지울까요?\n되돌릴 수 없습니다.`)) return;
      act(() => api('/admin/tags/rename', { method: 'POST', body: { from, to: '' } }));
    };
    el('aout').onclick = () => {
      ls.del('ews_admin');
      toast('관리자 로그아웃했습니다.');
      route();
    };
  }

  // 16차: 화면 크기가 바뀔 수 있는 순간마다 아래 메뉴 위치를 다시 맞춘다
  window.addEventListener('resize', fitNavSoon);
  window.addEventListener('orientationchange', fitNavSoon);
  window.addEventListener('pageshow', fitNavSoon);
  window.addEventListener('focusout', fitNavSoon, true);
  window.addEventListener('hashchange', fitNavSoon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fitNavSoon(); });
  if (window.visualViewport) visualViewport.addEventListener('resize', fitNavSoon);

  route();

  // 저장소 지속 요청 (13차): 브라우저가 공간이 모자랄 때 이 앱의 오프라인 악보·곡별 키 설정을 마음대로 지우지 못하게 요청한다.
  // 지원하는 브라우저에서만 동작하고, 허락 여부는 브라우저가 정한다. (거절돼도 앱 사용에는 영향 없음)
  try {
    if (navigator.storage && navigator.storage.persist && navigator.storage.persisted) {
      navigator.storage.persisted().then((on) => { if (!on) return navigator.storage.persist(); }).catch(() => {});
    }
  } catch {}

  // 오프라인 지원: 서비스 워커가 앱 파일과 본 악보·콘티를 이 기기에 저장해 둔다.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
