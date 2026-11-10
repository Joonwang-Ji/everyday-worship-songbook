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
  function parse(str) {
    const m = String(str || '').match(/\([^)]*\)|[^\s\-–—→>,()]+/g);
    return m ? m.map((t) => t.trim()).filter(Boolean) : [];
  }
  const format = (tokens) => tokens.join('-');

  // 마지막이 "C×2" 처럼 반복 표시면 [기본, 횟수]로 나눈다
  function splitRepeat(tok) {
    const m = /^(.*?)[×xX*](\d{1,2})$/.exec(tok);
    return m && m[1] ? { base: m[1], n: +m[2] } : { base: tok, n: 1 };
  }
  // 반복 표시를 한 단계 돌린다: (없음) → ×2 → ×3 → ×4 → 없음
  function cycleRepeat(tok) {
    const { base, n } = splitRepeat(tok);
    const next = n >= 4 ? 1 : n + 1;
    return next === 1 ? base : base + '×' + next;
  }

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
      if ((it.form || '').trim()) out.push(`   송폼: ${it.form.trim()}`);
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
      if (/^\(/.test(tok)) continue;
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
      const missing = [];
      for (const o of order) {
        if (!o.canon) { missing.push(o.raw); continue; }
        // 같은 이름이 있으면 그것, 없으면 같은 종류(C2→C, End↔Outro)
        const hit = secs.find((x) => x.canon === o.canon) || secs.find((x) => x.canon && Sections.kindKey(x.canon) === Sections.kindKey(o.canon));
        if (!hit) {
          if (['Intro', 'Inter'].includes(Sections.kindKey(o.canon))) continue; // 연주 구간은 없어도 정상
          missing.push(o.raw);
          continue;
        }
        for (let i = 0; i < o.n; i++) parts.push(sectionText(hit));
      }
      if (parts.length) return { text: parts.join('\n\n'), noForm: false, missing, empty: false };
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

  return { MAX, PALETTE, parse, format, splitRepeat, cycleRepeat, fmtDate, kakaoText, leaderList, canonSection, lyricSections, formOrder, songLyrics, lyricsText };
});
