// 이미지 → 코드 악보 변환 도우미 (25차) — 화면과 무관한 순수 함수 모음. 브라우저와 Node 테스트 양쪽에서 사용.
// AI가 돌려준 글자(ChordPro 초안)를 앱 형식으로 다듬는다. 저장 형식(ChordPro 글자)은 바꾸지 않는다.
// 다듬는 일: 코드 울타리·잡담 줄 제거, 제목·키 줄 분리, 구간 이름표 통일, 이상한 코드는 [?], 코드만 있는 줄은 [G] [C] 꼴로, 끝없이 반복되는 줄 자르기.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chord.js'), require('./sections.js'), require('./chordedit.js'));
  else root.ImgConv = factory(root.Chord, root.Sections, root.ChordEdit);
})(typeof self !== 'undefined' ? self : this, function (Chord, Sections, ChordEdit) {
  // Claude 앱에 붙여 넣는 프롬프트 2개 (26차). 순서: ① 가사 뽑기 → 사람이 가사·줄바꿈을 다듬음 → ② 코드 입히기.
  // ① 악보에서 가사만 뽑는다. 줄은 뜻 단위로, 구간은 {comment: 이름}으로. 코드는 아직 다루지 않는다.
  const LYRICS_PROMPT = [
    '첨부한 악보(이미지 또는 PDF)에서 가사만 뽑아줘. 코드는 쓰지 마. 설명 없이 결과만, 코드 블록 하나로 출력해줘.',
    '',
    '[가사]',
    '- 가사는 첨부한 악보에 인쇄된 그대로 적어줘. 번역하거나 고치거나 지어내지 마. 기억이나 검색으로 가사를 보충하거나 채우지 말고, 잘 안 보이는 글자는 ?로 표시해줘.',
    '- 악보 오선 줄의 줄바꿈을 따르지 말고, 가사의 뜻(문장·구절) 단위로 줄을 나눠줘. 한 줄은 노래로 한 호흡(대략 한 소절) 정도로 해줘.',
    '- 한 멜로디 아래에 1절·2절 가사가 위아래로 겹쳐 적혀 있으면 V1, V2로 나눠서 각각 따로 적어줘.',
    '- 같은 구간이 악보에 여러 번 인쇄되어 있어도 줄이거나 합치지 말고 인쇄된 대로 적어줘.',
    '',
    '[구간]',
    '- 구간은 한 줄에 {comment: 이름}으로 표시하고, 구간 사이는 빈 줄로 나눠줘. 이름은 Intro, V1, V2, V3, PC(프리코러스), C(후렴), B(브릿지), Inter(간주), Tag, Outro, End 중에서만 써줘.',
    '- 악보에 구간 이름이 적혀 있거나 구조가 분명할 때만 붙이고, 악보에 없는 구간을 지어내지 마. 확실하지 않으면 이름 없이 빈 줄로만 나눠줘.',
    '- 구간 이름이 아닌 악보 표시(1번 괄호, 2번 괄호, D.S., D.C., Fine, 코다, 2nd time 같은 반복 표시와 키가 바뀌는 전조)는 구간 이름표로 쓰지 말고, 악보에 나온 그 자리(해당 줄 사이)에 {ci: 1번 괄호}, {ci: 전조 Ab}, {ci: 2nd time}처럼 한 줄로 짧게 적어줘. 구간 한가운데에 있어도 구간을 나누지 마.',
    '',
    '[기타]',
    '- 맨 위에 {key: 원래 키} 한 줄만 넣고, 제목·쪽 번호·저작권 문구는 넣지 마.',
  ].join('\n');

  // ② 사람이 확정한 가사 위에 코드만 얹는다. 가사·줄·구간 이름표는 절대 바꾸지 않는다. 맨 아래에 다듬은 가사를 붙여 넣는다.
  const CHORD_PROMPT = [
    '첨부한 악보(이미지 또는 PDF)를 보고, 아래 [가사]에 코드만 얹어서 ChordPro 텍스트로 만들어줘. 설명 없이 결과만, 코드 블록 하나로 출력해줘.',
    '',
    '[반드시 지킬 것]',
    '- 가사의 글자, 줄바꿈, 빈 줄, {comment: …} 줄, {ci: …} 줄, {key: …} 줄은 한 글자도 바꾸지 말고 그대로 둬. 합치거나 나누거나 고치거나 빼지 마. 악보와 달라 보여도 아래 가사가 기준이야.',
    '- 할 일은 코드를 넣는 것뿐이야. 악보에서 가사 위에 있는 코드를 그 글자 바로 앞에 [코드]로 넣어줘. 예: [G]주님은 [C]나의 [D]힘이요',
    '- 코드 모양(7, maj7, sus4, add9, D/F# 같은 슬래시 코드)도 악보 그대로 적어줘. 보이지 않거나 불확실한 코드는 지어내지 말고 [?]로 표시해줘.',
    '- 첨부한 악보에 인쇄된 코드만 써줘. 기억이나 검색, 다른 곡의 코드로 코드·가사를 보충하거나 채우지 마.',
    '- 악보에 1절·2절이 겹쳐 적혀 있어 코드가 한 번만 있으면, 아래 가사의 V1·V2 모두에 같은 코드를 같은 자리에 넣어줘.',
    '- 키가 바뀐 뒤(전조)의 코드는 악보에 적힌 그대로 써줘. 코드가 필요 없는 {comment: …} 줄, {ci: …} 줄, 빈 줄은 그대로 둬.',
    '',
    '[가사]',
    '',
  ].join('\n');
  const MANUAL_PROMPT = CHORD_PROMPT; // 이전 이름 호환

  const CHATTER_HEAD = /^(here\b|here's|sure\b|certainly|okay\b|ok\b|below\b|the following|this is|i['’]?(m|ve|ll)\b|물론|다음은|아래는|변환 결과|변환된)/i;
  const CHATTER_TAIL = /^(note\s*:|notes\s*:|i hope|let me know|please note|참고\s*[:：]|※)/i;
  const KEEP_DIRECTIVE = /^(comment|c|ci|comment_italic|soc|eoc|start_of_chorus|end_of_chorus|sov|eov|start_of_verse|end_of_verse|sob|eob|ref)$/i;
  const DROP_DIRECTIVE = /^(title|t|subtitle|st|artist|copyright|capo|tempo|time|year|album|composer|lyricist)$/i;

  const isChordTok = (s) => ChordEdit.isChord(s) && s !== '?';

  // 한 쪽(한 번의 AI 답)을 다듬는다. → {text, key, nChords, nUnknown, nBare, nRepeat}
  // 29차: 코드가 가사 위 줄에 따로 적힌 글자(Ultimate Guitar 등에서 복사한 것)를 ChordPro로 바꾼다.
  // 위 줄 코드의 글자 칸(열) 위치를 아래 가사 줄의 같은 칸에 [코드]로 끼워 넣는다. 글자 폭이 같은 글꼴로 복사된 글자(공백으로 맞춘 것)여야 정확하다.
  const HEAD_RE = /^\[?\s*((?:pre[- ]?)?chorus|verse|bridge|intro|outro|inter(?:lude)?|instrumental|tag|ending|refrain|interlude)\s*\d*\s*[:\]]?\s*$/i;
  const isHeadLine = (t) => HEAD_RE.test(t.trim()) || /^\[[^\]]{1,24}\]$/.test(t.trim()) && !isChordTok(t.trim().slice(1, -1));
  const chordToks = (line) => {
    const t = line.trim();
    if (!t || /[\[\]{}]/.test(t)) return null;
    const toks = t.split(/\s+/);
    return toks.every(isChordTok) ? toks : null;
  };
  function looksChordOverLyrics(raw) {
    const ls = String(raw || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    let pairs = 0;
    for (let i = 0; i < ls.length - 1; i++) {
      if (chordToks(ls[i]) && ls[i + 1].trim() && !chordToks(ls[i + 1]) && !isHeadLine(ls[i + 1]) && !/[\[{]/.test(ls[i + 1])) pairs++;
    }
    return pairs >= 2;
  }
  function fromChordsOverLyrics(raw) {
    const ls = String(raw || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n').map((l) => l.replace(/\s+$/, ''));
    const out = [];
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];
      const t = line.trim();
      if (!t) { out.push(''); continue; }
      if (isHeadLine(t) && !chordToks(line)) {
        const nm = t.replace(/^\[|\]$/g, '').replace(/:$/, '').trim();
        const nv = Sections.normalize(nm);
        if (out.length && out[out.length - 1] !== '') out.push('');
        out.push('{comment: ' + (nv === null ? nm : nv) + '}');
        continue;
      }
      const toks = chordToks(line);
      if (!toks) { out.push(line); continue; }
      const nxt = ls[i + 1];
      if (nxt === undefined || !nxt.trim() || chordToks(nxt) || isHeadLine(nxt) || /[\[{]/.test(nxt)) {
        out.push(toks.map((c) => '[' + c + ']').join(' '));
        continue;
      }
      // 코드 위치(열) 수집 → 가사 줄에 오른쪽부터 끼워 넣는다
      const pos = [];
      const re = /\S+/g;
      let m;
      while ((m = re.exec(line))) pos.push([m.index, m[0]]);
      let lyric = nxt;
      for (let k = pos.length - 1; k >= 0; k--) {
        const at = Math.min(pos[k][0], lyric.length);
        lyric = lyric.slice(0, at) + '[' + pos[k][1] + ']' + lyric.slice(at);
      }
      out.push(lyric);
      i++;
    }
    return out.join('\n');
  }

  function clean(raw) {
    let s = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (looksChordOverLyrics(s)) s = fromChordsOverLyrics(s);
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
    let nMemo = 0;
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
        // 메모 줄 {ci: …} (27차): 구간을 나누지 않는 표시. 그대로 둔다(빈 것은 버린다).
        if (name === 'ci' || name === 'comment_italic') {
          const mv = val.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim();
          if (mv) { out.push('{ci: ' + mv + '}'); nMemo++; }
          prevLine = null; run = 0;
          continue;
        }
        if (name === 'comment' || name === 'c') {
          // 구간 이름이 아니라 전조·괄호·D.S. 같은 표시로 보이면 구간을 쪼개지 않도록 메모 줄로 바꾼다
          if (Sections.isMemoLike(val)) {
            out.push('{ci: ' + val.replace(/[{}]/g, ' ').replace(/\s+/g, ' ').trim() + '}');
            nMemo++;
          } else {
            const nv = Sections.normalize(val);
            out.push('{comment: ' + (nv === null ? val : nv) + '}');
          }
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
    return { text, key, nChords, nUnknown, nBare, nRepeat, nMemo };
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
      nMemo: sum('nMemo'),
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
    if (r.nMemo) n.push(`전조·괄호 같은 표시 ${r.nMemo}곳은 메모 줄로 넣었어요. 구간을 나누지 않아요.`);
    return n;
  }

  // 28차: 악보가 두 장 이상일 때, 프롬프트 첫 줄 아래에 "여러 장" 안내를 넣는다. n = 첨부할 악보 장수(1 이하면 그대로).
  // 쪽마다 따로 처리하거나 쪽이 바뀌는 곳에서 구간을 나누지 않게 하고, 쪽 번호·머리글이 가사로 섞이는 것을 막는다.
  function withPages(prompt, n) {
    const p = String(prompt || '');
    if (!(n > 1)) return p;
    const block = [
      '[여러 장]',
      `- 첨부한 악보는 ${n}장이고, 첨부한 순서(1쪽 → ${n}쪽)가 곡의 순서야. 한 곡이 여러 쪽에 걸쳐 이어지는 것이니 쪽마다 따로 출력하지 말고 하나로 이어서 출력해줘.`,
      '- 쪽이 바뀌는 곳에서 구간을 새로 나누거나 같은 줄을 다시 쓰지 마. 쪽 사이에 이어지는 구간은 계속 이어서 적어줘.',
      '- 쪽 번호, 매 쪽 위아래에 반복되는 곡 제목·머리글·저작권 문구는 넣지 마.',
    ].join('\n');
    const i = p.indexOf('\n\n[');
    return i < 0 ? p + '\n\n' + block : p.slice(0, i) + '\n\n' + block + p.slice(i);
  }
  return { LYRICS_PROMPT, CHORD_PROMPT, MANUAL_PROMPT, withPages, looksChordOverLyrics, fromChordsOverLyrics, clean, merge, notes };
});
