// 탭 편집기용 무손실 변환·편집 함수 (7차 B단계) — 화면과 무관한 순수 함수. 브라우저와 Node 테스트 양쪽에서 사용.
// 저장 형식(ChordPro 글자)은 그대로. 모델은 "줄 목록"이고, 손대지 않은 줄은 원문(raw)을 그대로 돌려준다.
//   parse(text)      → { lines:[ {kind, raw, ...} ] }
//   serialize(model) → 글자 (손대지 않았다면 parse 전 글자와 완전히 같다)
// kind: 'lyric'(가사+[코드]) | 'blank' | 'comment'({comment:}) | 'ref'({ref: C} 구간 자리표시) | 'soc' | 'eoc' | 'other'(주석·모르는 지시어·괄호가 깨진 줄: 그대로 보존)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sections.js'));
  else root.TabEdit = factory(root.Sections);
})(typeof self !== 'undefined' ? self : this, function (Sections) {
  const DIRECTIVE = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/;
  const SECTION_NAMES = Sections.PICKS; // Intro V1~V5 PC C B Inter Tag Outro End

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
      if (name === 'column_break' || name === 'colb') return { kind: 'colb', raw };
      if (name === 'ref' || name === 'chorus') { const c = Sections.canon(val); return { kind: 'ref', raw, id: c ? c.id : name === 'chorus' && !val ? 'C' : val, rest: c ? c.rest : '' }; }
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
  const isChorusLabel = (label) => { const c = Sections.canon(label); return !!c && c.id === 'C' && !c.rest; };
  // 후렴 표시 켜고 끄기. 이미 후렴 안이면 {soc}/{eoc}(와 바로 위 "후렴" 이름표)를 지우고, 아니면 덩어리를 {soc}~{eoc}로 감싼다.
  function toggleChorus(model, li) {
    const ch = chorusAround(model, li);
    if (ch) {
      const m = clone(model);
      const drop = [];
      if (ch.eoc >= 0) drop.push(ch.eoc);
      drop.push(ch.soc);
      const above = m.lines[ch.soc - 1];
      if (above && above.kind === 'comment' && isChorusLabel(above.label)) drop.push(ch.soc - 1);
      drop.sort((x, y) => y - x).forEach((i) => m.lines.splice(i, 1));
      return { model: m, on: false };
    }
    const r = blockRange(model, li);
    if (!r) return null;
    const m = clone(model);
    m.lines.splice(r.b + 1, 0, parseLine('{eoc}'));
    const above = m.lines[r.a - 1];
    const hasLabel = above && above.kind === 'comment' && isChorusLabel(above.label);
    const head = hasLabel ? ['{soc}'] : (r.a > 0 && above && above.kind !== 'blank' ? [''] : []).concat(['{comment: C}', '{soc}']);
    m.lines.splice(r.a, 0, ...head.map(parseLine));
    return { model: m, on: true };
  }
  const isInChorus = (model, li) => !!chorusAround(model, li);

  // ---------- 구간 자리표시 (18차) ----------
  // {ref: C} 한 줄이 "앞에 나온 C 구간을 여기서 다시"를 뜻한다. 같은 가사·코드가 반복되는 구간은 처음 한 번만 쓰고 나머지는 자리표시로 둔다.
  // 구간 목록 [{a, b(끝 다음 줄, 끝의 빈 줄 제외), id, label, isRef, hasLyrics, implicit}]
  function listSections(model) {
    const L = model.lines;
    const secs = [];
    let cur = null;
    const isBody = (k) => k === 'lyric' || k === 'other';
    const close = (i) => { if (cur) { cur.b = i; cur = null; } };
    L.forEach((l, i) => {
      if (l.kind === 'comment') {
        close(i);
        const c = Sections.canon(l.label);
        cur = { a: i, b: L.length, id: c ? c.id : '', label: l.label, rest: c ? c.rest : '', isRef: false, hasLyrics: false, implicit: false };
        secs.push(cur);
      } else if (l.kind === 'ref') {
        close(i);
        secs.push({ a: i, b: i + 1, id: l.id, label: l.id + (l.rest ? ' ' + l.rest : ''), rest: l.rest || '', isRef: true, hasLyrics: false, implicit: false });
      } else if (l.kind === 'soc') {
        if (!cur || cur.hasLyrics) { close(i); cur = { a: i, b: L.length, id: 'C', label: '', rest: '', isRef: false, hasLyrics: false, implicit: true }; secs.push(cur); }
      } else if (isBody(l.kind)) {
        if (!cur) { cur = { a: i, b: L.length, id: '', label: '', rest: '', isRef: false, hasLyrics: false, implicit: true }; secs.push(cur); }
        if (l.kind === 'lyric') cur.hasLyrics = true;
      }
    });
    secs.forEach((x) => {
      if (x.isRef) return;
      while (x.b > x.a + 1 && (L[x.b - 1].kind === 'blank' || L[x.b - 1].kind === 'colb')) x.b--;
    });
    return secs;
  }
  const sectionAt = (model, li) => listSections(model).find((x) => li >= x.a && li < x.b) || null;
  // 구간 본문의 원문 줄들(이름표 제외, 단 나누기 제외). 같은 구간인지 비교하고 펼칠 때 쓴다.
  function sectionRaws(model, sec) {
    const out = [];
    for (let i = sec.a; i < sec.b; i++) {
      const l = model.lines[i];
      if (i === sec.a && l.kind === 'comment') continue;
      if (l.kind === 'colb' || l.kind === 'ref') continue;
      out.push(l.raw);
    }
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return out;
  }
  // 자리표시 줄 li의 원본 구간. 같은 이름의 가사 있는 구간 중 바로 앞의 것, 없으면 곡 안 첫 번째.
  function refSource(model, li) {
    const secs = listSections(model);
    const me = secs.find((x) => x.a === li && x.isRef);
    if (!me) return null;
    let best = null;
    for (const o of secs) {
      if (o.isRef || !o.hasLyrics || o.id !== me.id) continue;
      if (o.a < li) best = o;
      else if (!best) { best = o; break; }
    }
    return best;
  }
  // 구간(li가 들어 있는)을 자리표시로 바꾼다. 앞에 같은 이름의 구간이 있어야 하고, 코드·가사가 같을 때만 바로 바꾼다.
  // 반환: {model} | {need:'name'|'source'} | {diff:true, srcA} (코드·가사가 달라 확인이 필요: force로 다시 부르면 바꿈)
  function sectionToRef(model, li, opt) {
    const secs = listSections(model);
    const me = secs.find((x) => li >= x.a && li < x.b && !x.isRef);
    if (!me || !me.hasLyrics) return { need: 'section' };
    if (!me.id) return { need: 'name' };
    let src = null;
    for (const o of secs) if (!o.isRef && o.hasLyrics && o.id === me.id && o.a < me.a) src = o;
    if (!src) return { need: 'source' };
    const same = sectionRaws(model, src).join('\n') === sectionRaws(model, me).join('\n');
    if (!same && !(opt && opt.force)) return { diff: true, srcA: src.a };
    const m = clone(model);
    m.lines.splice(me.a, me.b - me.a, parseLine('{ref: ' + me.id + (me.rest ? ' ' + me.rest : '') + '}'));
    return { model: m, at: me.a };
  }
  // 자리표시를 펼쳐서 따로 쓴다: 원본 구간을 복사해 이름표 + 본문으로 바꾼다. 원본이 없으면 null.
  function refToSection(model, li) {
    const src = refSource(model, li);
    if (!src) return null;
    const l = model.lines[li];
    const m = clone(model);
    const raws = ['{comment: ' + l.id + (l.rest ? ' ' + l.rest : '') + '}'].concat(sectionRaws(model, src));
    m.lines.splice(li, 1, ...raws.map(parseLine));
    return { model: m, at: li };
  }
  // 반복 구간 정리 후보: 같은 이름 구간이 앞에도 있는 구간들. same = 코드·가사까지 같음(자동으로 바꿔도 안전), 아니면 이유를 단다.
  function repeatCandidates(model) {
    const secs = listSections(model);
    const out = [];
    secs.forEach((me) => {
      if (me.isRef || !me.hasLyrics || !me.id) return;
      let src = null;
      for (const o of secs) if (!o.isRef && o.hasLyrics && o.id === me.id && o.a < me.a) src = o;
      if (!src) return;
      const A = sectionRaws(model, src), B = sectionRaws(model, me);
      const same = A.join('\n') === B.join('\n');
      let why = '';
      if (!same) {
        const strip = (r) => lyricKey(r.replace(/\[[^\]]*\]/g, ''));
        why = A.map(strip).join('|') === B.map(strip).join('|') ? '코드가 달라요' : '가사가 달라요';
      }
      out.push({ a: me.a, b: me.b, id: me.id, label: me.label || me.id, srcA: src.a, same, why });
    });
    return out;
  }
  // 반복 구간 정리 실행: rows(repeatCandidates 중 고른 것)를 아래쪽부터 자리표시로 바꾼다. 반환 {model, n}
  function collapseRepeats(model, rows) {
    const m = clone(model);
    let n = 0;
    [...rows].sort((x, y) => y.a - x.a).forEach((r) => {
      const l = m.lines[r.a];
      const rest = l && l.kind === 'comment' ? (Sections.canon(l.label) || {}).rest || '' : '';
      m.lines.splice(r.a, r.b - r.a, parseLine('{ref: ' + r.id + (rest ? ' ' + rest : '') + '}'));
      n++;
    });
    return { model: m, n };
  }
  // 줄 li 앞에 자리표시를 넣는다(앞 줄이 비어 있지 않으면 빈 줄도 하나). 반환 {model, at}
  function insertRef(model, li, id) {
    const m = clone(model);
    const prev = m.lines[li - 1];
    const next = m.lines[li];
    const needGap = li > 0 && prev && prev.kind !== 'blank';
    const gapAfter = !!next && next.kind !== 'blank'; // 아래에도 빈 줄: 다음 구간과 붙어 보이지 않게
    const raws = (needGap ? [''] : []).concat(['{ref: ' + id + '}'], gapAfter ? [''] : []);
    m.lines.splice(li, 0, ...raws.map(parseLine));
    return { model: m, at: li + (needGap ? 1 : 0) };
  }
  // 줄 li "아래"에 넣을 자리(줄 번호). 바로 아래가 {eoc}면 그 뒤로 넘긴다. 곡 끝이면 줄 수.
  function belowAt(model, li) {
    let at = li + 1;
    if (model.lines[at] && model.lines[at].kind === 'eoc') at++;
    return Math.min(at, model.lines.length);
  }
  // 지금 악보에 나온 구간 이름들(자리표시 칩 후보). 가사가 있는 구간만, 처음 나온 순서.
  function usedSectionIds(model) {
    const seen = [];
    listSections(model).forEach((x) => { if (!x.isRef && x.hasLyrics && x.id && !seen.includes(x.id)) seen.push(x.id); });
    return seen;
  }
  // 저장 점검용: 원본이 없는 자리표시 / 이름을 알아볼 수 없는 자리표시의 줄 번호(0부터)
  function refProblems(model) {
    const secs = listSections(model);
    const out = [];
    secs.forEach((x) => {
      if (!x.isRef) return;
      if (!Sections.canon(x.id)) out.push({ li: x.a, why: 'name' });
      else if (!refSource(model, x.a)) out.push({ li: x.a, why: 'source' });
    });
    return out;
  }

  // ---------- 단 나누기 (2단 보기에서 여기부터 다음 단) ----------
  // li 줄이 "다음 단의 첫 줄"이 되도록 {column_break}를 넣을 자리. 바로 위의 구간 이름표·{soc}는 함께 다음 단으로 보낸다.
  function colBreakPos(model, li) {
    let p = li;
    while (p > 0 && model.lines[p - 1] && (model.lines[p - 1].kind === 'comment' || model.lines[p - 1].kind === 'soc')) p--;
    return p;
  }
  // 이 자리에 이미 단 나누기가 있으면 그 줄 번호, 없으면 -1
  function colBreakAt(model, li) {
    const p = colBreakPos(model, li);
    return p > 0 && model.lines[p - 1] && model.lines[p - 1].kind === 'colb' ? p - 1 : -1;
  }
  // 단 나누기를 모두 지우고 li 앞에 하나만 둔다(한 곡에 하나만 쓰므로). 반환 {model, at}
  function setColBreak(model, li) {
    const m = clone(model);
    let pos = colBreakPos(m, li);
    // 원래 있던 표시는 먼저 지우고, 지운 만큼 자리를 당긴다
    for (let i = m.lines.length - 1; i >= 0; i--) {
      if (m.lines[i].kind === 'colb') { m.lines.splice(i, 1); if (i < pos) pos--; }
    }
    m.lines.splice(pos, 0, parseLine('{column_break}'));
    return { model: m, at: pos };
  }
  function clearColBreaks(model) {
    const m = clone(model);
    m.lines = m.lines.filter((l) => l.kind !== 'colb');
    if (!m.lines.length) m.lines.push(parseLine(''));
    return m;
  }

  // ---------- 반복 구간 코드 복사 (9차) ----------
  // 2절이 1절과 같은 진행이거나 후렴이 되풀이될 때, 이미 코드를 단 줄·구간의 코드를 다른 줄·구간으로 복사한다.
  // 가사 글자가 완전히 같으면 코드 자리도 그대로, 글자 수가 다르면 줄 길이에 비례해 옮기고 가까운 낱말 시작으로 맞춘다.
  const lyricKey = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const isWordStart = (t, p) => p === 0 ? t[0] !== ' ' : p >= t.length ? false : t[p - 1] === ' ' && t[p] !== ' ';
  const wordSpans = (t) => { const r = []; const re = /\S+/g; let m; while ((m = re.exec(t))) r.push([m.index, m.index + m[0].length]); return r; };
  // src 줄의 코드들을 dstText 위의 자리로 옮긴 목록 [{pos,c}]
  // 띄어쓰기를 뺀 글자 수 / k번째(0부터) 글자의 위치(없으면 끝) / 한글이 절반 이상인 줄
  const nonSpaceCount = (t) => String(t).replace(/\s/g, '').length;
  function nonSpacePos(t, k) {
    let n = 0;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      if (n === k) return i;
      n++;
    }
    return t.length;
  }
  function isKorean(t) {
    const ns = String(t).replace(/\s/g, '');
    if (!ns) return false;
    return ((ns.match(/[\uAC00-\uD7A3]/g) || []).length * 2) >= ns.length;
  }
  function mapChords(src, dstText) {
    const a = src.text, b = String(dstText);
    if (a === b) return src.chords.map((c) => ({ pos: c.pos, c: c.c }));
    if (!a.length) return src.chords.map((c) => ({ pos: Math.min(c.pos, b.length), c: c.c }));
    // 한국어 가사는 띄어쓰기가 줄마다 달라지기 쉬우므로, 띄어쓰기를 뺀 글자 수로 위치를 센다.
    // (코드 앞에 글자가 몇 개 있었는지 → 새 줄에서 그 개수만큼 지난 글자 앞)
    const ko = isKorean(a) && isKorean(b);
    const na = nonSpaceCount(a), nb = nonSpaceCount(b);
    if (ko && na === nb) {
      return src.chords.map((c) => (c.pos >= a.length ? { pos: b.length, c: c.c } : { pos: nonSpacePos(b, nonSpaceCount(a.slice(0, c.pos))), c: c.c }));
    }
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
      let np;
      if (ko && na && nb) {
        // 글자 수가 다른 한국어 줄: 띄어쓰기를 뺀 글자 수 기준으로 비례
        np = c.pos >= a.length ? b.length : nonSpacePos(b, Math.min(nb, Math.round((nonSpaceCount(a.slice(0, c.pos)) * nb) / na)));
      } else np = Math.round((c.pos * b.length) / a.length);
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

  // ---------- 가사 붙여넣기 → 구간 나누기 (19차) ----------
  // 붙여넣은 가사를 구간(덩어리)으로 나누고, 이름을 추측하고, 같은 가사가 반복되면 자동으로 자리표시로 만든다.
  // 블록: {lines:[…], label:'V1'|'C'|…|'', fixed:이름을 사람이 정했거나 이름표 줄이 있었음, guess:추측이 불확실함, ref:이 구간은 위와 같음(자리표시), expand:반복이어도 펼쳐서 넣기}
  const blockKey = (lines) => lyricKey(lines.join(' '));
  // 줄 하나가 구간 이름표인지: "[후렴]" "Chorus" "V1:" "1절" … 이름 뒤에 다른 글자가 없어야 한다. 반환 표준 이름 또는 ''
  function labelOfLine(raw) {
    const t = String(raw || '').trim();
    if (!t || t.length > 24) return '';
    const c = Sections.canon(t);
    return c && !c.rest ? c.id : '';
  }
  // 빈 줄이 없는 가사: 반복되는 두 줄 이상의 덩어리를 찾아 경계를 추측한다. 반환 [나눌 줄 번호(그 줄 앞에서 나눔)…] 또는 []
  function guessBreaks(lines) {
    const n = lines.length;
    const k = lines.map((l) => lyricKey(l));
    let best = null;
    for (let i = 0; i < n; i++) {
      if (!k[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (k[i] !== k[j]) continue;
        let len = 0;
        while (j + len < n && i + len < j && k[i + len] === k[j + len] && k[i + len]) len++;
        if (len >= 2 && (!best || len > best.len)) best = { i, j, len };
      }
    }
    if (!best) return [];
    const key = k.slice(best.i, best.i + best.len).join('|');
    const starts = [];
    for (let i = 0; i + best.len <= n; i++) {
      if (k.slice(i, i + best.len).join('|') === key && (!starts.length || i >= starts[starts.length - 1] + best.len)) starts.push(i);
    }
    const br = new Set();
    for (const st of starts) { if (st > 0) br.add(st); if (st + best.len < n) br.add(st + best.len); }
    return [...br].sort((x, y) => x - y);
  }
  function splitLyrics(text, opt) {
    const src = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/\s+$/, ''));
    const clean = (raw) => raw.replace(/\[/g, '(').replace(/\]/g, ')').replace(/[{}]/g, '');
    const blocks = [];
    let cur = [];
    let pending = '';
    const flush = () => {
      if (cur.length) blocks.push({ lines: cur, label: pending, fixed: !!pending, guess: false, ref: false, expand: false });
      cur = [];
      pending = '';
    };
    for (const raw of src) {
      if (raw.trim() === '') { flush(); continue; }
      const id = labelOfLine(raw);
      if (id) { flush(); pending = id; continue; } // 이름표 줄: 이어지는 덩어리의 이름
      cur.push(clean(raw));
    }
    flush();
    // 빈 줄이 하나도 없어 한 덩어리뿐이면, 반복되는 줄을 기준으로 경계를 추측한다
    if (!(opt && opt.noBreaks) && blocks.length === 1 && !blocks[0].fixed && blocks[0].lines.length >= 6) {
      const br = guessBreaks(blocks[0].lines);
      if (br.length) {
        const ls = blocks[0].lines;
        const out = [];
        let a = 0;
        for (const b of [...br, ls.length]) { if (b > a) out.push({ lines: ls.slice(a, b), label: '', fixed: false, guess: false, ref: false, expand: false }); a = b; }
        blocks.length = 0;
        blocks.push(...out);
        blocks.guessedBreaks = true;
      }
    }
    return autoLabel(blocks);
  }
  // 이름 추측 + 반복 자동 자리표시. 사람이 정한 이름(fixed)은 건드리지 않는다.
  //  · 같은 가사가 가장 많이 반복되는 덩어리 → C(앞의 것이 원본)  · 첫 C 앞은 V1, C 사이는 V2·V3…
  //  · 두 번째 C 뒤에 한 번만 나오는 덩어리는 B 후보(노란색, 확인 필요)
  function autoLabel(blocks) {
    const keys = blocks.map((b) => blockKey(b.lines));
    const count = new Map();
    keys.forEach((k) => count.set(k, (count.get(k) || 0) + 1));
    // 이름이 정해진 덩어리의 가사는 그 이름을 같은 가사 덩어리 모두에게 퍼뜨린다
    blocks.forEach((b, i) => {
      if (!b.fixed) return;
      blocks.forEach((o, j) => { if (j !== i && !o.fixed && keys[j] === keys[i]) { o.label = b.label; o.guess = false; o.spread = true; } });
    });
    const free = (b) => !b.fixed && !b.spread;
    let chorusKey = null, bestN = 1;
    const seenOrder = [];
    blocks.forEach((b, i) => {
      if (!free(b) || count.get(keys[i]) < 2) return;
      if (!seenOrder.includes(keys[i])) seenOrder.push(keys[i]);
      const n = count.get(keys[i]);
      if (n > bestN || (n === bestN && chorusKey === null)) { bestN = n; chorusKey = keys[i]; }
    });
    const usedLabels = new Set(blocks.filter((b) => !free(b)).map((b) => b.label));
    const hasFixedC = usedLabels.has('C');
    let verse = 0;
    let sawC = 0;
    const nextVerse = () => { do { verse++; } while (usedLabels.has('V' + verse)); return 'V' + verse; };
    blocks.forEach((b, i) => {
      if (!free(b)) { if (b.label === 'C') sawC++; return; }
      b.guess = false;
      if (chorusKey !== null && keys[i] === chorusKey && !hasFixedC) { b.label = 'C'; sawC++; return; }
      if (count.get(keys[i]) > 1) { // 후렴 말고 반복되는 덩어리: 한 번 확인
        const same = blocks.find((o, j) => j < i && keys[j] === keys[i] && o.label);
        if (same) { b.label = same.label; b.guess = same.guess; return; }
        b.label = chorusKey === null ? nextVerse() : sawC >= 2 ? 'B' : 'PC';
        b.guess = true;
        return;
      }
      if (sawC >= 2 && chorusKey !== null) { b.label = 'B'; b.guess = true; return; }
      b.label = nextVerse();
    });
    return markRefs(blocks);
  }
  // 같은 가사 + 같은 이름인 앞 덩어리가 있으면 자리표시로. (expand가 켜진 덩어리는 펼쳐서 넣는다)
  function markRefs(blocks) {
    const keys = blocks.map((b) => blockKey(b.lines));
    blocks.forEach((b, i) => {
      b.ref = !!b.label && !b.expand && blocks.some((o, j) => j < i && keys[j] === keys[i] && o.label === b.label && !o.ref);
    });
    return blocks;
  }
  // 한 덩어리의 이름을 바꾼다. 같은 가사의 다른 덩어리도 같은 이름으로 함께 바뀐다.
  function renameBlock(blocks, i, id) {
    const k = blockKey(blocks[i].lines);
    blocks.forEach((b) => { if (blockKey(b.lines) === k) { b.label = id; b.fixed = true; b.guess = false; b.spread = false; } });
    blocks.forEach((b) => { if (!b.fixed) b.spread = false; });
    return autoLabel(blocks.map((b) => (b.fixed ? b : Object.assign({}, b, { label: '', spread: false }))));
  }
  function splitBlockAt(blocks, i, at) {
    const b = blocks[i];
    if (!b || at <= 0 || at >= b.lines.length) return blocks;
    const out = blocks.slice();
    out.splice(i, 1, { lines: b.lines.slice(0, at), label: b.fixed ? b.label : '', fixed: b.fixed, guess: false, ref: false, expand: false }, { lines: b.lines.slice(at), label: '', fixed: false, guess: false, ref: false, expand: false });
    return autoLabel(out.map((x) => (x.fixed ? x : Object.assign({}, x, { label: '', spread: false }))));
  }
  function mergeBlockUp(blocks, i) {
    if (i <= 0 || !blocks[i]) return blocks;
    const out = blocks.slice();
    const up = out[i - 1];
    out.splice(i - 1, 2, { lines: up.lines.concat(blocks[i].lines), label: up.fixed ? up.label : '', fixed: up.fixed, guess: false, ref: false, expand: false });
    return autoLabel(out.map((x) => (x.fixed ? x : Object.assign({}, x, { label: '', spread: false }))));
  }
  // 추정 송폼 한 줄: 덩어리 순서대로의 이름, 같은 이름이 붙어서 이어지면 C×2. 화면에 보여 주고 복사만 한다(곡에 저장하지 않음).
  function estimateForm(blocks) {
    const out = [];
    for (const b of blocks) {
      if (!b.label) continue;
      const last = out[out.length - 1];
      if (last && last.id === b.label) last.n++;
      else out.push({ id: b.label, n: 1 });
    }
    return out.map((x) => (x.n > 1 ? x.id + '×' + x.n : x.id)).join('-');
  }
  // 덩어리 목록 → ChordPro 글자. label이 '' 이면 이름표 없이 가사만. C(후렴)는 {soc}~{eoc}로 감싼다.
  // 자리표시 덩어리는 {ref: 이름} 한 줄만 쓴다.
  function buildFromBlocks(blocks) {
    const out = [];
    blocks.forEach((b, i) => {
      if (!b.lines.length) return;
      if (i > 0 && out.length) out.push('');
      if (b.ref && b.label) { out.push('{ref: ' + b.label + '}'); return; }
      if (b.label) out.push('{comment: ' + b.label + '}');
      const ch = b.label === 'C';
      if (ch) out.push('{soc}');
      out.push(...b.lines);
      if (ch) out.push('{eoc}');
    });
    return out.join('\n');
  }
  // 예전 이름 (한글 이름 → 표준 이름)
  const canonLabel = (s) => labelOfLine(s) || (Sections.canon(s) || {}).id || '';

  return {
    SECTION_NAMES,
    parse, serialize, parseLyric, lyricRaw,
    addChord, appendChord, replaceChord, deleteChord, moveChord, reshape,
    insertLines, replaceLine, deleteLine, clearChords, setLyricText, instrumentalRaw,
    insertSection, belowAt, chorusAround, blockRange, toggleChorus, isInChorus,
    listSections, sectionAt, sectionRaws, refSource, sectionToRef, refToSection, repeatCandidates, collapseRepeats, insertRef, usedSectionIds, refProblems,
    colBreakAt, setColBreak, clearColBreaks,
    lyricKey, findSameLyric, copyLineChords, bodyBlocks, copyBlock,
    splitLyrics, buildFromBlocks, canonLabel, labelOfLine, guessBreaks, autoLabel, markRefs, renameBlock, splitBlockAt, mergeBlockUp, estimateForm,
  };
});
