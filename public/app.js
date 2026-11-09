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
    ['ews_token', 'ews_admin', 'ews_teams', 'ews_team_active', 'ews_team', 'ews_leader', 'ews_team_skip'].forEach((k) => ls.del(k));
    // 오프라인용으로 저장해 둔 악보·콘티도 이 기기에서 지운다 (다른 사람이 같은 기기를 쓸 때를 위해)
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

  async function loadMe() {
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
      ['#/more', '더보기', 'more', /^\/(more|team|admin)/.test(hash)],
    ];
    $nav.innerHTML = items.map(([href, label, ic, on]) => `<a href="${href}" class="${on ? 'on' : ''}">${NAV_ICON[ic]}<span>${label}</span></a>`).join('');
    $nav.hidden = false;
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
    const [hash, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
    const q = new URLSearchParams(qs || '');
    window.scrollTo(0, 0);
    document.querySelectorAll('.sheet-wrap').forEach((n) => n.remove()); // 열려 있던 아래 창은 닫는다
    document.querySelector('main').classList.remove('wide');
    try {
      if (!ls.get('ews_token', '')) return viewLogin();
      await loadMe();
      $top.hidden = false;
      renderNav(hash);
      // 처음 들어오면 팀 가입 화면부터. ("팀 없이 곡만 보기"를 고르면 건너뜀)
      if (!me.team && ls.get('ews_team_skip', '') !== '1' && hash !== '/team' && hash !== '/admin' && hash !== '/more') {
        location.hash = '#/team';
        return;
      }
      let m;
      if (hash === '/' || hash === '') return await viewHome();
      if (hash === '/songs') return await viewList(q);
      if (hash === '/more') return await viewMore();
      if ((m = /^\/song\/(\d+)$/.exec(hash))) return await viewSong(+m[1], q);
      if ((m = /^\/play\/song\/(\d+)$/.exec(hash))) return await viewPlay({ songId: +m[1] }, q);
      if ((m = /^\/play\/(\d+)$/.exec(hash))) return await viewPlay({ sl: +m[1] }, q);
      if (hash === '/new') return viewEdit(null, q);
      if ((m = /^\/history\/(\d+)$/.exec(hash))) return await viewHistory(+m[1]);
      if ((m = /^\/edit\/(\d+)$/.exec(hash))) return await viewEdit(+m[1]);
      if (hash === '/admin') return await viewAdmin();
      if (hash === '/team') return await viewTeam(q);
      if (hash === '/setlists') return await viewSetlists();
      if (hash === '/setlist/new') return await viewSetlistEdit(null);
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
      <div class="row between"><h1>곡 목록</h1>${lockBtn('song', '+ 새 곡', '#/new', 'primary')}</div>
      <input type="search" id="q" placeholder="제목 · 원제 · 가사(후렴) · 아티스트 · 태그 검색" value="${esc(listState.q)}">
      <details class="filter" id="filter"><summary id="fsum">분류·키로 찾기</summary><div id="chips"></div><p class="row" style="margin:8px 0 0"><button type="button" class="btn small" id="fclear">선택 모두 지우기</button></p></details>
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
      SongFilter.prune(listState.f, groups, kchips);
      $chips.innerHTML = SongFilter.chipsHTML(listState.f, groups, kchips, esc);
      const sum = SongFilter.summary(listState.f);
      document.getElementById('fsum').textContent = sum ? `분류·키로 찾기 · ${sum}` : '분류·키로 찾기';
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
            <div class="song-meta">${s.original_key ? `<span class="keybadge">${esc(s.original_key)}</span>` : ''}${SongFilter.badgesHTML(s, esc)}${s.artist ? `<span>${esc(s.artist)}</span>` : ''}${s.tempo ? `<span>♩${s.tempo}</span>` : ''}${used}</div>
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
    async function load() {
      const [r, info] = await Promise.all([api('/songs?q=' + encodeURIComponent(listState.q)), api('/tags')]);
      songs = r.songs;
      groups = groupTags(info);
      kchips = SongFilter.keyChips(songs);
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

    const prefs = { cols: ls.get('ews_cols', 'auto') === '1' ? '1' : 'auto', size: +ls.get('ews_size', '18'), chords: ls.get('ews_chords', '1') === '1', acc: ls.get('ews_acc', 'auto') };
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
    const isLeader = !!(me.team && me.team.isLeader);

    const playHref = '#/play/' + (slId ? slId + '?song=' + id : 'song/' + id + (q.toString() ? '?' + q.toString() : ''));
    // ⋯ 메뉴: 편집(권한이 없으면 🔒 PIN) · 수정 이력
    const menuRows = [
      me.canEdit ? `<a class="menu-row" href="#/edit/${id}">곡 편집</a>` : me.adminRequired ? `<button type="button" class="menu-row" data-lock="song" data-go="#/edit/${id}">🔒 곡 편집 <span class="muted small">PIN 필요</span></button>` : '',
      me.canEdit ? `<a class="menu-row" href="#/history/${id}">수정 이력</a>` : '',
    ].filter(Boolean);

    $app.innerHTML = `
      <div class="row between"><a href="${slId ? '#/setlist/' + slId : '#/songs'}" class="small">← ${slId ? '콘티' : '목록'}</a>${menuRows.length ? '<button class="btn small" id="smore" type="button" aria-label="더보기 메뉴">⋯</button>' : ''}</div>
      <h1>${esc(song.title)}</h1>
      ${song.orig_title ? `<div class="orig-line">원제 ${esc(song.orig_title)}</div>` : ''}
      <div class="row actions"><a class="btn primary big grow" href="${playHref}">▶ 연주 모드</a>${hasText ? '<button class="btn big" id="keychip" type="button" aria-label="키와 표시 설정"></button>' : ''}</div>
      <div class="song-meta" style="margin-bottom:8px">
        ${song.artist ? `<span>${esc(song.artist)}</span>` : ''}
        ${hasKey ? `<span>원키 <span class="keybadge">${esc(origKey)}</span>${gk.guessed ? ' (추정)' : ''}</span>` : ''}
        ${song.team_key ? `<span>우리 팀 <span class="keybadge" id="tkbadge">${esc(song.team_key)}</span></span>` : '<span id="tkwrap" hidden>우리 팀 <span class="keybadge" id="tkbadge"></span></span>'}
        ${song.tempo ? `<span>♩${song.tempo}</span>` : ''}
        ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener noreferrer">▶ 유튜브</a>` : ''}
      </div>
      ${SongFilter.tagsLineHTML(song.tags, esc)}
      ${usageHTML(song.usage)}
      ${hasText && files.length ? '<div class="tabs" id="tabs"><button class="tab" data-tab="chord">코드 악보</button><button class="tab" data-tab="img">이미지 악보</button></div>' : ''}
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
    function draw() {
      document.documentElement.style.setProperty('--song-size', prefs.size + 'px');
      $chtoggle.textContent = prefs.chords ? '코드 숨기기' : '코드 보기';
      document.getElementById('coltoggle').textContent = prefs.cols === 'auto' ? '2단: 자동' : '2단: 끔';
      applyCols();
      const p = Chord.plan(origKey, st.shift, st.capo, prefs.acc);
      $score.innerHTML = Chord.renderHTML(parsed, { originalKey: origKey, shift: st.shift, capo: st.capo, acc: prefs.acc, showChords: prefs.chords });
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
        const b = document.getElementById('tkbadge');
        b.textContent = k;
        const w = document.getElementById('tkwrap');
        if (w) w.hidden = false;
        toast(`우리 팀 기본 키를 ${k}(으)로 저장했습니다.`);
      } catch (e) {
        toast(e.message);
      } finally {
        $tk.disabled = false;
      }
    };
    $acc.onchange = () => { prefs.acc = $acc.value; ls.set('ews_acc', prefs.acc); draw(); };
    document.getElementById('fup').onclick = () => { prefs.size = Math.min(40, prefs.size + 2); ls.set('ews_size', prefs.size); draw(); };
    document.getElementById('fdown').onclick = () => { prefs.size = Math.max(12, prefs.size - 2); ls.set('ews_size', prefs.size); draw(); };
    document.getElementById('coltoggle').onclick = () => { prefs.cols = prefs.cols === 'auto' ? '1' : 'auto'; ls.set('ews_cols', prefs.cols); draw(); };
    $chtoggle.onclick = () => { prefs.chords = !prefs.chords; ls.set('ews_chords', prefs.chords ? '1' : '0'); draw(); };
    draw();

    // 코드 악보 / 이미지 악보 전환 (둘 다 있을 때만 탭 표시, 선택은 이 기기에 기억)
    const $pc = document.getElementById('pane-chord');
    const $pi = document.getElementById('pane-img');
    // 콘티에서 열었는데 이미지 악보의 원래 키와 부르는 키가 다르면, 이미지 위에 알려 준다.
    const wantKey = q.get('key') || '';
    const keyBanner = wantKey && origKey && wantKey !== origKey ? `<div class="memo" style="margin-bottom:10px">이 콘티에서는 <b>${esc(wantKey)}</b> 키로 부릅니다. 이미지 악보는 원래 키(<b>${esc(origKey)}</b>) 기준입니다.</div>` : '';
    $pi.innerHTML = (files.length ? keyBanner : '') + Files.renderPane(files);
    Files.bindPane($pi, files);
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
{comment: 1절}
[G]주님은 [C]나의 [G]목자
[Em]부족함이 [D]없으리
{comment: 후렴}
[C]찬양해 [D]찬양해 [G]주님을`;

  async function viewEdit(id, q) {
    if (!me.canEdit) {
      $app.innerHTML = `<div class="card"><p>악보를 편집할 권한이 없습니다.</p>
        <p class="muted small">관리자이거나, 관리자가 악보 편집 권한을 켜 준 팀의 팀장만 악보를 등록·수정할 수 있습니다.</p>
        ${me.adminRequired ? lockBtn('song', 'PIN 입력', location.hash || '#/songs', 'primary') + ' ' : '<p class="error">관리자 PIN(ADMIN_PIN)이 설정되어 있지 않아 아무도 편집할 수 없습니다. 설치 안내를 확인해 주세요.</p>'}<a class="btn" href="#/songs">목록</a></div>`;
      return;
    }
    document.querySelector('main').classList.add('wide');
    let song = { title: '', orig_title: '', lyrics_extra: '', artist: '', original_key: '', tempo: '', youtube_url: '', tags: '', chordpro: '', memo: '' };
    if (id) song = (await api('/songs/' + id)).song;
    else if (q && q.get('title')) song.title = q.get('title').slice(0, 200); // 목록에서 "새 곡으로 등록"으로 넘어온 검색어
    const tagInfo = await api('/tags');
    document.title = (id ? '편집 · ' + song.title : '새 곡') + ' · Everyday Worship Songbook';
    const keyOptions = ['', ...KEYS_MAJOR, ...KEYS_MINOR];

    $app.innerHTML = `
      <div class="row between"><a href="${id ? '#/song/' + id : '#/songs'}" class="small">← ${id ? '곡 보기' : '목록'}</a><h2 style="margin:0">${id ? '악보 편집' : '새 곡 등록'}</h2></div>
      <div class="edit-wrap">
        <div>
          <div class="card">
            <label for="title">제목</label><input id="title" type="text" value="${esc(song.title)}">
            <div class="hint" id="extfind" style="margin:6px 0 0"></div>
            <label for="otitle">원제 (원곡이 영어 등일 때 · 선택)</label><input id="otitle" type="text" placeholder="예: The Heart of Worship" value="${esc(song.orig_title)}">
            <div class="grid2">
              <div><label for="artist">아티스트</label><input id="artist" type="text" value="${esc(song.artist)}"></div>
              <div><label for="key">원래 키</label><select id="key">${keyOptions.map((k) => `<option value="${k}" ${k === song.original_key ? 'selected' : ''}>${k || '(모름)'}</option>`).join('')}</select></div>
              <div><label for="tempo">템포(BPM)</label><input id="tempo" type="number" inputmode="numeric" min="20" max="300" value="${esc(song.tempo || '')}"></div>
            </div>
            <label for="tags">태그 (쉼표로 구분 · 아래 추천 칩을 눌러도 돼요)</label><input id="tags" type="text" placeholder="경배, 빠른곡" value="${esc(song.tags)}">
            <div id="tagchips"></div>
            <label for="yt">유튜브 링크</label><input id="yt" type="url" placeholder="https://" value="${esc(song.youtube_url)}">
            <label for="memo">메모</label><textarea id="memo" rows="2">${esc(song.memo)}</textarea>
            <label for="lx">검색용 가사 · 후렴 (선택)</label><textarea id="lx" rows="3" placeholder="후렴 한두 줄을 적어 두면 가사로 검색돼요">${esc(song.lyrics_extra)}</textarea>
            <div class="hint">코드 악보 본문의 가사는 자동으로 검색됩니다. <b>이미지·PDF 악보만 있는 곡</b>은 가사가 글자로 없어서 검색되지 않으니, 후렴 몇 줄을 여기에 적어 주세요. (악보 화면에는 보이지 않고 검색에만 쓰입니다)</div>
          </div>
          <div class="card">
            <div id="draftbar" class="draftbar" hidden></div>
            <div class="row between" style="margin-bottom:8px"><span class="lbl-like">악보 본문</span></div>
            <div class="row" style="margin:0 0 8px"><button type="button" class="btn small" id="pastebtn">📋 가사 붙여넣기로 시작</button></div>
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
      $('pv').innerHTML = Chord.renderHTML(parsed, { originalKey: gk.key, showChords: true }) || '<p class="muted">본문을 입력하면 여기에 악보가 나타납니다.</p>';
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
            body = `<div class="te-lab">${esc(l.label || '(이름 없음)')}</div>`;
          } else if (l.kind === 'soc' || l.kind === 'eoc') {
            body = `<div class="te-soc">${l.kind === 'soc' ? '후렴 시작' : '후렴 끝'}</div>`;
          } else if (l.kind === 'blank') {
            body = `<div class="te-gap"></div>`;
          } else {
            body = `<div class="te-raw">${esc(l.raw)}<small> · 줄 메뉴(⋯)에서 고칠 수 있어요</small></div>`;
          }
          html += `<div class="te-row${ch}${l.kind === 'blank' ? ' blank' : ''}">${gut}${body}</div>`;
          if (l.kind === 'eoc') inCh = false;
        });
      }
      html += `<div class="row" style="margin-top:8px"><button type="button" class="btn small" data-op="addend">＋ 맨 끝에 가사 줄 추가</button></div>`;
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

    // 줄 메뉴(왼쪽 ⋯)
    function lineSheet(li) {
      const l = tm.lines[li];
      if (!l) return;
      const secChips = (skipChorus) => `<div class="te-pal-row wrap">${TabEdit.SECTION_NAMES.filter((n) => !(skipChorus && n === '후렴')).map((n) => `<button type="button" class="chip ctb sm" data-sec="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
      const inCh = TabEdit.isInChorus(tm, li);
      // 반복 구간 코드 복사: 같은 가사 줄이 있으면 줄 복사, 코드가 달린 다른 구간이 있으면 구간 복사를 보여 준다
      const sameLi = TabEdit.findSameLyric(tm, li);
      const allBlocks = TabEdit.bodyBlocks(tm);
      const myBlock = allBlocks.find((b) => li >= b.a && li <= b.b);
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
        </div>
        <details class="mdet"><summary>구간 이름 넣기 (1절·후렴 …)</summary>${secChips(true)}</details>
        <p class="mlabel">정리</p>
        <div class="mgrid">
          ${l.chords.length ? T('clear', '🧹', '코드 모두 지우기') : ''}
          ${T('del', '🗑', '이 줄 삭제', 'danger')}
        </div>`;
      } else if (l.kind === 'comment') {
        h += `<p class="hint" style="margin:0 0 4px">이름 바꾸기</p>${secChips(false)}
          <div class="menu-col" style="margin-top:8px"><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button><button type="button" class="btn danger" data-op="del">이 이름표 삭제</button></div>`;
      } else if (l.kind === 'soc' || l.kind === 'eoc') {
        h += `<div class="menu-col"><button type="button" class="btn" data-op="chorus">후렴 표시 끄기</button><button type="button" class="btn" data-op="add">＋ 아래에 가사 줄 추가</button></div>`;
      } else if (l.kind === 'blank') {
        h += `<p class="hint" style="margin:0 0 4px">여기 아래에 구간 이름 넣기</p>${secChips(true)}
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
        const sec = b.dataset.sec;
        if (sec !== undefined) {
          sh.close();
          if (l.kind === 'comment') apply(TabEdit.replaceLine(tm, li, '{comment: ' + sec + '}'));
          else {
            const at = l.kind === 'blank' ? li + 1 : li;
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
        else if (op === 'clear') apply(TabEdit.clearChords(tm, li));
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

    // 가사 붙여넣기: 빈 줄 기준으로 구간을 나누고, 구간 이름을 고른 뒤 악보에 넣는다
    function pasteSheet() {
      const sh = showSheet(`<h2 style="margin-top:0">가사 붙여넣기</h2>
        <div id="ps-step1">
          <p class="hint" style="margin:0 0 6px">가사를 통째로 붙여넣으세요. 빈 줄을 기준으로 구간을 나누고, 이름은 다음 화면에서 고칠 수 있어요. <b>[1절] [후렴]</b> 같은 이름표 줄이 있으면 알아서 읽어요.</p>
          <textarea id="ps-in" rows="8" spellcheck="false" placeholder="여기에 가사를 붙여넣기"></textarea>
          <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="ps-next">구간 나누기</button><button type="button" class="btn" id="ps-no">닫기</button></div>
        </div>
        <div id="ps-step2" hidden></div>`);
      const inp = sh.q('#ps-in');
      sh.q('#ps-no').onclick = () => sh.close();
      let blocks = [];
      sh.q('#ps-next').onclick = () => {
        blocks = TabEdit.splitLyrics(inp.value);
        if (!blocks.length) { toast('가사가 비어 있어요.'); return; }
        const names = ['', ...TabEdit.SECTION_NAMES];
        const s2 = sh.q('#ps-step2');
        s2.hidden = false;
        sh.q('#ps-step1').hidden = true;
        s2.innerHTML = `<p class="hint" style="margin:0 0 8px">${blocks.length}개 구간으로 나눴어요. 이름이 맞는지 확인하세요. (이름 없음 = 이름표 없이 가사만)</p>
          <div class="ps-blocks">${blocks
            .map((b, i) => `<div class="ps-block"><select data-i="${i}" aria-label="${i + 1}번째 구간 이름">${names.map((n) => `<option value="${esc(n)}" ${n === b.label ? 'selected' : ''}>${n || '(이름 없음)'}</option>`).join('')}</select><div class="ps-prev">${esc(b.lines.slice(0, 2).join(' / '))}${b.lines.length > 2 ? ` … (${b.lines.length}줄)` : ''}</div></div>`)
            .join('')}</div>
          <div class="row" style="margin-top:10px"><button type="button" class="btn primary" id="ps-ok">악보에 넣기</button><button type="button" class="btn" id="ps-back">← 다시 붙여넣기</button></div>`;
        s2.querySelectorAll('select').forEach((sel) => (sel.onchange = () => { blocks[+sel.dataset.i].label = sel.value; }));
        sh.q('#ps-back').onclick = () => { s2.hidden = true; sh.q('#ps-step1').hidden = false; };
        sh.q('#ps-ok').onclick = () => {
          const built = TabEdit.buildFromBlocks(blocks);
          const cur = ta.value.replace(/\s+$/, '');
          sh.close();
          setBody(cur ? cur + '\n\n' + built : built);
          toast('가사를 넣었습니다. 글자를 탭해서 코드를 얹어 보세요.');
        };
      };
    }
    $('pastebtn').onclick = pasteSheet;
    // 키(원래 키)를 바꾸면 코드 칩도 그 키에 맞춰 다시 그린다
    $('key').addEventListener('change', tePalette);
    tabRefresh();

    // ----- 태그: 추천 칩(주제·빠르기·절기 …) 누르면 넣고 빼기 -----
    const tagList = () => $('tags').value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
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
    function drawFiles() {
      $('files').innerHTML =
        files
          .map((f) => `<div class="file-item">${f.kind === 'image' ? `<img class="thumb" src="${esc(f.url)}" alt="">` : '<div class="thumb">📄</div>'}<button class="btn small danger" type="button" data-del="${f.id}">삭제</button></div>`)
          .join('') +
        pending
          .map((p, i) => `<div class="file-item"><div class="thumb">⏳</div><div>${esc(p.name.slice(0, 12))}</div><button class="btn small" type="button" data-rm="${i}">빼기</button></div>`)
          .join('');
      $('fnote').hidden = !pending.length;
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

    // ----- 입력 중 자동 임시저장 (이 기기 안에만 저장. 앱이 닫히거나 새로고침돼도 이어서 쓸 수 있다) -----
    const draftKey = 'ews_draft_' + (id || 'new');
    const FIELDS = { title: 'title', orig_title: 'otitle', artist: 'artist', original_key: 'key', tempo: 'tempo', tags: 'tags', youtube_url: 'yt', memo: 'memo', lyrics_extra: 'lx', chordpro: 'cp' };
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
        preview(); drawTagChips(); drawExt(); runCheck();
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
        title: $('title').value, orig_title: $('otitle').value, lyrics_extra: $('lx').value, artist: $('artist').value, original_key: $('key').value, tempo: $('tempo').value,
        youtube_url: $('yt').value, tags: $('tags').value, chordpro: $('cp').value, memo: $('memo').value, force: !!force,
      };
      const btn = $('save');
      btn.disabled = true;
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
      }
    }
    $('save').onclick = () => save(false);
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
  const noteBox = (html) => `<div class="card">${html}</div>`;

  // ---------- 권한 열기: 필요한 순간에 그 자리에서 PIN 묻기 (6차 전 개편) ----------
  // kind: 'leader' = 콘티 편집(팀장 PIN) · 'song' = 악보 편집(관리자 PIN, 또는 악보 권한이 있는 팀장 PIN)
  // 권한이 있으면 보통 버튼, 없지만 열 수 있으면 🔒 버튼(누르면 PIN 창), 열 방법이 없으면 보이지 않는다.
  function lockBtn(kind, label, go, cls) {
    const allowed = kind === 'leader' ? !!(me.team && me.team.isLeader) : !!me.canEdit;
    const c = cls || '';
    if (allowed) return `<a class="btn ${c}" href="${go}">${label}</a>`;
    const lockable = kind === 'leader' ? !!me.team : !!me.adminRequired;
    if (!lockable) return '';
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
        ${search}
        <p><a class="btn" href="#/songs">곡 목록 보기</a></p>`;
      bindSearch();
      return;
    }
    const { setlists } = await api('/setlists');
    const today = todayKst();
    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
    const upcoming = setlists.filter((l) => l.date && l.date >= today).sort(byDate);
    const past = setlists.filter((l) => !l.date || l.date < today).sort((a, b) => byDate(b, a));
    const featured = upcoming[0] || past[0] || null;
    let hero;
    if (!featured) {
      hero = `<div class="card hero">
        <div class="hero-label">${esc(me.team.name)}</div>
        <h2 class="hero-title">아직 콘티가 없어요</h2>
        <p class="muted" style="margin:0 0 12px">콘티를 만들면 이번 주 곡이 여기에 나타나고, 한 번에 연주 모드로 들어갈 수 있어요.</p>
        ${lockBtn('leader', '+ 새 콘티', '#/setlist/new', 'primary big')}
      </div>`;
    } else {
      const { setlist: s } = await api('/setlists/' + featured.id);
      const label = featured.date === today ? '오늘 콘티' : upcoming[0] ? '다가오는 콘티' : '가장 최근 콘티';
      const shown = s.items.slice(0, 8);
      hero = `<div class="card hero">
        <div class="hero-label">${label}${s.date ? ' · ' + esc(fmtDate(s.date)) : ''}</div>
        <h2 class="hero-title">${esc(s.title)}</h2>
        ${shown.length ? `<ol class="mini">${shown.map((it, i) => `<li><span class="num">${i + 1}</span><span class="grow">${esc(it.title)}</span>${(it.key || it.original_key) ? `<span class="keybadge">${esc(it.key || it.original_key)}</span>` : ''}</li>`).join('')}</ol>${s.items.length > shown.length ? `<p class="muted small" style="margin:4px 0 0">외 ${s.items.length - shown.length}곡</p>` : ''}` : '<p class="muted">이 콘티에는 아직 곡이 없어요.</p>'}
        <div class="row" style="margin-top:12px">${shown.length ? `<a class="btn primary big grow" href="#/play/${s.id}">▶ 연주 모드</a>` : ''}<a class="btn big" href="#/setlist/${s.id}">콘티 보기</a></div>
      </div>`;
    }
    const others = upcoming.slice(1, 3);
    $app.innerHTML = `
      ${teamChip()}
      ${hero}
      ${others.length ? `<h2>이어지는 콘티</h2><ul class="songs">${others.map((l) => `<li class="song-item"><a href="#/setlist/${l.id}"><div class="row between"><div class="song-title">${esc(l.title)}</div>${l.date ? `<span class="keybadge">${esc(fmtDate(l.date))}</span>` : ''}</div><div class="song-meta"><span>${l.item_count}곡</span></div></a></li>`).join('')}</ul>` : ''}
      ${search}
      <div class="row"><a class="btn" href="#/setlists">콘티 전체</a><a class="btn" href="#/songs">곡 목록</a></div>`;
    bindSearch();
  }

  // ---------- 더보기: 내 권한 · 우리 팀 · 앱 관리 · 로그아웃 ----------
  async function viewMore() {
    const t = me.team;
    const leader = !!(t && t.isLeader);
    const perm = (name, ok, hint, kind) =>
      `<div class="perm"><div class="grow"><b>${name}</b><div class="small muted">${hint}</div></div>${ok ? '<span class="pill ok">가능</span>' : lockBtn(kind, '열기', '', 'small') || '<span class="pill">불가</span>'}</div>`;
    $app.innerHTML = `
      <h1>더보기</h1>
      <div class="card">
        <h2>내 편집 권한</h2>
        ${t ? perm('콘티 편집', leader, leader ? '팀장 PIN으로 열려 있어요' : '팀장 PIN을 입력하면 열려요', 'leader') : ''}
        ${perm('악보 편집', !!me.canEdit, me.canEdit ? '이 기기에서 열려 있어요' : me.adminRequired ? '관리자 PIN을 입력하면 열려요' : '관리자 PIN이 설정되지 않았어요', 'song')}
        ${me.isAdmin || leader ? '<p style="margin:10px 0 0"><button class="btn small" id="closeperm" type="button">이 기기에서 편집 권한 닫기</button></p>' : ''}
      </div>
      <ul class="songs menu">
        <li class="song-item"><a href="#/team"><div class="song-title">${t ? esc(t.name) : '팀 가입'}</div><div class="song-meta">${t ? '가입코드 · 팀장 PIN · 팀 나가기' : '팀장에게 받은 가입코드로 입장하기'}</div></a></li>
        ${teamsGet().length ? `<li class="song-item"><a href="#" data-teamsw><div class="song-title">팀 전환 · 팀 추가</div><div class="song-meta">가입한 팀 ${teamsGet().length}개${teamsGet().some((x) => x.stale) ? ' · 다시 입장이 필요한 팀이 있어요' : ''}</div></a></li>` : ''}
        ${me.adminRequired ? `<li class="song-item"><a href="#/admin"><div class="song-title">앱 관리</div><div class="song-meta">${me.isAdmin ? '초대코드 · 팀 목록 · 추천 태그' : '관리자 PIN 필요'}</div></a></li>` : ''}
      </ul>
      <div class="footer"><button id="logout" type="button">로그아웃</button></div>
      <p class="muted small">교회 내부용 악보집입니다. 저작권 보호를 위해 외부 공유를 삼가 주세요.</p>`;
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
    const { setlists, canEdit } = await api('/setlists');
    $app.innerHTML = `
      ${teamChip()}
      <div class="row between"><h1>콘티</h1>${lockBtn('leader', '+ 새 콘티', '#/setlist/new', 'primary')}</div>
      ${
        setlists.length
          ? `<ul class="songs">${setlists
              .map(
                (l) => `<li class="song-item"><a href="#/setlist/${l.id}">
                  <div class="song-title">${esc(l.title)}</div>
                  <div class="song-meta">${l.date ? `<span class="keybadge">${esc(fmtDate(l.date))}</span>` : ''}<span>${l.item_count}곡</span></div>
                </a></li>`
              )
              .join('')}</ul>`
          : `<p class="muted center">아직 콘티가 없습니다.${canEdit ? ' “+ 새 콘티”로 만들어 보세요.' : ''}</p>`
      }
      `;
  }

  // ---------- 콘티 보기 ----------
  async function viewSetlist(id) {
    const { setlist: s, canEdit } = await api('/setlists/' + id);
    document.title = s.title + ' · Everyday Worship Songbook';
    const rows = s.items.map((it, i) => {
      const key = it.key || it.original_key || '';
      const imageOnly = it.view === 'image' || (!it.has_chords && it.file_count > 0);
      const p = new URLSearchParams();
      if (it.key) p.set('key', it.key);
      if (it.view !== 'auto') p.set('view', it.view);
      p.set('sl', id);
      const imgKeyNote = imageOnly && it.key && it.original_key && it.key !== it.original_key;
      return `<li class="song-item"><a href="#/song/${it.song_id}?${p.toString()}">
        <div class="row between"><div class="song-title"><span class="num">${i + 1}</span>${esc(it.title)}</div>${key ? `<span class="keybadge">${esc(key)}</span>` : ''}</div>
        <div class="song-meta">
          ${it.form ? `<span>송폼 ${esc(it.form)}</span>` : ''}
          ${imageOnly ? '<span class="fmt img" title="이미지 악보" aria-label="이미지 악보">🖼</span>' : it.has_chords ? '<span class="fmt chord" title="코드 악보" aria-label="코드 악보">🎼</span>' : ''}
          ${it.memo ? `<span>${esc(it.memo)}</span>` : ''}
        </div>
        ${imgKeyNote ? `<div class="hint" style="margin:2px 0 0">이미지 악보는 원래 키(${esc(it.original_key)}) 기준 · 이 콘티에서는 ${esc(it.key)}로 부름</div>` : ''}
      </a></li>`;
    });
    $app.innerHTML = `
      <div class="row between"><a href="#/setlists" class="small">← 콘티 목록</a>${lockBtn('leader', '편집', '#/setlist/' + id + '/edit', 'small')}</div>
      <h1>${esc(s.title)}</h1>
      <div class="song-meta" style="margin-bottom:10px">${s.date ? `<span class="keybadge">${esc(fmtDate(s.date))}</span>` : ''}<span>${s.items.length}곡</span></div>
      ${s.memo ? `<div class="memo" style="margin-bottom:12px">${esc(s.memo)}</div>` : ''}
      ${rows.length ? `<div class="row actions"><a class="btn primary big grow" href="#/play/${id}">▶ 연주 모드</a><button class="btn big" id="share" type="button">공유·저장</button></div>` : ''}
      ${rows.length ? `<ul class="songs">${rows.join('')}</ul>` : '<p class="muted">아직 곡이 없습니다.</p>'}
      <p class="muted small">곡을 누르면 이 콘티의 키로 악보가 열립니다.</p>`;

    // ----- 공유·저장 창: 카톡용 텍스트 · 표지 이미지 · PDF · 오프라인 준비 -----
    const $share = document.getElementById('share');
    if (!$share) return;
    $share.onclick = () => {
      const sh = showSheet(`<h2 style="margin-top:0">공유·저장</h2>
        <div class="share-list">
          <button class="share-item" id="x-text" type="button"><b>💬 카톡용 텍스트 복사</b><span>곡 순서·키·송폼·메모를 글자로 복사해요</span></button>
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

    
    const baseName = [s.date, (s.title || '콘티').trim()].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]/g, '').slice(0, 60) || '콘티';
    const $xt = sh.q('#x-text');
    if ($xt) $xt.onclick = async () => {
      const text = SongForm.kakaoText(s);
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
      const blob = await Exporter.coverPng(s);
      sh.close();
      showFileResult(blob, baseName + '.png', 'png');
    });
    const $xd = sh.q('#x-pdf');
    if ($xd) $xd.onclick = () => guarded($xd, 'PDF', async (setLabel) => {
      const r = await Exporter.buildPdf(s, {
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
    };
    const exitHref = src.sl ? '#/setlist/' + src.sl : '#/song/' + src.songId + (q.toString() ? '?' + q.toString() : '');

    $app.innerHTML = `
      <div class="play" id="play">
        <div class="play-top">
          <div class="play-row">
            <a class="pbtn" id="pexit" href="${exitHref}" aria-label="연주 모드 나가기">✕</a>
            <button class="play-title" id="ptitle" type="button"></button>
            <span class="play-off" id="poff" hidden>오프라인</span>
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

    // ----- 곡 불러오기 (한 번 불러온 곡은 이 화면 안에서 다시 쓴다. 악보 이미지 주소는 오래되면 만료되니 40분 뒤엔 새로 받는다) -----
    const songCache = new Map();
    function loadSong(sid) {
      const hit = songCache.get(sid);
      if (hit && Date.now() - hit.t < 40 * 60 * 1000) return hit.p;
      const p = api('/songs/' + sid).then((r) => r.song);
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
      const capo = Number.isInteger(saved.capo) ? saved.capo : 0;
      let tab = 'none';
      if (hasText && files.length) tab = it.view === 'image' ? 'img' : it.view === 'chord' ? 'chord' : ls.get('ews_tab_' + song.id, '') === 'img' ? 'img' : 'chord';
      else if (hasText) tab = 'chord';
      else if (files.length) tab = 'img';
      return { song, it, parsed, origKey, hasKey, files, pages, hasText, shift, capo, tab, page: 0 };
    }

    let cur = null;
    let nav = 0;
    function applyLook() {
      $play.classList.toggle('dark', P.theme === 'dark');
      $play.classList.toggle('light', P.theme === 'light');
      $play.style.setProperty('--song-size', P.size + 'px');
    }
    function draw() {
      if (!cur) return;
      const { song, it, parsed, origKey, hasKey, files, pages, hasText } = cur;
      const isImg = cur.tab === 'img';
      const top = $pb.scrollTop;
      let keyTxt = '';
      let extra = '';
      if (!isImg) {
        const p = Chord.plan(origKey, cur.shift, cur.capo, P.acc);
        keyTxt = hasKey ? p.soundKey : it.key || '';
        if (cur.capo) extra = `카포 ${cur.capo} · ${p.shapeKey} 코드`;
      } else {
        keyTxt = it.key || origKey || '';
        if (it.key && origKey && it.key !== origKey) extra = `악보는 원키 ${origKey} 기준`;
      }
      g('ptitle').textContent = (multi ? `${idx + 1}. ` : '') + song.title;
      // 다음 곡 미리보기: 제목 · 키 · 메모 (길면 말줄임). 누르면 다음 곡으로.
      const nx = items[idx + 1];
      const nextHtml = !multi ? '' : nx
        ? `<button class="play-next" id="pnext" type="button">다음 ▶ ${idx + 2}. ${esc(nx.title || '')}${nx.key ? ' · <b>' + esc(nx.key) + '</b>' : ''}${nx.memo ? ' · ' + esc(nx.memo) : ''}</button>`
        : '<span class="play-next">마지막 곡</span>';
      g('pinfo').innerHTML = [
        keyTxt ? `<span class="keybadge big">${esc(keyTxt)}</span>` : '',
        it.form ? `<span class="pi"><b>송폼</b> ${esc(it.form)}</span>` : '',
        it.memo ? `<span class="pi"><b>메모</b> ${esc(it.memo)}</span>` : '',
        extra ? `<span class="pi muted">${esc(extra)}</span>` : '',
        hasText && files.length ? `<button class="pbtn mini" id="pswap" type="button">${isImg ? '코드 악보로' : '이미지 악보로'}</button>` : '',
        nextHtml,
      ].join('');
      $pb.classList.toggle('img', isImg);
      g('pel').hidden = g('per').hidden = !isImg; // 이미지 악보일 때만 화면 양옆을 눌러 넘길 수 있다
      if (!isImg) {
        $pb.innerHTML = `<div class="score">${Chord.renderHTML(parsed, { originalKey: origKey, shift: cur.shift, capo: cur.capo, acc: P.acc, showChords: P.chords })}</div>`;
        $pb.scrollTop = top;
      } else if (pages.length) {
        $pb.innerHTML = `<img class="sheet" src="${esc(pages[cur.page].url)}" alt="악보 ${cur.page + 1}">`;
        if (pages[cur.page + 1]) new Image().src = pages[cur.page + 1].url;
      } else {
        $pb.innerHTML = Files.renderPane(files); // PDF만 있는 곡: 열기 링크
      }
      if (cur.tab === 'none') $pb.innerHTML = `<p class="muted center" style="margin-top:40px">등록된 악보가 아직 없습니다.</p>`;
      fitCols();
      updateDots();
    }
    // 코드 악보 2단 보기: 넓은 화면에서 두 단으로 나누고, 스크롤 없이 한 화면에 들어오도록 글자를 줄여 맞춘다. (못 맞추면 1단)
    function fitCols() {
      $play.style.setProperty('--song-size', P.size + 'px');
      const sc = $pb.querySelector('.score');
      $pb.classList.remove('cols');
      if (sc) sc.style.height = '';
      if (!sc || !cur || cur.tab === 'img' || cur.tab === 'none') return;
      if (P.cols === '1' || (P.cols === 'auto' && $pb.clientWidth < 700)) return;
      $pb.classList.add('cols');
      const cs = getComputedStyle($pb);
      sc.style.height = Math.max(100, $pb.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) + 'px';
      const avail = $pb.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      let size = P.size;
      for (;;) {
        $play.style.setProperty('--song-size', size + 'px');
        if (sc.scrollWidth <= avail + 2) return;
        if (size <= 14) break;
        size -= 1;
      }
      // 글자를 가장 작게 줄여도 두 단에 다 안 들어가면 1단으로 되돌린다
      $pb.classList.remove('cols');
      sc.style.height = '';
      $play.style.setProperty('--song-size', P.size + 'px');
    }
    function updateDots() {
      const parts = [];
      if (multi) parts.push(`곡 ${idx + 1}/${items.length}`);
      if (cur && cur.tab === 'img' && cur.pages.length > 1) parts.push(`쪽 ${cur.page + 1}/${cur.pages.length}`);
      g('pdots').textContent = parts.join(' · ');
      g('pdots').hidden = !parts.length;
    }
    async function show(i, startPage) {
      idx = i;
      const my = ++nav;
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
        cur = null;
        g('ptitle').textContent = (multi ? `${i + 1}. ` : '') + (it.title || '');
        $pb.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><p class="muted small">인터넷이 없다면, 미리 “오프라인 준비”를 해 둔 곡만 열 수 있어요.</p><button class="btn" id="pretry" type="button">다시 시도</button></div>`;
        g('pretry').onclick = () => show(i, startPage);
        return;
      }
      if (my !== nav) return;
      cur = buildState(song, it);
      if (startPage === 'last' && cur.tab === 'img') cur.page = Math.max(0, cur.pages.length - 1);
      document.title = song.title + ' · Everyday Worship Songbook';
      draw();
      prefetch(i + 1);
      prefetch(i - 1);
    }
    // 이미지 악보가 여러 쪽이면 쪽을 먼저 넘기고, 끝에서 다음(이전) 곡으로 넘어간다.
    function step(d) {
      if (cur && cur.tab === 'img' && cur.pages.length > 1) {
        const n = cur.page + d;
        if (n >= 0 && n < cur.pages.length) { cur.page = n; draw(); return; }
      }
      const n = idx + d;
      if (n < 0 || n >= items.length) {
        if (multi) toast(d > 0 ? '마지막 곡입니다.' : '첫 곡입니다.');
        return;
      }
      show(n, d < 0 ? 'last' : 0);
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

    // ----- 좌우 스와이프로 넘기기 (세로로 훑는 동작이나 짧은 움직임은 무시) -----
    function bindSwipe(el) {
      let sx = 0, sy = 0, st = 0, tracking = false;
      el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { tracking = false; return; }
        sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); tracking = true;
      }, { passive: true });
      el.addEventListener('touchmove', (e) => { if (e.touches.length > 1) tracking = false; }, { passive: true });
      el.addEventListener('touchend', (e) => {
        if (!tracking) return;
        tracking = false;
        const t = e.changedTouches[0];
        const dx = t.clientX - sx, dy = t.clientY - sy;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - st > 800) return;
        step(dx < 0 ? 1 : -1);
      }, { passive: true });
      el.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
    }
    bindSwipe($pb);
    bindSwipe(g('pel'));
    bindSwipe(g('per'));
    g('pel').onclick = () => step(-1);
    g('per').onclick = () => step(1);

    // ----- 위쪽 버튼, 설정·곡 목록 창 -----
    g('pinfo').onclick = (ev) => {
      if (ev.target.closest && ev.target.closest('#pnext')) { if (idx + 1 < items.length) show(idx + 1, 0); return; }
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
          <div class="srow"><span>코드 표시</span><span class="row">${seg('chords', [['1', '보기'], ['0', '숨기기']], P.chords ? '1' : '0')}</span></div>
          <div class="srow"><span>코드 표기</span><span class="row">${seg('acc', [['auto', '자동'], ['sharp', '♯'], ['flat', '♭']], P.acc)}</span></div>
          <p class="hint">키 변경은 곡 보기 화면에서 하세요. 콘티에서 정한 키로 열립니다.</p>
          <button type="button" class="btn primary" data-a="close" style="width:100%">닫기</button>
        </div>`;
      g('psheet').hidden = false;
    }
    function openList() {
      g('plsheet').innerHTML = `
        <div class="sheet-card">
          <h2 style="margin-top:0">곡 목록</h2>
          ${items.map((it, i) => `<button type="button" class="pick ${i === idx ? 'now' : ''}" data-i="${i}"><span class="song-title"><span class="num">${i + 1}</span>${esc(it.title)}</span><span class="song-meta">${it.key ? `<span class="keybadge">${esc(it.key)}</span>` : ''}${it.form ? `<span>송폼 ${esc(it.form)}</span>` : ''}</span></button>`).join('')}
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
      else if (a === 'cols') { P.cols = v; ls.set('ews_play_cols', v); }
      else if (a === 'theme') { P.theme = v; ls.set('ews_play_theme', v); }
      else if (a === 'wake') { P.wake = v === '1'; ls.set('ews_play_wake', v); if (P.wake) acquireWake(); else releaseWake(); }
      ls.set('ews_play_size', String(P.size));
      applyLook();
      draw();
      openSettings();
    };

    const onKey = (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
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
      fitCols();
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
  async function viewSetlistEdit(id) {
    if (!me.team || !me.team.isLeader) {
      $app.innerHTML = noteBox('<p>콘티는 팀장만 만들고 고칠 수 있습니다.</p>' + lockBtn('leader', '팀장 PIN 입력', location.hash || '#/setlists', 'primary') + ' <a class="btn" href="#/setlists">콘티 목록</a>');
      return;
    }
    const [songRes, listRes, tagRes] = await Promise.all([api('/songs'), id ? api('/setlists/' + id) : null, api('/tags')]);
    const songs = songRes.songs;
    const pickGroups = groupTags(tagRes);
    const pickF = SongFilter.newState(); // 곡 추가할 때 주제·키·악보 형식으로 좁히기 (곡 목록과 같은 규칙)
    const pickKeys = SongFilter.keyChips(songs);
    const byId = Object.fromEntries(songs.map((s) => [s.id, s]));
    const data = id
      ? {
          date: listRes.setlist.date || '',
          title: listRes.setlist.title,
          memo: listRes.setlist.memo,
          items: listRes.setlist.items.filter((it) => byId[it.song_id]).map((it) => ({ song_id: it.song_id, key: it.key, form: it.form, memo: it.memo, view: it.view })),
        }
      : { date: nextSunday(), title: '', memo: '', items: [] };
    document.title = (id ? '콘티 편집' : '새 콘티') + ' · Everyday Worship Songbook';
    // 송폼 탭 입력(6차): formSel = 카드별로 선택된 구간 번호, lastForms = 곡별 "지난번 송폼"
    let formSel = {};
    const lastForms = {};

    $app.innerHTML = `
      <div class="row between"><a href="${id ? '#/setlist/' + id : '#/setlists'}" class="small">← ${id ? '콘티 보기' : '콘티 목록'}</a><h2 style="margin:0">${id ? '콘티 편집' : '새 콘티'}</h2></div>
      <div class="card">
        <div class="grid2">
          <div><label for="sd" style="margin-top:0">날짜</label><input id="sd" type="date" value="${esc(data.date)}"></div>
          <div><label for="st" style="margin-top:0">제목</label><input id="st" type="text" maxlength="100" placeholder="예: 주일예배" value="${esc(data.title)}"></div>
        </div>
        <label for="sm">메모</label><textarea id="sm" rows="2" placeholder="예: 입례 찬양은 2절까지">${esc(data.memo)}</textarea>
      </div>
      <h2>곡 순서</h2>
      <div id="items"></div>
      <div class="card">
        <h2>곡 추가</h2>
        <input type="search" id="sq" placeholder="제목 · 아티스트 · 태그로 찾기">
        <details class="filter" id="pfilter"><summary id="pfsum">분류·키로 찾기</summary><div id="pchips"></div></details>
        <div id="res" class="pick-list"></div>
      </div>
      <p class="error" id="err"></p>
      <div class="row">
        <button class="btn primary" id="save">저장</button>
        <a class="btn" href="${id ? '#/setlist/' + id : '#/setlists'}">취소</a>
        ${id ? '<button class="btn danger" id="del" style="margin-left:auto">삭제</button>' : ''}
      </div>`;

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

    // ----- 송폼: 글자를 쓰지 않고 버튼을 눌러 순서대로 쌓는다 -----
    // 구간 버튼을 누르면 맨 뒤(또는 선택한 구간 바로 뒤)에 들어가고, 쌓인 구간을 누르면 앞뒤 이동·복제·반복(×2)·삭제를 할 수 있다.
    function formInner(i) {
      const it = data.items[i];
      const toks = SongForm.parse(it.form);
      const sel = formSel[i];
      const seq = toks.length
        ? toks.map((t, k) => `<button type="button" class="fchip ${k === sel ? 'sel' : ''}" data-fa="sel" data-i="${i}" data-k="${k}">${esc(t)}</button>`).join('<span class="farrow" aria-hidden="true">›</span>')
        : '<span class="muted small">아래 버튼을 눌러 순서대로 쌓아 보세요</span>';
      const hasSel = sel !== undefined && toks[sel] !== undefined;
      const tools = hasSel
        ? `<div class="ftools on"><span class="small"><b>${esc(toks[sel])}</b> 선택됨 · 아래 버튼은 이 뒤에 들어가요</span>
             <button type="button" class="btn small" data-fa="left" data-i="${i}" ${sel === 0 ? 'disabled' : ''} aria-label="앞으로">◀</button>
             <button type="button" class="btn small" data-fa="right" data-i="${i}" ${sel === toks.length - 1 ? 'disabled' : ''} aria-label="뒤로">▶</button>
             <button type="button" class="btn small" data-fa="dup" data-i="${i}">복제</button>
             <button type="button" class="btn small" data-fa="rep" data-i="${i}">×반복</button>
             <button type="button" class="btn small danger" data-fa="del" data-i="${i}">삭제</button></div>`
        : toks.length || (it._undo && it._undo.length)
          ? `<div class="ftools"><button type="button" class="btn small" data-fa="undo" data-i="${i}" ${it._undo && it._undo.length ? '' : 'disabled'}>↶ 되돌리기</button>${toks.length ? `<button type="button" class="btn small" data-fa="clear" data-i="${i}">모두 지우기</button>` : ''}</div>`
          : '';
      const last = !toks.length && lastForms[it.song_id] ? `<button type="button" class="btn small" data-fa="last" data-i="${i}">↺ 지난번 송폼 불러오기 <span class="muted">${esc(lastForms[it.song_id])}</span></button>` : '';
      return `<label>송폼</label>
        <div class="fseq">${seq}</div>${tools}${last}
        <div class="fpal">${SongForm.PALETTE.map((p) => `<button type="button" class="pchip" data-fa="add" data-i="${i}" data-c="${esc(p.code)}">${esc(p.code)}${p.hint ? `<small>${esc(p.hint)}</small>` : ''}</button>`).join('')}</div>
        <div class="fcustom"><input type="text" data-fcustom="${i}" maxlength="30" placeholder="그 밖의 구간 (예: 2절반복)" enterkeyhint="done"><button type="button" class="btn small" data-fa="addcustom" data-i="${i}">추가</button></div>`;
    }
    function drawForm(i) {
      const box = el('items').querySelector(`.formed[data-i="${i}"]`);
      if (!box) return;
      const old = box.querySelector('[data-fcustom]');
      const typed = old ? old.value : '';
      box.innerHTML = formInner(i);
      const nu = box.querySelector('[data-fcustom]');
      if (nu && typed) nu.value = typed;
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
    function formAction(a, i, b) {
      const it = data.items[i];
      if (!it) return;
      const toks = SongForm.parse(it.form);
      let sel = formSel[i];
      if (sel !== undefined && toks[sel] === undefined) sel = undefined;
      if (a === 'sel') {
        const k = +b.dataset.k;
        if (sel === k) delete formSel[i];
        else formSel[i] = k;
      } else if (a === 'add' || a === 'addcustom') {
        let add;
        if (a === 'add') add = [b.dataset.c];
        else {
          const inp = el('items').querySelector(`[data-fcustom="${i}"]`);
          add = SongForm.parse(inp ? inp.value : '');
          if (!add.length) return;
          inp.value = '';
        }
        const at = sel !== undefined ? sel + 1 : toks.length;
        toks.splice(at, 0, ...add);
        if (!setForm(i, SongForm.format(toks))) return;
        if (sel !== undefined) formSel[i] = at + add.length - 1; // 선택이 새로 넣은 구간으로 따라가서 연달아 누르면 이어 붙는다
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
      drawForm(i);
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
      formSel = {}; // 곡 순서가 바뀌면 카드 번호가 달라지므로 선택 상태를 비운다
      drawItems();
    };
    // 직접 입력칸에서 Enter 를 누르면 "추가"
    el('items').addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (ev.key === 'Enter' && t.dataset && t.dataset.fcustom !== undefined) {
        ev.preventDefault();
        formAction('addcustom', +t.dataset.fcustom, t);
      }
    });
    // 우리 팀이 지난번에 쓴 송폼 (불러오지 못해도 입력에는 지장 없음)
    api('/team/last-forms' + (id ? '?exclude=' + id : ''))
      .then((r) => {
        Object.assign(lastForms, r.forms || {});
        data.items.forEach((_, i) => drawForm(i));
      })
      .catch(() => {});

    function drawPickChips() {
      el('pchips').innerHTML = SongFilter.chipsHTML(pickF, pickGroups, pickKeys, esc);
      const sum = SongFilter.summary(pickF);
      el('pfsum').textContent = sum ? `분류·키로 찾기 · ${sum}` : '분류·키로 찾기';
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
              <span class="song-meta">${s.original_key ? `<span class="keybadge">${esc(s.original_key)}</span>` : ''}${s.team_key ? `<span>우리 팀 ${esc(s.team_key)}</span>` : ''}${s.last_used ? `<span class="tag used">최근 ${mmdd(s.last_used)}</span>` : ''}${SongFilter.badgesHTML(s, esc)}${used[s.id] ? `<span class="tag">✓ 추가됨${used[s.id] > 1 ? ' ×' + used[s.id] : ''}</span>` : ''}</span>
            </button>`
          )
          .join('') || '<p class="muted">찾는 곡이 없습니다.</p>';
    }
    el('sq').oninput = drawResults;
    el('res').onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-add]');
      if (!b) return;
      const s = byId[+b.dataset.add];
      if (data.items.length >= 60) return toast('콘티에는 곡을 60개까지 넣을 수 있습니다.');
      // 기본 키: 우리 팀 기본 키 ▶ 원래 키
      data.items.push({ song_id: s.id, key: s.team_key || s.original_key || '', form: '', memo: '', view: 'auto' });
      drawItems();
      drawResults();
      toast(`"${s.title}" 추가`);
    };
    drawItems();
    drawResults();

    el('save').onclick = async () => {
      el('err').textContent = '';
      const body = {
        date: el('sd').value,
        title: el('st').value,
        memo: el('sm').value,
        items: data.items.map((it) => {
          return { song_id: it.song_id, key: it.key, form: it.form, memo: it.memo, view: it.view };
        }),
      };
      el('save').disabled = true;
      try {
        const r = id ? await api('/setlists/' + id, { method: 'PUT', body }) : await api('/setlists', { method: 'POST', body });
        toast('저장했습니다.');
        location.hash = '#/setlist/' + r.id;
      } catch (e) {
        if (e.status === 403) await loadMe();
        el('err').textContent = e.message;
      } finally {
        el('save').disabled = false;
      }
    };
    if (id)
      el('del').onclick = async () => {
        if (!confirm(`"${data.title}" 콘티를 삭제할까요?\n삭제하면 되돌릴 수 없습니다.`)) return;
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
    $app.innerHTML = `
      <div class="row between"><a href="#/more" class="small">← 더보기</a></div>
      <h1>앱 관리</h1>
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
              (t) => `<div class="card" data-t="${t.id}">
              <div class="row between"><div class="song-title">${esc(t.name)}</div><span class="song-meta" style="margin:0"><span>콘티 ${t.setlist_count}개</span>${t.has_leader ? '' : '<span class="error" style="margin:0">팀장 없음</span>'}</span></div>
              <label>가입코드</label>
              <div class="row"><span class="bigcode small">${esc(t.join_code)}</span><button class="btn small" data-a="copy" data-code="${esc(t.join_code)}">복사</button><button class="btn small" data-a="code">재발급</button></div>
              <label class="check"><input type="checkbox" data-a="edit" ${t.can_edit_songs ? 'checked' : ''}> 이 팀 팀장에게 악보 편집 권한 주기</label>
              <div class="row" style="margin-top:8px">
                <button class="btn small" data-a="pin">팀장 PIN 재지정</button>
                <button class="btn small" data-a="rename">이름 변경</button>
                <button class="btn small danger" data-a="del" style="margin-left:auto">팀 삭제</button>
              </div>
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
      <h2>추천 태그 (주제 · 빠르기 · 절기)</h2>
      <div class="card">
        <p class="hint" style="margin-top:0">곡 편집 화면과 곡 목록 필터에 칩으로 나오는 목록입니다. 곡에는 이 목록에 없는 태그도 자유롭게 쓸 수 있어요. ◀ ▶ ▲ ▼ 로 순서를 바꾸면 곡에 표시되는 태그 순서도 이 순서를 따릅니다. 고친 뒤 <b>추천 목록 저장</b>을 눌러야 반영됩니다.</p>
        <div id="presets"></div>
        <p class="error" id="perr"></p>
        <div class="row"><button class="btn small" id="pnew" type="button">+ 분류 추가</button><button class="btn primary" id="psave" type="button">추천 목록 저장</button></div>
      </div>
      <details class="card fold"><summary>곡에 쓰인 태그 정리</summary>
        <p class="hint" style="margin-top:0">이름을 바꾸면 모든 곡의 태그가 함께 바뀝니다. 이미 있는 태그 이름으로 바꾸면 하나로 합쳐져요.</p>
        <div id="usedtags"></div>
      </details>
      <div class="footer"><button id="aout">관리자 권한 닫기</button></div>`;

    const refresh = () => route();
    const act = async (fn) => {
      try {
        await fn();
        refresh();
      } catch (e) {
        toast(e.message);
      }
    };
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

  route();

  // 오프라인 지원: 서비스 워커가 앱 파일과 본 악보·콘티를 이 기기에 저장해 둔다.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
