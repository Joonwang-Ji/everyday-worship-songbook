// 탭 편집기용 무손실 변환·편집 함수 (7차 B단계) — 화면과 무관한 순수 함수. 브라우저와 Node 테스트 양쪽에서 사용.
// 저장 형식(ChordPro 글자)은 그대로. 모델은 "줄 목록"이고, 손대지 않은 줄은 원문(raw)을 그대로 돌려준다.
//   parse(text)      → { lines:[ {kind, raw, ...} ] }
//   serialize(model) → 글자 (손대지 않았다면 parse 전 글자와 완전히 같다)
// kind: 'lyric'(가사+[코드]) | 'blank' | 'comment'({comment:}) | 'soc' | 'eoc' | 'other'(주석·모르는 지시어·괄호가 깨진 줄: 그대로 보존)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TabEdit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DIRECTIVE = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/;
  const SECTION_NAMES = ['인트로', '1절', '2절', '3절', '4절', '5절', '프리코러스', '후렴', '브릿지', '간주', '엔딩'];

  // "[G]주님은 [C]나의" → {text:'주님은 나의', chords:[{pos:0,c:'G'},{pos:4,c:'C'}]}. 괄호가 깨졌으면 null.
  function parseLyric(raw) {
    let text = '';
    const chords = [];
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '[') {
        const j = raw.indexOf(']', i + 1);
        const k = raw.indexOf('[', i + 1);
        if (j < 0 || (k >= 0 && k < j)) return null;
        chords.push({ pos: text.length, c: raw.slice(i + 1, j) });
        i = j;
      } else if (ch === ']') {
        return null;
      } else {
        text += ch;
      }
    }
    return { text, chords };
  }
  function lyricRaw(text, chords) {
    // 같은 자리의 코드는 들어 있던 순서를 지킨다.
    const by = new Map();
    for (const c of chords) {
      const p = Math.max(0, Math.min(text.length, c.pos));
      if (!by.has(p)) by.set(p, []);
      by.get(p).push(c.c);
    }
    let out = '';
    for (let i = 0; i <= text.length; i++) {
      if (by.has(i)) out += by.get(i).map((c) => '[' + c + ']').join('');
      if (i < text.length) out += text[i];
    }
    return out;
  }

  function parseLine(raw) {
    const d = DIRECTIVE.exec(raw);
    if (d) {
      const name = d[1].toLowerCase();
      const val = (d[2] || '').trim();
      if (['comment', 'c', 'comment_italic', 'ci'].includes(name)) return { kind: 'comment', raw, label: val };
      if (name === 'soc' || name === 'start_of_chorus') return { kind: 'soc', raw };
      if (name === 'eoc' || name === 'end_of_chorus') return { kind: 'eoc', raw };
      return { kind: 'other', raw };
    }
    if (/^\s*#/.test(raw)) return { kind: 'other', raw };
    if (raw.trim() === '') return { kind: 'blank', raw };
    if (/^\s*\{/.test(raw) || (/\}\s*$/.test(raw) && !/\[/.test(raw))) return { kind: 'other', raw };
    const p = parseLyric(raw);
    if (!p) return { kind: 'other', raw };
    return { kind: 'lyric', raw, text: p.text, chords: p.chords };
  }

  function parse(text) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    return { lines: src.split('\n').map(parseLine) };
  }
  function serialize(model) {
    return model.lines.map((l) => l.raw).join('\n');
  }
  const clone = (m) => ({
    lines: m.lines.map((l) => (l.kind === 'lyric' ? Object.assign({}, l, { chords: l.chords.map((c) => Object.assign({}, c)) }) : Object.assign({}, l))),
  });

  // ---------- 코드 편집 ----------
  // 가사 줄의 코드들을 자리(pos) 순으로 안정 정렬하고 raw를 다시 만든다.
  function commitLine(l) {
    l.chords = l.chords.map((c, i) => ({ c: c.c, pos: Math.max(0, Math.min(l.text.length, c.pos)), i })).sort((a, b) => a.pos - b.pos || a.i - b.i).map(({ c, pos }) => ({ c, pos }));
    l.raw = lyricRaw(l.text, l.chords);
  }
  const editable = (m, li) => m.lines[li] && m.lines[li].kind === 'lyric';

  // 코드 하나 넣기. 반환: {model, ci} (ci = 그 줄 chords 안에서 새 코드의 번호). 같은 자리에 이미 있으면 그 뒤에 쌓는다.
  function addChord(model, li, pos, chord) {
    if (!editable(model, li)) return null;
    const m = clone(model);
    const l = m.lines[li];
    const p = Math.max(0, Math.min(l.text.length, pos));
    let at = l.chords.length;
    for (let i = 0; i < l.chords.length; i++) if (l.chords[i].pos > p) { at = i; break; }
    l.chords.splice(at, 0, { pos: p, c: chord });
    commitLine(l);
    // 정렬 뒤 새 코드 위치 찾기: 같은 자리의 마지막 번호
    let ci = -1;
    for (let i = 0; i < l.chords.length; i++) if (l.chords[i].pos === p) ci = i;
    return { model: m, ci };
  }
  function replaceChord(model, li, ci, chord) {
    if (!editable(model, li) || !model.lines[li].chords[ci]) return null;
    const m = clone(model);
    m.lines[li].chords[ci].c = chord;
    commitLine(m.lines[li]);
    return { model: m, ci };
  }
  function deleteChord(model, li, ci) {
    if (!editable(model, li) || !model.lines[li].chords[ci]) return null;
    const m = clone(model);
    m.lines[li].chords.splice(ci, 1);
    commitLine(m.lines[li]);
    return { model: m, ci: -1 };
  }
  // 코드를 한 글자씩 옮긴다(delta = -1 | +1). 줄 끝/처음에서는 멈춘다.
  function moveChord(model, li, ci, delta) {
    if (!editable(model, li) || !model.lines[li].chords[ci]) return null;
    const l0 = model.lines[li];
    const np = l0.chords[ci].pos + delta;
    if (np < 0 || np > l0.text.length) return { model, ci, moved: false };
    const m = clone(model);
    const l = m.lines[li];
    const mv = l.chords[ci];
    l.chords.splice(ci, 1);
    // 옮긴 코드는 도착한 자리의 맨 앞(오른쪽으로 갈 때) 또는 맨 뒤(왼쪽으로 갈 때)에 둔다. 같은 자리 순서가 자연스럽도록.
    mv.pos = np;
    let at = l.chords.length;
    for (let i = 0; i < l.chords.length; i++) {
      if (delta > 0 ? l.chords[i].pos >= np : l.chords[i].pos > np) { at = i; break; }
    }
    l.chords.splice(at, 0, mv);
    commitLine(l);
    let nci = l.chords.indexOf(mv);
    if (nci < 0) nci = l.chords.findIndex((c) => c.pos === np && c.c === mv.c);
    return { model: m, ci: nci, moved: true };
  }
  // 코드만 있는 줄(간주·인트로)에서 뒤에 코드를 이어 붙인다: 코드 사이를 공백 하나로 띄운다.
  function appendChord(model, li, chord) {
    if (!editable(model, li)) return null;
    const m = clone(model);
    const l = m.lines[li];
    if (l.text !== '' || l.chords.length) l.text += ' ';
    l.chords.push({ pos: l.text.length, c: chord });
    commitLine(l);
    return { model: m, ci: l.chords.length - 1 };
  }
  // 코드 글자에서 모양(quality)·베이스(bass)만 바꾼다. 코드 모양이 아니면 null.
  function reshape(chord, opt) {
    const m = /^([A-G][#b]?)([^/]*)(?:\/(.*))?$/.exec(String(chord).trim());
    if (!m) return null;
    const q = opt.quality === undefined ? m[2] : opt.quality;
    const bass = opt.bass === undefined ? m[3] : opt.bass;
    return m[1] + q + (bass ? '/' + bass : '');
  }

  // ---------- 줄 편집 ----------
  function insertLines(model, at, raws) {
    const m = clone(model);
    m.lines.splice(at, 0, ...raws.map(parseLine));
    return m;
  }
  function replaceLine(model, li, raw) {
    if (!model.lines[li]) return model;
    const m = clone(model);
    m.lines[li] = parseLine(String(raw).replace(/[\r\n]/g, ' '));
    return m;
  }
  function deleteLine(model, li) {
    if (!model.lines[li]) return model;
    const m = clone(model);
    m.lines.splice(li, 1);
    if (!m.lines.length) m.lines.push(parseLine(''));
    return m;
  }
  function clearChords(model, li) {
    if (!editable(model, li)) return model;
    const m = clone(model);
    m.lines[li].chords = [];
    commitLine(m.lines[li]);
    return m;
  }
  // 가사 글자만 고친다. 코드는 앞·뒤에서 그대로인 부분을 기준으로 따라가고, 고친 한가운데 있던 코드는 고친 자리 앞으로 모은다.
  function setLyricText(model, li, newText) {
    if (!editable(model, li)) return model;
    const m = clone(model);
    const l = m.lines[li];
    const a = l.text, b = String(newText).replace(/[\[\]\r\n]/g, '');
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    const delta = b.length - a.length;
    for (const c of l.chords) {
      if (c.pos >= a.length - s) c.pos += delta; // 그대로인 뒷부분의 글자에 붙어 있던 코드는 그 글자를 따라간다
      else if (c.pos > p) c.pos = p; // 고친 한가운데 있던 코드는 고친 자리 앞으로
    }
    l.text = b;
    commitLine(l);
    return m;
  }
  // 코드만 있는 줄(간주·인트로) 만들기: 글자 없이 끝자리에 코드를 쌓는 줄
  const instrumentalRaw = () => '';

  // ---------- 구간 ----------
  // 줄 li 앞에 구간 이름표를 넣는다(앞 줄이 비어 있지 않으면 빈 줄도 하나). 반환: {model, at(이름표가 들어간 줄 번호)}
  function insertSection(model, li, name) {
    const m = clone(model);
    const prev = m.lines[li - 1];
    const needGap = li > 0 && prev && prev.kind !== 'blank';
    const raws = (needGap ? [''] : []).concat(['{comment: ' + name + '}']);
    m.lines.splice(li, 0, ...raws.map(parseLine));
    return { model: m, at: li + raws.length - 1 };
  }
  // 후렴 범위: li가 들어 있는 {soc}~{eoc}를 찾는다. 없으면 null. 반환 {soc, eoc} (eoc 없으면 -1)
  function chorusAround(model, li) {
    let soc = -1;
    for (let i = li; i >= 0; i--) {
      const k = model.lines[i].kind;
      if (k === 'eoc' && i !== li) return null;
      if (k === 'soc') { soc = i; break; }
    }
    if (soc < 0) return null;
    let eoc = -1;
    for (let i = Math.max(li, soc) ; i < model.lines.length; i++) {
      if (model.lines[i].kind === 'eoc') { eoc = i; break; }
      if (model.lines[i].kind === 'soc' && i !== soc) break;
    }
    return { soc, eoc };
  }
  // li 줄이 들어 있는 한 덩어리(빈 줄·이름표·soc/eoc로 끊김)의 시작·끝
  function blockRange(model, li) {
    const isBody = (i) => model.lines[i] && (model.lines[i].kind === 'lyric' || model.lines[i].kind === 'other');
    if (!isBody(li)) return null;
    let a = li, b = li;
    while (isBody(a - 1)) a--;
    while (isBody(b + 1)) b++;
    return { a, b };
  }
  // 후렴 표시 켜고 끄기. 이미 후렴 안이면 {soc}/{eoc}(와 바로 위 "후렴" 이름표)를 지우고, 아니면 덩어리를 {soc}~{eoc}로 감싼다.
  function toggleChorus(model, li) {
    const ch = chorusAround(model, li);
    if (ch) {
      const m = clone(model);
      const drop = [];
      if (ch.eoc >= 0) drop.push(ch.eoc);
      drop.push(ch.soc);
      const above = m.lines[ch.soc - 1];
      if (above && above.kind === 'comment' && above.label === '후렴') drop.push(ch.soc - 1);
      drop.sort((x, y) => y - x).forEach((i) => m.lines.splice(i, 1));
      return { model: m, on: false };
    }
    const r = blockRange(model, li);
    if (!r) return null;
    const m = clone(model);
    m.lines.splice(r.b + 1, 0, parseLine('{eoc}'));
    const above = m.lines[r.a - 1];
    const hasLabel = above && above.kind === 'comment' && above.label === '후렴';
    const head = hasLabel ? ['{soc}'] : (r.a > 0 && above && above.kind !== 'blank' ? [''] : []).concat(['{comment: 후렴}', '{soc}']);
    m.lines.splice(r.a, 0, ...head.map(parseLine));
    return { model: m, on: true };
  }
  const isInChorus = (model, li) => !!chorusAround(model, li);

  // ---------- 반복 구간 코드 복사 (9차) ----------
  // 2절이 1절과 같은 진행이거나 후렴이 되풀이될 때, 이미 코드를 단 줄·구간의 코드를 다른 줄·구간으로 복사한다.
  // 가사 글자가 완전히 같으면 코드 자리도 그대로, 글자 수가 다르면 줄 길이에 비례해 옮기고 가까운 낱말 시작으로 맞춘다.
  const lyricKey = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const isWordStart = (t, p) => p === 0 ? t[0] !== ' ' : p >= t.length ? false : t[p - 1] === ' ' && t[p] !== ' ';
  const wordSpans = (t) => { const r = []; const re = /\S+/g; let m; while ((m = re.exec(t))) r.push([m.index, m.index + m[0].length]); return r; };
  // src 줄의 코드들을 dstText 위의 자리로 옮긴 목록 [{pos,c}]
  function mapChords(src, dstText) {
    const a = src.text, b = String(dstText);
    if (a === b) return src.chords.map((c) => ({ pos: c.pos, c: c.c }));
    if (!a.length) return src.chords.map((c) => ({ pos: Math.min(c.pos, b.length), c: c.c }));
    // 낱말 개수가 같으면 "몇 번째 낱말의 몇 번째 글자"로 그대로 옮긴다. (비례 계산보다 훨씬 일정하다)
    const wa = wordSpans(a), wb = wordSpans(b);
    if (wa.length && wa.length === wb.length) {
      return src.chords.map((c) => {
        if (c.pos >= a.length) return { pos: b.length, c: c.c };
        let k = wa.findIndex((w) => c.pos < w[1]);
        if (k < 0) return { pos: b.length, c: c.c };
        const off = Math.max(0, c.pos - wa[k][0]);
        return { pos: wb[k][0] + Math.min(off, wb[k][1] - wb[k][0] - 1), c: c.c };
      });
    }
    return src.chords.map((c) => {
      let np = Math.round((c.pos * b.length) / a.length);
      np = Math.max(0, Math.min(b.length, np));
      if (np < b.length && !isWordStart(b, np)) {
        for (let d = 1; d <= 2; d++) {
          if (np - d >= 0 && isWordStart(b, np - d)) { np -= d; break; }
          if (np + d < b.length && isWordStart(b, np + d)) { np += d; break; }
        }
      }
      return { pos: np, c: c.c };
    });
  }
  // li 줄과 가사가 같고 코드가 달린 다른 줄의 번호(가까운 줄 우선, 같은 거리면 위쪽). 없으면 -1.
  function findSameLyric(model, li) {
    const l = model.lines[li];
    if (!l || l.kind !== 'lyric') return -1;
    const k = lyricKey(l.text);
    if (!k) return -1;
    let best = -1, bd = Infinity;
    model.lines.forEach((o, i) => {
      if (i === li || o.kind !== 'lyric' || !o.chords.length || lyricKey(o.text) !== k) return;
      const d = Math.abs(i - li) * 2 + (i > li ? 1 : 0);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  // 한 줄 복사: srcLi의 코드를 dstLi로. 도착 줄에 이미 코드가 있으면 overwrite일 때만 덮어쓴다. 복사할 게 없으면 null.
  function copyLineChords(model, dstLi, srcLi, opt) {
    const s = model.lines[srcLi], d = model.lines[dstLi];
    if (!s || !d || s.kind !== 'lyric' || d.kind !== 'lyric' || !s.chords.length || srcLi === dstLi) return null;
    if (d.chords.length && !(opt && opt.overwrite)) return null;
    const m = clone(model);
    m.lines[dstLi].chords = mapChords(s, d.text);
    commitLine(m.lines[dstLi]);
    return { model: m };
  }
  // 가사 덩어리(빈 줄·이름표·{soc}로 끊김) 목록. label = 바로 위 구간 이름표, chordLines = 코드가 달린 줄 수.
  function bodyBlocks(model) {
    const isBody = (i) => model.lines[i] && (model.lines[i].kind === 'lyric' || model.lines[i].kind === 'other');
    const out = [];
    for (let i = 0; i < model.lines.length; i++) {
      if (!isBody(i)) continue;
      let a = i, b = i;
      while (isBody(b + 1)) b++;
      let j = a - 1;
      if (model.lines[j] && model.lines[j].kind === 'soc') j--;
      const lab = model.lines[j] && model.lines[j].kind === 'comment' ? model.lines[j].label : '';
      const ls = [];
      for (let k = a; k <= b; k++) if (model.lines[k].kind === 'lyric') ls.push(model.lines[k]);
      out.push({ a, b, label: lab, lines: ls.length, chordLines: ls.filter((l) => l.chords.length).length, first: ls.length ? ls[0].text.trim() : '' });
      i = b;
    }
    return out;
  }
  // 구간 복사: src 덩어리의 k번째 줄 코드 → dst 덩어리의 k번째 줄. 코드가 이미 있는 줄은 overwrite일 때만 덮어쓴다.
  // 반환 {model, filled, skipped, extra}  (extra = dst에 짝이 없어 비어 있는 줄 수, skipped = 이미 코드가 있어 건너뛴 줄 수)
  function copyBlock(model, src, dst, opt) {
    if (!src || !dst || src.a === dst.a) return { model, filled: 0, skipped: 0, extra: 0 };
    const m = clone(model);
    let filled = 0, skipped = 0, extra = 0;
    const n = dst.b - dst.a + 1;
    for (let k = 0; k < n; k++) {
      const d = m.lines[dst.a + k];
      if (!d || d.kind !== 'lyric') continue;
      const s = k <= src.b - src.a ? m.lines[src.a + k] : null;
      if (!s || s.kind !== 'lyric' || !s.chords.length) { if (!s) extra++; continue; }
      if (d.chords.length && !(opt && opt.overwrite)) { skipped++; continue; }
      d.chords = mapChords(s, d.text);
      commitLine(d);
      filled++;
    }
    return { model: m, filled, skipped, extra };
  }

  // ---------- 가사 붙여넣기 → 구간 나누기 ----------
  const LABEL_RE = /^[\[\(【<＜\-–—\s]*(인트로|intro|1\s*절|2\s*절|3\s*절|4\s*절|5\s*절|프리\s*코러스|프리|pre\s*-?\s*chorus|후렴|코러스|chorus|브릿지|브리지|bridge|간주|interlude|엔딩|ending|outro|verse\s*\d?|v\d)\s*\d?[\]\)】>＞\-–—\s:：]*$/i;
  function canonLabel(s) {
    const t = s.toLowerCase().replace(/[\s\[\]\(\)【】<>＜＞\-–—:：]/g, '');
    if (/^인트로|^intro/.test(t)) return '인트로';
    let m = /^(\d)절/.exec(t);
    if (m) return m[1] + '절';
    m = /^(?:verse|v)(\d)/.exec(t);
    if (m) return m[1] + '절';
    if (/^verse|^v$/.test(t)) return '1절';
    if (/^프리|^pre/.test(t)) return '프리코러스';
    if (/^후렴|^코러스|^chorus/.test(t)) return '후렴';
    if (/^브릿지|^브리지|^bridge/.test(t)) return '브릿지';
    if (/^간주|^interlude/.test(t)) return '간주';
    if (/^엔딩|^ending|^outro/.test(t)) return '엔딩';
    return '';
  }
  const normBlock = (lines) => lines.join('\n').replace(/\s+/g, '').toLowerCase();
  // 붙여넣은 가사를 빈 줄 기준으로 덩어리로 나눈다. 반환: [{lines:[…], label}] — label은 추측(바꿀 수 있음).
  function splitLyrics(text) {
    const src = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/\s+$/, ''));
    const blocks = [];
    let cur = [];
    let pendingLabel = '';
    const flush = () => {
      if (cur.length) blocks.push({ lines: cur, label: pendingLabel });
      cur = [];
      pendingLabel = '';
    };
    for (const raw of src) {
      if (raw.trim() === '') { flush(); continue; }
      if (LABEL_RE.test(raw.trim())) {
        // "[후렴]" 같은 이름표 줄: 이어지는 덩어리의 이름으로 쓴다.
        if (cur.length) flush();
        pendingLabel = canonLabel(raw.trim());
        continue;
      }
      cur.push(raw.replace(/\[/g, '(').replace(/\]/g, ')').replace(/[{}]/g, ''));
    }
    flush();
    // 이름이 없는 덩어리 추측: 같은 가사가 두 번 이상 나오면 후렴, 나머지는 1절·2절…
    const count = new Map();
    blocks.forEach((b) => { const k = normBlock(b.lines); count.set(k, (count.get(k) || 0) + 1); });
    const named = new Set(blocks.map((b) => b.label).filter(Boolean));
    let verse = 0;
    for (const b of blocks) {
      if (b.label) continue;
      if (count.get(normBlock(b.lines)) > 1) { b.label = '후렴'; continue; }
      do { verse++; } while (named.has(verse + '절'));
      b.label = verse <= 5 ? verse + '절' : '';
    }
    return blocks;
  }
  // 덩어리 목록 → ChordPro 글자. label이 '' 이면 이름표 없이 가사만. 후렴은 {soc}~{eoc}로 감싼다.
  function buildFromBlocks(blocks) {
    const out = [];
    blocks.forEach((b, i) => {
      if (!b.lines.length) return;
      if (i > 0 && out.length) out.push('');
      if (b.label) out.push('{comment: ' + b.label + '}');
      if (b.label === '후렴') out.push('{soc}');
      out.push(...b.lines);
      if (b.label === '후렴') out.push('{eoc}');
    });
    return out.join('\n');
  }

  return {
    SECTION_NAMES,
    parse, serialize, parseLyric, lyricRaw,
    addChord, appendChord, replaceChord, deleteChord, moveChord, reshape,
    insertLines, replaceLine, deleteLine, clearChords, setLyricText, instrumentalRaw,
    insertSection, chorusAround, blockRange, toggleChorus, isInChorus,
    lyricKey, findSameLyric, copyLineChords, bodyBlocks, copyBlock,
    splitLyrics, buildFromBlocks, canonLabel,
  };
});
