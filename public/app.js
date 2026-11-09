// Everyday Worship Score — 화면 (1차: 접속암호, 곡 목록/보기/편집, 이조)
(function () {
  const $app = document.getElementById('app');
  const $top = document.getElementById('top');
  const $toast = document.getElementById('toast');
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');

  let me = { canEdit: false, adminRequired: false, isAdmin: false };
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($toast.hidden = true), 2600);
  }

  // ---------- API ----------
  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = ls.get('ews_token', '');
    if (t) headers.Authorization = 'Bearer ' + t;
    const a = ls.get('ews_admin', '');
    if (a) headers['X-Admin-Token'] = a;
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
    const headers = { 'Content-Type': type };
    const t = ls.get('ews_token', '');
    if (t) headers.Authorization = 'Bearer ' + t;
    const a = ls.get('ews_admin', '');
    if (a) headers['X-Admin-Token'] = a;
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
    if (!me.isAdmin && ls.get('ews_admin', '')) ls.del('ews_admin'); // 만료/무효 토큰 정리
  }

  // ---------- 라우터 ----------
  async function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    window.scrollTo(0, 0);
    document.querySelector('main').classList.remove('wide');
    try {
      if (!ls.get('ews_token', '')) return viewLogin();
      await loadMe();
      $top.hidden = false;
      let m;
      if (hash === '/' || hash === '') return await viewList();
      if ((m = /^\/song\/(\d+)$/.exec(hash))) return await viewSong(+m[1]);
      if (hash === '/new') return viewEdit(null);
      if ((m = /^\/edit\/(\d+)$/.exec(hash))) return await viewEdit(+m[1]);
      if (hash === '/admin') return viewAdmin();
      location.hash = '#/';
    } catch (e) {
      if (e.status === 401) {
        ls.del('ews_token');
        ls.del('ews_admin');
        return viewLogin('다시 로그인해 주세요.');
      }
      $app.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p><a class="btn" href="#/">처음으로</a></div>`;
    }
  }
  window.addEventListener('hashchange', route);

  // ---------- 로그인 ----------
  function viewLogin(msg) {
    $top.hidden = true;
    $app.innerHTML = `
      <div class="login">
        <h1>Everyday Worship Score</h1>
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

  // ---------- 곡 목록 ----------
  let listState = { q: '', tag: '' };
  async function viewList() {
    $app.innerHTML = `
      <div class="row between"><h1>곡 목록</h1>${me.canEdit ? '<a class="btn primary" href="#/new">+ 새 곡</a>' : ''}</div>
      <input type="search" id="q" placeholder="제목 · 가사 · 아티스트 · 태그 검색" value="${esc(listState.q)}">
      <div class="chips" id="chips"></div>
      <ul class="songs" id="list"></ul>
      <p class="muted center" id="empty" hidden></p>
      <div class="footer">
        ${me.adminRequired ? (me.isAdmin ? '<button id="adm-off">편집 권한 해제</button>' : '<a href="#/admin">편집 권한 입력</a>') : ''}
        <button id="logout">로그아웃</button>
      </div>`;
    const $q = document.getElementById('q');
    const $list = document.getElementById('list');
    const $chips = document.getElementById('chips');
    const $empty = document.getElementById('empty');
    let songs = [];

    function draw() {
      const tags = [...new Set(songs.flatMap((s) => (s.tags ? s.tags.split(',') : [])))].sort();
      $chips.innerHTML = tags.map((t) => `<button class="chip ${t === listState.tag ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('');
      const shown = songs.filter((s) => !listState.tag || (s.tags || '').split(',').includes(listState.tag));
      $list.innerHTML = shown
        .map(
          (s) => `<li class="song-item"><a href="#/song/${s.id}">
            <div class="song-title">${esc(s.title)}</div>
            <div class="song-meta">${s.original_key ? `<span class="keybadge">${esc(s.original_key)}</span>` : ''}${s.has_chords ? '<span class="tag">코드</span>' : ''}${s.file_count ? `<span class="tag">${(s.file_kinds || '').includes('image') ? '이미지' : 'PDF'}${s.file_count > 1 ? ' ' + s.file_count : ''}</span>` : ''}${s.artist ? `<span>${esc(s.artist)}</span>` : ''}${s.tempo ? `<span>♩${s.tempo}</span>` : ''}${(s.tags ? s.tags.split(',') : []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          </a></li>`
        )
        .join('');
      $empty.hidden = shown.length > 0;
      if (!shown.length) {
        $empty.textContent = listState.q || listState.tag ? '찾는 곡이 없습니다.' : me.canEdit ? '아직 등록된 곡이 없습니다. “+ 새 곡”으로 첫 곡을 등록해 보세요.' : '아직 등록된 곡이 없습니다.';
      }
    }
    async function load() {
      const r = await api('/songs?q=' + encodeURIComponent(listState.q));
      songs = r.songs;
      draw();
    }
    let timer;
    $q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { listState.q = $q.value.trim(); load().catch((e) => toast(e.message)); }, 250);
    };
    $chips.onclick = (ev) => {
      const t = ev.target.dataset && ev.target.dataset.t;
      if (t === undefined) return;
      listState.tag = listState.tag === t ? '' : t;
      draw();
    };
    document.getElementById('logout').onclick = () => {
      ls.del('ews_token'); ls.del('ews_admin'); route();
    };
    const off = document.getElementById('adm-off');
    if (off) off.onclick = () => { ls.del('ews_admin'); toast('편집 권한을 해제했습니다.'); route(); };
    await load();
  }

  // ---------- 관리자 PIN ----------
  function viewAdmin() {
    $app.innerHTML = `
      <h1>편집 권한 입력</h1>
      <form class="card" id="f">
        <label for="pin">관리자 PIN</label>
        <input id="pin" type="password" autocomplete="off" autofocus>
        <p class="error" id="err"></p>
        <div class="row"><button class="btn primary">확인</button><a class="btn" href="#/">취소</a></div>
      </form>
      <p class="muted small">악보를 등록·수정·삭제하려면 관리자 PIN이 필요합니다. (이 기기에 30일간 보관됩니다)</p>`;
    document.getElementById('f').onsubmit = async (ev) => {
      ev.preventDefault();
      try {
        const r = await api('/admin', { method: 'POST', body: { pin: document.getElementById('pin').value } });
        ls.set('ews_admin', r.adminToken);
        toast('편집 권한이 열렸습니다.');
        location.hash = '#/';
      } catch (e) {
        document.getElementById('err').textContent = e.message;
      }
    };
  }

  // ---------- 곡 보기 ----------
  const KEYS_MAJOR = Chord.MAJOR_NAMES;
  const KEYS_MINOR = Chord.MINOR_NAMES.map((n) => n + 'm');
  async function viewSong(id) {
    const { song } = await api('/songs/' + id);
    document.title = song.title + ' · Everyday Worship Score';
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

    $app.innerHTML = `
      <div class="row between"><a href="#/" class="small">← 목록</a>${me.canEdit ? `<a class="btn small" href="#/edit/${id}">편집</a>` : ''}</div>
      <h1>${esc(song.title)}</h1>
      <div class="song-meta" style="margin-bottom:8px">
        ${song.artist ? `<span>${esc(song.artist)}</span>` : ''}
        ${hasKey ? `<span>원키 <span class="keybadge">${esc(origKey)}</span>${gk.guessed ? ' (추정)' : ''}</span>` : ''}
        ${song.tempo ? `<span>♩${song.tempo}</span>` : ''}
        ${yt ? `<a href="${esc(yt)}" target="_blank" rel="noopener noreferrer">▶ 유튜브</a>` : ''}
        ${(song.tags ? song.tags.split(',') : []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </div>
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
      ls.set('ews_song_' + id, JSON.stringify(st));
    }
    const wrap = (n) => ((n % 12) + 12) % 12;
    const setShift = (n) => { st.shift = wrap(n); if (!hasKey) st.shift = Math.max(-11, Math.min(11, n)); draw(); };
    document.getElementById('up').onclick = () => setShift(st.shift + 1);
    document.getElementById('down').onclick = () => setShift(st.shift - 1);
    document.getElementById('reset').onclick = () => { st.shift = 0; st.capo = 0; $capo.value = '0'; draw(); };
    if ($key) $key.onchange = () => {
      // 목록은 C부터 반음 순서 → 인덱스가 곧 음높이
      setShift(keyList.indexOf($key.value) - kobj.idx);
    };
    $capo.onchange = () => { st.capo = +$capo.value; draw(); };
    $acc.onchange = () => { prefs.acc = $acc.value; ls.set('ews_acc', prefs.acc); draw(); };
    document.getElementById('fup').onclick = () => { prefs.size = Math.min(40, prefs.size + 2); ls.set('ews_size', prefs.size); draw(); };
    document.getElementById('fdown').onclick = () => { prefs.size = Math.max(12, prefs.size - 2); ls.set('ews_size', prefs.size); draw(); };
    $chtoggle.onclick = () => { prefs.chords = !prefs.chords; ls.set('ews_chords', prefs.chords ? '1' : '0'); draw(); };
    draw();

    // 코드 악보 / 이미지 악보 전환 (둘 다 있을 때만 탭 표시, 선택은 이 기기에 기억)
    const $pc = document.getElementById('pane-chord');
    const $pi = document.getElementById('pane-img');
    $pi.innerHTML = Files.renderPane(files);
    Files.bindPane($pi, files);
    function showTab(t) {
      $pc.hidden = t !== 'chord';
      $pi.hidden = t !== 'img';
      document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      if (hasText && files.length) ls.set('ews_tab_' + id, t);
    }
    const $tabs = document.getElementById('tabs');
    if ($tabs) $tabs.onclick = (ev) => ev.target.dataset.tab && showTab(ev.target.dataset.tab);
    showTab(hasText && !(files.length && ls.get('ews_tab_' + id, '') === 'img') ? 'chord' : files.length ? 'img' : 'chord');
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

  async function viewEdit(id) {
    if (!me.canEdit) {
      $app.innerHTML = `<div class="card"><p>악보를 편집하려면 관리자 PIN이 필요합니다.</p><a class="btn primary" href="#/admin">편집 권한 입력</a> <a class="btn" href="#/">목록</a></div>`;
      return;
    }
    document.querySelector('main').classList.add('wide');
    let song = { title: '', artist: '', original_key: '', tempo: '', youtube_url: '', tags: '', chordpro: '', memo: '' };
    if (id) song = (await api('/songs/' + id)).song;
    document.title = (id ? '편집 · ' + song.title : '새 곡') + ' · Everyday Worship Score';
    const keyOptions = ['', ...KEYS_MAJOR, ...KEYS_MINOR];

    $app.innerHTML = `
      <div class="row between"><a href="${id ? '#/song/' + id : '#/'}" class="small">← ${id ? '곡 보기' : '목록'}</a><h2 style="margin:0">${id ? '악보 편집' : '새 곡 등록'}</h2></div>
      <div class="edit-wrap">
        <div>
          <div class="card">
            <label for="title">제목</label><input id="title" type="text" value="${esc(song.title)}">
            <div class="grid2">
              <div><label for="artist">아티스트</label><input id="artist" type="text" value="${esc(song.artist)}"></div>
              <div><label for="key">원래 키</label><select id="key">${keyOptions.map((k) => `<option value="${k}" ${k === song.original_key ? 'selected' : ''}>${k || '(모름)'}</option>`).join('')}</select></div>
              <div><label for="tempo">템포(BPM)</label><input id="tempo" type="number" inputmode="numeric" min="20" max="300" value="${esc(song.tempo || '')}"></div>
              <div><label for="tags">태그 (쉼표로 구분)</label><input id="tags" type="text" placeholder="경배, 빠른곡" value="${esc(song.tags)}"></div>
            </div>
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

  route();
})();
