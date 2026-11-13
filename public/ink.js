// Everyday Worship Songbook — 이미지 악보 필기 + 개인 보관함 (15차)
// · 필기는 "그림 한 장의 가로·세로를 0~10000으로 나눈 좌표"로 저장한다 → 화면 크기·확대·회전과 무관.
// · 먼저 이 기기(IndexedDB)에 저장하고, 개인 보관함에 연결돼 있으면 서버와 맞춘다(인터넷이 없어도 쓸 수 있다).
// · 기기 두 대에서 같은 장을 고쳐도 지운 것은 지운 채로, 새로 쓴 것은 합쳐서 남긴다(mergeInk).
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const MAX_ITEMS = 3000;
  const MAX_BYTES = 380000;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  let cfg = { headers: () => ({}), toast: () => {}, teamId: () => 0 };
  const emit = (fileId) => window.dispatchEvent(new CustomEvent('ews-ink', { detail: { fileId } }));
  const emptyData = () => ({ v: 1, items: [], del: [] });
  // 콘티용 필기(16차): 콘티의 곡 한 칸(uid) + 악보 한 장(fid)마다 따로 저장한다. 같은 저장소에 문자열 키로 넣는다.
  const slKey = (u, fid) => `sl:${u}:${fid}`;
  // 30차: 코드 악보 필기는 곡(songId)마다 하나, 콘티용은 콘티 칸(uid)마다 하나. 서버에서는 file_id = -곡번호로 저장된다.
  const codeKeyOf = (songId, sl) => 'cs:' + songId + (sl ? ':' + sl.uid : '');
  const slMeta = (sl, fid) => (sl ? { sl: sl.uid, fid, setlistId: sl.setlistId } : {});

  // ---------- 이 기기 저장소 (IndexedDB, 안 되면 메모리) ----------
  let dbp = null;
  const mem = new Map();
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res) => {
      try {
        const r = indexedDB.open('ews-ink', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('pages', { keyPath: 'fileId' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
      } catch { res(null); }
    });
    return dbp;
  }
  async function rget(fid) {
    const db = await idb();
    if (!db) return mem.get(fid) || null;
    return new Promise((res) => {
      try { const q = db.transaction('pages').objectStore('pages').get(fid); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); }
    });
  }
  async function rput(rec) {
    const db = await idb();
    if (!db) { mem.set(rec.fileId, rec); return; }
    return new Promise((res) => {
      try { const tx = db.transaction('pages', 'readwrite'); tx.objectStore('pages').put(rec); tx.oncomplete = tx.onerror = tx.onabort = () => res(); } catch { mem.set(rec.fileId, rec); res(); }
    });
  }
  async function rdel(fid) {
    const db = await idb();
    mem.delete(fid);
    if (!db) return;
    return new Promise((res) => {
      try { const tx = db.transaction('pages', 'readwrite'); tx.objectStore('pages').delete(fid); tx.oncomplete = tx.onerror = tx.onabort = () => res(); } catch { res(); }
    });
  }
  async function rall() {
    const db = await idb();
    if (!db) return [...mem.values()];
    return new Promise((res) => {
      try { const q = db.transaction('pages').objectStore('pages').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch { res([]); }
    });
  }
  async function rclear() {
    const db = await idb();
    mem.clear();
    if (!db) return;
    return new Promise((res) => {
      try { const tx = db.transaction('pages', 'readwrite'); tx.objectStore('pages').clear(); tx.oncomplete = tx.onerror = tx.onabort = () => res(); } catch { res(); }
    });
  }

  // 서버와 같은 규칙으로 합친다(a=먼저 있던 것, b=새로 온 것)
  function mergeInk(a, b) {
    const del = new Set([...((a && a.del) || []), ...((b && b.del) || [])]);
    const map = new Map();
    for (const it of [...((a && a.items) || []), ...((b && b.items) || [])]) if (!del.has(it.id)) map.set(it.id, it);
    return { v: 1, items: [...map.values()].slice(0, MAX_ITEMS), del: [...del].slice(-2000) };
  }

  // ---------- 개인 보관함 (서버 연결) ----------
  const vget = () => { try { return JSON.parse(ls.get('ews_vault', 'null')); } catch { return null; } };
  const hasVault = () => !!(vget() && vget().token);
  async function vfetch(path, { method = 'GET', body, noToken } = {}) {
    const headers = { 'Content-Type': 'application/json', ...cfg.headers() };
    const v = vget();
    if (v && v.token && !noToken) headers['X-Vault-Token'] = v.token;
    const res = await fetch('/api/vault' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '오류가 발생했습니다.'), { status: res.status, data });
    return data;
  }
  let flushing = false;
  let warned = false;
  // 서버에 아직 못 올린(dirty) 장을 올린다. 인터넷이 없으면 조용히 다음 기회로 미룬다.
  async function flush() {
    if (flushing || !hasVault() || navigator.onLine === false) return;
    flushing = true;
    try {
      const all = await rall();
      for (const rec of all.filter((r) => r.dirty)) {
        try {
          const r = rec.code
            ? await vfetch('/cink/' + rec.songId + (rec.sl ? '/' + rec.sl : ''), { method: 'PUT', body: { base_rev: rec.rev || 0, data: rec.data } })
            : rec.sl
            ? await vfetch('/ink-sl/' + rec.sl + '/' + rec.fid, { method: 'PUT', body: { base_rev: rec.rev || 0, data: rec.data } })
            : await vfetch('/ink/' + rec.fileId, { method: 'PUT', body: { song_id: rec.songId, base_rev: rec.rev || 0, data: rec.data } });
          const cur = await rget(rec.fileId);
          if (cur && cur.stamp !== rec.stamp) {
            // 올리는 사이에 또 고쳤다: 서버에서 합쳐진 것과 내 최신본을 다시 합쳐 두고, 다음 번에 마저 올린다
            await rput({ ...cur, rev: r.rev, data: mergeInk(r.data, cur.data) });
          } else {
            await rput({ ...rec, rev: r.rev, data: r.data, dirty: false, stamp: rec.stamp });
            if (JSON.stringify(r.data) !== JSON.stringify(rec.data)) emit(rec.fileId);
          }
        } catch (e) {
          if (e.status === 404) await rdel(rec.fileId); // 악보 이미지가 지워진 장
          else if (e.status === 413 || e.status === 400) {
            await rput({ ...rec, dirty: false, err: e.message });
            cfg.toast(e.message);
          } else {
            if (e.status === 401 && !warned) { warned = true; cfg.toast('필기 보관함 연결이 풀렸어요. 더보기에서 코드를 다시 입력해 주세요.'); }
            break;
          }
        }
      }
    } finally { flushing = false; }
  }
  // 곡을 열 때 서버의 필기를 받아 이 기기 것과 맞춘다
  async function pull(songId) {
    if (!hasVault()) return;
    try {
      const r = await vfetch('/ink?song=' + encodeURIComponent(songId));
      for (const it of r.items || []) {
        const key = it.file_id < 0 ? codeKeyOf(it.song_id) : it.file_id; // 30차: file_id가 음수면 코드 악보 필기
        const cur = await rget(key);
        if (cur && (cur.dirty || cur.rev === it.rev)) continue;
        await rput({ fileId: key, songId: it.song_id, rev: it.rev, data: it.data, dirty: false, stamp: 0, ...(it.file_id < 0 ? { code: 1 } : {}) });
        emit(key);
      }
    } catch (e) {
      if (e.status === 401 && !warned) { warned = true; cfg.toast('필기 보관함 연결이 풀렸어요. 더보기에서 코드를 다시 입력해 주세요.'); }
    }
    flush();
  }
  // 콘티를 열 때: 그 콘티의 콘티용 필기를 받아 이 기기 것과 맞춘다
  async function pullSetlist(setlistId) {
    if (!hasVault()) return;
    try {
      const r = await vfetch('/ink-sl?setlist=' + encodeURIComponent(setlistId));
      for (const it of r.items || []) {
        const key = it.file_id < 0 ? codeKeyOf(it.song_id, { uid: it.uid }) : slKey(it.uid, it.file_id);
        const cur = await rget(key);
        if (cur && (cur.dirty || cur.rev === it.rev)) continue;
        await rput({ fileId: key, sl: it.uid, fid: it.file_id, setlistId: it.setlist_id, songId: it.song_id, rev: it.rev, data: it.data, dirty: false, stamp: 0, ...(it.file_id < 0 ? { code: 1 } : {}) });
        emit(key);
      }
    } catch (e) {
      if (e.status === 401 && !warned) { warned = true; cfg.toast('필기 보관함 연결이 풀렸어요. 더보기에서 코드를 다시 입력해 주세요.'); }
    }
    flush();
  }
  async function get(fileId) {
    const rec = await rget(fileId);
    return rec ? rec.data : null;
  }
  async function save(fileId, songId, data, meta) {
    const cur = await rget(fileId);
    await rput({ ...(cur && cur.sl ? { sl: cur.sl, fid: cur.fid, setlistId: cur.setlistId } : {}), ...(meta || {}), fileId, songId, rev: cur ? cur.rev || 0 : 0, data, dirty: true, stamp: Date.now() + Math.random() });
    emit(fileId);
    flush();
  }
  // 보관함을 처음 연결할 때: 서버에 있던 필기를 받아 합치고, 이 기기에 쌓인 필기를 모두 올린다
  async function adoptServerNotes() {
    const r = await vfetch('/ink');
    const sKey = (it) => (it.file_id < 0 ? codeKeyOf(it.song_id) : it.file_id);
    const sMeta = (it) => (it.file_id < 0 ? { code: 1 } : {});
    const lKey = (it) => (it.file_id < 0 ? codeKeyOf(it.song_id, { uid: it.uid }) : slKey(it.uid, it.file_id));
    for (const it of r.items || []) {
      const cur = await rget(sKey(it));
      if (!cur) await rput({ fileId: sKey(it), songId: it.song_id, rev: it.rev, data: it.data, dirty: false, stamp: 0, ...sMeta(it) });
      else await rput({ ...cur, rev: it.rev, data: mergeInk(it.data, cur.data), dirty: true, stamp: Date.now() + Math.random() });
      emit(sKey(it));
    }
    const r2 = await vfetch('/ink-sl');
    for (const it of r2.items || []) {
      const key = lKey(it);
      const cur = await rget(key);
      const meta = { sl: it.uid, fid: it.file_id, setlistId: it.setlist_id, songId: it.song_id, ...sMeta(it) };
      if (!cur) await rput({ fileId: key, ...meta, rev: it.rev, data: it.data, dirty: false, stamp: 0 });
      else await rput({ ...cur, rev: it.rev, data: mergeInk(it.data, cur.data), dirty: true, stamp: Date.now() + Math.random() });
      emit(key);
    }
    const all = await rall();
    for (const rec of all) {
      const onServer = rec.sl ? (r2.items || []).some((i) => lKey(i) === rec.fileId) : (r.items || []).some((i) => sKey(i) === rec.fileId);
      if (!rec.dirty && !onServer) await rput({ ...rec, rev: 0, dirty: true, stamp: Date.now() + Math.random() });
    }
    await flush();
  }
  async function vaultCreate() {
    const r = await vfetch('/', { method: 'POST', body: {}, noToken: true });
    ls.set('ews_vault', JSON.stringify({ token: r.token, code: r.code }));
    warned = false;
    await adoptServerNotes();
    return r.code;
  }
  async function vaultJoin(code) {
    const r = await vfetch('/join', { method: 'POST', body: { code }, noToken: true });
    ls.set('ews_vault', JSON.stringify({ token: r.token, code: String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-') }));
    warned = false;
    await adoptServerNotes();
  }
  // 이 기기에서만 연결 해제(서버의 필기는 그대로, 이 기기의 필기도 그대로)
  function vaultLeave() { ls.del('ews_vault'); }
  async function vaultDeleteServer() {
    await vfetch('/', { method: 'DELETE' });
    ls.del('ews_vault');
  }
  async function wipeLocal() {
    ls.del('ews_vault');
    await rclear();
    sh.rows = [];
    shSave();
  }


  // ---------- 팀 공유 필기 (31차) ----------
  // 팀장이 올린 필기를 팀원이 읽기 전용으로 겹쳐 본다. 내 필기(개인 보관함)와는 따로 저장되고, 서버 표는 annotations.
  //  · 한 덩어리 = (콘티 칸 uid 또는 '', 악보 장 fid(코드 악보는 -곡번호), 올린 사람 author). 팀장이 다시 올리면 통째로 바뀐다.
  //  · 이 기기에는 마지막으로 받은 것을 저장해 두어(오프라인에서도 보임), 곡·콘티를 열 때마다 새로 받아 바꾼다.
  //  · 보기 켜기/끄기(이 기기 전체)와 올린 사람별 숨기기는 이 기기에만 기억한다. 내가 올린 것은 내 필기 층이 이미 보이므로 겹쳐 그리지 않는다.
  const SH_COLORS = ['#0ea5e9', '#a855f7', '#f97316', '#10b981'];
  const sh = { rows: [], on: ls.get('ews_shared_on', '1') !== '0', off: new Set() };
  try { sh.off = new Set(JSON.parse(ls.get('ews_shared_off', '[]'))); } catch {}
  const shMe = () => {
    let a = ls.get('ews_author', '');
    if (!/^[0-9a-f]{12}$/.test(a)) {
      a = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
      ls.set('ews_author', a);
    }
    return a;
  };
  const emitShared = () => window.dispatchEvent(new CustomEvent('ews-shared'));
  let shdbp = null;
  function shdb() {
    if (shdbp) return shdbp;
    shdbp = new Promise((res) => {
      try {
        const r = indexedDB.open('ews-ink-sh', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('rows', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = r.onblocked = () => res(null);
      } catch { res(null); }
    });
    return shdbp;
  }
  async function shSave() {
    const db = await shdb();
    if (!db) return;
    return new Promise((res) => {
      try {
        const tx = db.transaction('rows', 'readwrite');
        const st = tx.objectStore('rows');
        st.clear();
        sh.rows.forEach((r) => st.put(r));
        tx.oncomplete = tx.onerror = tx.onabort = () => res();
      } catch { res(); }
    });
  }
  async function shLoad() {
    const db = await shdb();
    if (!db) return;
    const rows = await new Promise((res) => { try { const q = db.transaction('rows').objectStore('rows').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); } catch { res([]); } });
    if (rows.length && !sh.rows.length) { sh.rows = rows; emitShared(); }
  }
  async function sfetch(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...cfg.headers() }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '오류가 발생했습니다.'), { status: res.status });
    return data;
  }
  const hasTeamKey = () => !!cfg.headers()['X-Team-Token'];
  // 곡(songId)·콘티(setlistId)를 열 때 그 팀의 공유 필기를 받아 이 기기 것을 바꾼다. 실패(오프라인 등)하면 저장해 둔 것을 그대로 쓴다.
  async function pullShared({ songId, setlistId } = {}) {
    if (!hasTeamKey() || navigator.onLine === false || (!songId && !setlistId)) return;
    try {
      const qs = [songId ? 'song=' + encodeURIComponent(songId) : '', setlistId ? 'setlist=' + encodeURIComponent(setlistId) : ''].filter(Boolean).join('&');
      const r = await sfetch('/shared?' + qs);
      const old = JSON.stringify(sh.rows);
      const tid = cfg.teamId();
      sh.rows = sh.rows.filter((x) => !(x.team_id === tid && ((songId && x.song_id === +songId) || (setlistId && x.setlist_id === +setlistId))));
      for (const it of r.items || []) { sh.rows = sh.rows.filter((x) => x.id !== it.id); sh.rows.push(it); }
      if (JSON.stringify(sh.rows) !== old) { shSave(); emitShared(); }
    } catch (e) { /* 팀에 없거나 오프라인이면 조용히 */ }
  }
  // 이 악보 장(fid, 코드 악보는 -곡번호)에 보일 공유 행: 곡 기본(uid '')과, 콘티에서 열었으면 그 콘티 칸의 것
  function shRowsFor(fid, sl) {
    if (!sh.on) return [];
    const me = ls.get('ews_author', '');
    const tid = cfg.teamId();
    return sh.rows
      .filter((r) => r.team_id === tid && r.file_id === fid && (r.uid === '' || (sl && r.uid === sl.uid)) && !sh.off.has(r.author) && r.author !== me)
      .sort((a, b) => a.id - b.id);
  }
  const shAuthors = () => {
    const first = new Map();
    for (const r of sh.rows.filter((x) => x.team_id === cfg.teamId())) if (!first.has(r.author) || r.id < first.get(r.author).id) first.set(r.author, { id: r.id, name: r.name });
    return [...first.entries()].sort((a, b) => a[1].id - b[1].id).map(([author, v], i) => ({ author, name: v.name, color: SH_COLORS[i % SH_COLORS.length], off: sh.off.has(author), mine: author === ls.get('ews_author', '') }));
  };
  // 공유 행들을 그림으로: 올린 사람이 둘 이상 겹쳐 보이면 사람마다 윤곽색을 달리해 구분한다
  function shSVG(rows, W, H, ow) {
    if (!rows.length) return '';
    const cols = new Map(shAuthors().map((a) => [a.author, a.color]));
    const multi = new Set(rows.map((r) => r.author)).size > 1;
    return `<g class="sh-layer">${rows.map((r) => (r.data && r.data.items ? r.data.items.map((it) => itemSVG(it, W, H, multi ? { c: cols.get(r.author) || '#0ea5e9', w: ow || 3 } : null)).join('') : '')).join('')}</g>`;
  }
  function shSetOn(on) { sh.on = !!on; ls.set('ews_shared_on', on ? '1' : '0'); emitShared(); }
  function shToggleAuthor(author) { if (sh.off.has(author)) sh.off.delete(author); else sh.off.add(author); ls.set('ews_shared_off', JSON.stringify([...sh.off])); emitShared(); }
  // 팀장: 내 필기(이 기기에 있는 것)를 팀에 올린다 / 내린다. target = { songId, fileId(코드 악보는 -곡번호), uid? }
  const shKeyOf = (t) => (t.fileId < 0 ? codeKeyOf(t.songId, t.uid ? { uid: t.uid } : null) : t.uid ? slKey(t.uid, t.fileId) : t.fileId);
  async function shMyCount(t) {
    const rec = await rget(shKeyOf(t));
    return rec && rec.data && rec.data.items ? rec.data.items.length : 0;
  }
  async function shUp(t, name) {
    const rec = await rget(shKeyOf(t));
    const items = rec && rec.data && rec.data.items ? rec.data.items : [];
    const path = t.uid ? `/shared/slot/${t.uid}/${t.fileId}` : `/shared/song/${t.songId}/${t.fileId}`;
    const r = await sfetch(path, { method: 'PUT', body: { author: shMe(), name: name || '팀장', data: { v: 1, items, del: [] } } });
    await pullShared({ songId: t.songId, setlistId: t.setlistId });
    return r;
  }
  async function shDown(id) {
    await sfetch('/shared/' + id + '?author=' + shMe(), { method: 'DELETE' });
    sh.rows = sh.rows.filter((r) => r.id !== id);
    shSave();
    emitShared();
  }

  // ---------- 그리기 도우미 ----------
  // 획을 "선 긋기(stroke)"가 아니라 채운 모양(fill)으로 그린다.
  // 아이패드 사파리는 점이 많은 곡선을 stroke로 그으면 곳곳에 하얀 틈이 생겨서, 같은 굵기의 채운 모양으로 대신한다.
  function strokeD(p, W, H, wd) {
    const n = p.length / 2;
    const r = Math.max(wd, 0.2) / 2;
    const X = (i) => (p[i * 2] / 10000) * W;
    const Y = (i) => (p[i * 2 + 1] / 10000) * H;
    const pts = [[X(0), Y(0)]];
    const push = (x, y) => { const l = pts[pts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) >= 0.25) pts.push([x, y]); };
    for (let i = 1; i < n - 1; i++) {
      const sx = i === 1 ? X(0) : (X(i - 1) + X(i)) / 2, sy = i === 1 ? Y(0) : (Y(i - 1) + Y(i)) / 2;
      const cx = X(i), cy = Y(i), ex = (X(i) + X(i + 1)) / 2, ey = (Y(i) + Y(i + 1)) / 2;
      for (let k = 1; k <= 3; k++) {
        const t = k / 3, u = 1 - t;
        push(u * u * sx + 2 * u * t * cx + t * t * ex, u * u * sy + 2 * u * t * cy + t * t * ey);
      }
    }
    if (n > 1) push(X(n - 1), Y(n - 1));
    const f = (v) => v.toFixed(2);
    const dot = (x, y) => `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`;
    let d = dot(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / len) * r, ny = ((x1 - x0) / len) * r;
      d += `M${f(x0 + nx)} ${f(y0 + ny)}L${f(x1 + nx)} ${f(y1 + ny)}L${f(x1 - nx)} ${f(y1 - ny)}L${f(x0 - nx)} ${f(y0 - ny)}z` + dot(x1, y1);
    }
    return d;
  }
  function pathD(p, W, H) {
    const X = (i) => (p[i] / 10000) * W;
    const Y = (i) => (p[i + 1] / 10000) * H;
    const n = p.length / 2;
    if (n === 1) return `M${X(0).toFixed(1)} ${Y(0).toFixed(1)}l.01 0`;
    let d = `M${X(0).toFixed(1)} ${Y(0).toFixed(1)}`;
    for (let i = 1; i < n - 1; i++) {
      const x = X(i * 2), y = Y(i * 2), mx = (x + X(i * 2 + 2)) / 2, my = (y + Y(i * 2 + 2)) / 2;
      d += `Q${x.toFixed(1)} ${y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    return d + `L${X((n - 1) * 2).toFixed(1)} ${Y((n - 1) * 2).toFixed(1)}`;
  }
  function itemSVG(it, W, H, ol) {
    if (it.t === 'x') {
      const fs = (it.z / 10000) * W;
      const lines = String(it.s).split('\n');
      const x = (it.x / 10000) * W;
      const y = (it.y / 10000) * H + fs * 0.85;
      return `<text class="itx" x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${it.c}" stroke-width="${(fs * 0.18).toFixed(1)}"${ol ? ` style="stroke:${ol.c}"` : ''}>${lines
        .map((l, i) => `<tspan x="${x.toFixed(1)}" dy="${i ? '1.25em' : '0'}">${esc(l) || ' '}</tspan>`)
        .join('')}</text>`;
    }
    const hl = it.t === 'h';
    return `<path d="${strokeD(it.p, W, H, it.w / 10)}" fill="${it.c}" ${ol ? `stroke="${ol.c}" stroke-width="${ol.w}" stroke-opacity=".6" stroke-linejoin="round"` : 'stroke="none"'}${hl ? ' class="hl"' : ''}/>`;
  }
  const dataSVG = (data, W, H) => ((data && data.items) || []).map((it) => itemSVG(it, W, H)).join('');

  // Douglas-Peucker: 점을 줄여 저장 크기를 줄인다 (좌표는 0~10000, y는 그림 비율을 곱해 가로와 같은 눈금으로 잰다)
  function simplify(pts, ratio, eps) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let dmax = 0, idx = -1;
      const ax = pts[a][0], ay = pts[a][1] * ratio, bx = pts[b][0], by = pts[b][1] * ratio;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] * ratio + bx * ay - by * ax) / len;
        if (d > dmax) { dmax = d; idx = i; }
      }
      if (dmax > eps && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ---------- 악보 위에 보이기만 하는 필기 층 (곡 보기·연주 모드) ----------
  const overlays = new Set();
  // sl = { uid, setlistId } 이면 곡 기본 필기 위에 콘티용 필기를 겹쳐 보인다
  function attachImg(img, fileId, sl) {
    if (!img || !fileId || img.dataset.inkOn) return;
    const host = img.parentElement;
    if (!host) return;
    img.dataset.inkOn = '1';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ink-ov');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
    host.appendChild(svg);
    const o = { img, svg, fileId, sl, slKey: sl ? slKey(sl.uid, fileId) : '', data: null, sdata: null };
    o.place = () => {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      if (!nw || !nh) return;
      const bw = img.clientWidth, bh = img.clientHeight;
      const s = Math.min(bw / nw, bh / nh);
      const w = nw * s, h = nh * s;
      svg.style.left = img.offsetLeft + img.clientLeft + (bw - w) / 2 + 'px';
      svg.style.top = img.offsetTop + img.clientTop + (bh - h) / 2 + 'px';
      svg.style.width = w + 'px';
      svg.style.height = h + 'px';
      const H = (1000 * nh) / nw;
      svg.setAttribute('viewBox', `0 0 1000 ${H.toFixed(1)}`);
      o.H = H;
      svg.innerHTML = shSVG(shRowsFor(fileId, sl), 1000, H) + dataSVG(o.data, 1000, H) + dataSVG(o.sdata, 1000, H);
    };
    o.load = () => Promise.all([rget(fileId), o.slKey ? rget(o.slKey) : null]).then(([rec, srec]) => { o.data = rec ? rec.data : null; o.sdata = srec ? srec.data : null; o.place(); });
    overlays.add(o);
    img.addEventListener('load', o.place);
    try { o.ro = new ResizeObserver(o.place); o.ro.observe(img); } catch {}
    o.load();
  }
  window.addEventListener('ews-ink', (e) => {
    for (const o of [...overlays]) {
      if (!o.svg.isConnected) { overlays.delete(o); try { o.ro && o.ro.disconnect(); } catch {} continue; }
      if (o.fileId === e.detail.fileId || (o.slKey && o.slKey === e.detail.fileId)) o.load();
    }
  });
  window.addEventListener('resize', () => overlays.forEach((o) => o.svg.isConnected && o.place()));
  window.addEventListener('ews-shared', () => overlays.forEach((o) => o.svg.isConnected && o.place()));
  // 곡 보기 화면: root 안의 이미지 악보(img.sheet)에 차례대로 필기 층을 붙인다
  function decorate(root, files, sl) {
    const imgs = (files || []).filter((f) => f.kind === 'image');
    root.querySelectorAll('img.sheet').forEach((im, i) => imgs[i] && attachImg(im, imgs[i].id, sl));
  }

  // ---------- 필기 화면 (전체 화면) ----------
  const PEN_COLORS = ['#222222', '#d62828', '#1d4ed8', '#15803d'];
  const HL_COLORS = ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'];
  const WIDTHS = { pen: [25, 45, 80], hl: [150, 250, 400] };
  const TEXT_SIZES = [250, 380, 560];
  const MAX_ZOOM = 6;
  const DEFAULTS = { pen: { c: PEN_COLORS[0], w: 1 }, hl: { c: HL_COLORS[0], w: 1 }, tx: { c: PEN_COLORS[1], z: 1 } };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 확대·이동은 브라우저에 맡기지 않고 직접 처리한다(브라우저가 맡으면 펜슬 획이 끊기고, 확대하면 화면 전체가 커져 도구 줄이 밀려난다).
  //  펜슬·마우스 = 쓰기 / 손가락 한 개 = 쓰기(☝ 켬) 또는 이동(☝ 끔) / 손가락 두 개 = 항상 확대·이동
  function edit({ files, start = 0, songId, title = '', onClose, sl }) {
    const pages = (files || []).filter((f) => f.kind === 'image');
    if (!pages.length) return cfg.toast('필기할 이미지 악보가 없어요. (PDF 악보에는 쓸 수 없습니다)');
    let opts;
    try { opts = { ...DEFAULTS, ...JSON.parse(ls.get('ews_ink_opts', '{}')) }; } catch { opts = { ...DEFAULTS }; }
    let finger = ls.get('ews_ink_finger', '1') === '1';
    let tool = 'pen';
    let page = Math.max(0, Math.min(pages.length - 1, start));
    let ratio = 1.4;
    let items = [];
    let del = new Set();
    let undo = [];
    let redo = [];
    let timer = null;
    let active = null;
    let txtEdit = null;
    let bw = 300, bh = 420;
    const view = { s: 1, x: 0, y: 0 };
    const keyOf = (i) => (sl ? slKey(sl.uid, pages[i].id) : pages[i].id); // 이 장의 저장 키
    const metaOf = (i) => slMeta(sl, pages[i] && pages[i].id);
    let under = null; // 콘티용으로 쓰는 중이면 그 밑에 깔아 보여 주는 곡 기본 필기(고치지 않는다)
    const base = new Map(); // 이 필기 화면을 연 뒤 처음 불러온 장의 모습 (취소하면 이걸로 되돌린다)
    const dirty = new Set();
    const ov = document.createElement('div');
    ov.className = 'ink-ed';
    ov.setAttribute('role', 'dialog');
    ov.innerHTML = `
      <div class="ink-top">
        <button type="button" data-a="cancel" class="ink-cancel">취소</button>
        <button type="button" data-a="x" class="ink-done">완료</button>
        <button type="button" data-a="fit" class="ink-n" aria-label="화면에 맞추기"></button>
        <span class="ink-nav">
          <button type="button" data-a="prev" aria-label="이전 장">‹</button>
          <button type="button" data-a="next" aria-label="다음 장">›</button>
          <button type="button" data-a="out" aria-label="축소">−</button>
          <button type="button" data-a="in" aria-label="확대">+</button>
        </span>
      </div>
      <div class="ink-scroll"><div class="ink-stage"><img alt="악보" draggable="false"><svg class="ink-svg" preserveAspectRatio="none"></svg></div></div>
      <div class="ink-tools">
        <div class="ink-row" id="ink-r1"></div>
        <div class="ink-row" id="ink-r2"></div>
      </div>
      <div class="ink-txt" hidden>
        <textarea rows="3" maxlength="300" placeholder="글자 메모를 입력하세요" aria-label="글자 메모"></textarea>
        <div class="ink-row" id="ink-tr"></div>
        <div class="ink-row"><button type="button" class="ink-b" data-t="ok">확인</button><button type="button" class="ink-b" data-t="del">지우기</button><button type="button" class="ink-b" data-t="cancel">취소</button></div>
      </div>`;
    document.body.appendChild(ov);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('ink-open'); // 입력창이 올라와 화면이 줄어들 때 뒤의 아래 탭이 비치지 않게 숨긴다
    const q = (sel) => ov.querySelector(sel);
    const scroller = q('.ink-scroll');
    const stage = q('.ink-stage');
    const img = stage.querySelector('img');
    const svg = q('.ink-svg');
    const $txt = q('.ink-txt');
    const $ta = $txt.querySelector('textarea');
    let live = null; // 쓰는 중인 획의 미리보기 path
    const H = () => 1000 * ratio;

    // ----- 보기(확대·이동) -----
    const area = () => ({ w: scroller.clientWidth, h: scroller.clientHeight });
    function fitBase() {
      const a = area();
      bw = Math.max(50, Math.min(a.w - 8, (a.h - 8) / ratio));
      bh = bw * ratio;
      svg.setAttribute('viewBox', `0 0 1000 ${H().toFixed(1)}`);
    }
    function clampView() {
      const a = area(), sw = bw * view.s, sh = bh * view.s, m = 24;
      view.x = sw <= a.w ? (a.w - sw) / 2 : clamp(view.x, a.w - sw - m, m);
      view.y = sh <= a.h ? (a.h - sh) / 2 : clamp(view.y, a.h - sh - m, m);
    }
    function applyView() {
      stage.style.width = bw * view.s + 'px';
      stage.style.height = bh * view.s + 'px';
      stage.style.transform = `translate(${view.x}px,${view.y}px)`;
      q('.ink-n').textContent = `${title ? title + ' · ' : ''}${page + 1}/${pages.length}${view.s > 1.02 ? ` · ${view.s.toFixed(1)}배` : ''}`;
    }
    function resetView() { view.s = 1; clampView(); applyView(); }
    function zoomTo(ns, cx, cy) {
      ns = clamp(ns, 1, MAX_ZOOM);
      const px = (cx - view.x) / view.s, py = (cy - view.y) / view.s;
      view.s = ns; view.x = cx - px * ns; view.y = cy - py * ns;
      clampView(); applyView();
    }
    function layout() { fitBase(); clampView(); applyView(); redraw(); }
    function redraw() {
      let html = '';
      const shh = shSVG(shRowsFor(pages[page].id, sl), 1000, H());
      if (shh) html += `<g class="ink-under" pointer-events="none">${shh}</g>`;
      if (under && under.items && under.items.length) html += `<g class="ink-under" pointer-events="none">${dataSVG(under, 1000, H())}</g>`;
      html += dataSVG({ items: txtEdit ? items.filter((i) => i.id !== txtEdit.id) : items }, 1000, H());
      if (txtEdit) {
        if (txtEdit.s.trim()) html += itemSVG(txtEdit, 1000, H());
        // 글자를 넣을 자리를 점선 원과 십자로 표시한다
        const u = 1000 / (bw * view.s), mx = (txtEdit.x / 10000) * 1000, my = (txtEdit.y / 10000) * H();
        html += `<g class="ink-mark" pointer-events="none"><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="${(10 * u).toFixed(2)}" fill="rgba(255,255,255,.6)" stroke="#e11d48" stroke-width="${(2 * u).toFixed(2)}" stroke-dasharray="${(4 * u).toFixed(2)}"/><path d="M${(mx - 16 * u).toFixed(1)} ${my.toFixed(1)}h${(32 * u).toFixed(1)}M${mx.toFixed(1)} ${(my - 16 * u).toFixed(1)}v${(32 * u).toFixed(1)}" stroke="#e11d48" stroke-width="${(1.5 * u).toFixed(2)}"/></g>`;
      }
      svg.innerHTML = html;
    }
    const jsonSize = () => JSON.stringify({ items, del: [...del] }).length;
    async function persist() {
      clearTimeout(timer);
      timer = null;
      await save(keyOf(page), songId, { v: 1, items: items.slice(), del: [...del].slice(-2000) }, metaOf(page));
    }
    function touch() {
      dirty.add(page);
      clearTimeout(timer);
      timer = setTimeout(persist, 600);
    }
    async function loadPage() {
      undo = []; redo = [];
      const f = pages[page];
      const rec = await rget(keyOf(page));
      if (sl) { const br = await rget(f.id); under = br && br.data ? br.data : null; }
      items = rec && rec.data ? rec.data.items.slice() : [];
      del = new Set(rec && rec.data ? rec.data.del : []);
      if (!base.has(page)) base.set(page, { v: 1, items: items.slice(), del: [...del] });
      ratio = 1.4;
      img.onload = () => { ratio = img.naturalHeight / img.naturalWidth || 1.4; fitBase(); resetView(); redraw(); };
      img.src = f.url;
      fitBase(); resetView(); redraw();
      if (img.complete && img.naturalWidth) img.onload();
      if (sl) { pull(songId); pullSetlist(sl.setlistId); } else pull(songId);
      pullShared({ songId, setlistId: sl && sl.setlistId });
    }
    const removeItem = (id) => { items = items.filter((i) => i.id !== id); del.add(id); };
    const addItem = (it) => { items = items.filter((i) => i.id !== it.id); items.push(it); del.delete(it.id); };
    function applyOp(op, dir) {
      if (op.a === 'add') (dir < 0 ? removeItem(op.item.id) : addItem(op.item));
      else if (op.a === 'del') op.items.forEach((it) => (dir < 0 ? addItem(it) : removeItem(it.id)));
      else if (op.a === 'edit') addItem(dir < 0 ? op.before : op.after);
      redraw();
      touch();
      renderBar();
    }
    function doUndo() { const op = undo.pop(); if (!op) return; redo.push(op); applyOp(op, -1); }
    function doRedo() { const op = redo.pop(); if (!op) return; undo.push(op); applyOp(op, 1); }
    function record(op) { undo.push(op); redo = []; if (undo.length > 100) undo.shift(); }
    function canAdd() {
      if (items.length >= MAX_ITEMS || jsonSize() > MAX_BYTES) { cfg.toast('이 장에는 필기가 너무 많아요. 일부를 지워 주세요.'); return false; }
      return true;
    }

    // ----- 도구 줄 -----
    function dots(list, cur) {
      return list.map((c) => `<button type="button" class="ink-dot${c === cur ? ' on' : ''}" data-col="${c}" style="background:${c}" aria-label="색 ${c}"></button>`).join('');
    }
    function renderBar() {
      const tb = (id, label) => `<button type="button" class="ink-b${tool === id ? ' on' : ''}" data-tool="${id}" aria-pressed="${tool === id}">${label}</button>`;
      q('#ink-r1').innerHTML =
        tb('pen', '✎ 펜') + tb('hl', '🖍 형광펜') + tb('er', '⌫ 지우개') + tb('tx', 'T 글자') + tb('hand', '✋ 이동') +
        `<span class="ink-sp"></span><button type="button" class="ink-b" data-a="undo" ${undo.length ? '' : 'disabled'} aria-label="되돌리기">↶</button><button type="button" class="ink-b" data-a="redo" ${redo.length ? '' : 'disabled'} aria-label="다시 하기">↷</button>`;
      let r2 = '';
      if (tool === 'pen' || tool === 'hl') {
        const o = opts[tool];
        r2 += dots(tool === 'pen' ? PEN_COLORS : HL_COLORS, o.c);
        r2 += WIDTHS[tool].map((w, i) => `<button type="button" class="ink-w${i === o.w ? ' on' : ''}" data-w="${i}" aria-label="굵기 ${i + 1}"><i style="height:${tool === 'pen' ? 2 + i * 2 : 6 + i * 4}px"></i></button>`).join('');
      } else if (tool === 'tx') {
        r2 += dots(PEN_COLORS, opts.tx.c);
        r2 += TEXT_SIZES.map((sz, i) => `<button type="button" class="ink-w txs${i === opts.tx.z ? ' on' : ''}" data-z="${i}" aria-label="글자 크기 ${i + 1}" style="font-size:${12 + i * 4}px">가</button>`).join('');
        r2 += '<span class="ink-hint">빈 곳을 누르면 글자를 넣고, 글자를 누르면 고칩니다</span>';
      } else if (tool === 'er') r2 += '<span class="ink-hint">지울 필기 위를 문지르세요 (획 하나씩 지워져요)</span>';
      else r2 += '<span class="ink-hint">한 손가락으로 끌어 이동, 두 손가락으로 확대·축소 (쓰려면 펜을 다시 고르세요)</span>';
      if (tool !== 'hand') r2 += `<span class="ink-sp"></span><button type="button" class="ink-b small${finger ? ' on' : ''}" data-a="finger" aria-pressed="${finger}" title="Apple Pencil만 쓰려면 끄세요. 끄면 한 손가락은 화면 이동이에요">☝ 손가락 ${finger ? '쓰기' : '이동'}</button>`;
      q('#ink-r2').innerHTML = r2;
    }
    function saveOpts() { ls.set('ews_ink_opts', JSON.stringify(opts)); }
    ov.querySelector('.ink-tools').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { tool = b.dataset.tool; renderBar(); }
      else if (b.dataset.col) { (tool === 'tx' ? opts.tx : opts[tool]).c = b.dataset.col; saveOpts(); renderBar(); }
      else if (b.dataset.w) { opts[tool].w = +b.dataset.w; saveOpts(); renderBar(); }
      else if (b.dataset.z) { opts.tx.z = +b.dataset.z; saveOpts(); renderBar(); }
      else if (b.dataset.a === 'undo') doUndo();
      else if (b.dataset.a === 'redo') doRedo();
      else if (b.dataset.a === 'finger') { finger = !finger; ls.set('ews_ink_finger', finger ? '1' : '0'); ls.set('ews_ink_finger_set', '1'); renderBar(); }
    });

    // ----- 쓰기 -----
    const norm = (e, r = stage.getBoundingClientRect()) => {
      // r: 확대·이동이 반영된 그림의 실제 위치
      return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
    };
    function hitItems(nx, ny) {
      const r = 0.018 / view.s;
      const out = [];
      for (const it of items) {
        if (it.t === 'x') {
          const fs = it.z / 10000;
          const lines = String(it.s).split('\n');
          const w = Math.max(...lines.map((l) => l.length)) * fs * 0.62 + r;
          const h = lines.length * fs * 1.25;
          const x0 = it.x / 10000, y0 = it.y / 10000;
          if (nx >= x0 - r && nx <= x0 + w && (ny - y0) * ratio >= -r && (ny - y0) * ratio <= h + r) out.push(it);
        } else {
          const rr = r + it.w / 20000;
          for (let i = 0; i < it.p.length; i += 2) {
            const px = it.p[i] / 10000, py = it.p[i + 1] / 10000;
            let near = Math.hypot(nx - px, (ny - py) * ratio) < rr;
            if (!near && i + 2 < it.p.length) {
              const qx = it.p[i + 2] / 10000, qy = it.p[i + 3] / 10000;
              const dx = qx - px, dy = (qy - py) * ratio, l2 = dx * dx + dy * dy || 1e-12;
              const t = Math.max(0, Math.min(1, ((nx - px) * dx + (ny - py) * ratio * dy) / l2));
              near = Math.hypot(nx - (px + t * dx), (ny - py) * ratio - t * dy) < rr;
            }
            if (near) { out.push(it); break; }
          }
        }
      }
      return out;
    }
    function erase(a, n) {
      for (const it of hitItems(n[0], n[1])) {
        if (a.erased.some((x) => x.id === it.id)) continue;
        a.erased.push(it);
        removeItem(it.id);
      }
      if (a.erased.length !== a.shown) { a.shown = a.erased.length; redraw(); }
    }
    let liveRaf = 0;
    function drawLive() {
      if (liveRaf) return;
      liveRaf = requestAnimationFrame(() => {
        liveRaf = 0;
        if (!live || !active) return;
        const p = [];
        active.pts.forEach((pt) => p.push(Math.round(pt[0] * 10000), Math.round(pt[1] * 10000)));
        live.setAttribute('d', strokeD(p, 1000, H(), active.stroke.w / 10));
      });
    }
    let lastStroke = null;
    function startDraw(e) {
      const n = norm(e);
      active = { id: e.pointerId, type: e.pointerType, start: n, moved: 0, pts: [n], erased: [], shown: 0 };
      if ((tool === 'pen' || tool === 'hl') && lastStroke && e.pointerType === 'pen' && Date.now() - lastStroke.t < (lastStroke.cut ? 700 : 110) && lastStroke.tool === tool && items.includes(lastStroke.item)) {
        const li = lastStroke.item;
        const end = [li.p[li.p.length - 2] / 10000, li.p[li.p.length - 1] / 10000];
        if (Math.hypot(n[0] - end[0], (n[1] - end[1]) * ratio) < (lastStroke.cut ? 0.06 : 0.02) / view.s) {
          const prevPts = [];
          for (let i = 0; i < li.p.length; i += 2) prevPts.push([li.p[i] / 10000, li.p[i + 1] / 10000]);
          active.pts = prevPts.concat([n]);
          active.resume = li;
          removeItem(li.id);
          if (undo.length && undo[undo.length - 1].a === 'add' && undo[undo.length - 1].item.id === li.id) undo.pop();
          redraw();
        }
        lastStroke = null;
      }
      if (tool === 'pen' || tool === 'hl') {
        const o = opts[tool];
        // 확대해서 쓰면 선·글자가 같은 화면 굵기가 되도록 그림 기준 굵기를 줄여 저장한다
        const w = Math.max(10, Math.round(WIDTHS[tool][o.w] / view.s));
        active.stroke = active.resume ? { t: active.resume.t, c: active.resume.c, w: active.resume.w } : { t: tool === 'pen' ? 's' : 'h', c: o.c, w };
        live = document.createElementNS(NS, 'path');
        live.setAttribute('stroke', 'none');
        live.setAttribute('fill', active.stroke.c);
        if (tool === 'hl') live.setAttribute('class', 'hl');
        svg.appendChild(live);
        drawLive();
      } else if (tool === 'er') erase(active, n);
    }
    function discardDraw() {
      const a = active;
      active = null;
      if (live) { live.remove(); live = null; }
      if (a && a.erased.length) { a.erased.forEach(addItem); redraw(); }
    }
    function finish(cancel, cut) {
      const a = active;
      active = null;
      if (live) { live.remove(); live = null; }
      if (!a) return;
      if (window.__inkdbg) window.__inkdbg('finish ' + tool + ' 이동 ' + a.moved.toFixed(4) + ' 점 ' + a.pts.length + (cancel ? ' 취소' : ''));
      if (cancel) { if (a.erased.length) { a.erased.forEach(addItem); redraw(); } return; }
      if (a.stroke) {
        if (!canAdd()) return;
        const pts = simplify(a.pts.map((pt) => [Math.round(pt[0] * 10000), Math.round(pt[1] * 10000)]), ratio, 6 / view.s);
        const p = [];
        pts.forEach((pt) => p.push(pt[0], pt[1]));
        const it = { id: uid(), t: a.stroke.t, c: a.stroke.c, w: a.stroke.w, p };
        addItem(it);
        record({ a: 'add', item: it });
        lastStroke = { item: it, t: Date.now(), tool, cut: !!cut };
        redraw();
        touch();
        renderBar();
      } else if (tool === 'er') {
        if (a.erased.length) { record({ a: 'del', items: a.erased }); touch(); renderBar(); }
      } else if (tool === 'tx' && a.moved < 0.02 / view.s) {
        if (txtEdit && txtEdit.isNew) {
          txtEdit.x = Math.round(a.start[0] * 10000);
          txtEdit.y = Math.round(a.start[1] * 10000);
          redraw();
          return;
        }
        if (txtEdit) return;
        const hit = hitItems(a.start[0], a.start[1]).filter((i) => i.t === 'x').pop();
        openText(hit || null, a.start);
      }
    }

    // 손가락·펜 입력 가르기
    const touches = new Map();
    const ignore = new Set();
    let pinch = null, pan = null, penActive = false;
    const rel = (e) => { const r = scroller.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const modeOf = (e) => (tool === 'hand' || (e.pointerType === 'touch' && !finger) ? 'pan' : 'draw');
    function startPinch() {
      const [a, b] = [...touches.values()];
      const r = scroller.getBoundingClientRect();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: view.s, vx: view.x, vy: view.y, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
      pan = null;
    }
    function movePinch() {
      const [a, b] = [...touches.values()];
      const r = scroller.getBoundingClientRect();
      const ns = clamp((pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.d, 1, MAX_ZOOM);
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      const px = (pinch.cx - pinch.vx) / pinch.s, py = (pinch.cy - pinch.vy) / pinch.s;
      view.s = ns; view.x = cx - px * ns; view.y = cy - py * ns;
      clampView(); applyView();
    }
    const startPan = (e) => { pan = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; };
    scroller.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (e.pointerType === 'pen' && ls.get('ews_ink_pen', '') !== '1') {
        ls.set('ews_ink_pen', '1');
        if (finger && ls.get('ews_ink_finger_set', '') !== '1') { finger = false; ls.set('ews_ink_finger', '0'); renderBar(); cfg.toast('펜이 감지돼서 손가락은 화면 이동으로 바꿨어요. (도구 줄의 ☝에서 다시 켤 수 있어요)'); }
      }
      try { scroller.setPointerCapture(e.pointerId); } catch {}
      if (e.pointerType === 'touch') {
        if (penActive) { ignore.add(e.pointerId); return; } // 펜으로 쓰는 중에 닿은 손바닥은 무시
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) { discardDraw(); startPinch(); return; }
        if (modeOf(e) === 'pan') startPan(e); else startDraw(e);
        return;
      }
      if (e.pointerType === 'pen') { penActive = true; touches.clear(); pinch = null; pan = null; discardDraw(); }
      if (modeOf(e) === 'pan') startPan(e); else startDraw(e);
    });
    scroller.addEventListener('pointermove', (e) => {
      if (ignore.has(e.pointerId)) return;
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) { movePinch(); return; }
      }
      if (pan && e.pointerId === pan.id) {
        view.x = pan.vx + (e.clientX - pan.x);
        view.y = pan.vy + (e.clientY - pan.y);
        clampView(); applyView();
        return;
      }
      if (!active || e.pointerId !== active.id) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const rect = stage.getBoundingClientRect();
      for (const ev of evs.length ? evs : [e]) {
        if (e.buttons && !ev.buttons) continue; // 펜이 닿기 전 공중(호버) 위치가 묶여 오면 버린다
        const n = norm(ev, rect);
        const last = active.pts[active.pts.length - 1];
        if (Math.hypot(n[0] - last[0], (n[1] - last[1]) * ratio) < 0.0004 / view.s) continue;
        active.moved = Math.max(active.moved, Math.hypot(n[0] - active.start[0], (n[1] - active.start[1]) * ratio)); // 탭 판정은 처음 자리에서 얼마나 멀어졌는지로
        if (tool === 'er') erase(active, n);
        else if (active.stroke) active.pts.push(n);
      }
      if (active.stroke) drawLive();
    });
    function endPointer(e, cancel) {
      if (ignore.delete(e.pointerId)) return;
      if (e.pointerType === 'touch') {
        const had = touches.delete(e.pointerId);
        if (pinch) {
          if (touches.size < 2) { pinch = null; touches.forEach((_, id) => ignore.add(id)); touches.clear(); } // 남은 한 손가락은 뗄 때까지 무시
          return;
        }
        if (!had) return;
      }
      if (e.pointerType === 'pen') penActive = false;
      if (pan && e.pointerId === pan.id) { pan = null; return; }
      // 펜이 중간에 취소돼도 지금까지 그은 만큼은 남긴다(끊김 방지)
      if (active && e.pointerId === active.id) finish(cancel && e.pointerType !== 'pen', cancel && e.pointerType === 'pen');
    }
    const release = (e) => { try { scroller.releasePointerCapture(e.pointerId); } catch {} };
    scroller.addEventListener('pointerup', (e) => { endPointer(e, false); release(e); });
    scroller.addEventListener('pointercancel', (e) => { endPointer(e, true); release(e); });
    scroller.addEventListener('lostpointercapture', (e) => { if ((active && e.pointerId === active.id) || (pan && e.pointerId === pan.id)) endPointer(e, false); });
    scroller.addEventListener('wheel', (e) => { e.preventDefault(); const [cx, cy] = rel(e); zoomTo(view.s * (e.deltaY < 0 ? 1.18 : 1 / 1.18), cx, cy); }, { passive: false });
    scroller.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    scroller.addEventListener('contextmenu', (e) => e.preventDefault());
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((n) => ov.addEventListener(n, (e) => e.preventDefault())); // 사파리의 화면 전체 확대 막기


    // ----- 진단(더보기에서 켬): 펜 이벤트가 어떻게 오는지 화면에 보여준다 -----
    if (ls.get('ews_ink_dbg', '') === '1') {
      const box = document.createElement('div');
      box.className = 'ink-dbg';
      ov.appendChild(box);
      const rows = [];
      const t0 = performance.now();
      let moves = 0, lastMv = 0, gaps = 0, maxGap = 0;
      const add = (txt) => { rows.push(((performance.now() - t0) / 1000).toFixed(2) + ' ' + txt); if (rows.length > 16) rows.shift(); box.textContent = rows.join('\n') + '\n이동 ' + moves + ' 끊김(>60ms) ' + gaps + ' 최대 ' + Math.round(maxGap) + 'ms'; };
      ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchend', 'touchcancel', 'click', 'contextmenu', 'selectstart'].forEach((n) => {
        ov.addEventListener(n, (e) => {
          const t = e.pointerType || (e.changedTouches && e.changedTouches[0] ? 'T:' + (e.changedTouches[0].touchType || '') : '');
          add(n + ' ' + t + (e.pointerId != null ? ' #' + e.pointerId : '') + (e.target && e.target.className && e.target.className.baseVal === undefined ? ' ' + String(e.target.className).slice(0, 12) : ''));
          if (n === 'pointerdown' || n === 'pointerup' || n === 'pointercancel') { lastMv = 0; }
        }, true);
      });
      ov.addEventListener('pointermove', (e) => {
        if (!e.buttons) return;
        const now = performance.now();
        if (lastMv) { const g = now - lastMv; if (g > 60) { gaps++; if (g > maxGap) maxGap = g; add('간격 ' + Math.round(g) + 'ms ' + e.pointerType); } }
        lastMv = now; moves++;
      }, true);
      window.__inkdbg = add;
      add('진단 켜짐 (tool=' + tool + ')');
    }

    // ----- 글자 메모 -----
    function renderTextBar() {
      const cur = txtEdit;
      const zi = zIdx(cur.z);
      q('#ink-tr').innerHTML = dots(PEN_COLORS, cur.c) + TEXT_SIZES.map((sz, i) => `<button type="button" class="ink-w txs${i === zi ? ' on' : ''}" data-z2="${i}" style="font-size:${12 + i * 4}px">가</button>`).join('');
    }
    // 입력창이 가리지 않도록 글자 자리가 보이게 화면을 옮긴다
    function revealPoint() {
      if (!txtEdit) return;
      const r = scroller.getBoundingClientRect();
      const sy = r.top + view.y + (txtEdit.y / 10000) * bh * view.s;
      const limit = $txt.getBoundingClientRect().top - 70;
      if (sy > limit) { view.y -= sy - limit; applyView(); }
    }
    const zFor = (i) => clamp(Math.round(TEXT_SIZES[i] / view.s), 60, 600);
    const zIdx = (z) => { let bi = 0; TEXT_SIZES.forEach((_, i) => { if (Math.abs(zFor(i) - z) < Math.abs(zFor(bi) - z)) bi = i; }); return bi; };
    function openText(it, at) {
      const z0 = zFor(opts.tx.z);
      txtEdit = it ? { ...it, isNew: false } : { id: uid(), t: 'x', x: Math.round(at[0] * 10000), y: Math.round(at[1] * 10000), c: opts.tx.c, z: z0, s: '', isNew: true };
      $ta.value = txtEdit.s;
      $txt.hidden = false;
      // 탭한 뒤에 따라오는 클릭이 방금 나타난 입력창의 버튼(취소 등)을 누르지 않도록 잠깐 막는다
      $txt.style.pointerEvents = 'none';
      setTimeout(() => { $txt.style.pointerEvents = ''; }, 450);
      $txt.querySelector('[data-t="del"]').hidden = txtEdit.isNew;
      renderTextBar();
      redraw();
      setTimeout(() => { revealPoint(); $ta.focus(); }, 30);
    }
    function closeText() {
      $txt.hidden = true;
      txtEdit = null;
      redraw();
      clampView();
      applyView();
    }
    $ta.addEventListener('input', () => { if (txtEdit) { txtEdit.s = $ta.value; redraw(); } });
    $txt.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !txtEdit) return;
      if (b.dataset.col) { txtEdit.c = b.dataset.col; renderTextBar(); redraw(); }
      else if (b.dataset.z2) { const i = +b.dataset.z2; txtEdit.z = zFor(i); opts.tx.z = i; saveOpts(); renderTextBar(); redraw(); }
      else if (b.dataset.t === 'cancel') closeText();
      else if (b.dataset.t === 'del') {
        const old = items.find((i) => i.id === txtEdit.id);
        if (old) { removeItem(old.id); record({ a: 'del', items: [old] }); touch(); renderBar(); }
        closeText();
      } else if (b.dataset.t === 'ok') {
        const s = $ta.value.replace(/\s+$/, '');
        const old = items.find((i) => i.id === txtEdit.id);
        if (!s.trim()) {
          if (old) { removeItem(old.id); record({ a: 'del', items: [old] }); touch(); renderBar(); }
        } else {
          const it = { id: txtEdit.id, t: 'x', c: txtEdit.c, x: txtEdit.x, y: txtEdit.y, z: txtEdit.z, s };
          if (!old && !canAdd()) return;
          addItem(it);
          record(old ? { a: 'edit', before: old, after: it } : { a: 'add', item: it });
          if (txtEdit.isNew) { opts.tx.c = it.c; saveOpts(); }
          touch(); renderBar();
        }
        closeText();
      }
    });

    // ----- 위쪽 줄 · 닫기 -----
    async function go(d) {
      if (txtEdit) closeText();
      await persist();
      const np = page + d;
      if (np < 0 || np >= pages.length) return;
      page = np;
      await loadPage();
    }
    function teardown() {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('resize', layout);
      window.removeEventListener('ews-shared', onShared);
      if (window.visualViewport) { visualViewport.removeEventListener('resize', fitVV); visualViewport.removeEventListener('scroll', fitVV); }
      document.body.style.overflow = prevOverflow;
      document.body.classList.remove('ink-open');
      ov.remove();
    }
    async function close() {
      if (txtEdit) closeText();
      await persist();
      teardown();
      if (onClose) onClose(page);
    }
    // 이번에 쓴 필기를 모두 버리고 처음 모습으로 되돌린다
    async function cancelAll() {
      if (txtEdit) closeText();
      if (dirty.size || timer) {
        if (!confirm('이번에 쓴 필기를 모두 버리고 닫을까요?')) return;
      }
      clearTimeout(timer);
      timer = null;
      for (const i of dirty) if (base.has(i)) await save(keyOf(i), songId, base.get(i), metaOf(i));
      teardown();
      if (onClose) onClose(page);
    }
    q('.ink-top').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      const c = area();
      if (a === 'x') close();
      else if (a === 'cancel') cancelAll();
      else if (a === 'prev') go(-1);
      else if (a === 'next') go(1);
      else if (a === 'fit') resetView();
      else if (a === 'in') zoomTo(view.s * 1.5, c.w / 2, c.h / 2);
      else if (a === 'out') zoomTo(view.s / 1.5, c.w / 2, c.h / 2);
    });
    function onKey(e) {
      if (e.target && e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') close();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); }
    }
    const onHide = () => { if (document.hidden && timer) persist(); };
    // 키보드가 올라오면 보이는 영역만큼으로 줄여서 입력창이 가려지지 않게 한다
    function fitVV() {
      const vv = window.visualViewport;
      if (!vv) return;
      ov.style.top = vv.offsetTop + 'px';
      ov.style.height = vv.height + 'px';
      ov.style.bottom = 'auto';
      if (txtEdit) revealPoint();
    }
    const onShared = () => { if (!txtEdit) redraw(); };
    window.addEventListener('ews-shared', onShared);
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('resize', layout);
    if (window.visualViewport) { visualViewport.addEventListener('resize', fitVV); visualViewport.addEventListener('scroll', fitVV); }
    renderBar();
    loadPage();
  }

  // ---------- 더보기: 내 필기 보관함 카드 ----------
  async function pendingCount() {
    return (await rall()).filter((r) => r.dirty).length;
  }
  function mountVaultCard(el) {
    async function render(msg) {
      const v = vget();
      if (!v || !v.token) {
        el.innerHTML = `
          <h2 style="margin-top:0">✎ 내 필기 보관함</h2>
          <p class="muted small" style="margin:4px 0 8px">이미지 악보 위에 쓴 필기는 지금도 <b>이 기기</b>에 저장돼요. 아이패드에서 쓴 필기를 아이폰·맥북에서도 보려면 보관함을 만들고, 다른 기기에서 같은 코드를 입력하세요. 보관함은 <b>나만</b> 보는 필기 공간이에요(팀원에게 보이지 않아요).</p>
          ${msg ? `<p class="${msg.err ? 'error' : 'muted'} small">${esc(msg.text)}</p>` : ''}
          <div class="row"><button class="btn primary" id="vc-new" type="button">새 보관함 만들기</button><button class="btn" id="vc-join" type="button">코드로 연결하기</button></div>
          <div id="vc-form" hidden style="margin-top:8px"><div class="row"><input id="vc-code" placeholder="ABCD-EFGH-JKMN" autocapitalize="characters" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn primary" id="vc-go" type="button">연결</button></div></div>`;
        el.querySelector('#vc-new').onclick = async (e) => {
          e.target.disabled = true;
          try { await vaultCreate(); render({ text: '보관함을 만들었어요. 아래 코드를 안전한 곳에 적어 두세요.' }); } catch (err) { render({ err: 1, text: err.message }); }
        };
        el.querySelector('#vc-join').onclick = () => { el.querySelector('#vc-form').hidden = false; el.querySelector('#vc-code').focus(); };
        el.querySelector('#vc-go').onclick = async (e) => {
          e.target.disabled = true;
          try { await vaultJoin(el.querySelector('#vc-code').value); render({ text: '연결했어요. 이 보관함의 필기를 불러왔어요.' }); } catch (err) { render({ err: 1, text: err.message }); }
        };
        return;
      }
      let info = '';
      try { const m = await vfetch('/me'); info = `서버에 ${m.pages}장 · ${m.songs}곡의 필기가 있어요.`; } catch (err) { info = err.status === 401 ? '연결이 풀렸어요. 코드를 다시 입력해 주세요.' : '서버에 연결할 수 없어요(인터넷을 확인해 주세요).'; }
      const pend = await pendingCount();
      el.innerHTML = `
        <h2 style="margin-top:0">✎ 내 필기 보관함 <span class="pill ok">연결됨</span></h2>
        <p class="small" style="margin:4px 0">보관함 코드 <b class="vault-code" id="vc-code-v">${esc(v.code || '(이 기기에는 코드가 저장돼 있지 않아요)')}</b></p>
        <p class="muted small" style="margin:4px 0">다른 기기에서 <b>더보기 → 코드로 연결하기</b>에 이 코드를 넣으면 같은 필기가 보여요. 코드를 아는 사람은 이 필기를 볼 수 있으니 남에게 알려 주지 마세요.</p>
        <p class="muted small" style="margin:4px 0">${esc(info)}${pend ? ` 아직 올리지 못한 필기 ${pend}장(인터넷이 되면 자동으로 올라가요).` : ''}</p>
        ${msg ? `<p class="${msg.err ? 'error' : 'muted'} small">${esc(msg.text)}</p>` : ''}
        <div class="row"><button class="btn small" id="vc-dbg" type="button">필기 진단 ${ls.get('ews_ink_dbg', '') === '1' ? '끄기' : '켜기'}</button></div>
        <div class="row"><button class="btn small" id="vc-copy" type="button">코드 복사</button><button class="btn small" id="vc-sync" type="button">지금 맞추기</button><button class="btn small" id="vc-leave" type="button">이 기기 연결 해제</button><button class="btn small danger" id="vc-del" type="button">보관함 지우기</button></div>`;
      el.querySelector('#vc-dbg').onclick = () => { ls.set('ews_ink_dbg', ls.get('ews_ink_dbg', '') === '1' ? '0' : '1'); render({ text: '필기 진단을 ' + (ls.get('ews_ink_dbg', '') === '1' ? '켰어요. 필기 화면 왼쪽 아래에 기록이 보여요.' : '껐어요.') }); };
      el.querySelector('#vc-copy').onclick = async () => { try { await navigator.clipboard.writeText(v.code || ''); cfg.toast('코드를 복사했어요.'); } catch { cfg.toast('복사하지 못했어요. 코드를 직접 적어 주세요.'); } };
      el.querySelector('#vc-sync').onclick = async (e) => { e.target.disabled = true; try { await adoptServerNotes(); render({ text: '맞췄어요.' }); } catch (err) { render({ err: 1, text: err.message }); } };
      el.querySelector('#vc-leave').onclick = () => {
        if (!confirm('이 기기의 연결만 끊어요. 이 기기와 서버의 필기는 그대로 남아요.\n코드를 알면 다시 연결할 수 있어요.')) return;
        vaultLeave();
        render({ text: '연결을 해제했어요.' });
      };
      el.querySelector('#vc-del').onclick = async () => {
        if (!confirm('보관함과 서버에 올려 둔 필기를 모두 지웁니다. 되돌릴 수 없어요.\n(이 기기에 저장된 필기는 남아요.) 계속할까요?')) return;
        try { await vaultDeleteServer(); render({ text: '서버의 보관함을 지웠어요.' }); } catch (err) { render({ err: 1, text: err.message }); }
      };
    }
    render();
  }

  // ---------- 코드 악보 필기 (30차 · 31차 다듬기) ----------
  // 코드 악보는 글자라서 키·글자 크기·단 수에 따라 줄 위치가 바뀐다. 그래서 필기를 "그림 좌표"가 아니라 "줄"에 붙인다.
  //  · 한 획(글자)은 처음 찍은 점이 있는 줄에 붙는다: a = { b: 줄 번호, h: 줄 글자 해시, v: 악보 버전, o: 회차(있을 때만) }
  //  · 좌표는 그 줄 상자 안 값: x = 줄 너비의 1/10000, y = 줄 높이의 1/1000 (줄 위·아래로 나가도 된다)
  //  · 줄 글자를 고쳐 번호가 밀려도 해시로 위아래 2줄 안에서 다시 찾는다. 못 찾으면 "안 보이는 필기"로 세어 정리할 수 있다.
  //  · 회차(o): 송폼 순서 악보에서 같은 구간이 여러 번 나올 때 "V1#1", "C#2" 처럼 몇 번째인지. o가 없으면 모든 회차에 보인다.
  //  · 31차: 팀장이 공유한 필기(읽기 전용)가 내 필기 밑에 깔려 보이고, 필기 도구가 다듬어졌다(글자 위치 표시·끌어 옮기기, 닿는 즉시 지우는 지우개,
  //    쓰는 중 모습 = 뗀 뒤 모습, 펜↔지우개 전환, 손가락 관성 스크롤, 두 손가락 확대[글자 크기], 화면을 떠나면 도구줄 닫기).
  const cviews = new Set();
  const codeMeta = (songId, sl) => ({ code: 1, ...(sl ? { sl: sl.uid, fid: -songId, setlistId: sl.setlistId } : {}) });
  function relPos(el, root) {
    let x = 0, y = 0, e = el;
    while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }
  const lineEls = (root, v) => [...root.querySelectorAll('.ln[data-bl]')].filter((e) => (+e.dataset.v || 0) === v);
  function matchItem(list, a) {
    const cand = a.o ? list.filter((e) => e.dataset.o === a.o) : list;
    if (!cand.length) return { els: [], none: true };
    const by = new Map();
    for (const e of cand) { const k = +e.dataset.bl; if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
    const want = a.h || '';
    for (const d of [0, -1, 1, -2, 2]) {
      const k = a.b + d;
      if (by.has(k) && (by.get(k)[0].dataset.h || '') === want && (want || d === 0)) return { els: by.get(k) };
    }
    return { els: [], miss: true };
  }
  // 이 코드 악보 위에 깔려 보일 팀 공유 필기(읽기 전용)
  const sharedSources = (o) => shRowsFor(-o.songId, o.sl).map((r) => ({ key: 'sh:' + r.id, data: r.data, shared: true, author: r.author }));
  function cdraw(o) {
    const root = o.root;
    if (!root.isConnected) return;
    if (!o.svg || !o.svg.isConnected) {
      if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
      if (!o.svg) {
        o.svg = document.createElementNS(NS, 'svg');
        o.svg.setAttribute('class', 'ink-ov cink-ov');
        o.svg.setAttribute('aria-hidden', 'true');
      }
      root.appendChild(o.svg);
    }
    const svg = o.svg;
    svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;z-index:3;' + (o.editing ? 'pointer-events:auto;touch-action:none;' : 'pointer-events:none;');
    const cache = {};
    const miss = [];
    o.geo = [];
    let html = '';
    const shS = sharedSources(o);
    const multi = new Set(shS.map((x) => x.author)).size > 1;
    const cols = new Map(shAuthors().map((a) => [a.author, a.color]));
    for (const src of [...shS, ...o.sources]) {
      const ol = src.shared && multi ? { c: cols.get(src.author) || '#0ea5e9', w: 3 } : null;
      for (const it of (src.data && src.data.items) || []) {
        const a = it.a;
        if (!a) continue;
        if (!src.shared && o.hideId && it.id === o.hideId) continue; // 글자를 고치는 중이면 원래 글자는 숨긴다
        const lv = cache[a.v || 0] || (cache[a.v || 0] = lineEls(root, a.v || 0));
        const m = matchItem(lv, a);
        if (m.miss && !src.shared) miss.push({ id: it.id, key: src.key });
        for (const el of m.els || []) {
          const r = relPos(el, root);
          if (!r.w || !r.h) continue;
          const sc = r.w / 1000;
          html += `<g data-id="${esc(it.id)}" transform="translate(${r.x.toFixed(1)},${r.y.toFixed(1)}) scale(${sc.toFixed(4)})">${itemSVG(it, 1000, (10 * r.h) / sc, ol)}</g>`;
          if (!src.shared) o.geo.push({ id: it.id, key: src.key, it, r });
        }
      }
    }
    svg.innerHTML = html;
    o.miss = miss;
    cnote(o);
    if (o.afterDraw) o.afterDraw();
  }
  function cnote(o) {
    if (!o.note) {
      o.note = document.createElement('div');
      o.note.className = 'cink-miss muted small';
      o.root.insertAdjacentElement('afterend', o.note);
    }
    const n = o.miss.length;
    o.note.hidden = !n || o.readOnly;
    o.note.innerHTML = n ? `화면에 안 보이는 필기 ${n}개 (가사를 고쳐서 줄을 못 찾았어요) <button type="button" class="btn small" data-cl="1">정리</button>` : '';
    const b = o.note.querySelector('button');
    if (b) b.onclick = async () => {
      if (!confirm(`안 보이는 필기 ${n}개를 지울까요? 되돌릴 수 없어요.`)) return;
      for (const s of o.sources) {
        const ids = o.miss.filter((m) => m.key === s.key).map((m) => m.id);
        if (!ids.length) continue;
        const d = { v: 1, items: s.data.items.filter((i) => !ids.includes(i.id)), del: [...(s.data.del || []), ...ids] };
        await save(s.key, o.songId, d, s.meta);
      }
    };
  }
  async function cload(o) {
    const recs = await Promise.all(o.sources.map((s) => rget(s.key)));
    o.sources.forEach((s, i) => { s.data = recs[i] ? recs[i].data : null; });
    cdraw(o);
  }
  // 한 곡·한 콘티를 짧은 시간에 여러 번 열어도 공유 필기는 20초에 한 번만 새로 받는다
  const shPulled = new Map();
  function pullSharedSoon(args) {
    const k = (args.songId || '') + ':' + (args.setlistId || '');
    if (Date.now() - (shPulled.get(k) || 0) < 20000) return;
    shPulled.set(k, Date.now());
    pullShared(args);
  }
  // root(.score) 안의 .ln[data-bl] 줄들에 필기를 겹쳐 보인다. opt = { songId, sl, readOnly, v, zoom: { get(), set(px) } }
  function codeView(root, opt) {
    for (const x of [...cviews]) if (!x.root.isConnected && !x.editing) { cviews.delete(x); try { x.ro && x.ro.disconnect(); } catch {} if (x.note) x.note.remove(); }
    const base = { key: codeKeyOf(opt.songId), meta: codeMeta(opt.songId), data: null };
    const sources = [base];
    if (opt.sl) sources.push({ key: codeKeyOf(opt.songId, opt.sl), meta: codeMeta(opt.songId, opt.sl), data: null, sl: true });
    const o = { root, songId: opt.songId, sl: opt.sl, sources, readOnly: !!opt.readOnly, geo: [], miss: [], v: opt.v || 0, zoom: opt.zoom || null };
    cviews.add(o);
    o.refresh = () => cdraw(o);
    o.reload = () => cload(o);
    o.setV = (v) => { o.v = v || 0; };
    try { o.ro = new ResizeObserver(() => cdraw(o)); o.ro.observe(root); } catch {}
    o.edit = () => cedit(o);
    cload(o);
    pullSharedSoon({ songId: opt.songId, setlistId: opt.sl && opt.sl.setlistId });
    return o;
  }
  window.addEventListener('ews-ink', (e) => {
    for (const o of [...cviews]) {
      if (!o.root.isConnected) { cviews.delete(o); try { o.ro && o.ro.disconnect(); } catch {} if (o.note) o.note.remove(); continue; }
      if (!o.editing && o.sources.some((s) => s.key === e.detail.fileId)) cload(o);
    }
  });
  window.addEventListener('resize', () => cviews.forEach((o) => o.root.isConnected && cdraw(o)));
  window.addEventListener('ews-shared', () => cviews.forEach((o) => o.root.isConnected && !(o.busy && o.busy()) && cdraw(o)));

  // 필기 모드: 화면 아래 도구 줄이 뜨고, 코드 악보 위에 바로 쓴다. 펜슬·마우스 = 쓰기, 손가락 = 스크롤(☝ 켜면 쓰기), 두 손가락 = 확대.
  function cedit(o) {
    if (o.editing) return;
    o.editing = true;
    const target = o.sources[o.sources.length - 1]; // 콘티용이 있으면 콘티용에, 없으면 곡 기본 필기에 쓴다
    if (!target.data) target.data = emptyData();
    const hasOcc = !!o.root.querySelector('.ln[data-o]');
    const opts = { tool: 'pen', prev: 'pen', pen: { c: PEN_COLORS[0], w: 1 }, hl: { c: HL_COLORS[0], w: 1 }, tx: { c: PEN_COLORS[1], z: 1 }, finger: false, scope: hasOcc ? 'this' : 'all' };
    const ER = 12; // 지우개 반지름(px)
    const ZMIN = 12, ZMAX = 44;
    const origSize = o.zoom ? o.zoom.get() : 0;
    const hist = [];
    const redoS = [];
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
    const bar = mk('cink-bar');
    const pnl = mk('cink-txt');
    pnl.hidden = true;
    pnl.innerHTML = `<textarea rows="2" maxlength="300" placeholder="글자 메모를 입력하세요" aria-label="글자 메모"></textarea><div class="cink-txr" data-r="opt"></div><div class="cink-txr"><button type="button" data-x="ok" class="done">확인</button><button type="button" data-x="del">삭제</button><button type="button" data-x="cancel">취소</button><span class="cink-hint">점선 표시를 끌거나 악보를 눌러 자리를 옮겨요</span></div>`;
    document.body.append(bar, pnl);
    const $ta = pnl.querySelector('textarea');
    let S = null;
    let act = null;
    let txt = null; // 글자 입력창이 열려 있는 동안의 글자 { id, t, a, x, y, c, z, s, isNew }
    let penDown = false;
    let pinch = null;
    let inertia = 0;
    let liveG = null, liveRaf = 0, ec = null;
    const touches = new Map();
    const ignore = new Set();
    const snapNow = () => JSON.stringify({ items: target.data.items, del: target.data.del || [] });
    function applySnap(js) {
      const prev = JSON.parse(js);
      const cur = new Set(target.data.items.map((i) => i.id));
      const had = new Set(prev.items.map((i) => i.id));
      const del = new Set(target.data.del || []);
      cur.forEach((id) => { if (!had.has(id)) del.add(id); });
      had.forEach((id) => del.delete(id));
      target.data = { v: 1, items: prev.items, del: [...del].slice(-2000) };
    }
    async function commit(snap) {
      if (snap) { hist.push(snap); if (hist.length > 40) hist.shift(); redoS.length = 0; }
      await save(target.key, o.songId, target.data, target.meta);
      cdraw(o);
      paint();
    }
    function undo() { const s = hist.pop(); if (s == null) return; redoS.push(snapNow()); applySnap(s); commit(null); }
    function redo() { const s = redoS.pop(); if (s == null) return; hist.push(snapNow()); applySnap(s); commit(null); }
    const scopeLabel = () => (opts.scope === 'this' ? '이 회차만' : '모든 회차');
    function paint() {
      const t = opts.tool;
      const colors = t === 'hl' ? HL_COLORS : PEN_COLORS;
      const cur = opts[t] || opts.pen;
      // 좁은 화면(아이폰)에서는 글자 이름표를 숨기고 그림만 보여 도구 줄이 악보를 덜 가린다
      const tb = (id, ico, label) => `<button type="button" data-t="${id}" class="${t === id ? 'on' : ''}" aria-label="${label}" title="${label}"><span class="ico">${ico}</span><span class="lbl"> ${label}</span></button>`;
      bar.innerHTML =
        `<div class="cink-row">${tb('pen', '✎', '펜')}${tb('hl', '🖍', '형광펜')}${tb('tx', '가', '글자')}${tb('er', '⌫', '지우개')}<button type="button" class="swap" data-sw="1" aria-label="${t === 'er' ? '펜으로' : '지우개로'} 바꾸기" title="펜과 지우개를 서로 바꿔요 (키보드 E)"><span class="ico">⇄</span><span class="lbl"> ${t === 'er' ? '펜으로' : '지우개로'}</span></button></div>` +
        `<div class="cink-row">` +
        (t !== 'er' ? colors.map((c) => `<button type="button" class="sw${cur.c === c ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="색"></button>`).join('') : '') +
        (t === 'pen' || t === 'hl' ? `<button type="button" data-w="1">굵기 ${(cur.w || 0) + 1}</button>` : t === 'tx' ? `<button type="button" data-z="1">크기 ${(opts.tx.z || 0) + 1}</button>` : `<span class="cink-hint">지울 필기에 대세요 (닿는 즉시 지워져요)</span>`) +
        `<button type="button" data-f="1" class="${opts.finger ? 'on' : ''}" title="켜면 손가락으로도 써요">☝ ${opts.finger ? '손가락 쓰기' : '손가락 스크롤'}</button>` +
        (hasOcc ? `<button type="button" data-s="1">${scopeLabel()}</button>` : '') +
        `</div><div class="cink-row">` +
        `<button type="button" data-u="1" ${hist.length ? '' : 'disabled'} aria-label="되돌리기">↶</button><button type="button" data-r2="1" ${redoS.length ? '' : 'disabled'} aria-label="다시 하기">↷</button>` +
        (o.zoom ? `<button type="button" data-zm="-1" aria-label="글자 작게">가−</button><button type="button" data-zm="1" aria-label="글자 크게">가＋</button>` : '') +
        (!o.zoom ? '' : `<span class="cink-hint">두 손가락으로 벌리면 확대</span>`) +
        `<button type="button" class="done" data-d="1">완료</button></div>`;
      // 도구 줄이 차지하는 높이만큼 악보 아래에 여백을 둔다
      requestAnimationFrame(() => { if (bar.isConnected) document.documentElement.style.setProperty('--cink-h', bar.offsetHeight + 'px'); });
    }
    paint();
    bar.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const d = b.dataset;
      if (d.t) { if (d.t !== 'er') opts.prev = d.t; opts.tool = d.t; if (d.t !== 'er') hideCursor(); }
      else if (d.sw) swapTool();
      else if (d.c) (opts[opts.tool] || opts.pen).c = d.c;
      else if (d.w) { const x = opts[opts.tool]; x.w = (x.w + 1) % 3; }
      else if (d.z) opts.tx.z = (opts.tx.z + 1) % 3;
      else if (d.f) opts.finger = !opts.finger;
      else if (d.s) opts.scope = opts.scope === 'this' ? 'all' : 'this';
      else if (d.u) undo();
      else if (d.r2) redo();
      else if (d.zm) zoomStep(+d.zm * 2);
      else if (d.d) { stop(); return; }
      paint();
    };
    function swapTool() {
      if (opts.tool === 'er') opts.tool = opts.prev || 'pen';
      else { opts.prev = opts.tool === 'tx' ? 'pen' : opts.tool; opts.tool = 'er'; }
      if (opts.tool !== 'er') hideCursor();
      paint();
    }

    // ----- 펜 신호 실험: 펜의 버튼·지우개 끝이 보내는 신호를 받아 본다(애플펜슬 더블탭·스퀴즈는 웹에 오지 않는 것으로 알려져 있어, 오는지 확인만 한다) -----
    const told = new Set();
    const tellOnce = (k, msg) => { if (told.has(k)) return; told.add(k); cfg.toast(msg); };
    function penSignal(e) {
      if (e.pointerType !== 'pen') return;
      if (e.buttons & 2) tellOnce('b2', '펜 버튼 신호를 받았어요. (펜↔지우개 전환에 써요)');
      if (e.buttons & 32) tellOnce('b32', '펜의 지우개 끝 신호를 받았어요. (닿으면 지워요)');
      if (e.buttons > 1 && !(e.buttons & 34)) tellOnce('b' + e.buttons, '펜의 낯선 신호(' + e.buttons + ')를 받았어요. 알려 주세요.');
    }

    // 더보기의 "필기 진단"을 켜면, 펜·손가락·버튼 신호가 오는 대로 화면 위쪽에 적어 준다(애플펜슬 더블탭·스퀴즈가 오는지 확인용)
    let dbgBox = null;
    const dbgRows = [];
    const dbgOn = ls.get('ews_ink_dbg', '') === '1';
    const dbgAdd = (txt) => {
      if (!dbgOn) return;
      if (!dbgBox) { dbgBox = document.createElement('div'); dbgBox.className = 'ink-dbg'; dbgBox.style.cssText = 'position:fixed;left:6px;top:calc(env(safe-area-inset-top) + 8px);bottom:auto;max-width:92vw;z-index:1100'; document.body.appendChild(dbgBox); }
      dbgRows.push(txt);
      if (dbgRows.length > 12) dbgRows.shift();
      dbgBox.textContent = dbgRows.join('\n');
    };
    if (dbgOn) {
      ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'auxclick', 'dblclick', 'touchstart', 'gesturestart'].forEach((n) => document.addEventListener(n, function dbgL(e) {
        if (!o.editing) { document.removeEventListener(n, dbgL, true); return; }
        const t = e.pointerType || (e.touches && e.touches[0] && e.touches[0].touchType) || '';
        dbgAdd(`${n} ${t}${e.buttons != null ? ' b=' + e.buttons : ''}${e.pressure ? ' p=' + e.pressure.toFixed(2) : ''}${e.altitudeAngle != null && e.pointerType === 'pen' ? ' alt=' + e.altitudeAngle.toFixed(2) : ''}${e.twist ? ' tw=' + e.twist : ''}`);
      }, true));
      dbgAdd('진단 켜짐: 펜슬 더블탭·스퀴즈·버튼을 눌러 보세요');
    }

    // ----- 줄 찾기 -----
    function nearest(px, py) {
      const els = lineEls(o.root, o.v);
      let best = null, bd = 1e9;
      for (const el of els) {
        const r = relPos(el, o.root);
        if (!r.w || !r.h) continue;
        const dx = px < r.x ? r.x - px : px > r.x + r.w ? px - r.x - r.w : 0;
        const dy = py < r.y ? r.y - py : py > r.y + r.h ? py - r.y - r.h : 0;
        const dd = dx * 1.5 + dy;
        if (dd < bd) { bd = dd; best = { el, r }; }
      }
      return best;
    }
    const anchorOf = (el, scope) => ({ b: +el.dataset.bl, h: el.dataset.h || '', v: +el.dataset.v || 0, ...((scope || opts.scope) === 'this' && el.dataset.o ? { o: el.dataset.o } : {}) });
    const lineFor = (a) => { const m = matchItem(lineEls(o.root, a.v || 0), a); return m.els && m.els[0]; };
    // 화면 좌표 → 악보 안 좌표. 연주 모드처럼 악보가 가로로 밀려 있어도(transform) 맞도록 겉보기 크기 비율로 나눈다.
    const pt = (e) => { const b = o.root.getBoundingClientRect(); const k = b.width / (o.root.offsetWidth || b.width) || 1; return [(e.clientX - b.left) / k, (e.clientY - b.top) / k]; };

    // ----- 스크롤(손가락 한 개): 직접 밀고, 놓으면 관성으로 더 미끄러진다 -----
    function scrollerEl() {
      let e = o.root.parentElement;
      while (e && e !== document.body && e !== document.documentElement) {
        const cs = getComputedStyle(e);
        if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1) return e;
        e = e.parentElement;
      }
      return null;
    }
    const scrollBy = (dy) => { const e = scrollerEl(); if (e) e.scrollTop += dy; else window.scrollBy(0, dy); };
    const stopInertia = () => { if (inertia) cancelAnimationFrame(inertia); inertia = 0; };
    function startInertia(v) {
      stopInertia();
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(40, now - last);
        last = now;
        scrollBy(v * dt);
        v *= Math.pow(0.94, dt / 16);
        inertia = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
      };
      inertia = requestAnimationFrame(step);
    }

    // ----- 두 손가락 확대: 화면 글자 크기를 바꿔 준다(줄에 붙은 필기는 그대로 따라간다). 끝나면 원래 크기로 돌아간다 -----
    function zoomStep(d) {
      if (!o.zoom) return;
      const cur = o.zoom.get();
      const ns = clamp(cur + d, ZMIN, ZMAX);
      if (ns !== cur) o.zoom.set(ns);
    }
    function startPinch() {
      if (!o.zoom) return;
      const [a, b] = [...touches.values()];
      stopInertia();
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, size: o.zoom.get(), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, s: 1, rb: o.root.getBoundingClientRect(), tf: o.root.style.transform, to: o.root.style.transformOrigin };
    }
    function movePinch() {
      const [a, b] = [...touches.values()];
      const ns = clamp(Math.round((pinch.size * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d), ZMIN, ZMAX);
      pinch.s = ns / pinch.size;
      o.root.style.transformOrigin = `${pinch.cx - pinch.rb.left}px ${pinch.cy - pinch.rb.top}px`;
      o.root.style.transform = `scale(${pinch.s})`;
    }
    function endPinch() {
      if (!pinch) return;
      const p = pinch;
      pinch = null;
      o.root.style.transform = p.tf;
      o.root.style.transformOrigin = p.to;
      const ns = clamp(Math.round(p.size * p.s), ZMIN, ZMAX);
      if (ns === o.zoom.get()) return;
      const fy = (p.cy - p.rb.top) / (p.rb.height || 1); // 손가락 가운데가 가리키던 악보 안 세로 위치(비율)
      o.zoom.set(ns);
      requestAnimationFrame(() => {
        const r = o.root.getBoundingClientRect();
        scrollBy(r.top + fy * r.height - p.cy);
      });
    }

    // ----- 지우개: 닿는 즉시 지운다. 닿는 곳에 ○ 표시 -----
    const segD = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    const wch = (l) => [...l].reduce((s, c) => s + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.58), 0);
    function textBox(g) {
      const it = g.it, fs = (it.z / 10000) * g.r.w, L = String(it.s).split('\n');
      return { x: g.r.x + (it.x / 10000) * g.r.w, y: g.r.y + (it.y / 1000) * g.r.h, w: Math.max(...L.map(wch)) * fs, h: L.length * fs * 1.25 };
    }
    const nearBox = (b, x, y, m) => Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.w)), Math.max(b.y - y, 0, y - (b.y + b.h))) <= m;
    function hitErase(x, y) {
      const dead = new Set();
      for (const g of o.geo) {
        if (g.key !== target.key) continue;
        const it = g.it;
        if (it.t === 'x') { if (nearBox(textBox(g), x, y, ER)) dead.add(it.id); continue; }
        const wpx = ((it.w / 10) * g.r.w) / 1000;
        const P = (i) => [g.r.x + (it.p[i] / 10000) * g.r.w, g.r.y + (it.p[i + 1] / 1000) * g.r.h];
        for (let i = 0; i < it.p.length; i += 2) {
          const a = P(i), b = i + 2 < it.p.length ? P(i + 2) : a;
          if (segD(x, y, a[0], a[1], b[0], b[1]) <= ER + wpx / 2) { dead.add(it.id); break; }
        }
      }
      return dead;
    }
    function eraseAt(x, y) {
      const fresh = [...hitErase(x, y)].filter((id) => !act.erased.has(id));
      if (!fresh.length) return;
      fresh.forEach((id) => act.erased.add(id));
      const f = new Set(fresh);
      target.data.items = target.data.items.filter((i) => !f.has(i.id));
      S.querySelectorAll('g[data-id]').forEach((g) => { if (f.has(g.getAttribute('data-id'))) g.remove(); });
      o.geo = o.geo.filter((g) => !f.has(g.id));
    }
    function showCursor(x, y) {
      if (!ec || !ec.isConnected) {
        ec = document.createElementNS(NS, 'circle');
        ec.setAttribute('r', ER);
        ec.setAttribute('fill', 'rgba(255,255,255,.35)');
        ec.setAttribute('stroke', '#e11d48');
        ec.setAttribute('stroke-width', '1.5');
        ec.setAttribute('stroke-dasharray', '3 2');
        ec.setAttribute('pointer-events', 'none');
        S.appendChild(ec);
      }
      ec.setAttribute('cx', x.toFixed(1));
      ec.setAttribute('cy', y.toFixed(1));
      ec.removeAttribute('display');
    }
    function hideCursor() { if (ec) ec.setAttribute('display', 'none'); }

    // ----- 획: 쓰는 중 보이는 모습 = 뗀 뒤 모습 (같은 변환을 거친다) -----
    function buildStroke(a) {
      const r = a.r;
      const pts = a.pts.map(([x, y]) => [((x - r.x) / r.w) * 10000, ((y - r.y) / r.h) * 1000]);
      const ratio = r.h / 1000 / (r.w / 10000);
      let eps = 4;
      let sp = simplify(pts, ratio, eps);
      while (sp.length > 2800 && eps < 200) { eps *= 1.6; sp = simplify(pts, ratio, eps); }
      const p = [];
      for (const q of sp) p.push(Math.round(q[0]), Math.round(q[1]));
      if (p.length === 2) p.push(p[0], p[1]);
      return { id: uid(), t: a.tool === 'pen' ? 's' : 'h', c: opts[a.tool].c, w: a.w, p, a: anchorOf(a.el) };
    }
    function paintLive() {
      if (liveRaf) return;
      liveRaf = requestAnimationFrame(() => {
        liveRaf = 0;
        if (!act || !act.pts) return;
        if (!liveG || !liveG.isConnected) { liveG = document.createElementNS(NS, 'g'); liveG.setAttribute('pointer-events', 'none'); S.appendChild(liveG); }
        const r = act.r, sc = r.w / 1000;
        liveG.setAttribute('transform', `translate(${r.x.toFixed(1)},${r.y.toFixed(1)}) scale(${sc.toFixed(4)})`);
        liveG.innerHTML = itemSVG(buildStroke(act), 1000, (10 * r.h) / sc);
      });
    }
    function clearLive() { if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; } if (liveG) { liveG.remove(); liveG = null; } }

    // ----- 글자: 놓을 자리를 표시하고, 끌어서 옮기고, 입력창에서 고친다 -----
    function drawExtras() {
      if (!S || !S.isConnected) return;
      S.querySelectorAll('.cink-ex').forEach((n) => n.remove());
      const ex = o.ex;
      if (!ex) return;
      const el = lineFor(ex.item.a);
      if (!el) return;
      const r = relPos(el, o.root);
      if (!r.w || !r.h) return;
      const sc = r.w / 1000;
      let g = '';
      if (ex.item.s && ex.item.s.trim()) g += `<g transform="translate(${r.x.toFixed(1)},${r.y.toFixed(1)}) scale(${sc.toFixed(4)})">${itemSVG(ex.item, 1000, (10 * r.h) / sc)}</g>`;
      if (ex.mark) {
        const mx = r.x + (ex.item.x / 10000) * r.w, my = r.y + (ex.item.y / 1000) * r.h;
        g += `<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="10" fill="rgba(255,255,255,.6)" stroke="#e11d48" stroke-width="1.5" stroke-dasharray="3 2"/><path d="M${(mx - 16).toFixed(1)} ${my.toFixed(1)}h32M${mx.toFixed(1)} ${(my - 16).toFixed(1)}v32" stroke="#e11d48" stroke-width="1"/>`;
      }
      S.insertAdjacentHTML('beforeend', `<g class="cink-ex" pointer-events="none">${g}</g>`);
    }
    function textLive(item, mark) { o.ex = { item, mark }; drawExtras(); }
    // 점(x,y)이 놓인 줄에 글자를 붙이고, 줄 안 좌표를 다시 계산한다
    function placeAt(item, x, y, scope) {
      const n = nearest(x, y);
      if (!n) return;
      item.a = anchorOf(n.el, scope);
      item.x = Math.round(((x - n.r.x) / n.r.w) * 10000);
      item.y = Math.round(((y - n.r.y) / n.r.h) * 1000);
    }
    function renderTxtBar() {
      pnl.querySelector('[data-r="opt"]').innerHTML = PEN_COLORS.map((c) => `<button type="button" class="sw${txt.c === c ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="색"></button>`).join('') + TEXT_SIZES.map((z, i) => `<button type="button" class="${txt.z === z ? 'on' : ''}" data-z="${z}" style="font-size:${12 + i * 4}px">가</button>`).join('');
    }
    function revealMark() {
      if (!txt) return;
      const el = lineFor(txt.a);
      if (!el) return;
      const r = relPos(el, o.root), rb = o.root.getBoundingClientRect();
      const k = rb.width / (o.root.offsetWidth || rb.width) || 1;
      const my = rb.top + (r.y + (txt.y / 1000) * r.h) * k;
      const limit = pnl.getBoundingClientRect().top - 70;
      if (my > limit) scrollBy(my - limit);
    }
    function fitVV() {
      if (!txt) return;
      const vv = window.visualViewport;
      const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      pnl.style.bottom = `${kb + 8}px`;
      revealMark();
    }
    function openText(it, at) {
      txt = it ? { ...it, isNew: false } : { id: uid(), t: 'x', a: null, x: 0, y: 0, c: opts.tx.c, z: TEXT_SIZES[opts.tx.z], s: '', isNew: true };
      if (!it) { placeAt(txt, at[0], at[1]); if (!txt.a) { txt = null; return; } }
      $ta.value = txt.s;
      o.hideId = it ? it.id : null;
      bar.style.display = 'none';
      pnl.hidden = false;
      // 탭한 뒤에 따라오는 클릭이 방금 나타난 입력창의 버튼을 누르지 않도록 잠깐 막는다
      pnl.style.pointerEvents = 'none';
      setTimeout(() => { pnl.style.pointerEvents = ''; }, 450);
      pnl.querySelector('[data-x="del"]').hidden = txt.isNew;
      document.body.classList.add('cink-txt-on');
      renderTxtBar();
      cdraw(o);
      textLive(txt, true);
      setTimeout(() => { fitVV(); $ta.focus(); }, 30);
    }
    function closeText() {
      txt = null;
      o.ex = null;
      o.hideId = null;
      pnl.hidden = true;
      bar.style.display = '';
      document.body.classList.remove('cink-txt-on');
      try { $ta.blur(); } catch {}
    }
    $ta.addEventListener('input', () => { if (txt) { txt.s = $ta.value; textLive(txt, true); } });
    pnl.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b || !txt) return;
      const d = b.dataset;
      if (d.c) { txt.c = d.c; renderTxtBar(); textLive(txt, true); return; }
      if (d.z) { txt.z = +d.z; opts.tx.z = Math.max(0, TEXT_SIZES.indexOf(+d.z)); renderTxtBar(); textLive(txt, true); return; }
      if (d.x === 'cancel') { closeText(); cdraw(o); paint(); return; }
      const sn = snapNow();
      const old = target.data.items.find((i) => i.id === txt.id);
      if (d.x === 'del') {
        if (old) target.data = { v: 1, items: target.data.items.filter((i) => i.id !== old.id), del: [...(target.data.del || []), old.id].slice(-2000) };
        closeText();
        await commit(old ? sn : null);
        return;
      }
      if (d.x === 'ok') {
        const s = $ta.value.replace(/\s+$/, '');
        if (!s.trim()) {
          if (old) target.data = { v: 1, items: target.data.items.filter((i) => i.id !== old.id), del: [...(target.data.del || []), old.id].slice(-2000) };
          closeText();
          await commit(old ? sn : null);
          return;
        }
        const it = { id: txt.id, t: 'x', c: txt.c, x: txt.x, y: txt.y, z: txt.z, s: s.slice(0, 300), a: txt.a };
        if (old) target.data.items = target.data.items.map((i) => (i.id === it.id ? it : i));
        else target.data.items.push(it);
        if (txt.isNew) opts.tx.c = it.c;
        closeText();
        await commit(sn);
      }
    };
    const vvFn = () => fitVV();
    if (window.visualViewport) { visualViewport.addEventListener('resize', vvFn); visualViewport.addEventListener('scroll', vvFn); }
    function hitText(x, y) {
      for (let i = o.geo.length - 1; i >= 0; i--) {
        const g = o.geo[i];
        if (g.key !== target.key || g.it.t !== 'x') continue;
        if (nearBox(textBox(g), x, y, 6)) return g;
      }
      return null;
    }

    // ----- 선택·기본 동작 막기: 필기 중 글자 선택·돋보기·스크리블로 넘어가 획이 끊기지 않게 -----
    S = o.svg;
    cdraw(o);
    S = o.svg;
    o.afterDraw = drawExtras;
    o.busy = () => !!act || !!pinch;
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((n) => S.addEventListener(n, (e) => { e.stopPropagation(); if (e.cancelable) e.preventDefault(); }, { passive: false }));
    const noSel = (e) => { if (e.type === 'contextmenu') tellOnce('ctx', '펜·손가락의 보조 신호(contextmenu)를 받았어요.'); e.preventDefault(); };
    ['selectstart', 'contextmenu', 'dragstart', 'gesturestart'].forEach((n) => { S.addEventListener(n, noSel); o.root.addEventListener(n, noSel); });
    o.root.classList.add('cink-editing');
    try { const g = window.getSelection && window.getSelection(); if (g) g.removeAllRanges(); } catch {}
    function cancelAct() {
      if (act && act.erase && act.erased.size) { target.data = { v: 1, items: target.data.items, del: [...(target.data.del || []), ...act.erased].slice(-2000) }; commit(act.snap); }
      if (act && act.tmove && act.tmove.moved) { o.hideId = null; o.ex = null; cdraw(o); }
      clearLive();
      act = null;
    }
    S.onpointerdown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const pen = e.pointerType === 'pen';
      penSignal(e);
      if (e.pointerType === 'touch') {
        if (penDown) { ignore.add(e.pointerId); return; } // 펜으로 쓰는 중에 닿은 손바닥은 무시
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size >= 2) { cancelAct(); startPinch(); return; }
        if (!opts.finger) { stopInertia(); act = { id: e.pointerId, scroll: true, y: e.clientY, t: performance.now(), v: 0, moved: false }; return; }
      }
      if (pen) { penDown = true; touches.clear(); pinch = null; cancelAct(); }
      e.preventDefault();
      try { S.setPointerCapture(e.pointerId); } catch {}
      stopInertia();
      const [x, y] = pt(e);
      if (txt) { // 글자 입력창이 열려 있으면 어디를 눌러도 글자 자리가 그리로 옮겨진다(누른 채 끌어도 따라온다)
        act = { id: e.pointerId, drag: true };
        placeAt(txt, x, y, txt.isNew ? opts.scope : txt.a && txt.a.o ? 'this' : 'all');
        textLive(txt, true);
        return;
      }
      let tool = opts.tool;
      if (pen && e.buttons & 32) tool = 'er'; // 펜의 지우개 끝
      if (pen && e.buttons & 2) { swapTool(); return; } // 펜 버튼으로 펜↔지우개 전환
      const n = nearest(x, y);
      if (!n) return;
      if (tool === 'er') {
        act = { id: e.pointerId, erase: true, erased: new Set(), snap: snapNow() };
        eraseAt(x, y);
        showCursor(x, y);
        return;
      }
      if (tool === 'tx') {
        const hit = hitText(x, y);
        if (hit) {
          const b = textBox(hit);
          act = { id: e.pointerId, tmove: hit, ox: b.x - x, oy: b.y - y, sx: x, sy: y, moved: false, draft: { ...hit.it } };
        } else act = { id: e.pointerId, tnew: true, sx: x, sy: y, moved: false };
        return;
      }
      act = { id: e.pointerId, tool, pts: [[x, y]], r: n.r, el: n.el, w: WIDTHS[tool][opts[tool].w], snap: snapNow() };
      paintLive();
    };
    function hover(e) {
      if (opts.tool === 'er' && (e.pointerType === 'pen' || e.pointerType === 'mouse') && !txt) { const [x, y] = pt(e); showCursor(x, y); }
      else hideCursor();
    }
    S.onpointermove = (e) => {
      if (ignore.has(e.pointerId)) return;
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) { movePinch(); return; }
      }
      if (!act || act.id !== e.pointerId) { hover(e); return; }
      if (act.scroll) {
        const now = performance.now(), dy = act.y - e.clientY, dt = Math.max(1, now - act.t);
        act.v = 0.7 * act.v + 0.3 * (dy / dt);
        act.t = now;
        act.y = e.clientY;
        if (Math.abs(dy) > 0) act.moved = true;
        scrollBy(dy);
        return;
      }
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        if (e.buttons && !ev.buttons) continue; // 펜이 닿기 전 공중(호버) 위치가 묶여 오면 버린다
        const [x, y] = pt(ev);
        if (act.drag) { if (txt) placeAt(txt, x, y, txt.isNew ? opts.scope : txt.a && txt.a.o ? 'this' : 'all'); }
        else if (act.erase) { eraseAt(x, y); showCursor(x, y); }
        else if (act.tmove) {
          if (!act.moved && Math.hypot(x - act.sx, y - act.sy) > 6) { act.moved = true; o.hideId = act.tmove.it.id; cdraw(o); }
          if (act.moved) placeAt(act.draft, x + act.ox, y + act.oy, act.draft.a && act.draft.a.o ? 'this' : 'all');
        } else if (act.tnew) { if (Math.hypot(x - act.sx, y - act.sy) > 8) act.moved = true; }
        else if (act.pts) {
          const l = act.pts[act.pts.length - 1];
          if (Math.hypot(x - l[0], y - l[1]) >= 1.2) act.pts.push([x, y]);
        }
      }
      if (act.drag && txt) textLive(txt, true);
      else if (act.tmove && act.moved) textLive(act.draft, false);
      else if (act.pts) paintLive();
    };
    S.onpointerleave = (e) => { if (e.pointerType !== 'touch') hideCursor(); };
    const end = async (e) => {
      if (ignore.delete(e.pointerId)) return;
      if (e.pointerType === 'pen') penDown = false;
      if (e.pointerType === 'touch') {
        touches.delete(e.pointerId);
        if (pinch) {
          if (touches.size < 2) { endPinch(); touches.forEach((_, id) => ignore.add(id)); touches.clear(); } // 남은 한 손가락은 뗄 때까지 무시
          return;
        }
      }
      if (!act || act.id !== e.pointerId) return;
      const a = act;
      act = null;
      if (a.scroll) { if (a.moved && performance.now() - a.t < 90 && Math.abs(a.v) > 0.08) startInertia(a.v); return; }
      if (a.drag) return;
      if (a.erase) {
        if (e.pointerType === 'touch') hideCursor();
        if (a.erased.size) {
          target.data = { v: 1, items: target.data.items, del: [...(target.data.del || []), ...a.erased].slice(-2000) };
          await commit(a.snap);
        }
        return;
      }
      if (a.tnew) { if (!a.moved && e.type !== 'pointercancel') openText(null, [a.sx, a.sy]); return; }
      if (a.tmove) {
        if (e.type === 'pointercancel') { o.hideId = null; o.ex = null; cdraw(o); return; }
        if (!a.moved) { openText(a.tmove.it, null); return; }
        const sn = snapNow();
        target.data.items = target.data.items.map((i) => (i.id === a.draft.id ? { ...a.draft } : i));
        o.hideId = null;
        o.ex = null;
        await commit(sn);
        return;
      }
      clearLive();
      if (!a.pts || a.pts.length < 1) return; // 취소(pointercancel)돼도 그린 만큼은 남긴다
      const it = buildStroke(a);
      if (it.p.length < 2) return;
      target.data.items.push(it);
      await commit(a.snap);
    };
    S.onpointerup = end;
    S.onpointercancel = end;

    // ----- 키보드(맥북): ⌘Z 되돌리기, ⌘⇧Z 다시, E 펜↔지우개 -----
    const onKey = (e) => {
      if (e.target && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.code === 'KeyE') { e.preventDefault(); swapTool(); }
    };
    document.addEventListener('keydown', onKey);

    // ----- 화면을 떠나면 도구 줄도 닫는다(다른 메뉴로 가거나, 코드 악보가 가려지거나, 악보가 바뀌었을 때) -----
    const guard = setInterval(() => { if (!o.root.isConnected || !o.root.offsetWidth) stop(); }, 400);
    const onNav = () => stop();
    window.addEventListener('hashchange', onNav);
    window.addEventListener('pagehide', onNav);
    function stop() {
      if (!o.editing) return;
      cancelAct();
      closeText();
      o.editing = false;
      clearInterval(guard);
      stopInertia();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('pagehide', onNav);
      if (window.visualViewport) { visualViewport.removeEventListener('resize', vvFn); visualViewport.removeEventListener('scroll', vvFn); }
      if (S) S.onpointerdown = S.onpointermove = S.onpointerup = S.onpointercancel = S.onpointerleave = null;
      o.afterDraw = null;
      o.busy = null;
      o.ex = null;
      o.hideId = null;
      bar.remove();
      pnl.remove();
      if (dbgBox) { dbgBox.remove(); dbgBox = null; }
      if (pinch) { o.root.style.transform = pinch.tf; o.root.style.transformOrigin = pinch.to; pinch = null; }
      o.root.classList.remove('cink-editing');
      document.body.classList.remove('cink-on', 'cink-txt-on');
      document.documentElement.style.removeProperty('--cink-h');
      if (o.zoom && origSize && o.zoom.get() !== origSize) o.zoom.set(origSize); // 확대는 필기하는 동안만
      cdraw(o);
      cload(o);
      if (o.onStop) o.onStop();
    }
    o.stop = stop;
    document.body.classList.add('cink-on');
  }

  function init(c) {
    cfg = { ...cfg, ...c };
    window.addEventListener('online', flush);
    setTimeout(flush, 1500);
    shLoad();
  }

  window.Ink = {
    init, edit, codeView, attachImg, decorate, pull, pullSetlist, flush, get, save, mountVaultCard, hasVault, wipeLocal, mergeInk, simplify,
    // 31차: 팀 공유 필기
    shared: { pull: pullShared, pullSoon: pullSharedSoon, rows: () => sh.rows.filter((r) => r.team_id === cfg.teamId()), authors: shAuthors, isOn: () => sh.on, setOn: shSetOn, toggleAuthor: shToggleAuthor, me: shMe, myCount: shMyCount, up: shUp, down: shDown, load: shLoad },
  };
})();
