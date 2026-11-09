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

  // ---------- API ----------
  // 이 기기에 저장된 열쇠들(접속암호·관리자·팀·팀장)을 요청마다 함께 보낸다.
  function authHeaders() {
    const h = {};
    const t = ls.get('ews_token', '');
    if (t) h.Authorization = 'Bearer ' + t;
    const a = ls.get('ews_admin', '');
    if (a) h['X-Admin-Token'] = a;
    const tm = ls.get('ews_team', '');
    if (tm) h['X-Team-Token'] = tm;
    const ld = ls.get('ews_leader', '');
    if (ld) h['X-Leader-Token'] = ld;
    return h;
  }
  function clearSession() {
    ['ews_token', 'ews_admin', 'ews_team', 'ews_leader', 'ews_team_skip'].forEach((k) => ls.del(k));
  }
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json', ...authHeaders() };
    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error('인터넷 연결을 확인해 주세요.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '오류가 발생했습니다.'), { status: res.status, data });
    return data;
  }

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
    me = await api('/me');
    // 만료/무효가 된 열쇠는 이 기기에서 지운다
    if (!me.isAdmin && ls.get('ews_admin', '')) ls.del('ews_admin');
    if (!me.team) { ls.del('ews_team'); ls.del('ews_leader'); }
    else if (!me.team.isLeader) ls.del('ews_leader');
  }

  // 화면 아래 메뉴: 곡 / 콘티 / 팀 (관리자 PIN이 열려 있으면 관리자)
  function renderNav(hash) {
    const items = [
      ['#/', '곡', hash === '/' || /^\/(song|new|edit|history)/.test(hash)],
      ['#/setlists', '콘티', /^\/setlist/.test(hash)],
      ['#/team', me.team ? '팀' : '팀 가입', hash === '/team'],
    ];
    if (me.isAdmin) items.push(['#/admin', '관리자', hash === '/admin']);
    $nav.innerHTML = items.map(([href, label, on]) => `<a href="${href}" class="${on ? 'on' : ''}">${label}</a>`).join('');
    $nav.hidden = false;
  }

  // ---------- 라우터 ----------
  async function route() {
    const [hash, qs] = (location.hash.replace(/^#/, '') || '/').split('?');
    const q = new URLSearchParams(qs || '');
    window.scrollTo(0, 0);
    document.querySelector('main').classList.remove('wide');
    try {
      if (!ls.get('ews_token', '')) return viewLogin();
      await loadMe();
      $top.hidden = false;
      renderNav(hash);
      // 처음 들어오면 팀 가입 화면부터. ("팀 없이 곡만 보기"를 고르면 건너뜀)
      if (!me.team && ls.get('ews_team_skip', '') !== '1' && hash !== '/team' && hash !== '/admin') {
        location.hash = '#/team';
        return;
      }
      let m;
      if (hash === '/' || hash === '') return await viewList();
      if ((m = /^\/song\/(\d+)$/.exec(hash))) return await viewSong(+m[1], q);
      if (hash === '/new') return viewEdit(null, q);
      if ((m = /^\/history\/(\d+)$/.exec(hash))) return await viewHistory(+m[1]);
      if ((m = /^\/edit\/(\d+)$/.exec(hash))) return await viewEdit(+m[1]);
      if (hash === '/admin') return await viewAdmin();
      if (hash === '/team') return await viewTeam();
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
  const OTHER_KEY = '__other';
  // 추천 목록의 분류별 태그 + 추천에는 없지만 곡에 쓰인 태그("기타"). 쓰이지 않는 추천 태그는 필터에서 뺀다.
  function groupTags(info) {
    const inPreset = new Set(info.presets.flatMap((g) => g.items));
    const groups = info.presets.map((g) => ({ key: g.group, label: g.group, items: g.items.filter((t) => (info.usage[t] || 0) > 0) }));
    groups.push({ key: OTHER_KEY, label: '기타', items: Object.keys(info.usage).filter((t) => !inPreset.has(t)).sort() });
    return groups.filter((g) => g.items.length);
  }
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
  // sel: 분류별로 고른 태그 { 분류이름: 태그 } — 분류 안에서는 하나, 분류끼리는 "그리고"로 좁혀 간다.
  let listState = { q: '', sel: {}, sort: 'title' };
  async function viewList() {
    $app.innerHTML = `
      <div class="row between"><h1>곡 목록</h1>${me.canEdit ? '<a class="btn primary" href="#/new">+ 새 곡</a>' : ''}</div>
      <input type="search" id="q" placeholder="제목 · 가사 · 아티스트 · 태그 검색" value="${esc(listState.q)}">
      <details class="filter" id="filter"><summary id="fsum">분류로 찾기</summary><div id="chips"></div></details>
      ${me.team ? `<div class="row sortrow"><span class="ctl-label">정렬</span><select id="sort" aria-label="정렬"><option value="title">제목순</option><option value="old">오래 안 부른 순</option><option value="recent">최근 부른 순</option></select></div>` : ''}
      <ul class="songs" id="list"></ul>
      <div class="card" id="ext" hidden></div>
      <p class="muted center" id="empty" hidden></p>
      <div class="footer">
        ${me.adminRequired ? `<a href="#/admin">${me.isAdmin ? '관리자 화면' : '관리자'}</a>` : ''}
        <button id="logout">로그아웃</button>
      </div>`;
    const $q = document.getElementById('q');
    const $list = document.getElementById('list');
    const $chips = document.getElementById('chips');
    const $empty = document.getElementById('empty');
    const $ext = document.getElementById('ext');
    const $sort = document.getElementById('sort');
    let songs = [];
    let groups = [];
    if ($sort) $sort.value = listState.sort;

    const selTags = () => Object.values(listState.sel);
    function drawChips() {
      // 고른 태그가 더는 없는 태그면 선택에서 뺀다
      for (const k of Object.keys(listState.sel)) if (!groups.some((g) => g.key === k && g.items.includes(listState.sel[k]))) delete listState.sel[k];
      $chips.innerHTML = groups
        .map(
          (g) => `<div class="chipgroup"><span class="ctl-label">${esc(g.label)}</span><div class="chips">${g.items
            .map((t) => `<button type="button" class="chip ${listState.sel[g.key] === t ? 'on' : ''}" data-g="${esc(g.key)}" data-t="${esc(t)}">${esc(t)}</button>`)
            .join('')}</div></div>`
        )
        .join('');
      const n = selTags().length;
      document.getElementById('fsum').textContent = n ? `분류로 찾기 · ${selTags().join(' + ')}` : '분류로 찾기';
      document.getElementById('filter').hidden = !groups.length;
    }
    function draw() {
      drawChips();
      const want = selTags();
      let shown = songs.filter((s) => {
        const t = (s.tags || '').split(',');
        return want.every((w) => t.includes(w));
      });
      if (me.team && listState.sort !== 'title') {
        // 우리 팀 콘티 기준. 한 번도 안 쓴 곡은 "오래 안 부른" 쪽으로 본다.
        const key = (s) => s.last_used || '';
        shown = [...shown].sort((a, b) => (listState.sort === 'recent' ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b))) || a.title.localeCompare(b.title, 'ko'));
      }
      const anyUsed = songs.some((s) => s.last_used); // 팀 콘티가 아직 없으면 "안 불러 봄" 표시는 생략
      $list.innerHTML = shown
        .map((s) => {
          const used = me.team && anyUsed ? (s.last_used ? `<span class="tag used" title="우리 팀이 가장 최근에 부른 날">최근 ${mmdd(s.last_used)}</span>` : '<span class="tag unused">안 불러 봄</span>') : '';
          return `<li class="song-item"><a href="#/song/${s.id}">
            <div class="song-title">${esc(s.title)}</div>
            <div class="song-meta">${s.original_key ? `<span class="keybadge">${esc(s.original_key)}</span>` : ''}${s.has_chords ? '<span class="tag">코드</span>' : ''}${s.file_count ? `<span class="tag">${(s.file_kinds || '').includes('image') ? '이미지' : 'PDF'}${s.file_count > 1 ? ' ' + s.file_count : ''}</span>` : ''}${s.artist ? `<span>${esc(s.artist)}</span>` : ''}${s.tempo ? `<span>♩${s.tempo}</span>` : ''}${used}${(s.tags ? s.tags.split(',') : []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          </a></li>`;
        })
        .join('');
      $empty.hidden = shown.length > 0;
      if (!shown.length) {
        $empty.textContent = listState.q || want.length ? '찾는 곡이 없습니다.' : me.canEdit ? '아직 등록된 곡이 없습니다. “+ 새 곡”으로 첫 곡을 등록해 보세요.' : '아직 등록된 곡이 없습니다.';
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
      draw();
    }
    let timer;
    $q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { listState.q = $q.value.trim(); load().catch((e) => toast(e.message)); }, 250);
    };
    $chips.onclick = (ev) => {
      const b = ev.target.closest && ev.target.closest('button[data-t]');
      if (!b) return;
      const { g, t } = b.dataset;
      if (listState.sel[g] === t) delete listState.sel[g];
      else listState.sel[g] = t;
      draw();
    };
    if ($sort) $sort.onchange = () => { listState.sort = $sort.value; draw(); };
    document.getElementById('filter').open = selTags().length > 0;
    document.getElementById('logout').onclick = () => {
      clearSession(); route();
    };
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

    const prefs = { size: +ls.get('ews_size', '18'), chords: ls.get('ews_chords', '1') === '1', acc: ls.get('ews_acc', 'auto') };
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

    $app.innerHTML = `
      <div class="row between"><a href="${slId ? '#/setlist/' + slId : '#/'}" class="small">← ${slId ? '콘티' : '목록'}</a>${me.canEdit ? `<span class="row" style="gap:6px"><a class="btn small" href="#/history/${id}">수정 이력</a><a class="btn small" href="#/edit/${id}">편집</a></span>` : ''}</div>
      <h1>${esc(song.title)}</h1>
      <div class="song-meta" style="margin-bottom:8px">
        ${song.artist ? `<span>${esc(song.artist)}</span>` : ''}
        ${hasKey ? `<span>원키 <span class="keybadge">${esc(origKey)}</span>${gk.guessed ? ' (추정)' : ''}</span>` : ''}
        ${song.team_key ? `<span>우리 팀 <span class="keybadge" id="tkbadge">${esc(song.team_key)}</span></span>` : '<span id="tkwrap" hidden>우리 팀 <span class="keybadge" id="tkbadge"></span></span>'}
        ${song.tempo ? `<span>♩${song.tempo}</span>` : ''}
        ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener noreferrer">▶ 유튜브</a>` : ''}
        ${(song.tags ? song.tags.split(',') : []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
      ${usageHTML(song.usage)}
      ${hasText && files.length ? '<div class="tabs" id="tabs"><button class="tab" data-tab="chord">코드 악보</button><button class="tab" data-tab="img">이미지 악보</button></div>' : ''}
      ${!hasText && !files.length ? `<p class="muted">등록된 악보가 아직 없습니다.${me.canEdit ? ' 편집에서 코드 악보를 입력하거나 이미지·PDF를 올려 주세요.' : ''}</p>` : ''}
      <div id="pane-chord">
      <div class="controls">
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
          <button class="btn small" id="fdown">가−</button><button class="btn small" id="fup">가+</button>
          <button class="btn small" id="chtoggle"></button>
        </div>
        <div class="capo-note" id="note"></div>
      </div>
      <div class="score" id="score"></div>
      </div>
      <div id="pane-img" hidden></div>
      ${song.memo ? `<h2>메모</h2><div class="memo">${esc(song.memo)}</div>` : ''}
      <p class="muted small" style="margin-top:20px">키 변경은 이 기기에만 저장됩니다.</p>`;

    const $score = document.getElementById('score');
    const $note = document.getElementById('note');
    const $key = document.getElementById('keysel');
    const $capo = document.getElementById('capo');
    const $acc = document.getElementById('acc');
    const $chtoggle = document.getElementById('chtoggle');
    $capo.value = String(st.capo);
    $acc.value = prefs.acc;

    function draw() {
      document.documentElement.style.setProperty('--song-size', prefs.size + 'px');
      $chtoggle.textContent = prefs.chords ? '코드 숨기기' : '코드 보기';
      const p = Chord.plan(origKey, st.shift, st.capo, prefs.acc);
      $score.innerHTML = Chord.renderHTML(parsed, { originalKey: origKey, shift: st.shift, capo: st.capo, acc: prefs.acc, showChords: prefs.chords });
      if (hasKey) {
        $key.value = p.soundKey;
        $note.textContent = st.capo ? `카포 ${st.capo}프렛 · 실제 키 ${p.soundKey} · ${p.shapeKey} 코드로 연주` : '';
      } else {
        document.getElementById('shiftlbl').textContent = (st.shift > 0 ? '+' : '') + st.shift;
        $note.textContent = '원래 키 정보가 없어 반음 단위로만 표시합니다. 편집에서 키를 입력해 보세요.';
      }
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
        ${me.adminRequired ? '<a class="btn primary" href="#/admin">관리자 PIN 입력</a> ' : '<p class="error">관리자 PIN(ADMIN_PIN)이 설정되어 있지 않아 아무도 편집할 수 없습니다. 설치 안내를 확인해 주세요.</p>'}<a class="btn" href="#/team">팀 화면</a> <a class="btn" href="#/">목록</a></div>`;
      return;
    }
    document.querySelector('main').classList.add('wide');
    let song = { title: '', artist: '', original_key: '', tempo: '', youtube_url: '', tags: '', chordpro: '', memo: '' };
    if (id) song = (await api('/songs/' + id)).song;
    else if (q && q.get('title')) song.title = q.get('title').slice(0, 200); // 목록에서 "새 곡으로 등록"으로 넘어온 검색어
    const tagInfo = await api('/tags');
    document.title = (id ? '편집 · ' + song.title : '새 곡') + ' · Everyday Worship Songbook';
    const keyOptions = ['', ...KEYS_MAJOR, ...KEYS_MINOR];

    $app.innerHTML = `
      <div class="row between"><a href="${id ? '#/song/' + id : '#/'}" class="small">← ${id ? '곡 보기' : '목록'}</a><h2 style="margin:0">${id ? '악보 편집' : '새 곡 등록'}</h2></div>
      <div class="edit-wrap">
        <div>
          <div class="card">
            <label for="title">제목</label><input id="title" type="text" value="${esc(song.title)}">
            <div class="hint" id="extfind" style="margin:6px 0 0"></div>
            <div class="grid2">
              <div><label for="artist">아티스트</label><input id="artist" type="text" value="${esc(song.artist)}"></div>
              <div><label for="key">원래 키</label><select id="key">${keyOptions.map((k) => `<option value="${k}" ${k === song.original_key ? 'selected' : ''}>${k || '(모름)'}</option>`).join('')}</select></div>
              <div><label for="tempo">템포(BPM)</label><input id="tempo" type="number" inputmode="numeric" min="20" max="300" value="${esc(song.tempo || '')}"></div>
            </div>
            <label for="tags">태그 (쉼표로 구분 · 아래 추천 칩을 눌러도 돼요)</label><input id="tags" type="text" placeholder="경배, 빠른곡" value="${esc(song.tags)}">
            <div id="tagchips"></div>
            <label for="yt">유튜브 링크</label><input id="yt" type="url" placeholder="https://" value="${esc(song.youtube_url)}">
            <label for="memo">메모</label><textarea id="memo" rows="2">${esc(song.memo)}</textarea>
          </div>
          <div class="card">
            <label for="cp" style="margin-top:0">악보 본문 (ChordPro)</label>
            <textarea id="cp" class="code" spellcheck="false" placeholder="${esc(SAMPLE)}">${esc(song.chordpro)}</textarea>
            <details>
              <summary>입력 방법 보기</summary>
              <pre class="help">코드는 글자 바로 앞에 [코드] 로 넣습니다.
[G]주님은 [C]나의 [D]목자

{title: 제목}   {key: G}
{comment: 1절}  ← 절/후렴 구분 표시
{soc} … {eoc}   ← 후렴 구간(왼쪽 줄 표시)
[D/F#]  [Am7]  [Csus4]  [?](불확실한 코드)</pre>
            </details>
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
            <a class="btn" href="${id ? '#/song/' + id : '#/'}">취소</a>
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
    $('cp').oninput = preview;
    $('key').onchange = preview;
    preview();

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
      $('tags').value = (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]).join(', ');
      drawTagChips();
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

    async function save(force) {
      const err = $('err');
      err.textContent = '';
      const body = {
        title: $('title').value, artist: $('artist').value, original_key: $('key').value, tempo: $('tempo').value,
        youtube_url: $('yt').value, tags: $('tags').value, chordpro: $('cp').value, memo: $('memo').value, force: !!force,
      };
      const btn = $('save');
      btn.disabled = true;
      try {
        const r = id ? await api('/songs/' + id, { method: 'PUT', body }) : await api('/songs', { method: 'POST', body });
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
        if (e.status === 409 && confirm(`"${e.data.duplicate.title}" 곡이 이미 있습니다.\n그래도 새 곡으로 저장할까요?`)) return save(true);
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
        location.hash = '#/';
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

  // ---------- 팀 ----------
  async function viewTeam() {
    // 팀이 없으면: 가입코드로 입장 / 새 팀 만들기 / 팀 없이 보기
    if (!me.team) {
      $app.innerHTML = `
        <h1>팀 가입</h1>
        <p class="muted">콘티는 팀 단위로 공유됩니다. 팀장에게 받은 <b>가입코드</b>로 입장하세요.</p>
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
        <p><button class="btn" id="skip">팀 없이 곡만 볼게요</button></p>
        <p class="muted small">팀 없이도 곡 목록과 악보는 볼 수 있습니다. 콘티는 팀에 가입해야 볼 수 있어요.</p>`;
      el('jf').onsubmit = async (ev) => {
        ev.preventDefault();
        el('jerr').textContent = '';
        try {
          const r = await api('/teams/join', { method: 'POST', body: { code: el('jc').value } });
          ls.set('ews_team', r.teamToken);
          ls.del('ews_leader');
          ls.del('ews_team_skip');
          toast(`"${r.team.name}" 팀에 입장했습니다.`);
          location.hash = '#/setlists';
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
            ls.set('ews_team', r.teamToken);
            ls.set('ews_leader', r.leaderToken);
            ls.del('ews_team_skip');
            toast(`"${r.team.name}" 팀을 만들었습니다. 가입코드를 팀원에게 알려 주세요.`);
            route();
          } catch (e) {
            el('cerr').textContent = e.message;
          }
        };
      el('skip').onclick = () => {
        ls.set('ews_team_skip', '1');
        location.hash = '#/';
      };
      return;
    }

    const { team } = await api('/team');
    const leader = !!team.isLeader;
    $app.innerHTML = `
      <h1>${esc(team.name)}</h1>
      <p class="muted">${leader ? '팀장으로 로그인되어 있습니다.' : '팀원으로 입장했습니다.'}</p>
      ${
        leader
          ? `<div class="card">
              <h2>팀 가입코드</h2>
              <div class="bigcode" id="jcode">${esc(team.join_code)}</div>
              <div class="row"><button class="btn small" id="cpy">복사</button><button class="btn small danger" id="reissue">재발급</button></div>
              <p class="hint">팀원에게 알려 주세요. 재발급하면 이전 코드는 쓸 수 없고, 기존 팀원은 새 코드로 다시 입장해야 합니다.</p>
            </div>
            <div class="card">
              <h2>악보 편집 권한</h2>
              <p style="margin:0">${team.canEditSongs ? '이 팀 팀장은 악보를 등록·수정할 수 있습니다.' : '이 팀 팀장은 악보를 보기만 할 수 있습니다. (콘티 편집은 가능) 악보 편집이 필요하면 관리자에게 요청해 주세요.'}</p>
            </div>
            <form class="card" id="pf">
              <h2>팀장 PIN 변경</h2>
              <label for="pc" style="margin-top:0">현재 PIN</label><input id="pc" type="password" autocomplete="current-password">
              <label for="pn">새 PIN (4자 이상)</label><input id="pn" type="password" autocomplete="new-password">
              <p class="error" id="perr"></p>
              <p><button class="btn">PIN 변경</button></p>
            </form>
            <p><button class="btn" id="lout">팀장 로그아웃</button></p>`
          : `<form class="card" id="lf">
              <h2>팀장 로그인</h2>
              <label for="lp" style="margin-top:0">팀장 PIN</label><input id="lp" type="password" autocomplete="off">
              <p class="error" id="lerr"></p>
              <p><button class="btn primary">팀장으로 로그인</button></p>
              <p class="hint">콘티를 만들고 고치려면 팀장 PIN이 필요합니다. (이 기기에 30일간 보관됩니다)</p>
            </form>`
      }
      <div class="footer"><button id="leave">이 기기에서 팀 나가기</button></div>`;
    if (leader) {
      el('cpy').onclick = () => copyText(team.join_code);
      el('reissue').onclick = async () => {
        if (!confirm('가입코드를 다시 발급할까요?\n기존 팀원은 새 코드로 다시 입장해야 합니다.')) return;
        try {
          const r = await api('/team/join-code', { method: 'POST' });
          ls.set('ews_team', r.teamToken);
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
          ls.set('ews_leader', r.leaderToken);
          toast('PIN을 바꿨습니다. 다른 기기에서는 새 PIN으로 다시 로그인해야 합니다.');
          route();
        } catch (e) {
          el('perr').textContent = e.message;
        }
      };
      el('lout').onclick = () => {
        ls.del('ews_leader');
        toast('팀장 로그아웃했습니다.');
        route();
      };
    } else {
      el('lf').onsubmit = async (ev) => {
        ev.preventDefault();
        el('lerr').textContent = '';
        try {
          const r = await api('/team/leader-login', { method: 'POST', body: { pin: el('lp').value } });
          ls.set('ews_leader', r.leaderToken);
          toast('팀장으로 로그인했습니다.');
          route();
        } catch (e) {
          el('lerr').textContent = e.message;
        }
      };
    }
    el('leave').onclick = () => {
      if (!confirm('이 기기에서 팀을 나갈까요?\n(다시 들어오려면 가입코드가 필요합니다)')) return;
      ls.del('ews_team');
      ls.del('ews_leader');
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
      <div class="row between"><h1>콘티 · ${esc(me.team.name)}</h1>${canEdit ? '<a class="btn primary" href="#/setlist/new">+ 새 콘티</a>' : ''}</div>
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
      ${canEdit ? '' : '<p class="muted small">콘티를 만들고 고치려면 <a href="#/team">팀 화면</a>에서 팀장 PIN을 입력하세요.</p>'}`;
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
          ${imageOnly ? '<span class="tag">이미지 악보</span>' : it.has_chords ? '<span class="tag">코드 악보</span>' : ''}
          ${it.memo ? `<span>${esc(it.memo)}</span>` : ''}
        </div>
        ${imgKeyNote ? `<div class="hint" style="margin:2px 0 0">이미지 악보는 원래 키(${esc(it.original_key)}) 기준 · 이 콘티에서는 ${esc(it.key)}로 부름</div>` : ''}
      </a></li>`;
    });
    $app.innerHTML = `
      <div class="row between"><a href="#/setlists" class="small">← 콘티 목록</a>${canEdit ? `<a class="btn small" href="#/setlist/${id}/edit">편집</a>` : ''}</div>
      <h1>${esc(s.title)}</h1>
      <div class="song-meta" style="margin-bottom:10px">${s.date ? `<span class="keybadge">${esc(fmtDate(s.date))}</span>` : ''}<span>${s.items.length}곡</span></div>
      ${s.memo ? `<div class="memo" style="margin-bottom:12px">${esc(s.memo)}</div>` : ''}
      ${rows.length ? `<ul class="songs">${rows.join('')}</ul>` : '<p class="muted">아직 곡이 없습니다.</p>'}
      <p class="muted small">곡을 누르면 이 콘티의 키로 악보가 열립니다.</p>`;
  }

  // ---------- 콘티 편집 (팀장) ----------
  async function viewSetlistEdit(id) {
    if (!me.team || !me.team.isLeader) {
      $app.innerHTML = noteBox('<p>콘티는 팀장만 만들고 고칠 수 있습니다.</p><a class="btn primary" href="#/team">팀 화면에서 팀장 로그인</a> <a class="btn" href="#/setlists">콘티 목록</a>');
      return;
    }
    const [songRes, listRes, tagRes] = await Promise.all([api('/songs'), id ? api('/setlists/' + id) : null, api('/tags')]);
    const songs = songRes.songs;
    const pickGroups = groupTags(tagRes);
    const pickSel = {}; // 곡 추가할 때 분류(주제 등)로 좁히기
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
        ${pickGroups.length ? '<details class="filter" id="pfilter"><summary id="pfsum">분류로 찾기</summary><div id="pchips"></div></details>' : ''}
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
            <div class="grid2">${keyUI}${viewUI}
              <div><label>송폼</label><input type="text" data-f="form" data-i="${i}" maxlength="200" placeholder="예: V1-C-V2-C-B-C" value="${esc(it.form)}"></div>
              <div><label>메모</label><input type="text" data-f="memo" data-i="${i}" maxlength="500" placeholder="예: 천천히 시작" value="${esc(it.memo)}"></div>
            </div>
          </div>`;
        })
        .join('');
    }
    // 입력칸은 다시 그리지 않고 값만 저장해서, 타이핑 중에 커서가 튀지 않게 한다.
    const onField = (ev) => {
      const t = ev.target;
      if (t.dataset && t.dataset.f !== undefined && data.items[+t.dataset.i]) data.items[+t.dataset.i][t.dataset.f] = t.value;
    };
    el('items').addEventListener('input', onField);
    el('items').addEventListener('change', onField);
    el('items').onclick = (ev) => {
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

    function drawPickChips() {
      if (!el('pchips')) return;
      el('pchips').innerHTML = pickGroups
        .map((g) => `<div class="chipgroup"><span class="ctl-label">${esc(g.label)}</span><div class="chips">${g.items.map((t) => `<button type="button" class="chip ${pickSel[g.key] === t ? 'on' : ''}" data-g="${esc(g.key)}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`)
        .join('');
      const sel = Object.values(pickSel);
      el('pfsum').textContent = sel.length ? `분류로 찾기 · ${sel.join(' + ')}` : '분류로 찾기';
    }
    if (el('pchips')) {
      el('pchips').onclick = (ev) => {
        const b = ev.target.closest && ev.target.closest('button[data-t]');
        if (!b) return;
        if (pickSel[b.dataset.g] === b.dataset.t) delete pickSel[b.dataset.g];
        else pickSel[b.dataset.g] = b.dataset.t;
        drawPickChips();
        drawResults();
      };
      drawPickChips();
    }
    function drawResults() {
      const q = el('sq').value.trim().toLowerCase();
      const want = Object.values(pickSel);
      const found = songs
        .filter((s) => !q || [s.title, s.artist, s.tags].join(' ').toLowerCase().includes(q))
        .filter((s) => want.every((w) => (s.tags || '').split(',').includes(w)))
        .slice(0, 30);
      const used = {};
      data.items.forEach((it) => (used[it.song_id] = (used[it.song_id] || 0) + 1));
      el('res').innerHTML =
        found
          .map(
            (s) => `<button class="pick" type="button" data-add="${s.id}">
              <span class="song-title">${esc(s.title)}</span>
              <span class="song-meta">${s.original_key ? `<span class="keybadge">${esc(s.original_key)}</span>` : ''}${s.team_key ? `<span>우리 팀 ${esc(s.team_key)}</span>` : ''}${s.last_used ? `<span class="tag used">최근 ${mmdd(s.last_used)}</span>` : ''}${s.has_chords ? '<span class="tag">코드</span>' : ''}${s.file_count ? '<span class="tag">이미지·PDF</span>' : ''}${used[s.id] ? `<span class="tag">✓ 추가됨${used[s.id] > 1 ? ' ×' + used[s.id] : ''}</span>` : ''}</span>
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
        <h1>관리자</h1>
        <form class="card" id="f">
          <label for="pin" style="margin-top:0">관리자 PIN</label>
          <input id="pin" type="password" autocomplete="off" autofocus>
          <p class="error" id="err"></p>
          <div class="row"><button class="btn primary">확인</button><a class="btn" href="#/">취소</a></div>
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
      <h1>관리자</h1>
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
      <form class="card" id="nf">
        <h2>팀 직접 만들기</h2>
        <div class="grid2">
          <div><label for="nn" style="margin-top:0">팀 이름</label><input id="nn" type="text" maxlength="40"></div>
          <div><label for="np" style="margin-top:0">팀장 PIN (4자 이상)</label><input id="np" type="password" autocomplete="new-password"></div>
        </div>
        <p class="error" id="nerr"></p>
        <p><button class="btn">팀 만들기</button></p>
      </form>
      <h2>추천 태그 (주제 · 빠르기 · 절기)</h2>
      <div class="card">
        <p class="hint" style="margin-top:0">곡 편집 화면과 곡 목록 필터에 칩으로 나오는 목록입니다. 곡에는 이 목록에 없는 태그도 자유롭게 쓸 수 있어요. 고친 뒤 <b>추천 목록 저장</b>을 눌러야 반영됩니다.</p>
        <div id="presets"></div>
        <p class="error" id="perr"></p>
        <div class="row"><button class="btn small" id="pnew" type="button">+ 분류 추가</button><button class="btn primary" id="psave" type="button">추천 목록 저장</button></div>
      </div>
      <h2>곡에 쓰인 태그 정리</h2>
      <div class="card">
        <p class="hint" style="margin-top:0">이름을 바꾸면 모든 곡의 태그가 함께 바뀝니다. 이미 있는 태그 이름으로 바꾸면 하나로 합쳐져요.</p>
        <div id="usedtags"></div>
      </div>
      <div class="footer"><button id="aout">관리자 로그아웃</button></div>`;

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
              <div class="row"><input class="gname" type="text" maxlength="12" value="${esc(g.group)}" aria-label="분류 이름"><button class="btn small danger" type="button" data-a="gdel">분류 삭제</button></div>
              <div class="chips">${g.items.map((t, ti) => `<span class="chip on edit">${esc(t)}<button type="button" class="x" data-a="tdel" data-ti="${ti}" aria-label="${esc(t)} 빼기">✕</button></span>`).join('') || '<span class="muted small">비어 있음</span>'}</div>
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
      if (b.dataset.a === 'tdel') { presets[gi].items.splice(+b.dataset.ti, 1); drawPresets(); }
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
})();
