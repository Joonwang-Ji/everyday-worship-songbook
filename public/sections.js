// 구간 이름 사전 (17차) — 송폼·악보 구간 이름표·자리표시가 모두 같은 이름을 쓰도록 한 곳에서 판별한다.
// 브라우저, Node 테스트, 서버(이관) 모두에서 쓰는 순수 함수 모음.
//
// 표준 이름(저장 글자): Intro · V1~V5(숫자 아무거나) · PC(Pre-Chorus) · C(Chorus) · B(Bridge) · Inter(Interlude) · Tag · Outro · End(Ending)
// 같은 종류가 다르게 두 번 나오면 번호를 붙인다: C2, B2, Inter2 …
// 읽을 때는 한글·영어 풀네임·약어를 모두 알아본다. 저장할 때는 항상 표준 이름으로 쓴다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sections = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FULL = { Intro: 'Intro', V: 'Verse', PC: 'Pre-Chorus', C: 'Chorus', B: 'Bridge', Inter: 'Interlude', Tag: 'Tag', Outro: 'Outro', End: 'Ending' };

  // 글자 앞부분이 어느 종류인지. 순서가 중요하다(긴 이름 먼저).
  // 끝에는 "뒤에 글자·숫자가 이어지면 다른 낱말"이라는 경계 검사를 둔다. (Come, 2절반복 같은 것을 이름으로 오해하지 않게)
  const NUM = '(?:\\s*(\\d{1,2}))?';
  const END = '(?![A-Za-z\\uAC00-\\uD7A3\\d])';
  const RULES = [
    ['Intro', new RegExp('^(?:인트로|intro(?:duction)?)' + NUM + END, 'i')],
    ['V', new RegExp('^(?:verse|v)' + NUM + END, 'i')],
    ['PC', new RegExp('^(?:프리\\s*코러스|프리|pre\\s*-?\\s*chorus|pc|p)' + NUM + END, 'i')],
    ['C', new RegExp('^(?:후렴|코러스|chorus|c)' + NUM + END, 'i')],
    ['B', new RegExp('^(?:브릿지|브리지|bridge|b)' + NUM + END, 'i')],
    ['Inter', new RegExp('^(?:간주|interlude|inter)' + NUM + END, 'i')],
    ['Tag', new RegExp('^(?:태그|tag)' + NUM + END, 'i')],
    ['Outro', new RegExp('^(?:아웃트로|outro)' + NUM + END, 'i')],
    ['End', new RegExp('^(?:엔딩|ending|end)' + NUM + END, 'i')],
  ];
  const KO_VERSE = new RegExp('^(\\d{1,2})\\s*절' + END);
  const OPEN = /^[\[\(【<＜\-–—\s]+/;
  const CLOSE = /^[\]\)】>＞\-–—\s:：]+/;

  const makeId = (kind, n) => (kind === 'V' ? 'V' + (n || 1) : n > 1 ? kind + n : kind);

  // "V1 (느리게)" → {id:'V1', kind:'V', n:1, rest:'(느리게)'}. 알아보지 못하면 null.
  // rest: 이름 뒤에 사용자가 적은 말. 이름을 괄호로 감싼 "[후렴]" 같은 글자는 rest에 남기지 않는다.
  function canon(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return null;
    const bracket = OPEN.test(s) && /[\[\(【<＜]/.test(s.match(OPEN)[0]);
    s = s.replace(OPEN, '');
    let hit = null;
    let m = KO_VERSE.exec(s);
    if (m) hit = { kind: 'V', n: +m[1], len: m[0].length };
    else {
      for (const [kind, re] of RULES) {
        m = re.exec(s);
        if (m) { hit = { kind, n: m[1] ? +m[1] : 0, len: m[0].length }; break; }
      }
    }
    if (!hit) return null;
    let rest = s.slice(hit.len);
    if (bracket) rest = rest.replace(CLOSE, '');
    rest = rest.trim();
    return { id: makeId(hit.kind, hit.n), kind: hit.kind, n: hit.kind === 'V' ? hit.n || 1 : hit.n || 1, rest };
  }

  // id('V1','C2','PC') → 보이는 이름
  function display(id, mode) {
    if (mode === 'abbr') return id;
    const m = /^(Intro|V|PC|C|B|Inter|Tag|Outro|End)(\d*)$/.exec(id || '');
    if (!m) return id;
    const n = m[2] ? +m[2] : 0;
    if (m[1] === 'V') return FULL.V + ' ' + (n || 1);
    return FULL[m[1]] + (n > 1 ? ' ' + n : '');
  }
  // 악보 구간 이름표 글자 → 보이는 글자. 이름이 아니면(느리게 같은 메모) 그대로.
  function label(text, mode) {
    const c = canon(text);
    if (!c) return String(text == null ? '' : text);
    return display(c.id, mode) + (c.rest ? ' ' + c.rest : '');
  }
  // 저장할 글자(표준 이름 + 뒤에 적은 말). 알아보지 못하면 null.
  function normalize(text) {
    const c = canon(text);
    return c ? c.id + (c.rest ? ' ' + c.rest : '') : null;
  }
  // 가사 복사의 이름 맞춤용: V는 번호까지, 나머지는 번호를 떼고 같은 종류로, Outro와 End는 같은 종류로 본다.
  function kindKey(id) {
    const m = /^(Intro|V|PC|C|B|Inter|Tag|Outro|End)(\d*)$/.exec(id || '');
    if (!m) return '';
    if (m[1] === 'V') return 'V' + (m[2] || '1');
    return m[1] === 'Outro' ? 'End' : m[1];
  }

  // 누르는 버튼 목록. code = 저장 글자, hint = 작은 풀네임(약어와 같으면 비움)
  const PICKS = ['Intro', 'V1', 'V2', 'V3', 'V4', 'V5', 'PC', 'C', 'B', 'Inter', 'Tag', 'Outro', 'End'];
  const PALETTE = PICKS.map((code) => ({ code, hint: display(code, 'full') === code ? '' : display(code, 'full') }));

  // ---------- 기존 글자 변환 (이관) ----------
  const DIRECTIVE_COMMENT = /^(\s*\{\s*)(comment|c|comment_italic|ci)(\s*:\s*)(.*?)(\s*\}\s*)$/i;
  // ChordPro 본문 → {text, changed(바뀐 줄 수), unknown:[알아보지 못한 이름표 글자]}
  function migrateChordPro(text) {
    const src = String(text == null ? '' : text);
    const lines = src.split('\n');
    let changed = 0;
    const unknown = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, '');
      const m = DIRECTIVE_COMMENT.exec(raw);
      if (!m) continue;
      const val = m[4];
      if (!val.trim()) continue;
      const nv = normalize(val);
      if (nv === null) { unknown.push(val.trim()); continue; }
      if (nv !== val.trim()) {
        lines[i] = m[1] + m[2] + m[3] + nv + m[5] + (lines[i].endsWith('\r') ? '\r' : '');
        changed++;
      }
    }
    return { text: lines.join('\n'), changed, unknown };
  }
  // 송폼 글자 → {form, changed(바뀌었나), unknown}. 구분 글자·괄호 메모·×반복은 그대로 둔다.
  function migrateForm(form) {
    const src = String(form == null ? '' : form);
    const unknown = [];
    const out = src.replace(/\([^)]*\)|[^\s\-–—→>,()]+/g, (tok) => {
      if (tok[0] === '(') return tok;
      const m = /^(.*?)[×xX*](\d{1,2})$/.exec(tok);
      const base = m && m[1] ? m[1] : tok;
      const rep = m && m[1] ? tok.slice(base.length) : '';
      const c = canon(base);
      if (!c || c.rest) { unknown.push(tok); return tok; }
      return c.id + rep;
    });
    return { form: out, changed: out !== src, unknown };
  }

  return { FULL, PICKS, PALETTE, canon, display, label, normalize, kindKey, makeId, migrateChordPro, migrateForm };
});
