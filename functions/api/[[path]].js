// Everyday Worship Songbook — API (Cloudflare Pages Functions)
// 접속암호 로그인, 팀(가입코드·팀장 PIN), 콘티, 관리자, 곡 목록/보기/저장/삭제, 악보 파일(이미지·PDF) 업로드.
// 필요한 설정: D1 바인딩 DB, R2 바인딩 BUCKET(이미지 악보용), 환경변수 CHURCH_CODE (필수), ADMIN_PIN (필수에 가까움: 관리자 화면·악보 편집),
//              INVITE_CODE (선택: 처음 쓰는 팀 생성용 초대코드. 이후엔 관리자 화면에서 바꿀 수 있음)

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- 토큰 (HMAC 서명) ----------
function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function hmacKey(env) {
  // 접속암호나 관리자 PIN을 바꾸면 기존 토큰이 자동으로 무효가 된다.
  const secret = env.TOKEN_SECRET || `${env.CHURCH_CODE}|${env.ADMIN_PIN || ''}|ews-v1`;
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signPayload(env, payload) {
  const body = b64uEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return body + '.' + b64uEncode(new Uint8Array(sig));
}
function signToken(env, role, days, extra) {
  return signPayload(env, { ...(extra || {}), r: role, exp: Math.floor(Date.now() / 1000) + Math.floor(days * 86400) });
}
// 서명이 맞고 만료되지 않았으면 내용(payload)을, 아니면 null
async function readToken(env, token) {
  try {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64uDecode(sig), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64uDecode(body)));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
async function verifyToken(env, token, role) {
  const p = await readToken(env, token);
  return !!p && p.r === role;
}

// ---------- 악보 파일(R2) ----------
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_SONG = 30;
const FILE_TYPES = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image', 'application/pdf': 'pdf' };
function magicOk(type, buf) {
  const u = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  const at = (i, s) => [...s].every((c, k) => u[i + k] === c.charCodeAt(0));
  if (type === 'image/jpeg') return u[0] === 0xff && u[1] === 0xd8;
  if (type === 'image/png') return u[0] === 0x89 && at(1, 'PNG');
  if (type === 'image/gif') return at(0, 'GIF8');
  if (type === 'image/webp') return at(0, 'RIFF') && at(8, 'WEBP');
  if (type === 'application/pdf') return at(0, '%PDF');
  return false;
}
function requireBucket(env) {
  if (!env.BUCKET) throw new HttpError(500, '이미지 저장소(R2)가 연결되지 않았습니다. 설치 안내의 R2 연결 단계(변수 이름: BUCKET)를 확인해 주세요.');
}
// 파일은 <img> 로 바로 불러야 하므로, 한두 시간 유효한 서명 주소를 만들어 준다.
// (같은 시간대에는 같은 주소가 나와서 브라우저 캐시가 잘 먹는다)
async function fileUrl(env, fid) {
  const exp = (Math.floor(Date.now() / 3600000) + 2) * 3600;
  return `/api/files/${fid}?s=${await signPayload(env, { r: 'file', f: fid, exp })}`;
}
async function songFiles(env, songId) {
  const { results } = await env.DB.prepare('SELECT id,kind FROM song_files WHERE song_id=? ORDER BY id').bind(songId).all();
  return Promise.all(results.map(async (f) => ({ id: f.id, kind: f.kind, url: await fileUrl(env, f.id) })));
}
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- PIN 해시 (PBKDF2) ----------
const PBKDF2_ITER = 100000; // Cloudflare Workers가 허용하는 최대값
async function pbkdf2(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64uEncode(salt)}$${b64uEncode(await pbkdf2(pin, salt, PBKDF2_ITER))}`;
}
async function verifyPin(pin, stored) {
  try {
    const [alg, iter, salt, hash] = String(stored || '').split('$');
    if (alg !== 'pbkdf2') return false;
    const n = Math.min(parseInt(iter, 10) || PBKDF2_ITER, PBKDF2_ITER);
    return await safeEqual(b64uEncode(await pbkdf2(pin, b64uDecode(salt), n)), hash);
  } catch {
    return false;
  }
}
async function shortHash(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 헷갈리는 글자(0/O, 1/I/L)를 뺀 8자리 코드
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(len = 8) {
  const u = crypto.getRandomValues(new Uint8Array(len));
  return [...u].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const normCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

// ---------- DB 초기화 (처음 한 번 자동으로 표 생성, 필요한 칸은 안전하게 추가) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    original_key TEXT NOT NULL DEFAULT '',
    tempo INTEGER,
    youtube_url TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    chordpro TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS song_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    chordpro TEXT NOT NULL,
    edited_by_team INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_song_versions_song ON song_versions(song_id)`,
  `CREATE TABLE IF NOT EXISTS song_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    kind TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    join_code TEXT NOT NULL,
    leader_pin_hash TEXT,
    can_edit_songs INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS setlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    date TEXT,
    title TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_setlists_team ON setlists(team_id, date)`,
  `CREATE TABLE IF NOT EXISTS setlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setlist_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    form TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_setlist_items_list ON setlist_items(setlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_setlist_items_song ON setlist_items(song_id)`,
  // 팀별 곡 기본 키
  `CREATE TABLE IF NOT EXISTS team_song_keys (
    team_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY (team_id, song_id)
  )`,
  // 앱 설정값(초대코드를 관리자 화면에서 바꾸면 여기에 저장)
  `CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`,
  // PIN·초대코드 무작위 대입 방지
  `CREATE TABLE IF NOT EXISTS auth_fails (
    k TEXT PRIMARY KEY,
    n INTEGER NOT NULL DEFAULT 0,
    until INTEGER NOT NULL DEFAULT 0
  )`,
];
// 이미 운영 중인 표에는 CREATE TABLE IF NOT EXISTS 로 칸이 늘지 않으므로, 없는 칸만 ALTER 로 추가한다.
async function ensureColumn(db, table, column, ddl) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (results.some((c) => c.name === column)) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  } catch (e) {
    if (!/duplicate column/i.test(String((e && e.message) || e))) throw e; // 다른 요청이 먼저 추가했다면 괜찮다
  }
}
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  // 콘티 항목에서 코드 악보/이미지 악보 중 무엇을 보여 줄지: auto | chord | image
  await ensureColumn(db, 'setlist_items', 'view', `"view" TEXT NOT NULL DEFAULT 'auto'`);
  schemaReady = true;
}

// ---------- 공통 ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const bearer = (request) => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
const nowIso = () => new Date().toISOString();

// ---------- 로그인 시도 제한 ----------
const MAX_FAILS = 5;
const LOCK_SECONDS = 600;
async function throttleCheck(db, key) {
  const row = await db.prepare('SELECT until FROM auth_fails WHERE k=?').bind(key).first();
  const left = row ? row.until - Math.floor(Date.now() / 1000) : 0;
  if (left > 0) throw new HttpError(429, `시도 횟수가 너무 많습니다. ${Math.ceil(left / 60)}분 뒤에 다시 해 주세요.`);
}
async function throttleFail(db, key) {
  const row = await db.prepare('SELECT n FROM auth_fails WHERE k=?').bind(key).first();
  const n = (row ? row.n : 0) + 1;
  const locked = n >= MAX_FAILS;
  const until = locked ? Math.floor(Date.now() / 1000) + LOCK_SECONDS : 0;
  await db.prepare('INSERT INTO auth_fails (k,n,until) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET n=excluded.n, until=excluded.until').bind(key, locked ? 0 : n, until).run();
  await sleep(500);
}
async function throttleOk(db, key) {
  await db.prepare('DELETE FROM auth_fails WHERE k=?').bind(key).run();
}

// ---------- 권한 확인 ----------
// 요청 하나에서 "누구인지"를 한 번만 계산한다.
//  member: 교회 접속암호 통과 / admin: 관리자 PIN 통과 / team: 소속 팀 / leader: 그 팀의 팀장 PIN 통과
const ctxCache = new WeakMap();
async function getCtx(env, request) {
  if (ctxCache.has(request)) return ctxCache.get(request);
  const ctx = { member: false, admin: false, team: null, leader: false };
  ctxCache.set(request, ctx);
  ctx.member = await verifyToken(env, bearer(request), 'member');
  ctx.admin = !!env.ADMIN_PIN && (await verifyToken(env, request.headers.get('X-Admin-Token') || '', 'admin'));
  const getTeam = (id) => (Number.isInteger(id) ? env.DB.prepare('SELECT * FROM teams WHERE id=?').bind(id).first() : null);
  // 팀장 토큰: 팀장 PIN이 바뀌면 자동으로 무효
  const lt = await readToken(env, request.headers.get('X-Leader-Token') || '');
  if (lt && lt.r === 'leader') {
    const t = await getTeam(lt.t);
    if (t && t.leader_pin_hash && lt.p === (await shortHash(t.leader_pin_hash))) {
      ctx.team = t;
      ctx.leader = true;
    }
  }
  // 팀원 토큰: 가입코드를 다시 발급하면 자동으로 무효
  if (!ctx.team) {
    const tt = await readToken(env, request.headers.get('X-Team-Token') || '');
    if (tt && tt.r === 'team') {
      const t = await getTeam(tt.t);
      if (t && tt.j === (await shortHash(t.join_code))) ctx.team = t;
    }
  }
  return ctx;
}
// 악보 편집: 관리자, 또는 관리자가 편집 권한을 켜 준 팀의 팀장
const canEdit = (ctx) => ctx.admin || (ctx.leader && ctx.team.can_edit_songs === 1);
function requireEdit(env, ctx) {
  if (canEdit(ctx)) return;
  throw new HttpError(
    403,
    env.ADMIN_PIN
      ? '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력하거나, 관리자에게 팀장 편집 권한을 요청해 주세요.'
      : '악보를 편집하려면 관리자 PIN이 필요합니다. Cloudflare 환경변수 ADMIN_PIN을 설정해 주세요. (설치 안내 참고)'
  );
}
function requireAdmin(env, ctx) {
  if (!env.ADMIN_PIN) throw new HttpError(400, '관리자 PIN이 설정되어 있지 않습니다. (ADMIN_PIN 환경변수)');
  if (!ctx.admin) throw new HttpError(403, '관리자 PIN을 입력해 주세요.');
}
const requireTeam = (ctx) => {
  if (!ctx.team) throw new HttpError(403, '먼저 팀에 가입해 주세요.');
};
const requireLeader = (ctx) => {
  if (!ctx.leader) throw new HttpError(403, '팀장만 할 수 있습니다. 팀 화면에서 팀장 PIN을 입력해 주세요.');
};

// 초대코드: 관리자 화면에서 바꾸면 DB 값이 우선, 없으면 환경변수 INVITE_CODE
async function getInvite(env) {
  const row = await env.DB.prepare(`SELECT v FROM settings WHERE k='invite_code'`).first();
  return row ? row.v : String(env.INVITE_CODE || '').trim();
}
function cleanPin(v) {
  const pin = typeof v === 'string' ? v.trim() : '';
  if (pin.length < 4 || pin.length > 30) throw new HttpError(400, 'PIN은 4자 이상으로 입력해 주세요.');
  return pin;
}
function cleanName(v) {
  const name = typeof v === 'string' ? v.trim().slice(0, 40) : '';
  if (!name) throw new HttpError(400, '팀 이름을 입력해 주세요.');
  return name;
}
async function newJoinCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(8);
    if (!(await db.prepare('SELECT id FROM teams WHERE join_code=?').bind(code).first())) return code;
  }
  throw new HttpError(500, '가입코드를 만들지 못했습니다. 다시 시도해 주세요.');
}
const teamToken = async (env, t) => signToken(env, 'team', 180, { t: t.id, j: await shortHash(t.join_code) });
const leaderToken = async (env, t) => signToken(env, 'leader', 30, { t: t.id, p: await shortHash(t.leader_pin_hash) });
const teamInfo = (t, ctx) => ({ id: t.id, name: t.name, isLeader: !!ctx.leader, canEditSongs: t.can_edit_songs === 1 });

const KEY_RE = /^[A-G][#b]?m?$/;
function cleanSong(body, { requireTitle = true } = {}) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const chordpro = typeof body.chordpro === 'string' ? body.chordpro.replace(/\r\n?/g, '\n') : '';
  if (chordpro.length > 60000) throw new HttpError(400, '악보 본문이 너무 깁니다.');
  let title = str(body.title, 200);
  if (!title) {
    const m = /\{\s*(?:title|t)\s*:\s*(.+?)\s*\}/i.exec(chordpro);
    if (m) title = m[1].slice(0, 200);
  }
  if (requireTitle && !title) throw new HttpError(400, '제목을 입력해 주세요.');
  let key = str(body.original_key, 4);
  if (!key) {
    const m = /\{\s*key\s*:\s*([A-G][#b]?m?)\s*\}/i.exec(chordpro);
    if (m) key = m[1];
  }
  if (key && !KEY_RE.test(key)) throw new HttpError(400, '원래 키는 G, Am, Bb 같은 형식으로 입력해 주세요.');
  let tempo = parseInt(body.tempo, 10);
  if (!Number.isFinite(tempo) || tempo < 20 || tempo > 300) tempo = null;
  let youtube = str(body.youtube_url, 500);
  if (youtube && !/^https?:\/\//i.test(youtube)) youtube = '';
  const tags = [...new Set(str(body.tags, 300).split(/[,，]/).map((t) => t.trim()).filter(Boolean))].join(',');
  return {
    title,
    artist: str(body.artist, 200),
    original_key: key,
    tempo,
    youtube_url: youtube,
    tags,
    chordpro,
    memo: str(body.memo, 2000),
  };
}
const normTitle = (s) => s.toLowerCase().replace(/[\s\-_.,!?'"()]/g, '');
const lyricsOnly = (chordpro) =>
  chordpro
    .split('\n')
    .filter((l) => !/^\s*\{.*\}\s*$/.test(l) && !/^\s*#/.test(l))
    .map((l) => l.replace(/\[[^\]]*\]/g, ''))
    .join(' ');

// ---------- 콘티 입력 정리 ----------
const MAX_SETLIST_ITEMS = 60;
const VIEWS = ['auto', 'chord', 'image'];
async function cleanSetlist(db, body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  let title = str(body.title, 100);
  if (!title && !date) throw new HttpError(400, '콘티 제목이나 날짜를 입력해 주세요.');
  if (!title) title = `${date} 콘티`;
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > MAX_SETLIST_ITEMS) throw new HttpError(400, `콘티에는 곡을 ${MAX_SETLIST_ITEMS}개까지 넣을 수 있습니다.`);
  const items = rawItems.map((it) => {
    const song_id = parseInt(it && it.song_id, 10);
    if (!Number.isInteger(song_id)) throw new HttpError(400, '곡 정보가 올바르지 않습니다.');
    const key = str(it.key, 4);
    if (key && !KEY_RE.test(key)) throw new HttpError(400, '키는 G, Am, Bb 같은 형식이어야 합니다.');
    return { song_id, key, form: str(it.form, 200), memo: str(it.memo, 500), view: VIEWS.includes(it.view) ? it.view : 'auto' };
  });
  if (items.length) {
    const ids = [...new Set(items.map((i) => i.song_id))];
    const { results } = await db.prepare(`SELECT id FROM songs WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    if (results.length !== ids.length) throw new HttpError(400, '삭제된 곡이 콘티에 들어 있습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
  }
  return { date, title, memo: str(body.memo, 2000), items };
}
const itemInserts = (db, setlistId, items) =>
  items.map((it, i) =>
    db.prepare('INSERT INTO setlist_items (setlist_id,position,song_id,key,form,memo,"view") VALUES (?,?,?,?,?,?,?)').bind(setlistId, i + 1, it.song_id, it.key, it.form, it.memo, it.view)
  );

// ---------- 라우팅 ----------
export async function onRequest({ request, env }) {
  try {
    if (!env.DB) throw new HttpError(500, 'D1 데이터베이스가 연결되지 않았습니다. (바인딩 변수 이름: DB) 설치 안내의 4단계를 확인해 주세요.');
    if (!env.CHURCH_CODE) throw new HttpError(500, '환경변수 CHURCH_CODE(교회 접속암호)가 설정되지 않았습니다. 설치 안내의 5단계를 확인해 주세요.');
    await ensureSchema(env.DB);

    const db = env.DB;
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const method = request.method;
    const readBody = async () => {
      try {
        return await request.json();
      } catch {
        throw new HttpError(400, '요청 형식이 올바르지 않습니다.');
      }
    };

    // 로그인 (토큰 불필요)
    if (parts[0] === 'login' && method === 'POST') {
      const { code } = await readBody();
      if (!(await safeEqual(code || '', env.CHURCH_CODE))) {
        await sleep(500);
        throw new HttpError(401, '접속암호가 맞지 않습니다.');
      }
      return json({ token: await signToken(env, 'member', 180) });
    }

    // 악보 파일 보기: <img src> 로 불러야 해서 헤더 대신 서명 주소(?s=)로 확인한다
    if (parts[0] === 'files' && parts[1] && method === 'GET') {
      const fid = parseInt(parts[1], 10);
      const p = await readToken(env, url.searchParams.get('s') || '');
      if (!Number.isInteger(fid) || !p || p.r !== 'file' || p.f !== fid) throw new HttpError(401, '파일 주소가 만료되었습니다. 곡 화면을 새로 고쳐 주세요.');
      requireBucket(env);
      const row = await db.prepare('SELECT r2_key FROM song_files WHERE id=?').bind(fid).first();
      const obj = row && (await env.BUCKET.get(row.r2_key));
      if (!obj) throw new HttpError(404, '파일을 찾을 수 없습니다.');
      return new Response(obj.body, {
        headers: {
          'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      });
    }

    // 이하 모두 교회 접속암호 로그인 필요
    const ctx = await getCtx(env, request);
    if (!ctx.member) throw new HttpError(401, '로그인이 필요합니다.');

    if (parts[0] === 'files' && parts[1] && method === 'DELETE') {
      requireEdit(env, ctx);
      const fid = parseInt(parts[1], 10);
      const row = Number.isInteger(fid) && (await db.prepare('SELECT r2_key FROM song_files WHERE id=?').bind(fid).first());
      if (!row) throw new HttpError(404, '파일을 찾을 수 없습니다.');
      await db.prepare('DELETE FROM song_files WHERE id=?').bind(fid).run();
      if (env.BUCKET) await env.BUCKET.delete(row.r2_key).catch(() => {});
      return json({ ok: true });
    }

    if (parts[0] === 'me' && method === 'GET') {
      return json({
        canEdit: canEdit(ctx),
        adminRequired: !!env.ADMIN_PIN,
        isAdmin: ctx.admin,
        team: ctx.team ? teamInfo(ctx.team, ctx) : null,
        inviteEnabled: !!(await getInvite(env)),
      });
    }

    // ===== 관리자 =====
    if (parts[0] === 'admin') {
      // 관리자 PIN 입력
      if (!parts[1] && method === 'POST') {
        if (!env.ADMIN_PIN) throw new HttpError(400, '관리자 PIN이 설정되어 있지 않습니다. (ADMIN_PIN 환경변수)');
        await throttleCheck(db, 'admin');
        const { pin } = await readBody();
        if (!(await safeEqual(pin || '', env.ADMIN_PIN))) {
          await throttleFail(db, 'admin');
          throw new HttpError(401, '관리자 PIN이 맞지 않습니다.');
        }
        await throttleOk(db, 'admin');
        return json({ adminToken: await signToken(env, 'admin', 30) });
      }

      requireAdmin(env, ctx);

      // 초대코드 확인 / 재발급
      if (parts[1] === 'invite') {
        if (method === 'GET') {
          const row = await db.prepare(`SELECT v FROM settings WHERE k='invite_code'`).first();
          return json({ code: await getInvite(env), source: row ? 'app' : env.INVITE_CODE ? 'env' : 'none' });
        }
        if (method === 'POST') {
          const code = randomCode(8);
          await db.prepare(`INSERT INTO settings (k,v) VALUES ('invite_code',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(code).run();
          return json({ code, source: 'app' });
        }
      }

      if (parts[1] === 'teams') {
        const tid = parts[2] ? parseInt(parts[2], 10) : null;
        if (parts[2] && !Number.isInteger(tid)) throw new HttpError(404, '팀을 찾을 수 없습니다.');

        if (!tid && method === 'GET') {
          const { results } = await db
            .prepare(
              `SELECT id,name,join_code,can_edit_songs,(leader_pin_hash IS NOT NULL) AS has_leader,
                (SELECT COUNT(*) FROM setlists l WHERE l.team_id = teams.id) AS setlist_count
               FROM teams ORDER BY id`
            )
            .all();
          return json({ teams: results.map((t) => ({ ...t, can_edit_songs: t.can_edit_songs === 1, has_leader: !!t.has_leader })) });
        }
        // 관리자가 직접 팀 만들기(팀장 PIN 포함)
        if (!tid && method === 'POST') {
          const body = await readBody();
          const name = cleanName(body.name);
          const pinHash = await hashPin(cleanPin(body.pin));
          const code = await newJoinCode(db);
          const r = await db.prepare('INSERT INTO teams (name,join_code,leader_pin_hash,can_edit_songs) VALUES (?,?,?,0)').bind(name, code, pinHash).run();
          return json({ id: r.meta.last_row_id, join_code: code }, 201);
        }
        const team = tid && (await db.prepare('SELECT * FROM teams WHERE id=?').bind(tid).first());
        if (tid && !team) throw new HttpError(404, '팀을 찾을 수 없습니다.');

        // 이름 변경 / 악보 편집 권한 켜기·끄기
        if (tid && !parts[3] && method === 'PUT') {
          const body = await readBody();
          const name = body.name === undefined ? team.name : cleanName(body.name);
          const can = body.can_edit_songs === undefined ? team.can_edit_songs : body.can_edit_songs ? 1 : 0;
          await db.prepare('UPDATE teams SET name=?, can_edit_songs=? WHERE id=?').bind(name, can, tid).run();
          return json({ ok: true });
        }
        // 가입코드 재발급(기존 팀원은 다시 가입코드를 입력해야 함)
        if (tid && parts[3] === 'join-code' && method === 'POST') {
          const code = await newJoinCode(db);
          await db.prepare('UPDATE teams SET join_code=? WHERE id=?').bind(code, tid).run();
          return json({ join_code: code });
        }
        // 팀장 지정(재지정): 새 PIN을 정하면 이전 팀장 로그인은 모두 풀린다
        if (tid && parts[3] === 'leader-pin' && method === 'POST') {
          const pinHash = await hashPin(cleanPin((await readBody()).pin));
          await db.prepare('UPDATE teams SET leader_pin_hash=? WHERE id=?').bind(pinHash, tid).run();
          await throttleOk(db, 'leader:' + tid);
          return json({ ok: true });
        }
        if (tid && !parts[3] && method === 'DELETE') {
          await db.batch([
            db.prepare('DELETE FROM setlist_items WHERE setlist_id IN (SELECT id FROM setlists WHERE team_id=?)').bind(tid),
            db.prepare('DELETE FROM setlists WHERE team_id=?').bind(tid),
            db.prepare('DELETE FROM team_song_keys WHERE team_id=?').bind(tid),
            db.prepare('UPDATE song_versions SET edited_by_team=NULL WHERE edited_by_team=?').bind(tid),
            db.prepare('DELETE FROM teams WHERE id=?').bind(tid),
          ]);
          return json({ ok: true });
        }
      }
      throw new HttpError(404, '요청한 주소를 찾을 수 없습니다.');
    }

    // ===== 팀 가입 / 만들기 =====
    if (parts[0] === 'teams' && method === 'POST') {
      // 가입코드로 팀원 입장
      if (parts[1] === 'join') {
        const { code } = await readBody();
        const c = normCode(code);
        const t = c && (await db.prepare('SELECT * FROM teams WHERE join_code=?').bind(c).first());
        if (!t) {
          await sleep(500);
          throw new HttpError(404, '가입코드가 맞지 않습니다. 팀장에게 확인해 주세요.');
        }
        return json({ teamToken: await teamToken(env, t), team: { id: t.id, name: t.name } });
      }
      // 초대코드로 새 팀 만들기: 만든 사람이 팀장
      if (!parts[1]) {
        const invite = await getInvite(env);
        if (!invite) throw new HttpError(400, '팀 만들기가 아직 열려 있지 않습니다. 관리자에게 초대코드를 요청해 주세요.');
        await throttleCheck(db, 'invite');
        const body = await readBody();
        if (!(await safeEqual(String(body.invite || '').trim(), invite))) {
          await throttleFail(db, 'invite');
          throw new HttpError(401, '초대코드가 맞지 않습니다.');
        }
        await throttleOk(db, 'invite');
        const name = cleanName(body.name);
        const pinHash = await hashPin(cleanPin(body.pin));
        const code = await newJoinCode(db);
        const r = await db.prepare('INSERT INTO teams (name,join_code,leader_pin_hash,can_edit_songs) VALUES (?,?,?,0)').bind(name, code, pinHash).run();
        const t = await db.prepare('SELECT * FROM teams WHERE id=?').bind(r.meta.last_row_id).first();
        return json({ teamToken: await teamToken(env, t), leaderToken: await leaderToken(env, t), team: { id: t.id, name: t.name }, joinCode: code }, 201);
      }
    }

    // ===== 내 팀 =====
    if (parts[0] === 'team') {
      requireTeam(ctx);
      const t = ctx.team;

      if (!parts[1] && method === 'GET') {
        return json({ team: { ...teamInfo(t, ctx), ...(ctx.leader ? { join_code: t.join_code } : {}) } });
      }
      // 팀장 PIN 입력
      if (parts[1] === 'leader-login' && method === 'POST') {
        if (!t.leader_pin_hash) throw new HttpError(400, '이 팀에는 팀장이 지정되어 있지 않습니다. 관리자에게 문의해 주세요.');
        const key = 'leader:' + t.id;
        await throttleCheck(db, key);
        const { pin } = await readBody();
        if (!(await verifyPin(String(pin || '').trim(), t.leader_pin_hash))) {
          await throttleFail(db, key);
          throw new HttpError(401, '팀장 PIN이 맞지 않습니다.');
        }
        await throttleOk(db, key);
        return json({ leaderToken: await leaderToken(env, t) });
      }
      if (parts[1] === 'join-code' && method === 'POST') {
        requireLeader(ctx);
        const code = await newJoinCode(db);
        await db.prepare('UPDATE teams SET join_code=? WHERE id=?').bind(code, t.id).run();
        const nt = { ...t, join_code: code };
        // 재발급한 사람의 기기는 바로 새 코드로 이어서 쓸 수 있게 토큰도 새로 준다
        return json({ join_code: code, teamToken: await teamToken(env, nt) });
      }
      if (parts[1] === 'leader-pin' && method === 'POST') {
        requireLeader(ctx);
        const body = await readBody();
        if (!(await verifyPin(String(body.current || '').trim(), t.leader_pin_hash))) {
          await sleep(500);
          throw new HttpError(401, '현재 PIN이 맞지 않습니다.');
        }
        const hash = await hashPin(cleanPin(body.pin));
        await db.prepare('UPDATE teams SET leader_pin_hash=? WHERE id=?').bind(hash, t.id).run();
        return json({ leaderToken: await leaderToken(env, { ...t, leader_pin_hash: hash }) });
      }
      // 곡별 "우리 팀 기본 키"
      if (parts[1] === 'keys' && parts[2] && method === 'PUT') {
        requireLeader(ctx);
        const sid = parseInt(parts[2], 10);
        if (!Number.isInteger(sid)) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const { key } = await readBody();
        const k = typeof key === 'string' ? key.trim() : '';
        if (k && !KEY_RE.test(k)) throw new HttpError(400, '키는 G, Am, Bb 같은 형식이어야 합니다.');
        if (!(await db.prepare('SELECT id FROM songs WHERE id=?').bind(sid).first())) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        if (k) {
          await db.prepare('INSERT INTO team_song_keys (team_id,song_id,key) VALUES (?,?,?) ON CONFLICT(team_id,song_id) DO UPDATE SET key=excluded.key').bind(t.id, sid, k).run();
        } else {
          await db.prepare('DELETE FROM team_song_keys WHERE team_id=? AND song_id=?').bind(t.id, sid).run();
        }
        return json({ ok: true, key: k });
      }
      throw new HttpError(404, '요청한 주소를 찾을 수 없습니다.');
    }

    // ===== 콘티 (열람: 그 팀 팀원, 편집: 그 팀 팀장) =====
    if (parts[0] === 'setlists') {
      requireTeam(ctx);
      const team = ctx.team;
      const lid = parts[1] ? parseInt(parts[1], 10) : null;
      if (parts[1] && !Number.isInteger(lid)) throw new HttpError(404, '콘티를 찾을 수 없습니다.');

      if (!lid && method === 'GET') {
        const { results } = await db
          .prepare(
            `SELECT l.id,l.date,l.title,l.memo,
              (SELECT COUNT(*) FROM setlist_items i WHERE i.setlist_id = l.id) AS item_count
             FROM setlists l WHERE l.team_id=? ORDER BY COALESCE(l.date,'') DESC, l.id DESC`
          )
          .bind(team.id)
          .all();
        return json({ setlists: results, canEdit: ctx.leader });
      }

      if (!lid && method === 'POST') {
        requireLeader(ctx);
        const s = await cleanSetlist(db, await readBody());
        const now = nowIso();
        const r = await db.prepare('INSERT INTO setlists (team_id,date,title,memo,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(team.id, s.date, s.title, s.memo, now, now).run();
        const id = r.meta.last_row_id;
        if (s.items.length) await db.batch(itemInserts(db, id, s.items));
        return json({ id }, 201);
      }

      // 이 팀의 콘티만 접근 가능
      const list = lid && (await db.prepare('SELECT * FROM setlists WHERE id=? AND team_id=?').bind(lid, team.id).first());
      if (lid && !list) throw new HttpError(404, '콘티를 찾을 수 없습니다.');

      if (lid && method === 'GET') {
        const { results } = await db
          .prepare(
            `SELECT i.id,i.position,i.song_id,i.key,i.form,i.memo,i."view" AS view,
              s.title,s.original_key,s.chordpro,
              (SELECT COUNT(*) FROM song_files f WHERE f.song_id = i.song_id) AS file_count
             FROM setlist_items i LEFT JOIN songs s ON s.id = i.song_id
             WHERE i.setlist_id=? ORDER BY i.position`
          )
          .bind(lid)
          .all();
        const { results: tk } = await db.prepare('SELECT song_id,key FROM team_song_keys WHERE team_id=?').bind(team.id).all();
        const tkMap = Object.fromEntries(tk.map((r) => [r.song_id, r.key]));
        const items = results.map(({ chordpro, ...it }) => ({ ...it, title: it.title || '(삭제된 곡)', has_chords: /\S/.test(chordpro || ''), team_key: tkMap[it.song_id] || '' }));
        return json({ setlist: { id: list.id, date: list.date, title: list.title, memo: list.memo, items }, canEdit: ctx.leader });
      }

      if (lid && method === 'PUT') {
        requireLeader(ctx);
        const s = await cleanSetlist(db, await readBody());
        await db.batch([
          db.prepare('UPDATE setlists SET date=?,title=?,memo=?,updated_at=? WHERE id=?').bind(s.date, s.title, s.memo, nowIso(), lid),
          db.prepare('DELETE FROM setlist_items WHERE setlist_id=?').bind(lid),
          ...itemInserts(db, lid, s.items),
        ]);
        return json({ id: lid });
      }

      if (lid && method === 'DELETE') {
        requireLeader(ctx);
        await db.batch([db.prepare('DELETE FROM setlist_items WHERE setlist_id=?').bind(lid), db.prepare('DELETE FROM setlists WHERE id=?').bind(lid)]);
        return json({ ok: true });
      }
    }

    // ===== 곡 =====
    if (parts[0] === 'songs') {
      const id = parts[1] ? parseInt(parts[1], 10) : null;
      if (parts[1] && !Number.isInteger(id)) throw new HttpError(404, '곡을 찾을 수 없습니다.');

      // 목록 + 검색(제목·아티스트·태그·가사)
      if (!id && method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const { results } = await db
          .prepare(
            `SELECT id,title,artist,original_key,tempo,tags,chordpro,updated_at,
              (SELECT COUNT(*) FROM song_files f WHERE f.song_id = songs.id) AS file_count,
              (SELECT group_concat(DISTINCT kind) FROM song_files f WHERE f.song_id = songs.id) AS file_kinds
             FROM songs ORDER BY title`
          )
          .all();
        let tkMap = {};
        if (ctx.team) {
          const { results: tk } = await db.prepare('SELECT song_id,key FROM team_song_keys WHERE team_id=?').bind(ctx.team.id).all();
          tkMap = Object.fromEntries(tk.map((r) => [r.song_id, r.key]));
        }
        const songs = results
          .filter((s) => !q || [s.title, s.artist, s.tags, lyricsOnly(s.chordpro)].join(' ').toLowerCase().includes(q))
          .map((s) => {
            const { chordpro, ...rest } = s;
            return { ...rest, file_kinds: rest.file_kinds || '', has_chords: /\S/.test(chordpro), team_key: tkMap[s.id] || '' };
          });
        return json({ songs });
      }

      // 악보 파일(이미지·PDF) 올리기: 본문 자체가 파일 내용이다
      if (id && parts[2] === 'files' && method === 'POST') {
        requireEdit(env, ctx);
        requireBucket(env);
        if (!(await db.prepare('SELECT id FROM songs WHERE id=?').bind(id).first())) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
        const kind = FILE_TYPES[type];
        if (!kind) throw new HttpError(400, '이미지(JPG·PNG·WEBP·GIF) 또는 PDF만 올릴 수 있습니다.');
        if (parseInt(request.headers.get('Content-Length') || '0', 10) > MAX_FILE_BYTES) throw new HttpError(413, '파일이 너무 큽니다. (최대 25MB)');
        const buf = await request.arrayBuffer();
        if (!buf.byteLength) throw new HttpError(400, '빈 파일입니다.');
        if (buf.byteLength > MAX_FILE_BYTES) throw new HttpError(413, '파일이 너무 큽니다. (최대 25MB)');
        if (!magicOk(type, buf)) throw new HttpError(400, '파일 내용이 형식과 맞지 않습니다.');
        const cnt = await db.prepare('SELECT COUNT(*) AS n FROM song_files WHERE song_id=?').bind(id).first();
        if (cnt.n >= MAX_FILES_PER_SONG) throw new HttpError(400, `곡 하나에는 파일을 ${MAX_FILES_PER_SONG}개까지 올릴 수 있습니다.`);
        const key = `songs/${id}/${crypto.randomUUID()}`;
        await env.BUCKET.put(key, buf, { httpMetadata: { contentType: type } });
        let fid;
        try {
          const r = await db.prepare('INSERT INTO song_files (song_id,r2_key,kind) VALUES (?,?,?)').bind(id, key, kind).run();
          fid = r.meta.last_row_id;
        } catch (e) {
          await env.BUCKET.delete(key).catch(() => {});
          throw e;
        }
        await db.prepare('UPDATE songs SET updated_at=? WHERE id=?').bind(nowIso(), id).run();
        return json({ file: { id: fid, kind, url: await fileUrl(env, fid) } }, 201);
      }

      // 새 곡
      if (!id && method === 'POST') {
        requireEdit(env, ctx);
        const body = await readBody();
        const song = cleanSong(body);
        if (!body.force) {
          const { results } = await db.prepare('SELECT id,title FROM songs').all();
          const dup = results.find((s) => normTitle(s.title) === normTitle(song.title));
          if (dup) throw new HttpError(409, '같은 제목의 곡이 이미 있습니다.', { duplicate: dup });
        }
        const now = nowIso();
        const r = await db
          .prepare(
            `INSERT INTO songs (title,artist,original_key,tempo,youtube_url,tags,chordpro,memo,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(song.title, song.artist, song.original_key, song.tempo, song.youtube_url, song.tags, song.chordpro, song.memo, now, now)
          .run();
        return json({ id: r.meta.last_row_id }, 201);
      }

      if (id && method === 'GET') {
        const song = await db.prepare('SELECT * FROM songs WHERE id=?').bind(id).first();
        if (!song) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        song.files = await songFiles(env, id);
        song.team_key = '';
        if (ctx.team) {
          const tk = await db.prepare('SELECT key FROM team_song_keys WHERE team_id=? AND song_id=?').bind(ctx.team.id, id).first();
          song.team_key = tk ? tk.key : '';
        }
        return json({ song });
      }

      if (id && method === 'PUT') {
        requireEdit(env, ctx);
        const old = await db.prepare('SELECT chordpro FROM songs WHERE id=?').bind(id).first();
        if (!old) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const song = cleanSong(await readBody());
        const now = nowIso();
        const stmts = [];
        if (old.chordpro !== song.chordpro) {
          // 바뀌기 전 본문을 수정 이력에 보관 (되돌리기 화면은 3차에서 추가). 팀장이 고쳤다면 그 팀 번호도 남긴다.
          stmts.push(
            db.prepare('INSERT INTO song_versions (song_id,chordpro,edited_by_team,created_at) VALUES (?,?,?,?)').bind(id, old.chordpro, ctx.admin || !ctx.team ? null : ctx.team.id, now)
          );
        }
        stmts.push(
          db
            .prepare('UPDATE songs SET title=?,artist=?,original_key=?,tempo=?,youtube_url=?,tags=?,chordpro=?,memo=?,updated_at=? WHERE id=?')
            .bind(song.title, song.artist, song.original_key, song.tempo, song.youtube_url, song.tags, song.chordpro, song.memo, now, id)
        );
        await db.batch(stmts);
        return json({ id });
      }

      if (id && method === 'DELETE') {
        requireEdit(env, ctx);
        const { results: files } = await db.prepare('SELECT r2_key FROM song_files WHERE song_id=?').bind(id).all();
        await db.batch([
          db.prepare('DELETE FROM song_versions WHERE song_id=?').bind(id),
          db.prepare('DELETE FROM song_files WHERE song_id=?').bind(id),
          // 콘티·팀 기본 키에 남은 흔적도 함께 정리한다
          db.prepare('DELETE FROM setlist_items WHERE song_id=?').bind(id),
          db.prepare('DELETE FROM team_song_keys WHERE song_id=?').bind(id),
          db.prepare('DELETE FROM songs WHERE id=?').bind(id),
        ]);
        if (env.BUCKET && files.length) await env.BUCKET.delete(files.map((f) => f.r2_key)).catch(() => {});
        return json({ ok: true });
      }
    }

    throw new HttpError(404, '요청한 주소를 찾을 수 없습니다.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    return json({ error: '서버 오류가 발생했습니다: ' + (e && e.message ? e.message : e) }, 500);
  }
}
