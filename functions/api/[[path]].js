// Everyday Worship Songbook — API (Cloudflare Pages Functions)
// 접속암호 로그인, 팀(가입코드·팀장 PIN), 콘티, 관리자, 곡 목록/보기/저장/삭제, 악보 파일(이미지·PDF) 업로드.
// 필요한 설정: D1 바인딩 DB, R2 바인딩 BUCKET(이미지 악보용), 환경변수 CHURCH_CODE (필수), ADMIN_PIN (필수에 가까움: 관리자 화면·악보 편집),
//              INVITE_CODE (선택: 처음 쓰는 팀 생성용 초대코드. 이후엔 관리자 화면에서 바꿀 수 있음)

import Sections from '../../public/sections.js'; // 구간 이름 사전 (화면과 같은 파일을 쓴다)

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
const newUid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
const UID_RE = /^[0-9a-f]{12}$/;
const normCode = (s) => String(s || '').toUpperCase().replace(/[\s-]/g, '');

// ---------- 개인 보관함 · 필기 ----------
const VAULT_CODE_LEN = 12; // 31^12 가지 (화면에는 4자씩 끊어 보여 준다)
const MAX_INK_BYTES = 400000; // 악보 한 장의 필기 최대 크기
const MAX_INK_ITEMS = 3000;
const MAX_VAULT_PAGES = 1500; // 보관함 하나에 필기를 둘 수 있는 악보 장 수
async function vaultHash(code) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('ews-vault|' + normCode(code))));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const fmtVaultCode = (c) => String(c).replace(/(.{4})(?=.)/g, '$1-');
// 필기 덩어리를 받아 허용된 모양만 남긴다.
//  획: {id,t:'s'|'h',c:색,w:굵기(가로폭 대비 만분율),p:[x,y,x,y…](0~10000 정수)}
//  글자: {id,t:'x',x,y,c,z:글자 크기(만분율),s:내용}
function cleanInk(raw) {
  const inum = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(raw && raw.items) ? raw.items.slice(0, MAX_INK_ITEMS) : []) {
    if (!it || typeof it.id !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(it.id) || seen.has(it.id)) continue;
    const c = /^#[0-9a-fA-F]{6}$/.test(it.c) ? it.c : '#222222';
    if (it.t === 's' || it.t === 'h') {
      if (!Array.isArray(it.p) || it.p.length < 2 || it.p.length > 6000 || it.p.length % 2) continue;
      items.push({ id: it.id, t: it.t, c, w: inum(it.w, 1, 400), p: it.p.map((n) => inum(n, 0, 10000)) });
    } else if (it.t === 'x') {
      const s = String(it.s == null ? '' : it.s).slice(0, 300);
      if (!s.trim()) continue;
      items.push({ id: it.id, t: 'x', c, x: inum(it.x, 0, 10000), y: inum(it.y, 0, 10000), z: inum(it.z, 60, 600), s });
    } else continue;
    seen.add(it.id);
  }
  const del = (Array.isArray(raw && raw.del) ? raw.del : []).filter((d) => typeof d === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(d)).slice(-2000);
  return { v: 1, items, del };
}
// 다른 기기에서 먼저 저장된 필기와 합친다: 지운 것은 계속 지운 채로, 같은 번호면 새로 온 것을 쓴다.
function mergeInk(a, b) {
  const del = new Set([...(a.del || []), ...(b.del || [])]);
  const map = new Map();
  for (const it of [...(a.items || []), ...(b.items || [])]) if (!del.has(it.id)) map.set(it.id, it);
  return { v: 1, items: [...map.values()].slice(0, MAX_INK_ITEMS), del: [...del].slice(-2000) };
}
async function vaultFromRequest(env, request) {
  const t = await readToken(env, request.headers.get('X-Vault-Token') || '');
  if (!t || t.r !== 'vault') return null;
  const row = await env.DB.prepare('SELECT id, code_hash FROM vaults WHERE id=?').bind(t.v).first();
  if (!row || t.h !== (await shortHash(row.code_hash))) return null;
  return row;
}
const vaultToken = async (env, row) => signToken(env, 'vault', 400, { v: row.id, h: await shortHash(row.code_hash) });

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
  // 팀별 예배 종류(kind='service': 주일오전예배 …, extra=기본 요일 0~6)와 인도자 목록(kind='leader')
  `CREATE TABLE IF NOT EXISTS team_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    extra TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_team_options_team ON team_options(team_id, kind)`,
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
  // 개인 보관함(15차): 코드를 아는 기기끼리 필기를 나눠 쓴다. 코드는 해시로만 저장한다.
  `CREATE TABLE IF NOT EXISTS vaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )`,
  // 이미지 악보 한 장(file_id)당 필기 한 덩어리. rev는 저장할 때마다 1씩 늘어 기기 간 충돌을 알아챈다.
  `CREATE TABLE IF NOT EXISTS vault_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'ink',
    song_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (vault_id, kind, file_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vault_items_song ON vault_items(vault_id, song_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vault_items_file ON vault_items(file_id)`,
  // 콘티용 필기(16차): 콘티의 곡 한 칸(uid)마다, 악보 한 장(file_id)당 필기 한 덩어리
  `CREATE TABLE IF NOT EXISTS vault_sl_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vault_id INTEGER NOT NULL,
    uid TEXT NOT NULL,
    setlist_id INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    rev INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (vault_id, uid, file_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_vault_sl_setlist ON vault_sl_items(vault_id, setlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vault_sl_uid ON vault_sl_items(uid)`,
  `CREATE INDEX IF NOT EXISTS idx_vault_sl_file ON vault_sl_items(file_id)`,
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
  // 콘티 곡 한 칸의 고유 번호 (콘티용 필기가 이 번호에 붙는다)
  await ensureColumn(db, 'setlist_items', 'uid', `uid TEXT`);
  // 17차: 구간 용어를 영어로 통일(관리자 이관)할 때 바꾸기 전 송폼 글자를 한 번 보관한다
  await ensureColumn(db, 'setlist_items', 'form_prev', `form_prev TEXT`);
  // 원곡이 영어 등일 때 적어 두는 원제 / 이미지·PDF 악보 곡을 위한 "검색용 가사(후렴 등)"
  await ensureColumn(db, 'songs', 'orig_title', `orig_title TEXT NOT NULL DEFAULT ''`);
  await ensureColumn(db, 'songs', 'lyrics_extra', `lyrics_extra TEXT NOT NULL DEFAULT ''`);
  // 13차: 박자(4/4, 3/4, 6/8 …). 비어 있으면 아직 정하지 않은 곡
  await ensureColumn(db, 'songs', 'time_sig', `time_sig TEXT NOT NULL DEFAULT ''`);
  // 11차: 콘티의 예배 종류 / 인도자(이름 글자, 쉼표로 구분) / 임시(급하게 만든) 표시
  await ensureColumn(db, 'setlists', 'service_id', `service_id INTEGER`);
  await ensureColumn(db, 'setlists', 'leaders', `leaders TEXT NOT NULL DEFAULT ''`);
  await ensureColumn(db, 'setlists', 'is_temp', `is_temp INTEGER NOT NULL DEFAULT 0`);
  await addMidTempoOnce(db);
  schemaReady = true;
}
// 빠르기에 "중간곡" 추가 (6차에서 요청). 관리자가 이미 추천 목록을 저장해 두었다면 기본값이 적용되지 않으므로,
// 저장본의 "빠르기" 분류에 한 번만 끼워 넣는다. 이후 관리자가 지워도 다시 넣지 않는다.
async function addMidTempoOnce(db) {
  const done = await db.prepare(`SELECT v FROM settings WHERE k='mid_tempo_added'`).first();
  if (done) return;
  const row = await db.prepare(`SELECT v FROM settings WHERE k='tag_presets'`).first();
  if (row) {
    try {
      const list = JSON.parse(row.v);
      const g = Array.isArray(list) && list.find((x) => x && x.group === '빠르기');
      if (g && Array.isArray(g.items) && !g.items.includes('중간곡')) {
        const at = g.items.indexOf('빠른곡');
        g.items.splice(at >= 0 ? at + 1 : g.items.length, 0, '중간곡');
        await db.prepare(`UPDATE settings SET v=? WHERE k='tag_presets'`).bind(JSON.stringify(list)).run();
      }
    } catch {
      /* 저장값이 깨졌으면 건드리지 않는다 */
    }
  }
  await db.prepare(`INSERT OR REPLACE INTO settings (k,v) VALUES ('mid_tempo_added','1')`).run();
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
  // 박자: "4/4"처럼 (분자 1~16 / 분모 2·4·8·16). 14차부터 "3/4,4/4"처럼 쉼표로 여러 개(최대 4개, 적은 순서 유지)도 받는다.
  // 모양이 맞지 않는 항목은 버리고, 같은 박자는 한 번만 둔다.
  let timeSig = '';
  {
    const seen = [];
    for (const part of String(body.time_sig == null ? '' : body.time_sig).split(/[,，]/)) {
      const m = /^\s*(\d{1,2})\s*[\/／]\s*(\d{1,2})\s*$/.exec(part);
      if (!m || +m[1] < 1 || +m[1] > 16 || ![2, 4, 8, 16].includes(+m[2])) continue;
      const v = `${+m[1]}/${+m[2]}`;
      if (!seen.includes(v)) seen.push(v);
    }
    timeSig = seen.slice(0, 4).join(',');
  }
  let youtube = str(body.youtube_url, 500);
  if (youtube && !/^https?:\/\//i.test(youtube)) youtube = '';
  const tags = [...new Set(str(body.tags, 300).split(/[,，]/).map((t) => t.trim()).filter(Boolean))].join(',');
  const lyricsExtra = typeof body.lyrics_extra === 'string' ? body.lyrics_extra.replace(/\r\n?/g, '\n').trim().slice(0, 3000) : '';
  return {
    title,
    orig_title: str(body.orig_title, 200),
    lyrics_extra: lyricsExtra,
    artist: str(body.artist, 200),
    original_key: key,
    tempo,
    time_sig: timeSig,
    youtube_url: youtube,
    tags,
    chordpro,
    memo: str(body.memo, 2000),
  };
}
// ---------- 검색 ----------
// 띄어쓰기·기호·대소문자를 모두 무시하고 비교한다. ("주님의 마음을" 은 "의마음" 으로도 찾아진다)
const searchKey = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
// 본문(ChordPro)에서 가사 줄만 뽑는다. 후렴 구간({soc}…{eoc} 또는 {comment: 후렴} 아래 한 덩어리)은 chorus 로 표시한다.
function lyricLines(chordpro) {
  const out = [];
  let inChorus = false;
  let commentChorus = false;
  for (const raw of String(chordpro || '').split('\n')) {
    const d = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/.exec(raw);
    if (d) {
      const name = d[1].toLowerCase();
      if (name === 'soc' || name === 'start_of_chorus') inChorus = true;
      else if (name === 'eoc' || name === 'end_of_chorus') inChorus = false;
      else if (['comment', 'c', 'comment_italic', 'ci'].includes(name)) commentChorus = (Sections.canon(d[2] || '') || {}).kind === 'C';
      continue;
    }
    if (/^\s*#/.test(raw)) continue;
    if (!raw.trim()) {
      commentChorus = false;
      continue;
    }
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (text) out.push({ text, chorus: inChorus || commentChorus });
  }
  return out;
}
const lyricsOnly = (chordpro) => lyricLines(chordpro).map((l) => l.text).join(' ');
// 검색어 → { all: 공백 없이 이은 전체, tokens: 단어별 }
function parseQuery(q) {
  const tokens = String(q || '').split(/\s+/).map(searchKey).filter(Boolean);
  return { all: tokens.join(''), tokens };
}
// 단어를 이은 전체가 들어 있거나, 모든 단어가 (순서와 상관없이) 들어 있으면 일치
const hasQuery = (hay, pq) => !!pq.all && (hay.includes(pq.all) || pq.tokens.every((t) => hay.includes(t)));
// 가사에서 일치한 부분: 한 줄 안에서 찾고, 없으면 이어진 두 줄에서 찾는다.
function findSnippet(lines, pq) {
  const keys = lines.map((l) => searchKey(l.text));
  for (let i = 0; i < lines.length; i++) if (hasQuery(keys[i], pq)) return lines[i];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (hasQuery(keys[i] + keys[i + 1], pq)) return { text: lines[i].text + ' / ' + lines[i + 1].text, chorus: lines[i].chorus && lines[i + 1].chorus };
  }
  for (let i = 0; i < lines.length; i++) if (pq.tokens.some((t) => keys[i].includes(t))) return lines[i];
  return null;
}
// 곡 하나가 검색어와 맞는지. 제목·원제·아티스트·태그에서 맞으면 rank 0, 가사(본문·검색용 가사)에서만 맞으면 rank 1.
function matchSong(s, pq) {
  const head = [s.title, s.orig_title, s.artist, s.tags].map(searchKey).join('');
  if (hasQuery(head, pq)) return { rank: 0 };
  const body = lyricLines(s.chordpro);
  const extra = (s.lyrics_extra || '').split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ text, extra: true }));
  const all = [...body, ...extra];
  const hay = head + all.map((l) => searchKey(l.text)).join('');
  if (!hasQuery(hay, pq)) return null;
  const sn = findSnippet(all, pq);
  const label = !sn ? '' : sn.extra ? '검색용 가사' : sn.chorus ? '후렴' : '가사';
  return { rank: 1, snippet: sn ? { text: sn.text.slice(0, 80), label } : null };
}

// ---------- 추천 태그 목록 (주제·빠르기·절기 …) ----------
// 곡의 태그는 자유롭게 쓰되, 아래 목록은 곡 편집·목록 필터에서 "추천 칩"으로 보여 준다.
// 관리자가 고친 목록은 settings.tag_presets 에 JSON으로 저장되고, 없으면 이 기본값을 쓴다.
const DEFAULT_PRESETS = [
  { group: '주제', items: ['찬양', '경배', '회개&보혈', '예수님', '성령님', '교회&하나님나라', '결단', '선포', '십자가&부활'] },
  { group: '빠르기', items: ['빠른곡', '중간곡', '느린곡'] },
  { group: '절기', items: ['성탄', '고난주간', '부활절', '성령강림절', '추수감사절', '송구영신'] },
];
const MAX_PRESET_GROUPS = 8;
const MAX_PRESET_ITEMS = 60;
const cleanTagName = (v) => (typeof v === 'string' ? v.replace(/[,，]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20) : '');
function cleanPresets(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, '추천 태그 목록 형식이 올바르지 않습니다.');
  if (raw.length > MAX_PRESET_GROUPS) throw new HttpError(400, `분류는 ${MAX_PRESET_GROUPS}개까지 만들 수 있습니다.`);
  const seenGroup = new Set();
  const out = [];
  for (const g of raw) {
    const group = cleanTagName(g && g.group).slice(0, 12);
    if (!group) throw new HttpError(400, '분류 이름을 입력해 주세요.');
    if (seenGroup.has(group)) throw new HttpError(400, `분류 이름이 겹칩니다: ${group}`);
    seenGroup.add(group);
    const items = [...new Set((Array.isArray(g.items) ? g.items : []).map(cleanTagName).filter(Boolean))];
    if (items.length > MAX_PRESET_ITEMS) throw new HttpError(400, `"${group}"에는 태그를 ${MAX_PRESET_ITEMS}개까지 넣을 수 있습니다.`);
    out.push({ group, items });
  }
  return out;
}
async function getPresets(db) {
  const row = await db.prepare(`SELECT v FROM settings WHERE k='tag_presets'`).first();
  if (row) {
    try {
      return cleanPresets(JSON.parse(row.v));
    } catch {
      /* 저장값이 깨졌으면 기본값 */
    }
  }
  return DEFAULT_PRESETS;
}
const splitTags = (s) => (s ? s.split(',').map((t) => t.trim()).filter(Boolean) : []);
// 곡의 태그를 추천 목록 순서(분류 순서 → 분류 안 순서)로 정렬한다. 추천에 없는 태그는 끝에 가나다순.
// 저장된 글자는 그대로 두고 읽을 때·저장할 때 정렬하므로, 관리자가 순서를 바꾸면 모든 곡의 표시 순서가 따라 바뀐다.
function makeTagOrder(presets) {
  const rank = new Map();
  let n = 0;
  for (const g of presets) for (const t of g.items) if (!rank.has(t)) rank.set(t, n++);
  return (tagStr) => {
    const list = [...new Set(splitTags(tagStr))];
    list.sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a) : Infinity;
      const rb = rank.has(b) ? rank.get(b) : Infinity;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b, 'ko');
    });
    return list.join(',');
  };
}
// 태그 이름 바꾸기·합치기·지우기: 모든 곡의 태그에 반영한다. to 가 비어 있으면 지운다.
async function renameTagInSongs(db, from, to) {
  const { results } = await db.prepare(`SELECT id,tags FROM songs WHERE tags <> ''`).all();
  const stmts = [];
  for (const r of results) {
    const list = splitTags(r.tags);
    if (!list.includes(from)) continue;
    const next = [...new Set(list.map((t) => (t === from ? to : t)).filter(Boolean))].join(',');
    stmts.push(db.prepare('UPDATE songs SET tags=? WHERE id=?').bind(next, r.id));
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}
// 한국 시간 기준 오늘 (YYYY-MM-DD)
const todayKst = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const MAX_VERSIONS_PER_SONG = 50;
// 곡마다 이력은 최근 50개까지만 보관(저장 공간 절약)
const pruneVersions = (db, songId) =>
  db
    .prepare('DELETE FROM song_versions WHERE song_id=? AND id NOT IN (SELECT id FROM song_versions WHERE song_id=? ORDER BY id DESC LIMIT ?)')
    .bind(songId, songId, MAX_VERSIONS_PER_SONG);

// ---------- 콘티 입력 정리 ----------
const MAX_SETLIST_ITEMS = 60;
const VIEWS = ['auto', 'chord', 'image'];
async function cleanSetlist(db, body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  // 제목은 비워도 된다. 화면에서 "제목 → 예배 종류 + 날짜 → 날짜 콘티" 순으로 대신 보여 준다.
  const title = str(body.title, 100);
  // 인도자: 이름 글자 목록(최대 8명, 한 명당 20자). 쉼표로 이어 저장한다.
  const rawLeaders = Array.isArray(body.leaders) ? body.leaders : typeof body.leaders === 'string' ? body.leaders.split(',') : [];
  const leaderNames = [];
  for (const n of rawLeaders) {
    const nm = typeof n === 'string' ? n.replace(/[,\n]/g, ' ').trim().slice(0, 20) : '';
    if (nm && !leaderNames.includes(nm)) leaderNames.push(nm);
  }
  if (leaderNames.length > 8) throw new HttpError(400, '인도자는 8명까지 지정할 수 있습니다.');
  const sid = parseInt(body.service_id, 10);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > MAX_SETLIST_ITEMS) throw new HttpError(400, `콘티에는 곡을 ${MAX_SETLIST_ITEMS}개까지 넣을 수 있습니다.`);
  const items = rawItems.map((it) => {
    const song_id = parseInt(it && it.song_id, 10);
    if (!Number.isInteger(song_id)) throw new HttpError(400, '곡 정보가 올바르지 않습니다.');
    const key = str(it.key, 4);
    if (key && !KEY_RE.test(key)) throw new HttpError(400, '키는 G, Am, Bb 같은 형식이어야 합니다.');
    return { song_id, key, form: str(it.form, 200), memo: str(it.memo, 500), view: VIEWS.includes(it.view) ? it.view : 'auto', uid: typeof it.uid === 'string' && UID_RE.test(it.uid) ? it.uid : '' };
  });
  if (items.length) {
    const ids = [...new Set(items.map((i) => i.song_id))];
    const { results } = await db.prepare(`SELECT id FROM songs WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    if (results.length !== ids.length) throw new HttpError(400, '삭제된 곡이 콘티에 들어 있습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.');
  }
  return { date, title, memo: str(body.memo, 2000), items, leaders: leaderNames.join(','), service_id: Number.isInteger(sid) ? sid : null, is_temp: body.is_temp ? 1 : 0 };
}
// 예배 종류는 이 팀 것만 쓸 수 있다. 없는 번호면 "미분류"(NULL)로 저장한다.
async function checkService(db, teamId, serviceId) {
  if (serviceId === null) return null;
  const row = await db.prepare(`SELECT id FROM team_options WHERE id=? AND team_id=? AND kind='service'`).bind(serviceId, teamId).first();
  return row ? serviceId : null;
}
// keep: 이 콘티에 이미 있던 uid 집합(수정할 때만). 없거나 겹치면 새 번호를 준다. 복사·새 콘티는 keep 이 비어 있어 항상 새 번호.
function itemInserts(db, setlistId, items, keep = new Set()) {
  const used = new Set();
  return items.map((it, i) => {
    let uid = it.uid && keep.has(it.uid) && !used.has(it.uid) ? it.uid : newUid();
    used.add(uid);
    it.uid = uid;
    return db.prepare('INSERT INTO setlist_items (setlist_id,position,song_id,key,form,memo,"view",uid) VALUES (?,?,?,?,?,?,?,?)').bind(setlistId, i + 1, it.song_id, it.key, it.form, it.memo, it.view, uid);
  });
}

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

    // ----- 개인 보관함(15차): 필기를 기기 사이에 나눠 쓴다. 교회 접속암호 로그인 + 보관함 코드가 모두 필요 -----
    if (parts[0] === 'vault') {
      // 새 보관함 만들기: 코드를 한 번만 보여 준다(서버에는 해시만 남는다)
      if (!parts[1] && method === 'POST') {
        for (let i = 0; i < 5; i++) {
          const code = randomCode(VAULT_CODE_LEN);
          const h = await vaultHash(code);
          try {
            const r = await db.prepare('INSERT INTO vaults (code_hash,created_at,last_seen) VALUES (?,?,?)').bind(h, nowIso(), nowIso()).run();
            const row = { id: r.meta.last_row_id, code_hash: h };
            return json({ code: fmtVaultCode(code), token: await vaultToken(env, row) }, 201);
          } catch (e) {
            if (!/unique|constraint/i.test(String((e && e.message) || e))) throw e;
          }
        }
        throw new HttpError(500, '보관함 코드를 만들지 못했습니다. 다시 시도해 주세요.');
      }
      // 다른 기기에서 코드로 들어오기
      if (parts[1] === 'join' && method === 'POST') {
        const { code } = await readBody();
        await throttleCheck(db, 'vault-join');
        const row = normCode(code).length === VAULT_CODE_LEN ? await db.prepare('SELECT id, code_hash FROM vaults WHERE code_hash=?').bind(await vaultHash(code)).first() : null;
        if (!row) {
          await throttleFail(db, 'vault-join');
          throw new HttpError(401, '보관함 코드가 맞지 않습니다. 글자를 다시 확인해 주세요.');
        }
        await throttleOk(db, 'vault-join');
        await db.prepare('UPDATE vaults SET last_seen=? WHERE id=?').bind(nowIso(), row.id).run();
        return json({ token: await vaultToken(env, row) });
      }
      const vault = await vaultFromRequest(env, request);
      if (!vault) throw new HttpError(401, '보관함에 들어가 있지 않습니다. 더보기에서 보관함 코드를 다시 입력해 주세요.', { vaultExpired: true });
      if (parts[1] === 'me' && method === 'GET') {
        const n = await db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT song_id) AS songs FROM vault_items WHERE vault_id=?').bind(vault.id).first();
        const m = await db.prepare('SELECT COUNT(*) AS n FROM vault_sl_items WHERE vault_id=?').bind(vault.id).first();
        return json({ ok: true, pages: n.n, songs: n.songs, slPages: m.n });
      }
      // 보관함 지우기: 이 보관함의 필기가 서버에서 모두 사라진다
      if (!parts[1] && method === 'DELETE') {
        await db.batch([db.prepare('DELETE FROM vault_items WHERE vault_id=?').bind(vault.id), db.prepare('DELETE FROM vault_sl_items WHERE vault_id=?').bind(vault.id), db.prepare('DELETE FROM vaults WHERE id=?').bind(vault.id)]);
        return json({ ok: true });
      }
      // 곡 하나의 필기 목록 (또는 ?all=1 로 전부)
      if (parts[1] === 'ink' && !parts[2] && method === 'GET') {
        const url2 = new URL(request.url);
        const sid = parseInt(url2.searchParams.get('song') || '', 10);
        const q = Number.isInteger(sid)
          ? db.prepare('SELECT file_id, song_id, rev, data FROM vault_items WHERE vault_id=? AND song_id=?').bind(vault.id, sid)
          : db.prepare('SELECT file_id, song_id, rev, data FROM vault_items WHERE vault_id=? ORDER BY id LIMIT 400').bind(vault.id);
        const { results } = await q.all();
        return json({ items: results.map((r) => ({ file_id: r.file_id, song_id: r.song_id, rev: r.rev, data: JSON.parse(r.data) })) });
      }
      // 악보 한 장의 필기 저장 (base_rev가 서버와 다르면 다른 기기에서 먼저 저장된 것이므로 합쳐서 돌려준다)
      if (parts[1] === 'ink' && parts[2] && method === 'PUT') {
        const fid = parseInt(parts[2], 10);
        const body = await readBody();
        const file = Number.isInteger(fid) && (await db.prepare(`SELECT id, song_id FROM song_files WHERE id=? AND kind='image'`).bind(fid).first());
        if (!file) throw new HttpError(404, '악보 이미지를 찾을 수 없습니다. (지워졌거나 PDF입니다)');
        const mine = cleanInk(body.data);
        const cur = await db.prepare(`SELECT rev, data FROM vault_items WHERE vault_id=? AND kind='ink' AND file_id=?`).bind(vault.id, fid).first();
        let data = mine;
        let rev = 1;
        if (cur) {
          rev = cur.rev + 1;
          if (Number(body.base_rev) !== cur.rev) data = mergeInk(JSON.parse(cur.data), mine);
        } else {
          const n = await db.prepare('SELECT (SELECT COUNT(*) FROM vault_items WHERE vault_id=?1) + (SELECT COUNT(*) FROM vault_sl_items WHERE vault_id=?1) AS n').bind(vault.id).first();
          if (n.n >= MAX_VAULT_PAGES) throw new HttpError(400, '보관함에 둘 수 있는 필기 장 수를 넘었습니다.');
        }
        const text = JSON.stringify(data);
        if (text.length > MAX_INK_BYTES) throw new HttpError(413, '이 악보 한 장에 필기가 너무 많습니다. 일부를 지우고 다시 저장해 주세요.');
        await db
          .prepare(`INSERT INTO vault_items (vault_id,kind,song_id,file_id,rev,data,updated_at) VALUES (?,'ink',?,?,?,?,?)
                    ON CONFLICT(vault_id,kind,file_id) DO UPDATE SET rev=excluded.rev, data=excluded.data, updated_at=excluded.updated_at, song_id=excluded.song_id`)
          .bind(vault.id, file.song_id, fid, rev, text, nowIso())
          .run();
        await db.prepare('UPDATE vaults SET last_seen=? WHERE id=?').bind(nowIso(), vault.id).run();
        return json({ rev, data });
      }
      // 콘티용 필기 목록: ?setlist=번호 (한 콘티) 또는 생략하면 전부
      if (parts[1] === 'ink-sl' && !parts[2] && method === 'GET') {
        const url2 = new URL(request.url);
        const lid2 = parseInt(url2.searchParams.get('setlist') || '', 10);
        const q = Number.isInteger(lid2)
          ? db.prepare('SELECT uid, setlist_id, file_id, song_id, rev, data FROM vault_sl_items WHERE vault_id=? AND setlist_id=?').bind(vault.id, lid2)
          : db.prepare('SELECT uid, setlist_id, file_id, song_id, rev, data FROM vault_sl_items WHERE vault_id=? ORDER BY id LIMIT 800').bind(vault.id);
        const { results } = await q.all();
        return json({ items: results.map((r) => ({ uid: r.uid, setlist_id: r.setlist_id, file_id: r.file_id, song_id: r.song_id, rev: r.rev, data: JSON.parse(r.data) })) });
      }
      // 콘티 곡 한 칸 + 악보 한 장의 콘티용 필기 저장 (규칙은 곡 기본 필기와 같다)
      if (parts[1] === 'ink-sl' && parts[2] && parts[3] && method === 'PUT') {
        const uid = String(parts[2]);
        const fid = parseInt(parts[3], 10);
        const body = await readBody();
        const slot = UID_RE.test(uid) && (await db.prepare('SELECT i.setlist_id, i.song_id FROM setlist_items i JOIN setlists l ON l.id=i.setlist_id WHERE i.uid=? AND l.team_id=?').bind(uid, ctx.team ? ctx.team.id : -1).first());
        if (!slot) throw new HttpError(404, '콘티의 곡을 찾을 수 없습니다. (콘티에서 빠졌거나 지워졌습니다)');
        const file = Number.isInteger(fid) && (await db.prepare(`SELECT id, song_id FROM song_files WHERE id=? AND kind='image'`).bind(fid).first());
        if (!file || file.song_id !== slot.song_id) throw new HttpError(404, '악보 이미지를 찾을 수 없습니다. (지워졌거나 PDF입니다)');
        const mine = cleanInk(body.data);
        const cur = await db.prepare('SELECT rev, data FROM vault_sl_items WHERE vault_id=? AND uid=? AND file_id=?').bind(vault.id, uid, fid).first();
        let data = mine;
        let rev = 1;
        if (cur) {
          rev = cur.rev + 1;
          if (Number(body.base_rev) !== cur.rev) data = mergeInk(JSON.parse(cur.data), mine);
        } else {
          const n = await db.prepare('SELECT (SELECT COUNT(*) FROM vault_items WHERE vault_id=?1) + (SELECT COUNT(*) FROM vault_sl_items WHERE vault_id=?1) AS n').bind(vault.id).first();
          if (n.n >= MAX_VAULT_PAGES) throw new HttpError(400, '보관함에 둘 수 있는 필기 장 수를 넘었습니다.');
        }
        const text = JSON.stringify(data);
        if (text.length > MAX_INK_BYTES) throw new HttpError(413, '이 악보 한 장에 필기가 너무 많습니다. 일부를 지우고 다시 저장해 주세요.');
        await db
          .prepare(`INSERT INTO vault_sl_items (vault_id,uid,setlist_id,song_id,file_id,rev,data,updated_at) VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(vault_id,uid,file_id) DO UPDATE SET rev=excluded.rev, data=excluded.data, updated_at=excluded.updated_at`)
          .bind(vault.id, uid, slot.setlist_id, file.song_id, fid, rev, text, nowIso())
          .run();
        await db.prepare('UPDATE vaults SET last_seen=? WHERE id=?').bind(nowIso(), vault.id).run();
        return json({ rev, data });
      }
      throw new HttpError(404, '요청한 주소를 찾을 수 없습니다.');
    }

    if (parts[0] === 'files' && parts[1] && method === 'DELETE') {
      requireEdit(env, ctx);
      const fid = parseInt(parts[1], 10);
      const row = Number.isInteger(fid) && (await db.prepare('SELECT r2_key FROM song_files WHERE id=?').bind(fid).first());
      if (!row) throw new HttpError(404, '파일을 찾을 수 없습니다.');
      await db.batch([db.prepare('DELETE FROM song_files WHERE id=?').bind(fid), db.prepare('DELETE FROM vault_items WHERE file_id=?').bind(fid), db.prepare('DELETE FROM vault_sl_items WHERE file_id=?').bind(fid)]);
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

    // 추천 태그 목록 + 태그별 곡 수 (곡 편집·목록 필터·관리자 화면에서 사용)
    if (parts[0] === 'tags' && !parts[1] && method === 'GET') {
      const { results } = await db.prepare(`SELECT tags FROM songs WHERE tags <> ''`).all();
      const usage = {};
      for (const r of results) for (const t of splitTags(r.tags)) usage[t] = (usage[t] || 0) + 1;
      return json({ presets: await getPresets(db), usage });
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

      // 백업 내려받기 (17차): 곡 전체와 콘티·콘티 곡(송폼 포함)을 JSON으로. 대량 변환(이관) 전에 받아 두는 용도.
      if (parts[1] === 'backup' && method === 'GET') {
        const songs = (await db.prepare('SELECT * FROM songs ORDER BY id').all()).results;
        const setlists = (await db.prepare('SELECT * FROM setlists ORDER BY id').all()).results;
        const setlist_items = (await db.prepare('SELECT * FROM setlist_items ORDER BY setlist_id, position').all()).results;
        return json({ exported_at: new Date().toISOString(), songs, setlists, setlist_items });
      }
      // 구간 용어 영어 통일 이관 (17차). GET = 미리 보기(바뀔 곡·콘티 수, 알아보지 못한 이름), POST = 실행.
      // 곡은 바꾸기 전 본문을 수정 이력 한 건으로 남기고, 콘티 송폼은 form_prev에 한 번 보관한다. 몇 번 눌러도 결과가 같다.
      if (parts[1] === 'migrate-sections' && (method === 'GET' || method === 'POST')) {
        const run = method === 'POST';
        const songRows = (await db.prepare('SELECT id,title,chordpro FROM songs').all()).results;
        const itemRows = (await db.prepare(`SELECT id,form FROM setlist_items WHERE form <> ''`).all()).results;
        const unknown = new Map();
        const addUnknown = (name) => unknown.set(name, (unknown.get(name) || 0) + 1);
        const songChanges = [];
        let lines = 0;
        for (const r of songRows) {
          const m = Sections.migrateChordPro(r.chordpro);
          m.unknown.forEach(addUnknown);
          if (m.changed) { songChanges.push({ id: r.id, old: r.chordpro, text: m.text }); lines += m.changed; }
        }
        const itemChanges = [];
        for (const r of itemRows) {
          const m = Sections.migrateForm(r.form);
          m.unknown.forEach(addUnknown);
          if (m.changed) itemChanges.push({ id: r.id, old: r.form, form: m.form });
        }
        const info = {
          songs: { total: songRows.length, changed: songChanges.length },
          items: { total: itemRows.length, changed: itemChanges.length },
          lines,
          unknown: [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
        };
        if (!run) {
          const row = await db.prepare(`SELECT v FROM settings WHERE k='sections_migrated'`).first();
          return json({ ...info, done_at: row ? row.v : '' });
        }
        const now = new Date().toISOString();
        const stmts = [];
        for (const c of songChanges) {
          stmts.push(db.prepare('INSERT INTO song_versions (song_id,chordpro,edited_by_team,created_at) VALUES (?,?,NULL,?)').bind(c.id, c.old, now));
          stmts.push(db.prepare('UPDATE songs SET chordpro=? WHERE id=?').bind(c.text, c.id));
          stmts.push(pruneVersions(db, c.id));
        }
        for (const c of itemChanges) {
          stmts.push(db.prepare('UPDATE setlist_items SET form_prev=COALESCE(form_prev,form), form=? WHERE id=?').bind(c.form, c.id));
        }
        for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
        await db.prepare(`INSERT INTO settings (k,v) VALUES ('sections_migrated',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(now).run();
        return json({ ...info, done_at: now, ran: true });
      }

      // 추천 태그 목록 저장 (관리자만)
      if (parts[1] === 'tags' && !parts[2] && method === 'PUT') {
        const presets = cleanPresets((await readBody()).presets);
        await db.prepare(`INSERT INTO settings (k,v) VALUES ('tag_presets',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(JSON.stringify(presets)).run();
        return json({ presets });
      }
      // 태그 이름 바꾸기 / 합치기 / 모든 곡에서 지우기(to 를 비우면 지움). 추천 목록에도 같이 반영한다.
      if (parts[1] === 'tags' && parts[2] === 'rename' && method === 'POST') {
        const body = await readBody();
        const from = cleanTagName(body.from);
        const to = cleanTagName(body.to);
        if (!from) throw new HttpError(400, '바꿀 태그를 골라 주세요.');
        const changed = await renameTagInSongs(db, from, to);
        const presets = (await getPresets(db)).map((g) => ({
          group: g.group,
          items: [...new Set(g.items.map((t) => (t === from ? to : t)).filter(Boolean))],
        }));
        await db.prepare(`INSERT INTO settings (k,v) VALUES ('tag_presets',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).bind(JSON.stringify(presets)).run();
        return json({ changed, presets });
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
            db.prepare('DELETE FROM vault_sl_items WHERE setlist_id IN (SELECT id FROM setlists WHERE team_id=?)').bind(tid),
            db.prepare('DELETE FROM setlist_items WHERE setlist_id IN (SELECT id FROM setlists WHERE team_id=?)').bind(tid),
            db.prepare('DELETE FROM setlists WHERE team_id=?').bind(tid),
            db.prepare('DELETE FROM team_song_keys WHERE team_id=?').bind(tid),
            db.prepare('DELETE FROM team_options WHERE team_id=?').bind(tid),
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
      // 곡별 "지난번 송폼" (6차): 콘티에 곡을 넣을 때 우리 팀이 가장 최근에 쓴 송폼을 한 번에 불러오기 위한 조회.
      // ?exclude=<콘티 번호> 로 지금 고치는 콘티는 빼고 찾는다. 송폼이 비어 있던 항목은 건너뛴다.
      if (parts[1] === 'last-forms' && method === 'GET') {
        const ex = parseInt(url.searchParams.get('exclude') || '', 10);
        const { results } = await db
          .prepare(
            `SELECT i.song_id AS song_id, i.form AS form
             FROM setlist_items i JOIN setlists l ON l.id = i.setlist_id
             WHERE l.team_id=? AND i.form <> '' AND l.id <> ?
             ORDER BY COALESCE(l.date,'') DESC, l.id DESC, i.position`
          )
          .bind(t.id, Number.isInteger(ex) ? ex : -1)
          .all();
        const forms = {};
        for (const r of results) if (!(r.song_id in forms)) forms[r.song_id] = r.form;
        return json({ forms });
      }
      // 예배 종류·인도자 목록 (열람: 팀원, 편집: 팀장)
      if (parts[1] === 'options') {
        const oid = parts[2] ? parseInt(parts[2], 10) : null;
        if (parts[2] && !Number.isInteger(oid)) throw new HttpError(404, '항목을 찾을 수 없습니다.');
        if (!oid && method === 'GET') {
          const { results } = await db.prepare('SELECT id,kind,name,extra,position FROM team_options WHERE team_id=? ORDER BY position, id').bind(t.id).all();
          return json({ services: results.filter((r) => r.kind === 'service'), leaders: results.filter((r) => r.kind === 'leader'), canEdit: ctx.leader });
        }
        if (!oid && method === 'POST') {
          requireLeader(ctx);
          const b = await readBody();
          const kind = b.kind === 'leader' ? 'leader' : b.kind === 'service' ? 'service' : '';
          if (!kind) throw new HttpError(400, '종류가 올바르지 않습니다.');
          const names = (Array.isArray(b.names) ? b.names : [b.name]).map((n) => (typeof n === 'string' ? n.replace(/[,\n]/g, ' ').trim().slice(0, 20) : '')).filter(Boolean);
          if (!names.length) throw new HttpError(400, '이름을 입력해 주세요.');
          const extra = kind === 'service' && /^[0-6]$/.test(String(b.extra ?? '')) ? String(b.extra) : '';
          const { results: ex } = await db.prepare('SELECT name,position FROM team_options WHERE team_id=? AND kind=?').bind(t.id, kind).all();
          if (ex.length + names.length > 40) throw new HttpError(400, '한 종류에 40개까지 등록할 수 있습니다.');
          let pos = ex.reduce((m, r) => Math.max(m, r.position), 0);
          const have = new Set(ex.map((r) => r.name));
          const stmts = [];
          for (const nm of names) {
            if (have.has(nm)) continue;
            have.add(nm);
            stmts.push(db.prepare('INSERT INTO team_options (team_id,kind,name,extra,position) VALUES (?,?,?,?,?)').bind(t.id, kind, nm, kind === 'service' && names.length === 1 ? extra : '', ++pos));
          }
          if (!stmts.length) throw new HttpError(409, '이미 있는 이름입니다.');
          await db.batch(stmts);
          return json({ ok: true }, 201);
        }
        if (oid) {
          const opt = await db.prepare('SELECT * FROM team_options WHERE id=? AND team_id=?').bind(oid, t.id).first();
          if (!opt) throw new HttpError(404, '항목을 찾을 수 없습니다.');
          if (method === 'PUT') {
            requireLeader(ctx);
            const b = await readBody();
            const name = typeof b.name === 'string' ? b.name.replace(/[,\n]/g, ' ').trim().slice(0, 20) : opt.name;
            if (!name) throw new HttpError(400, '이름을 입력해 주세요.');
            const dup = await db.prepare('SELECT id FROM team_options WHERE team_id=? AND kind=? AND name=? AND id<>?').bind(t.id, opt.kind, name, oid).first();
            if (dup) throw new HttpError(409, '이미 있는 이름입니다.');
            const extra = opt.kind === 'service' ? (/^[0-6]$/.test(String(b.extra ?? '')) ? String(b.extra) : b.extra === '' ? '' : opt.extra) : '';
            const position = Number.isInteger(b.position) ? b.position : opt.position;
            const stmts = [db.prepare('UPDATE team_options SET name=?,extra=?,position=? WHERE id=?').bind(name, extra, position, oid)];
            await db.batch(stmts);
            // 인도자 이름을 고치면 이 팀의 기존 콘티에 적힌 이름도 같이 바꾼다
            if (opt.kind === 'leader' && name !== opt.name) {
              const { results: ls } = await db.prepare(`SELECT id,leaders FROM setlists WHERE team_id=? AND leaders <> ''`).bind(t.id).all();
              const up = [];
              for (const l of ls) {
                const arr = l.leaders.split(',');
                if (!arr.includes(opt.name)) continue;
                const next = [...new Set(arr.map((x) => (x === opt.name ? name : x)))];
                up.push(db.prepare('UPDATE setlists SET leaders=? WHERE id=?').bind(next.join(','), l.id));
              }
              if (up.length) await db.batch(up);
            }
            return json({ ok: true });
          }
          if (method === 'DELETE') {
            requireLeader(ctx);
            const stmts = [db.prepare('DELETE FROM team_options WHERE id=?').bind(oid)];
            // 예배 종류를 지우면 그 콘티들은 "미분류"로 남는다. 인도자 이름은 콘티에 글자로 남아 있다.
            if (opt.kind === 'service') stmts.push(db.prepare('UPDATE setlists SET service_id=NULL WHERE service_id=? AND team_id=?').bind(oid, t.id));
            await db.batch(stmts);
            return json({ ok: true });
          }
        }
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
      // 여러 콘티 한 번에 삭제 (임시 콘티 정리용)
      if (parts[1] === 'delete' && method === 'POST') {
        requireLeader(ctx);
        const b = await readBody();
        const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((v) => parseInt(v, 10)).filter(Number.isInteger))].slice(0, 100);
        if (!ids.length) throw new HttpError(400, '삭제할 콘티를 골라 주세요.');
        const mine = (await db.prepare(`SELECT id FROM setlists WHERE team_id=? AND id IN (${ids.map(() => '?').join(',')})`).bind(team.id, ...ids).all()).results.map((r) => r.id);
        if (mine.length) {
          const ph = mine.map(() => '?').join(',');
          await db.batch([db.prepare(`DELETE FROM vault_sl_items WHERE setlist_id IN (${ph})`).bind(...mine), db.prepare(`DELETE FROM setlist_items WHERE setlist_id IN (${ph})`).bind(...mine), db.prepare(`DELETE FROM setlists WHERE id IN (${ph})`).bind(...mine)]);
        }
        return json({ ok: true, deleted: mine.length });
      }
      const lid = parts[1] ? parseInt(parts[1], 10) : null;
      if (parts[1] && !Number.isInteger(lid)) throw new HttpError(404, '콘티를 찾을 수 없습니다.');

      if (!lid && method === 'GET') {
        const { results } = await db
          .prepare(
            `SELECT l.id,l.date,l.title,l.memo,l.service_id,l.leaders,l.is_temp,
              (SELECT o.name FROM team_options o WHERE o.id = l.service_id AND o.kind='service') AS service_name,
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
        const svc = await checkService(db, team.id, s.service_id);
        const now = nowIso();
        const r = await db.prepare('INSERT INTO setlists (team_id,date,title,memo,service_id,leaders,is_temp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(team.id, s.date, s.title, s.memo, svc, s.leaders, s.is_temp, now, now).run();
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
            `SELECT i.id,i.uid,i.position,i.song_id,i.key,i.form,i.memo,i."view" AS view,
              s.title,s.original_key,s.time_sig,s.chordpro,
              (SELECT COUNT(*) FROM song_files f WHERE f.song_id = i.song_id) AS file_count
             FROM setlist_items i LEFT JOIN songs s ON s.id = i.song_id
             WHERE i.setlist_id=? ORDER BY i.position`
          )
          .bind(lid)
          .all();
        // 예전에 만든 콘티 칸에는 uid가 없으므로 처음 열 때 채워 준다
        const missing = results.filter((r) => !r.uid);
        if (missing.length) {
          for (const r of missing) r.uid = newUid();
          await db.batch(missing.map((r) => db.prepare('UPDATE setlist_items SET uid=? WHERE id=? AND uid IS NULL').bind(r.uid, r.id)));
        }
        const { results: tk } = await db.prepare('SELECT song_id,key FROM team_song_keys WHERE team_id=?').bind(team.id).all();
        const tkMap = Object.fromEntries(tk.map((r) => [r.song_id, r.key]));
        const svc = list.service_id ? await db.prepare(`SELECT name FROM team_options WHERE id=? AND kind='service'`).bind(list.service_id).first() : null;
        const svcName = svc ? svc.name : '';
        const items = results.map(({ chordpro, ...it }) => ({ ...it, title: it.title || '(삭제된 곡)', has_chords: /\S/.test(chordpro || ''), team_key: tkMap[it.song_id] || '' }));
        return json({ setlist: { id: list.id, date: list.date, title: list.title, memo: list.memo, service_id: list.service_id, service_name: svcName, leaders: list.leaders || '', is_temp: list.is_temp ? 1 : 0, items }, canEdit: ctx.leader });
      }

      // 임시 표시를 떼어 정식 콘티로 확정
      if (lid && parts[2] === 'confirm' && method === 'POST') {
        requireLeader(ctx);
        await db.prepare('UPDATE setlists SET is_temp=0,updated_at=? WHERE id=?').bind(nowIso(), lid).run();
        return json({ ok: true });
      }

      if (lid && method === 'PUT') {
        requireLeader(ctx);
        const s = await cleanSetlist(db, await readBody());
        const svc = await checkService(db, team.id, s.service_id);
        const keep = new Set((await db.prepare('SELECT uid FROM setlist_items WHERE setlist_id=? AND uid IS NOT NULL').bind(lid).all()).results.map((r) => r.uid));
        const ins = itemInserts(db, lid, s.items, keep);
        const alive = s.items.map((it) => it.uid);
        await db.batch([
          db.prepare('UPDATE setlists SET date=?,title=?,memo=?,service_id=?,leaders=?,is_temp=?,updated_at=? WHERE id=?').bind(s.date, s.title, s.memo, svc, s.leaders, s.is_temp, nowIso(), lid),
          // 콘티에서 빠진 곡 칸의 콘티용 필기는 함께 지운다
          db.prepare(`DELETE FROM vault_sl_items WHERE setlist_id=?${alive.length ? ` AND uid NOT IN (${alive.map(() => '?').join(',')})` : ''}`).bind(lid, ...alive),
          db.prepare('DELETE FROM setlist_items WHERE setlist_id=?').bind(lid),
          ...ins,
        ]);
        return json({ id: lid });
      }

      if (lid && method === 'DELETE') {
        requireLeader(ctx);
        await db.batch([db.prepare('DELETE FROM vault_sl_items WHERE setlist_id=?').bind(lid), db.prepare('DELETE FROM setlist_items WHERE setlist_id=?').bind(lid), db.prepare('DELETE FROM setlists WHERE id=?').bind(lid)]);
        return json({ ok: true });
      }
    }

    // ===== 곡 =====
    if (parts[0] === 'songs') {
      const id = parts[1] ? parseInt(parts[1], 10) : null;
      if (parts[1] && !Number.isInteger(id)) throw new HttpError(404, '곡을 찾을 수 없습니다.');

      // 목록 + 검색(제목·아티스트·태그·가사)
      if (!id && method === 'GET') {
        const pq = parseQuery(url.searchParams.get('q') || '');
        const { results } = await db
          .prepare(
            `SELECT id,title,orig_title,artist,original_key,tempo,time_sig,tags,chordpro,lyrics_extra,updated_at,
              (SELECT COUNT(*) FROM song_files f WHERE f.song_id = songs.id) AS file_count,
              (SELECT group_concat(DISTINCT kind) FROM song_files f WHERE f.song_id = songs.id) AS file_kinds
             FROM songs ORDER BY title`
          )
          .all();
        let tkMap = {};
        let lastMap = {};
        if (ctx.team) {
          const { results: tk } = await db.prepare('SELECT song_id,key FROM team_song_keys WHERE team_id=?').bind(ctx.team.id).all();
          tkMap = Object.fromEntries(tk.map((r) => [r.song_id, r.key]));
          // 우리 팀 콘티에서 가장 최근에 쓴 날짜 (오늘까지의 콘티만. 앞으로 잡힌 콘티는 "예정"이라 제외)
          const { results: lu } = await db
            .prepare(
              `SELECT i.song_id AS song_id, MAX(l.date) AS last, COUNT(DISTINCT l.id) AS n
               FROM setlist_items i JOIN setlists l ON l.id = i.setlist_id
               WHERE l.team_id=? AND l.date IS NOT NULL AND l.date <= ?
               GROUP BY i.song_id`
            )
            .bind(ctx.team.id, todayKst())
            .all();
          lastMap = Object.fromEntries(lu.map((r) => [r.song_id, r]));
        }
        const orderTags = makeTagOrder(await getPresets(db));
        for (const s of results) s.tags = orderTags(s.tags);
        const hits = [];
        for (const s of results) {
          if (!pq.all) {
            hits.push({ s, m: null });
            continue;
          }
          const m = matchSong(s, pq);
          if (m) hits.push({ s, m });
        }
        // 검색 중에는 제목·원제·아티스트·태그에서 맞은 곡을 먼저, 가사에서만 맞은 곡은 뒤에 (각각 제목순)
        if (pq.all) hits.sort((a, b) => a.m.rank - b.m.rank);
        const songs = hits.map(({ s, m }) => {
          const { chordpro, lyrics_extra, ...rest } = s;
          const lu = lastMap[s.id];
          return {
            ...rest,
            file_kinds: rest.file_kinds || '',
            has_chords: /\S/.test(chordpro),
            team_key: tkMap[s.id] || '',
            last_used: lu ? lu.last : '',
            use_count: lu ? lu.n : 0,
            snippet: m && m.snippet ? m.snippet : null,
          };
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
        song.tags = makeTagOrder(await getPresets(db))(song.tags);
        if (!body.force) {
          const { results } = await db.prepare('SELECT id,title FROM songs').all();
          const dup = results.find((s) => searchKey(s.title) === searchKey(song.title));
          if (dup) throw new HttpError(409, '같은 제목의 곡이 이미 있습니다.', { duplicate: dup });
        }
        const now = nowIso();
        const r = await db
          .prepare(
            `INSERT INTO songs (title,orig_title,lyrics_extra,artist,original_key,tempo,time_sig,youtube_url,tags,chordpro,memo,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .bind(song.title, song.orig_title, song.lyrics_extra, song.artist, song.original_key, song.tempo, song.time_sig, song.youtube_url, song.tags, song.chordpro, song.memo, now, now)
          .run();
        return json({ id: r.meta.last_row_id }, 201);
      }

      // ----- 수정 이력 (편집 권한이 있는 사람만) -----
      // song_versions 한 줄 = "이 본문을 created_at 에 edited_by 가 다른 내용으로 바꿨다"는 뜻(바뀌기 전 본문 보관)
      if (id && parts[2] === 'versions') {
        requireEdit(env, ctx);
        const cur = await db.prepare('SELECT title,chordpro,updated_at FROM songs WHERE id=?').bind(id).first();
        if (!cur) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const who = (v) => (v.edited_by_team ? v.team_name || '(삭제된 팀)' : '관리자');
        const base = `SELECT v.id,v.chordpro,v.edited_by_team,v.created_at,t.name AS team_name
                      FROM song_versions v LEFT JOIN teams t ON t.id = v.edited_by_team`;

        if (!parts[3] && method === 'GET') {
          const { results } = await db.prepare(base + ' WHERE v.song_id=? ORDER BY v.id DESC').bind(id).all();
          return json({
            title: cur.title,
            current: { updated_at: cur.updated_at, chars: cur.chordpro.length },
            versions: results.map((v) => ({ id: v.id, created_at: v.created_at, edited_by: who(v), chars: v.chordpro.length, first_line: (v.chordpro.split('\n').find((l) => l.trim()) || '').slice(0, 60) })),
          });
        }
        const vid = parseInt(parts[3], 10);
        if (!Number.isInteger(vid)) throw new HttpError(404, '이력을 찾을 수 없습니다.');
        const ver = await db.prepare(base + ' WHERE v.id=? AND v.song_id=?').bind(vid, id).first();
        if (!ver) throw new HttpError(404, '이력을 찾을 수 없습니다.');

        if (!parts[4] && method === 'GET') {
          return json({ version: { id: ver.id, created_at: ver.created_at, edited_by: who(ver), chordpro: ver.chordpro }, current: { chordpro: cur.chordpro, updated_at: cur.updated_at } });
        }
        // 되돌리기: 지금 본문도 이력에 남겨 두므로, 잘못 되돌려도 다시 되돌릴 수 있다.
        if (parts[4] === 'restore' && method === 'POST') {
          const now = nowIso();
          const editor = ctx.admin || !ctx.team ? null : ctx.team.id;
          const stmts = [];
          if (cur.chordpro !== ver.chordpro) {
            stmts.push(db.prepare('INSERT INTO song_versions (song_id,chordpro,edited_by_team,created_at) VALUES (?,?,?,?)').bind(id, cur.chordpro, editor, now));
          }
          stmts.push(db.prepare('UPDATE songs SET chordpro=?,updated_at=? WHERE id=?').bind(ver.chordpro, now, id));
          stmts.push(pruneVersions(db, id));
          await db.batch(stmts);
          return json({ ok: true });
        }
        throw new HttpError(404, '요청한 주소를 찾을 수 없습니다.');
      }

      if (id && method === 'GET') {
        const song = await db.prepare('SELECT * FROM songs WHERE id=?').bind(id).first();
        if (!song) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        song.files = await songFiles(env, id);
        song.tags = makeTagOrder(await getPresets(db))(song.tags);
        song.team_key = '';
        song.usage = null;
        if (ctx.team) {
          const tk = await db.prepare('SELECT key FROM team_song_keys WHERE team_id=? AND song_id=?').bind(ctx.team.id, id).first();
          song.team_key = tk ? tk.key : '';
          // 우리 팀 콘티 사용 이력: 오늘까지 쓴 최근 5번, 전체 횟수, 다음 예정일
          const today = todayKst();
          const { results: used } = await db
            .prepare(
              `SELECT l.id,l.date,l.title FROM setlists l
               WHERE l.team_id=? AND l.date IS NOT NULL AND l.date <= ? AND EXISTS (SELECT 1 FROM setlist_items i WHERE i.setlist_id = l.id AND i.song_id=?)
               ORDER BY l.date DESC, l.id DESC`
            )
            .bind(ctx.team.id, today, id)
            .all();
          const next = await db
            .prepare(
              `SELECT l.id,l.date,l.title FROM setlists l
               WHERE l.team_id=? AND l.date > ? AND EXISTS (SELECT 1 FROM setlist_items i WHERE i.setlist_id = l.id AND i.song_id=?)
               ORDER BY l.date ASC LIMIT 1`
            )
            .bind(ctx.team.id, today, id)
            .first();
          song.usage = { count: used.length, recent: used.slice(0, 5), next: next || null };
        }
        return json({ song });
      }

      if (id && method === 'PUT') {
        requireEdit(env, ctx);
        const old = await db.prepare('SELECT chordpro FROM songs WHERE id=?').bind(id).first();
        if (!old) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const song = cleanSong(await readBody());
        song.tags = makeTagOrder(await getPresets(db))(song.tags);
        const now = nowIso();
        const stmts = [];
        if (old.chordpro !== song.chordpro) {
          // 바뀌기 전 본문을 수정 이력에 보관 (이력 보기·되돌리기는 4차에서 추가). 팀장이 고쳤다면 그 팀 번호도 남긴다.
          stmts.push(
            db.prepare('INSERT INTO song_versions (song_id,chordpro,edited_by_team,created_at) VALUES (?,?,?,?)').bind(id, old.chordpro, ctx.admin || !ctx.team ? null : ctx.team.id, now)
          );
          stmts.push(pruneVersions(db, id));
        }
        stmts.push(
          db
            .prepare('UPDATE songs SET title=?,orig_title=?,lyrics_extra=?,artist=?,original_key=?,tempo=?,time_sig=?,youtube_url=?,tags=?,chordpro=?,memo=?,updated_at=? WHERE id=?')
            .bind(song.title, song.orig_title, song.lyrics_extra, song.artist, song.original_key, song.tempo, song.time_sig, song.youtube_url, song.tags, song.chordpro, song.memo, now, id)
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
          db.prepare('DELETE FROM vault_items WHERE song_id=?').bind(id),
          db.prepare('DELETE FROM vault_sl_items WHERE song_id=?').bind(id),
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
