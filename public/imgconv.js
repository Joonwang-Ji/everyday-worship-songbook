// 이미지 → 코드 악보 변환 도우미 (25차) — 화면과 무관한 순수 함수 모음. 브라우저와 Node 테스트 양쪽에서 사용.
// AI가 돌려준 글자(ChordPro 초안)를 앱 형식으로 다듬는다. 저장 형식(ChordPro 글자)은 바꾸지 않는다.
// 다듬는 일: 코드 울타리·잡담 줄 제거, 제목·키 줄 분리, 구간 이름표 통일, 이상한 코드는 [?], 코드만 있는 줄은 [G] [C] 꼴로, 끝없이 반복되는 줄 자르기.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chord.js'), require('./sections.js'), require('./chordedit.js'));
  else root.ImgConv = factory(root.Chord, root.Sections, root.ChordEdit);
})(typeof self !== 'undefined' ? self : this, function (Chord, Sections, ChordEdit) {
  // 사용자가 직접 Claude 채팅에 붙여 넣을 때 쓰는 프롬프트 (서버의 앱 안 변환 프롬프트와 같은 규칙)
  const MANUAL_PROMPT = [
    '첨부한 악보 이미지를 ChordPro 형식으로 변환해줘.',
    '- 가사 위에 있는 코드는 해당 글자 바로 앞에 [코드] 형태로 넣어줘 (예: [G]주님은 [C]나의 [D]힘이요)',
    '- 가사는 인쇄된 그대로 적고, 번역하거나 지어내지 마',
    '- 구간은 한 줄에 {comment: V1} {comment: V2} {comment: PC} {comment: C} {comment: B} {comment: Inter} {comment: Tag} {comment: Outro} {comment: End} 중 하나로 표시해줘 (V=절, PC=프리코러스, C=후렴, B=브릿지). 이름이 없으면 모양을 보고 추측해줘',
    '- 원래 키가 적혀 있으면 맨 위에 {key: G} 를 넣어줘',
    '- 보이지 않거나 불확실한 코드는 [?]로 표시해줘',
    '- 제목·쪽 번호·저작권 문구는 넣지 마',
    '- 설명 없이 변환 결과만 출력해줘',
  ].join('\n');

  const CHATTER_HEAD = /^(here\b|here's|sure\b|certainly|okay\b|ok\b|below\b|the following|this is|i['’]?(m|ve|ll)\b|물론|다음은|아래는|변환 결과|변환된)/i;
  const CHATTER_TAIL = /^(note\s*:|notes\s*:|i hope|let me know|please note|참고\s*[:：]|※)/i;
  const KEEP_DIRECTIVE = /^(comment|c|ci|comment_italic|soc|eoc|start_of_chorus|end_of_chorus|sov|eov|start_of_verse|end_of_verse|sob|eob|ref)$/i;
  const DROP_DIRECTIVE = /^(title|t|subtitle|st|artist|copyright|capo|tempo|time|year|album|composer|lyricist)$/i;

  const isChordTok = (s) => ChordEdit.isChord(s) && s !== '?';

  // 한 쪽(한 번의 AI 답)을 다듬는다. → {text, key, nChords, nUnknown, nBare, nRepeat}
  function clean(raw) {
    let s = String(raw == null ? '' : raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    // 코드 울타리(```chordpro … ```)
    const fence = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(s);
    if (fence) s = fence[1];
    s = s.replace(/```[a-zA-Z]*/g, '');
    let lines = s.split('\n').map((l) => l.replace(/\s+$/, ''));
    // 앞뒤 잡담 줄
    while (lines.length && (!lines[0].trim() || CHATTER_HEAD.test(lines[0].trim())) ) lines.shift();
    const tail = lines.findIndex((l) => CHATTER_TAIL.test(l.trim()));
    if (tail > 0) lines = lines.slice(0, tail);

    let key = '';
    let nChords = 0;
    let nUnknown = 0;
    let nBare = 0;
    let nRepeat = 0;
    const out = [];
    let run = 0;
    let prevLine = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { out.push(''); prevLine = ''; run = 0; continue; }
      // 지시어 줄 {…}
      const d = /^\{\s*([A-Za-z_]+)\s*(?::\s*(.*?))?\s*\}$/.exec(t);
      if (d) {
        const name = d[1].toLowerCase();
        const val = (d[2] || '').trim();
        if (name === 'key') {
          if (!key && val) { const k = String(val).replace(/\s+/g, ''); if (Chord.parseKey(k)) key = k; }
          continue;
        }
        if (DROP_DIRECTIVE.test(name)) continue;
        if (name === 'comment' || name === 'c' || name === 'ci' || name === 'comment_italic') {
          const nv = Sections.normalize(val);
          out.push('{comment: ' + (nv === null ? val : nv) + '}');
          prevLine = null; run = 0;
          continue;
        }
        if (KEEP_DIRECTIVE.test(name)) { out.push(t); prevLine = null; run = 0; continue; }
        continue; // 모르는 지시어는 버린다
      }
      // 코드만 있는 줄("G   C   D") → [G] [C] [D]
      const toks = t.split(/\s+/);
      if (toks.length && !/[\[\]]/.test(t) && toks.every(isChordTok)) {
        nBare++;
        nChords += toks.length;
        const fixed = toks.map((c) => '[' + c + ']').join(' ');
        out.push(fixed);
        prevLine = fixed; run = 1;
        continue;
      }
      // 대괄호 안이 코드 모양이 아니면 [?]
      const fixed = line.replace(/\[([^\]]*)\]/g, (m, inner) => {
        const c = inner.trim();
        if (c === '?') { nUnknown++; return '[?]'; }
        if (isChordTok(c)) { nChords++; return '[' + c + ']'; }
        nUnknown++;
        return '[?]';
      });
      // 끝없이 반복되는 같은 줄(작은 AI 모델이 자주 하는 실수)은 연속 2줄까지만 남긴다
      if (fixed === prevLine) {
        run++;
        if (run > 2) { nRepeat++; continue; }
      } else { run = 1; prevLine = fixed; }
      out.push(fixed);
    }
    let text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    return { text, key, nChords, nUnknown, nBare, nRepeat };
  }

  // 여러 쪽 합치기. 키는 첫 번째로 읽은 것.
  function merge(pages) {
    const ok = pages.filter((p) => p && p.text);
    const sum = (f) => ok.reduce((n, p) => n + (p[f] || 0), 0);
    return {
      text: ok.map((p) => p.text).join('\n\n'),
      key: (ok.find((p) => p.key) || {}).key || '',
      nChords: sum('nChords'),
      nUnknown: sum('nUnknown'),
      nBare: sum('nBare'),
      nRepeat: sum('nRepeat'),
      pages: ok.length,
    };
  }

  // 사용자에게 보여 줄 한 줄 요약(주의할 점 위주)
  function notes(r) {
    const n = [];
    if (!r.text) n.push('읽어 낸 내용이 없어요.');
    else if (!r.nChords) n.push('코드를 하나도 읽지 못했어요. 가사만 들어갈 수 있어요.');
    if (r.nUnknown) n.push(`읽기 어려운 코드 ${r.nUnknown}곳은 [?]로 표시했어요.`);
    if (r.nBare) n.push(`가사 없이 코드만 있던 ${r.nBare}줄은 [G] [C] 꼴로 넣었어요.`);
    if (r.nRepeat) n.push(`같은 줄이 끝없이 반복되어 ${r.nRepeat}줄을 잘랐어요.`);
    return n;
  }

  return { MANUAL_PROMPT, clean, merge, notes };
});
