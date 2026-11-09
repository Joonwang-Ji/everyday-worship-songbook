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

  // s: { date, title, memo, items:[{title, key, original_key, form, memo}] }
  function kakaoText(s) {
    const date = fmtDate(s.date);
    const title = (s.title || '').trim();
    const name = title ? (/콘티$/.test(title) ? title : title + ' 콘티') : '콘티';
    const out = [`📅 ${[date, name].filter(Boolean).join(' ')}`];
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

  return { MAX, PALETTE, parse, format, splitRepeat, cycleRepeat, fmtDate, kakaoText };
});
