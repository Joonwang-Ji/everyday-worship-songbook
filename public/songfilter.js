// 곡 찾기 공용 도구 (8차): 악보 형식 배지, 키 순서·정리, 필터(주제·키·악보 형식) 상태, 주소 저장.
// 곡 목록과 콘티의 "곡 추가" 창이 같은 규칙을 쓰도록 한곳에 모았다. (브라우저와 Node 테스트 양쪽에서 사용)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chord.js'));
  else root.SongFilter = factory(root.Chord);
})(typeof self !== 'undefined' ? self : this, function (Chord) {
  const OTHER_KEY = '__other';
  const NO_KEY = 99;

  // ---------- 키 ----------
  // "A#", "Gb", "Dbm" 처럼 다르게 적힌 키를 대표 표기로 맞춘다. 키가 아니면 ''.
  function normKey(k) {
    const p = Chord.parseKey(k);
    if (!p) return '';
    return p.minor ? Chord.MINOR_NAMES[p.idx] + 'm' : Chord.MAJOR_NAMES[p.idx];
  }
  // 정렬 번호: 장조 C→B(0~11), 다음 단조 Cm→Bm(12~23), 키 없음은 맨 끝.
  function keyRank(k) {
    const p = Chord.parseKey(k);
    if (!p) return NO_KEY;
    return (p.minor ? 12 : 0) + p.idx;
  }
  const cmpTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ko');

  // ---------- 키·박자 표시 (14차) ----------
  // 곡에 보이는 키는 "우리 팀 키"가 있으면 그것, 없으면 원래 키. 필터·정렬도 같은 기준을 쓴다.
  const effKey = (s) => normKey(s.team_key) || normKey(s.original_key);
  // 두 키가 다른 키인지 (A# 과 Bb 처럼 표기만 다른 경우는 같은 키로 본다)
  const keyDiffers = (a, b) => (normKey(a) || String(a || '').trim()) !== (normKey(b) || String(b || '').trim());
  // 박자는 "3/4,4/4"처럼 쉼표로 여러 개가 올 수 있다.
  const tsigList = (v) => String(v == null ? '' : v).split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  const tsigText = (v) => tsigList(v).join(' · ');
  const tsigHTML = (v, esc) => { const t = tsigText(v); return t ? `<span class="tsigbadge" title="박자">${esc(t)}</span>` : ''; };
  // 키 배지 바로 오른쪽에 박자, 팀 키와 원키가 다르면 원키를 작게 덧붙인다. (곡 목록 줄·곡 고르는 창 공용)
  function keyTsigHTML(s, esc) {
    const team = String(s.team_key || '').trim();
    const orig = String(s.original_key || '').trim();
    const shown = team || orig;
    let h = shown ? `<span class="keybadge">${esc(shown)}</span>` : '';
    h += tsigHTML(s.time_sig, esc);
    if (team && orig && keyDiffers(team, orig)) h += `<span class="origkey" title="원래 키">원키 ${esc(orig)}</span>`;
    return h;
  }

  // ---------- 악보 형식 ----------
  function formatOf(s) {
    const kinds = String(s.file_kinds || '').split(',').filter(Boolean);
    const image = kinds.includes('image');
    const pdf = kinds.includes('pdf');
    const n = s.file_count || 0;
    return { chord: !!s.has_chords, image, pdf, n, both: image && pdf };
  }
  // ---------- 악보 보완 (13차) ----------
  // 이상적인 곡은 코드 악보와 이미지·PDF 악보가 모두 있는 곡. 'full' | 'chord'(코드만) | 'file'(이미지·PDF만) | 'none'
  function completeness(s) {
    const f = formatOf(s);
    const hasFile = f.n > 0;
    return f.chord && hasFile ? 'full' : f.chord ? 'chord' : hasFile ? 'file' : 'none';
  }
  const MISSING_TEXT = { chord: '이미지·PDF 없음', file: '코드 없음', none: '악보 없음' };
  const missingText = (s) => MISSING_TEXT[completeness(s)] || '';
  // [채우기]로 편집 화면을 열 때 먼저 보여 줄 칸: 코드 악보가 비었으면 chord, 아니면 image
  const fixTarget = (s) => (completeness(s) === 'chord' ? 'image' : 'chord');
  function stats(songs) {
    const n = { total: songs.length, full: 0, chord: 0, file: 0, none: 0 };
    for (const s of songs) n[completeness(s)]++;
    return n;
  }
  // 오늘의 보완 제안: 비어 있는 곡 중에서 ① 다가오는 콘티에 들어 있는 곡 ② 우리 팀이 자주 쓴 곡 ③ 제목순으로 max곡.
  // opt.upcoming: 다가오는 콘티에 든 곡 번호 Set, opt.hidden: {곡번호: 숨김 끝나는 시각(ms)}, opt.now
  function suggest(songs, opt) {
    const o = Object.assign({ upcoming: new Set(), hidden: {}, now: Date.now(), max: 3 }, opt);
    const rows = [];
    for (const s of songs) {
      const state = completeness(s);
      if (state === 'full') continue;
      if ((o.hidden[s.id] || 0) > o.now) continue;
      rows.push({ s, state, soon: o.upcoming.has(s.id) });
    }
    rows.sort((a, b) => (b.soon ? 1 : 0) - (a.soon ? 1 : 0) || (b.s.use_count || 0) - (a.s.use_count || 0) || cmpTitle(a.s, b.s));
    return rows.slice(0, o.max);
  }

  // 곡 한 줄에 붙는 형식 배지. 주제 태그와 모양이 달라서 한눈에 구분된다.
  function badgesHTML(s, esc) {
    const f = formatOf(s);
    const out = [];
    if (f.chord) out.push('<span class="fmt chord" title="코드 악보(키를 바꿀 수 있어요)" aria-label="코드 악보">🎼</span>');
    if (f.image) out.push(`<span class="fmt img" title="이미지 악보" aria-label="이미지 악보">🖼${!f.both && f.n > 1 ? ' ' + f.n : ''}</span>`);
    if (f.pdf) out.push(`<span class="fmt pdf" title="PDF 악보" aria-label="PDF 악보">📄${!f.both && f.n > 1 ? ' ' + f.n : ''}</span>`);
    if (!out.length) out.push('<span class="fmt none">악보 없음</span>');
    return out.join('');
  }
  // 주제·절기 태그는 옅은 글자로 따로 한 줄에. 순서는 서버가 정해 둔 순서 그대로.
  function tagsLineHTML(tags, esc) {
    const list = String(tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    return list.length ? `<div class="song-tags">${list.map((t) => `<span class="tg">#${esc(t)}</span>`).join('')}</div>` : '';
  }

  // ---------- 필터 상태 ----------
  // { tags: ['회개&보혈'], keys: ['G','E'], fmt: ''|'chord'|'file' }  (정렬·검색어는 목록 화면이 따로 가진다)
  const newState = () => ({ tags: [], keys: [], fmt: '' });

  // 분류별로 곡에 쓰인 태그만 모은 칩 목록 (추천 목록 순서, 추천에 없는 태그는 "기타")
  function groupTags(info) {
    const inPreset = new Set(info.presets.flatMap((g) => g.items));
    const groups = info.presets.map((g) => ({ key: g.group, label: g.group, items: g.items.filter((t) => (info.usage[t] || 0) > 0) }));
    groups.push({ key: OTHER_KEY, label: '기타', items: Object.keys(info.usage).filter((t) => !inPreset.has(t)).sort() });
    return groups.filter((g) => g.items.length);
  }

  // 곡이 실제로 쓰는 키(우리 팀 키가 있으면 팀 키, 없으면 원래 키)만 칩으로. 곡 수를 함께 센다.
  function keyChips(songs) {
    const count = new Map();
    for (const s of songs) {
      const k = effKey(s);
      if (k) count.set(k, (count.get(k) || 0) + 1);
    }
    return [...count.entries()].sort((a, b) => keyRank(a[0]) - keyRank(b[0])).map(([key, n]) => ({ key, n }));
  }

  // 한 곡이 필터에 맞는지. 태그는 "그리고", 키는 여러 개 중 하나("또는"), 악보 형식은 하나.
  function matches(s, st) {
    if (st.tags.length) {
      const have = String(s.tags || '').split(',');
      if (!st.tags.every((t) => have.includes(t))) return false;
    }
    if (st.keys.length && !st.keys.includes(effKey(s))) return false;
    if (st.fmt === 'chord' && !s.has_chords) return false;
    if (st.fmt === 'file' && !(s.file_count > 0)) return false;
    if (st.fmt === 'missing' && completeness(s) === 'full') return false;
    if (st.fmt === 'full' && completeness(s) !== 'full') return false;
    return true;
  }
  const isActive = (st) => !!(st.tags.length || st.keys.length || st.fmt);

  // 칩을 눌렀을 때 상태를 바꾼다. 태그는 분류 안에서 하나만(다시 누르면 해제), 키는 여러 개, 형식은 하나.
  function toggle(st, groups, ds) {
    if (ds.k !== undefined) {
      const i = st.keys.indexOf(ds.k);
      if (i >= 0) st.keys.splice(i, 1);
      else st.keys.push(ds.k);
      st.keys.sort((a, b) => keyRank(a) - keyRank(b));
    } else if (ds.fmt !== undefined) {
      st.fmt = st.fmt === ds.fmt ? '' : ds.fmt;
    } else if (ds.t !== undefined) {
      const g = groups.find((x) => x.items.includes(ds.t));
      if (st.tags.includes(ds.t)) st.tags = st.tags.filter((t) => t !== ds.t);
      else {
        if (g) st.tags = st.tags.filter((t) => !g.items.includes(t));
        st.tags.push(ds.t);
      }
    }
  }
  // 더는 없는 태그·키가 상태에 남아 있으면 뺀다 (주소로 들어왔거나 곡이 지워진 경우)
  function prune(st, groups, chips) {
    const all = new Set(groups.flatMap((g) => g.items));
    st.tags = st.tags.filter((t) => all.has(t));
    const keys = new Set(chips.map((c) => c.key));
    st.keys = st.keys.filter((k) => keys.has(k));
  }
  const summary = (st) => [...st.tags, st.keys.length ? st.keys.join('·') : '', st.fmt === 'chord' ? '코드 악보' : st.fmt === 'file' ? '이미지·PDF' : st.fmt === 'missing' ? '빠진 것 있음' : st.fmt === 'full' ? '둘 다 있음' : ''].filter(Boolean).join(' + ');

  // ---------- 칩 그리기 ----------
  function chipsHTML(st, groups, chips, esc) {
    const grp = (label, body) => `<div class="chipgroup"><span class="ctl-label">${esc(label)}</span><div class="chips">${body}</div></div>`;
    const chip = (on, attrs, text) => `<button type="button" class="chip ${on ? 'on' : ''}" ${attrs}>${text}</button>`;
    const parts = groups.map((g) => grp(g.label, g.items.map((t) => chip(st.tags.includes(t), `data-t="${esc(t)}"`, esc(t))).join('')));
    if (chips.length) parts.push(grp('키 (팀 키 기준)', chips.map((c) => chip(st.keys.includes(c.key), `data-k="${esc(c.key)}"`, `${esc(c.key)} <small>${c.n}</small>`)).join('')));
    parts.push(grp('악보', chip(st.fmt === 'chord', 'data-fmt="chord"', '🎼 코드') + chip(st.fmt === 'file', 'data-fmt="file"', '🖼 이미지·PDF') + chip(st.fmt === 'missing', 'data-fmt="missing"', '⚠ 빠진 것 있음') + chip(st.fmt === 'full', 'data-fmt="full"', '✓ 둘 다 있음')));
    return parts.join('');
  }

  // ---------- 정렬 ----------
  // sort: 'title' | 'key' | 'old' | 'recent'  (old/recent 는 팀 콘티 기준)
  function sortSongs(songs, sort) {
    const list = [...songs];
    if (sort === 'key') list.sort((a, b) => keyRank(effKey(a)) - keyRank(effKey(b)) || cmpTitle(a, b));
    else if (sort === 'old' || sort === 'recent') {
      const key = (s) => s.last_used || '';
      list.sort((a, b) => (sort === 'recent' ? key(b).localeCompare(key(a)) : key(a).localeCompare(key(b))) || cmpTitle(a, b));
    }
    return list;
  }

  // ---------- 주소에 저장 ----------
  // #/songs?q=은혜&tag=회개%26보혈&key=G,E&fmt=chord&sort=key
  const SORTS = ['title', 'key', 'old', 'recent'];
  function toQuery(st, extra) {
    const p = new URLSearchParams();
    if (extra && extra.q) p.set('q', extra.q);
    st.tags.forEach((t) => p.append('tag', t));
    if (st.keys.length) p.set('key', st.keys.join(','));
    if (st.fmt) p.set('fmt', st.fmt);
    if (extra && extra.sort && extra.sort !== 'title') p.set('sort', extra.sort);
    return p.toString();
  }
  const FILTER_PARAMS = ['q', 'tag', 'key', 'fmt', 'sort'];
  const hasFilterParams = (p) => FILTER_PARAMS.some((k) => p.has(k));
  function fromQuery(p) {
    const st = newState();
    st.tags = [...new Set(p.getAll('tag').map((t) => t.trim()).filter(Boolean))];
    st.keys = [...new Set((p.get('key') || '').split(',').map((k) => normKey(k.trim().replace(/^./, (c) => c.toUpperCase()))).filter(Boolean))].sort((a, b) => keyRank(a) - keyRank(b));
    const f = p.get('fmt');
    st.fmt = f === 'chord' || f === 'file' || f === 'missing' || f === 'full' ? f : '';
    const sort = SORTS.includes(p.get('sort')) ? p.get('sort') : 'title';
    return { st, q: (p.get('q') || '').trim(), sort };
  }

  return { OTHER_KEY, normKey, effKey, keyDiffers, tsigList, tsigText, tsigHTML, keyTsigHTML, keyRank, formatOf, completeness, missingText, fixTarget, stats, suggest, badgesHTML, tagsLineHTML, newState, groupTags, keyChips, matches, isActive, toggle, prune, summary, chipsHTML, sortSongs, toQuery, fromQuery, hasFilterParams };
});
