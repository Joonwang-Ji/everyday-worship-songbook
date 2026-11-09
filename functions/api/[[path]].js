// Everyday Worship Score — API (Cloudflare Pages Functions)
// 접속암호 로그인, 관리자 PIN(편집 권한), 곡 목록/보기/저장/삭제, 악보 파일(이미지·PDF) 업로드.
// 필요한 설정: D1 바인딩 DB, R2 바인딩 BUCKET(이미지 악보용), 환경변수 CHURCH_CODE (필수), ADMIN_PIN (권장)

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
function signToken(env, role, days) {
  return signPayload(env, { r: role, exp: Math.floor(Date.now() / 1000) + Math.floor(days * 86400) });
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

// ---------- DB 초기화 (처음 한 번 자동으로 표 생성) ----------
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
  `CREATE TABLE IF NOT EXISTS setlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setlist_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    song_id INTEGER NOT NULL,
    key TEXT NOT NULL DEFAULT '',
    form TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT ''
  )`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
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

async function isMember(env, request) {
  return verifyToken(env, bearer(request), 'member');
}
async function isAdmin(env, request) {
  return verifyToken(env, request.headers.get('X-Admin-Token') || '', 'admin');
}
// ADMIN_PIN을 설정하지 않았다면 교회 구성원 누구나 편집 가능(설치 안내에서 PIN 설정을 권장)
async function canEdit(env, request) {
  if (!env.ADMIN_PIN) return true;
  return isAdmin(env, request);
}

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

// ---------- 라우팅 ----------
export async function onRequest({ request, env }) {
  try {
    if (!env.DB) throw new HttpError(500, 'D1 데이터베이스가 연결되지 않았습니다. (바인딩 변수 이름: DB) 설치 안내의 4단계를 확인해 주세요.');
    if (!env.CHURCH_CODE) throw new HttpError(500, '환경변수 CHURCH_CODE(교회 접속암호)가 설정되지 않았습니다. 설치 안내의 5단계를 확인해 주세요.');
    await ensureSchema(env.DB);

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
      const row = await env.DB.prepare('SELECT r2_key FROM song_files WHERE id=?').bind(fid).first();
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
    if (!(await isMember(env, request))) throw new HttpError(401, '로그인이 필요합니다.');

    if (parts[0] === 'files' && parts[1] && method === 'DELETE') {
      if (!(await canEdit(env, request))) throw new HttpError(403, '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력해 주세요.');
      const fid = parseInt(parts[1], 10);
      const row = Number.isInteger(fid) && (await env.DB.prepare('SELECT r2_key FROM song_files WHERE id=?').bind(fid).first());
      if (!row) throw new HttpError(404, '파일을 찾을 수 없습니다.');
      await env.DB.prepare('DELETE FROM song_files WHERE id=?').bind(fid).run();
      if (env.BUCKET) await env.BUCKET.delete(row.r2_key).catch(() => {});
      return json({ ok: true });
    }

    if (parts[0] === 'me' && method === 'GET') {
      return json({ canEdit: await canEdit(env, request), adminRequired: !!env.ADMIN_PIN, isAdmin: await isAdmin(env, request) });
    }

    if (parts[0] === 'admin' && method === 'POST') {
      if (!env.ADMIN_PIN) throw new HttpError(400, '관리자 PIN이 설정되어 있지 않습니다. (ADMIN_PIN 환경변수)');
      const { pin } = await readBody();
      if (!(await safeEqual(pin || '', env.ADMIN_PIN))) {
        await sleep(500);
        throw new HttpError(401, '관리자 PIN이 맞지 않습니다.');
      }
      return json({ adminToken: await signToken(env, 'admin', 30) });
    }

    if (parts[0] === 'songs') {
      const db = env.DB;
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
        const songs = results
          .filter((s) => !q || [s.title, s.artist, s.tags, lyricsOnly(s.chordpro)].join(' ').toLowerCase().includes(q))
          .map((s) => {
            const { chordpro, ...rest } = s;
            return { ...rest, file_kinds: rest.file_kinds || '', has_chords: /\S/.test(chordpro) };
          });
        return json({ songs });
      }

      // 악보 파일(이미지·PDF) 올리기: 본문 자체가 파일 내용이다
      if (id && parts[2] === 'files' && method === 'POST') {
        if (!(await canEdit(env, request))) throw new HttpError(403, '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력해 주세요.');
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
        await db.prepare('UPDATE songs SET updated_at=? WHERE id=?').bind(new Date().toISOString(), id).run();
        return json({ file: { id: fid, kind, url: await fileUrl(env, fid) } }, 201);
      }

      // 새 곡
      if (!id && method === 'POST') {
        if (!(await canEdit(env, request))) throw new HttpError(403, '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력해 주세요.');
        const body = await readBody();
        const song = cleanSong(body);
        if (!body.force) {
          const { results } = await db.prepare('SELECT id,title FROM songs').all();
          const dup = results.find((s) => normTitle(s.title) === normTitle(song.title));
          if (dup) throw new HttpError(409, '같은 제목의 곡이 이미 있습니다.', { duplicate: dup });
        }
        const now = new Date().toISOString();
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
        return json({ song });
      }

      if (id && method === 'PUT') {
        if (!(await canEdit(env, request))) throw new HttpError(403, '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력해 주세요.');
        const old = await db.prepare('SELECT chordpro FROM songs WHERE id=?').bind(id).first();
        if (!old) throw new HttpError(404, '곡을 찾을 수 없습니다.');
        const song = cleanSong(await readBody());
        const now = new Date().toISOString();
        const stmts = [];
        if (old.chordpro !== song.chordpro) {
          // 바뀌기 전 본문을 수정 이력에 보관 (되돌리기 화면은 3차에서 추가)
          stmts.push(db.prepare('INSERT INTO song_versions (song_id,chordpro,edited_by_team,created_at) VALUES (?,?,NULL,?)').bind(id, old.chordpro, now));
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
        if (!(await canEdit(env, request))) throw new HttpError(403, '악보를 편집할 권한이 없습니다. 관리자 PIN을 입력해 주세요.');
        const { results: files } = await db.prepare('SELECT r2_key FROM song_files WHERE song_id=?').bind(id).all();
        await db.batch([
          db.prepare('DELETE FROM song_versions WHERE song_id=?').bind(id),
          db.prepare('DELETE FROM song_files WHERE song_id=?').bind(id),
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
