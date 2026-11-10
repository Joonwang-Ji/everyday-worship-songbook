// 송폼(구간 순서) 처리 + 카톡용 콘티 텍스트 (브라우저와 Node 테스트 양쪽에서 사용)
// 송폼은 서버에 "인트로-V1-C-V2-C-B-C" 같은 한 줄 글자로 저장된다. 탭으로 만들든 직접 쓰든 같은 형식.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SongForm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX = 200; // 서버가 받는 최대 글자 수

  // 누르는 버튼. code = 실제로 저장되는 글자, hint = 버튼 아래 작은 설명
  const PALETTE = [
    { code: '인트로', hint: '' },
    { code: 'V1', hint: '1절' },
    { code: 'V2', hint: '2절' },
    { code: 'V3', hint: '3절' },
    { code: 'V4', hint: '4절' },
    { code: 'V5', hint: '5절' },
    { code: 'P', hint: '프리' },
    { code: 'C', hint: '후렴' },
    { code: 'B', hint: '브릿지' },
    { code: '간주', hint: '' },
    { code: '태그', hint: '' },
    { code: '아웃트로', hint: '' },
    { code: '엔딩', hint: '' },
  ];

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
  // 구간 이름 → 표준 이름. 악보의 {comment: 1절} 같은 이름표와 송폼의 V1·C 같은 글자를 같은 이름으로 맞춘다.
  function canonSection(s) {
    const t = String(s || '').toLowerCase().replace(/[\s\[\]\(\)【】<>＜＞\-–—:：]/g, '');
    if (!t) return '';
    if (/^인트로|^intro/.test(t)) return '인트로';
    let m = /^(\d)절/.exec(t);
    if (m) return m[1] + '절';
    m = /^(?:verse|v)(\d)$/.exec(t) || /^(?:verse|v)(\d)/.exec(t);
    if (m) return m[1] + '절';
    if (/^verse$|^v$/.test(t)) return '1절';
    if (/^프리|^pre/.test(t)) return '프리코러스';
    if (/^후렴|^코러스|^chorus$|^c$/.test(t) || /^chorus/.test(t)) return '후렴';
    if (/^브릿지|^브리지|^bridge$|^b$/.test(t) || /^bridge/.test(t)) return '브릿지';
    if (/^간주|^interlude/.test(t)) return '간주';
    if (/^태그|^tag/.test(t)) return '태그';
    if (/^엔딩|^아웃트로|^ending|^outro/.test(t)) return '엔딩';
    if (t === 'p') return '프리코러스';
    return '';
  }

  // 코드 악보(Chord.parseChordPro 결과) → 구간 목록 [{label, canon, paras:[[가사 줄, …], …]}]
  // 코드만 있는 줄(간주 등)은 가사가 없으므로 뺀다. 이름표가 없는 앞부분은 label ''인 구간이 된다.
  function lyricSections(parsed) {
    const out = [];
    let cur = { label: '', canon: '', paras: [[]] };
    const hasText = (sec) => sec.paras.some((p) => p.length);
    const flush = () => { if (hasText(cur)) { cur.paras = cur.paras.filter((p) => p.length); out.push(cur); } };
    for (const ln of (parsed && parsed.lines) || []) {
      if (ln.type === 'comment') {
        flush();
        const label = String(ln.text || '').trim();
        cur = { label, canon: canonSection(label), paras: [[]] };
      } else if (ln.type === 'blank') {
        if (cur.paras[cur.paras.length - 1].length) cur.paras.push([]);
      } else if (ln.type === 'lyric') {
        const t = (ln.segs || []).map((x) => x.text).join('').replace(/\s+/g, ' ').trim();
        if (t) cur.paras[cur.paras.length - 1].push(t);
      }
    }
    flush();
    return out;
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

  // 곡 하나의 가사. mode: 'labeled'(구간 이름 + 가사) | 'form'(송폼 순서대로) | 'plain'(가사만)
  // 반환 {text, noForm(송폼이 없어 악보 순서로 대신함), missing(악보에 없어 건너뛴 송폼 글자들), empty(가사가 없음)}
  function songLyrics(parsed, form, mode) {
    const secs = lyricSections(parsed);
    if (!secs.length) return { text: '', noForm: false, missing: [], empty: true };
    if (mode === 'form') {
      const order = formOrder(form);
      const parts = [];
      const missing = [];
      for (const o of order) {
        if (!o.canon) { missing.push(o.raw); continue; }
        if (['인트로', '간주'].includes(o.canon) && !secs.some((x) => x.canon === o.canon)) continue; // 연주 구간은 없어도 정상
        const hit = secs.find((x) => x.canon === o.canon);
        if (!hit) { missing.push(o.raw); continue; }
        for (let i = 0; i < o.n; i++) parts.push(sectionText(hit));
      }
      if (parts.length) return { text: parts.join('\n\n'), noForm: false, missing, empty: false };
      // 송폼이 비어 있거나 하나도 맞지 않으면 악보에 적힌 순서대로
      return { text: secs.map(sectionText).join('\n\n'), noForm: true, missing: [], empty: false };
    }
    if (mode === 'labeled') {
      return { text: secs.map((x) => (x.label ? `[${x.label}]\n` : '') + sectionText(x)).join('\n\n'), noForm: false, missing: [], empty: false };
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
