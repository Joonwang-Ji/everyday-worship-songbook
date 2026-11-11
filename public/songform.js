// 송폼(구간 순서) 처리 + 카톡용 콘티 텍스트 (브라우저와 Node 테스트 양쪽에서 사용)
// 송폼은 서버에 "Intro-V1-C-V2-C-B-C" 같은 한 줄 글자로 저장된다. 탭으로 만들든 직접 쓰든 같은 형식. 구간 이름은 sections.js(표준 약어)를 따른다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sections.js'));
  else root.SongForm = factory(root.Sections);
})(typeof self !== 'undefined' ? self : this, function (Sections) {
  const MAX = 200; // 서버가 받는 최대 글자 수

  // 누르는 버튼. code = 실제로 저장되는 글자, hint = 버튼 아래 작은 풀네임 (sections.js 한 곳의 표를 쓴다)
  const PALETTE = Sections.PALETTE;

  // "V1-C-V2 C (2번)" → ['V1','C','V2','C','(2번)']  (구분: - – → > , 와 빈칸. 괄호 안은 한 덩어리)
  // 전조 칩(Key+2(D7 E) · Key-1 · Key:A)은 한 덩어리로 묶는다. "Key+2 (D7 E)"처럼 띄어 쓴 괄호도 전조에 붙인다. (22차)
  function parse(str) {
    const m = String(str || '').match(Sections.FORM_TOKEN());
    const toks = m ? m.map((t) => t.trim()).filter(Boolean) : [];
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (isKeyChange(t) && !/\(/.test(t) && toks[i + 1] && toks[i + 1][0] === '(') { out.push(t + toks[i + 1]); i++; }
      else out.push(t);
    }
    return out;
  }
  const isKeyChange = (tok) => Sections.isKeyChange(tok);
  const format = (tokens) => tokens.join('-');

  // 마지막이 "C×2" 처럼 반복 표시면 [기본, 횟수]로 나눈다
  function splitRepeat(tok) {
    const m = /^(.*?)[×xX*](\d{1,2})$/.exec(tok);
    return m && m[1] ? { base: m[1], n: +m[2] } : { base: tok, n: 1 };
  }
  // 반복 표시를 한 단계 돌린다: (없음) → ×2 → ×3 → ×4 → 없음
  function cycleRepeat(tok) {
    if (isKeyChange(tok)) return tok; // 전조 칩에는 반복 표시를 쓰지 않는다
    const { base, n } = splitRepeat(tok);
    const next = n >= 4 ? 1 : n + 1;
    return next === 1 ? base : base + '×' + next;
  }

  // ---------- 전조 칩 (22차) ----------
  // 송폼 글자 속 "Key+2(D7 E)" · "Key-1" · "Key:A" → {delta(반음, +위/-아래) | null, to(도착 키) | null, chords(연결 코드)}. 아니면 null.
  const KMAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const KMINOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const mod12 = (n) => ((n % 12) + 12) % 12;
  function parseKeyName(str) {
    const m = /^([A-G])([#b]?)(m|min)?$/.exec(String(str || '').trim());
    return m ? { idx: mod12(LETTERS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)), minor: !!m[3] } : null;
  }
  const keyNameOf = (idx, minor) => (minor ? KMINOR : KMAJOR)[mod12(idx)] + (minor ? 'm' : '');
  function keyChange(tok) {
    const m = /^(?:Key|전조)(?:([+\-－−–])(\d{1,2})|:([A-Ga-g][#b♯♭]?m?))(?:\(([^)]*)\))?$/i.exec(String(tok || '').trim());
    if (!m) return null;
    const chords = (m[4] || '').trim();
    if (m[3]) {
      let to = m[3].replace('♯', '#').replace('♭', 'b');
      to = to[0].toUpperCase() + to.slice(1);
      return { delta: null, to, chords };
    }
    const n = +m[2];
    return { delta: m[1] === '+' ? n : -n, to: null, chords };
  }
  // 전조 칩 만들기: {delta | to, chords} → 저장 글자. 값이 맞지 않으면 ''.
  function makeKeyChange(o) {
    const chords = String((o && o.chords) || '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
    let core = '';
    if (o && o.to && parseKeyName(String(o.to).replace('♯', '#').replace('♭', 'b'))) core = 'Key:' + String(o.to).replace('♯', '#').replace('♭', 'b');
    else if (o && Number.isInteger(o.delta) && o.delta !== 0 && Math.abs(o.delta) <= 11) core = 'Key' + (o.delta > 0 ? '+' : '-') + Math.abs(o.delta);
    return core ? core + (chords ? '(' + chords + ')' : '') : '';
  }
  // 시작 키에서 송폼을 따라가며 전조 단계 목록을 만든다. 시작 키를 모르면 키 이름 없이 반음만 돌려준다.
  // → [{tok, delta, from, to, chords}]  (delta는 위로 0~11 또는 입력한 값)
  function keySteps(form, startKey) {
    const out = [];
    let cur = parseKeyName(startKey);
    for (const tok of parse(form)) {
      const kc = keyChange(tok);
      if (!kc) continue;
      const from = cur ? keyNameOf(cur.idx, cur.minor) : '';
      let to = '';
      let delta = kc.delta;
      if (kc.to) {
        const t = parseKeyName(kc.to);
        to = kc.to;
        if (cur && t) delta = mod12(t.idx - cur.idx);
        if (t) cur = { idx: t.idx, minor: t.minor };
      } else if (cur) {
        const ni = mod12(cur.idx + kc.delta);
        to = keyNameOf(ni, cur.minor);
        cur = { idx: ni, minor: cur.minor };
      }
      out.push({ tok, delta, from, to, chords: kc.chords });
    }
    return out;
  }
  const deltaText = (d) => (d === null || d === undefined ? '' : (d > 0 ? '+' : '') + d);
  // 전조 칩 하나의 보이는 글자. 예) "♯ 전조 +2 · G → A (D7 E)"
  function keyStepText(st) {
    const head = st.delta !== null && st.delta !== undefined && st.delta !== 0 ? deltaText(st.delta) : '';
    const keys = st.to ? (st.from ? `${st.from} → ${st.to}` : `→ ${st.to}`) : '';
    return `♯ 전조${head ? ' ' + head : ''}${keys ? (head ? ' · ' : ' ') + keys : ''}${st.chords ? ' (' + st.chords + ')' : ''}`;
  }
  // 곡 전체의 키 흐름. 예) "G → A → B". 전조가 없으면 ''. 시작 키를 모르면 ''.
  function keyPathText(form, startKey) {
    const steps = keySteps(form, startKey);
    if (!steps.length || !steps[0].from) return '';
    return [steps[0].from, ...steps.map((s) => s.to)].join(' → ');
  }
  // 송폼을 사람이 읽는 글자로 (카톡·PDF·가사 복사용): 전조 칩만 "전조 +2 G→A (D7 E)"로 풀어 쓴다.
  function formDisplay(form, startKey) {
    const steps = keySteps(form, startKey);
    let k = 0;
    return parse(form)
      .map((t) => (isKeyChange(t) ? keyStepText(steps[k++]).replace(/^♯ /, '').replace(/ · /, ' ').replace(/ → /g, '→') : t))
      .join('-');
  }
  const hasKeyChange = (form) => parse(form).some(isKeyChange);

  // ---------- 카톡용 콘티 텍스트 ----------
  const fmtDate = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) return '';
    const dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return `${+m[2]}/${+m[3]}(${'일월화수목금토'[dt.getDay()]})`;
  };

  // 인도자: 쉼표 글자 또는 배열 → 이름 배열
  const leaderList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);

  // s: { date, title, memo, leaders, items:[{title, key, original_key, form, memo}] }
  function kakaoText(s) {
    const date = fmtDate(s.date);
    const title = (s.title || '').trim();
    const name = title ? (/콘티$/.test(title) ? title : title + ' 콘티') : '콘티';
    const out = [`📅 ${[date, name].filter(Boolean).join(' ')}`];
    const who = leaderList(s.leaders);
    if (who.length) out.push(`🎤 인도: ${who.join(', ')}`);
    if ((s.memo || '').trim()) out.push(...s.memo.trim().split('\n').map((l) => '※ ' + l.trim()).filter((l) => l !== '※'));
    out.push('');
    (s.items || []).forEach((it, i) => {
      const key = (it.key || it.original_key || '').trim();
      out.push(`${i + 1}. ${it.title}${key ? ` (${key})` : ''}`);
      if ((it.form || '').trim()) out.push(`   송폼: ${formDisplay(it.form.trim(), key)}`);
      if ((it.memo || '').trim()) out.push(`   메모: ${it.memo.trim().replace(/\s*\n\s*/g, ' ')}`);
    });
    return out.join('\n');
  }


  // ---------- 가사 복사 (12차) ----------
  // 구간 이름 → 표준 이름(V1·C·B …). 악보의 {comment: 1절} 같은 이름표와 송폼의 V1·C 같은 글자를 같은 이름으로 맞춘다.
  function canonSection(s) {
    const c = Sections.canon(s);
    return c ? c.id : '';
  }

  // 코드 악보(Chord.parseChordPro 결과) → 구간 목록 [{label, canon, paras:[[가사 줄, …], …]}]
  // 코드만 있는 줄(간주 등)은 가사가 없으므로 뺀다. 이름표가 없는 앞부분은 label ''인 구간이 된다.
  // opt.expandRefs: 자리표시({ref})를 원본 구간의 가사로 채워 그 자리에 넣는다. (악보 순서로 복사할 때)
  function lyricSections(parsed, opt) {
    const expand = !!(opt && opt.expandRefs);
    const out = [];
    let cur = { label: '', canon: '', paras: [[]] };
    const hasText = (sec) => sec.paras.some((p) => p.length);
    const flush = () => { if (hasText(cur)) { cur.paras = cur.paras.filter((p) => p.length); out.push(cur); } };
    const lineText = (ln) => (ln.segs || []).map((x) => x.text).join('').replace(/\s+/g, ' ').trim();
    const add = (ln) => {
      if (ln.type === 'blank') { if (cur.paras[cur.paras.length - 1].length) cur.paras.push([]); }
      else if (ln.type === 'lyric') { const t = lineText(ln); if (t) cur.paras[cur.paras.length - 1].push(t); }
    };
    for (const ln of (parsed && parsed.lines) || []) {
      if (ln.type === 'comment') {
        flush();
        const label = String(ln.text || '').trim();
        cur = { label, canon: canonSection(label), paras: [[]] };
      } else if (ln.type === 'ref') {
        flush();
        cur = { label: '', canon: '', paras: [[]] };
        if (expand && ln.src >= 0 && parsed.sections) {
          cur = { label: ln.id, canon: ln.id, paras: [[]] };
          for (const b of sectionBodyOf(parsed, ln.src)) add(b);
          flush();
          cur = { label: '', canon: '', paras: [[]] };
        }
      } else add(ln);
    }
    flush();
    return out;
  }
  // Chord.sectionBody와 같은 일을 하되 Chord 없이도 쓸 수 있게 한 사본 (Node 시험에서 Chord 없이 parsed만 넘길 때)
  function sectionBodyOf(parsed, si) {
    const s = parsed.sections[si];
    if (!s) return [];
    let a = s.start;
    if (parsed.lines[a] && parsed.lines[a].type === 'comment') a++;
    const body = parsed.lines.slice(a, s.end).filter((l) => l.type !== 'colbreak' && l.type !== 'ref');
    while (body.length && body[body.length - 1].type === 'blank') body.pop();
    while (body.length && body[0].type === 'blank') body.shift();
    return body;
  }

  // 송폼 글자 → 순서 목록 [{canon, n, raw}]. 괄호 메모·알 수 없는 글자는 canon ''로 둔다.
  function formOrder(form) {
    const out = [];
    for (const tok of parse(form)) {
      if (/^\(/.test(tok)) continue; // 괄호 메모는 가사 구간이 아니다
      if (isKeyChange(tok)) { out.push({ canon: '', n: 1, raw: tok, kc: true }); continue; } // 전조 칩: 가사 구간은 아니지만 복사할 때 표시는 남긴다
      const { base, n } = splitRepeat(tok);
      out.push({ canon: canonSection(base), n, raw: tok });
    }
    return out;
  }

  const sectionText = (sec) => sec.paras.map((p) => p.join('\n')).join('\n\n');
  // 구간 이름표: 알아보는 이름은 표준 약어([V1]·[C])로, 그 밖의 메모는 적은 그대로
  const tagOf = (x) => (x.canon || x.label || '');

  // 곡 하나의 가사. mode: 'labeled'(구간 이름 + 가사) | 'form'(송폼 순서대로) | 'plain'(가사만)
  // 반환 {text, noForm(송폼이 없어 악보 순서로 대신함), missing(악보에 없어 건너뛴 송폼 글자들), empty(가사가 없음)}
  // labeled·plain은 악보에 적힌 순서이므로 자리표시를 원본 가사로 채워 그 자리에 넣는다. form은 송폼이 순서를 정한다.
  function songLyrics(parsed, form, mode) {
    const secs = lyricSections(parsed, { expandRefs: mode !== 'form' });
    if (!secs.length) return { text: '', noForm: false, missing: [], empty: true };
    if (mode === 'form') {
      const order = formOrder(form);
      const parts = [];
      let real = 0; // 가사가 들어간 구간 수(전조 표시는 세지 않는다)
      const missing = [];
      for (const o of order) {
        if (o.kc) { parts.push(keyStepText(keySteps(o.raw, '')[0])); continue; }
        if (!o.canon) { missing.push(o.raw); continue; }
        // 같은 이름이 있으면 그것, 없으면 같은 종류(C2→C, End↔Outro)
        const hit = secs.find((x) => x.canon === o.canon) || secs.find((x) => x.canon && Sections.kindKey(x.canon) === Sections.kindKey(o.canon));
        if (!hit) {
          if (['Intro', 'Inter'].includes(Sections.kindKey(o.canon))) continue; // 연주 구간은 없어도 정상
          missing.push(o.raw);
          continue;
        }
        for (let i = 0; i < o.n; i++) { parts.push(sectionText(hit)); real++; }
      }
      if (real) return { text: parts.join('\n\n'), noForm: false, missing, empty: false };
      // 송폼이 비어 있거나 하나도 맞지 않으면 악보에 적힌 순서대로
      return { text: secs.map(sectionText).join('\n\n'), noForm: true, missing: [], empty: false };
    }
    if (mode === 'labeled') {
      return { text: secs.map((x) => (tagOf(x) ? `[${tagOf(x)}]\n` : '') + sectionText(x)).join('\n\n'), noForm: false, missing: [], empty: false };
    }
    return { text: secs.map(sectionText).join('\n\n'), noForm: false, missing: [], empty: false };
  }

  // entries: [{title, form, parsed|null}] → {text, noText:[제목], noForm:[제목], missing:[{title, tokens}]}
  // opt.numbered(기본 true): 제목 앞에 "1." 번호. 'plain'은 제목도 번호도 없이 곡 사이에 빈 줄 두 개.
  function lyricsText(entries, mode, opt) {
    const o = Object.assign({ numbered: true }, opt);
    const noText = [], noForm = [], missing = [];
    const blocks = [];
    entries.forEach((e, i) => {
      const r = e.parsed ? songLyrics(e.parsed, e.form, mode) : { text: '', empty: true, noForm: false, missing: [] };
      if (r.empty) { noText.push(e.title); if (mode === 'plain') return; }
      if (mode === 'form' && r.noForm) noForm.push(e.title);
      if (r.missing.length) missing.push({ title: e.title, tokens: r.missing });
      if (mode === 'plain') { blocks.push(r.text); return; }
      const head = o.numbered ? `${i + 1}. ${e.title}` : e.title;
      blocks.push(head + '\n' + (r.empty ? '(이미지·PDF 악보라 가사를 복사할 수 없어요)' : r.text));
    });
    return { text: blocks.join(mode === 'plain' ? '\n\n\n' : '\n\n'), noText, noForm, missing };
  }

  return { MAX, PALETTE, parse, format, splitRepeat, cycleRepeat, isKeyChange, keyChange, makeKeyChange, keySteps, keyStepText, keyPathText, formDisplay, hasKeyChange, parseKeyName, keyNameOf, KEY_NAMES: KMAJOR, KEY_NAMES_MINOR: KMINOR, fmtDate, kakaoText, leaderList, canonSection, lyricSections, formOrder, songLyrics, lyricsText };
});
