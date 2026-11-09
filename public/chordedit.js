// 코드 악보 입력 도우미 (7차 A단계) — 화면과 무관한 순수 함수 모음. 브라우저와 Node 테스트 양쪽에서 사용.
// 저장 형식(ChordPro 글자)은 바꾸지 않는다. 여기 함수들은 "글자를 어떻게 고칠지"만 계산한다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chord.js'));
  else root.ChordEdit = factory(root.Chord);
})(typeof self !== 'undefined' ? self : this, function (Chord) {
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const mod12 = (n) => ((n % 12) + 12) % 12;

  // ---------- 코드 모양 검사 ----------
  // 루트(A–G, #/b) + 품질(m, maj7, 7, sus4, dim, aug, add9 …) + 슬래시 베이스. [?]·N.C.는 허용.
  const CHORD_RE = /^[A-G][#b]?(?:maj|min|dim|aug|sus|add|m|M|\+|-|°|ø|[#b]?\d{1,2}|\([#b+-]?\d{1,2}\))*(?:\/[A-G][#b]?)?$/;
  function isChord(s) {
    s = String(s == null ? '' : s).trim();
    if (!s || s.length > 14) return false;
    if (s === '?' || /^N\.?C\.?$/i.test(s)) return true;
    return CHORD_RE.test(s);
  }
  function rootPc(chord) {
    const m = /^([A-G])([#b]?)/.exec(chord || '');
    if (!m) return null;
    return mod12(LETTER[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
  }

  // ---------- 곡 키에 맞는 기본 코드 ----------
  // 장조: I IV V vi ii iii / 단조: i iv V VI VII III. 키를 모르면 null.
  function diatonic(keyStr) {
    const k = Chord.parseKey(keyStr);
    if (!k) return null;
    const flats = Chord.keyUsesFlats(keyStr);
    const name = (off) => Chord.noteName(k.idx + off, flats);
    const rows = k.minor
      ? [['i', 0, 'm'], ['iv', 5, 'm'], ['V', 7, ''], ['VI', 8, ''], ['VII', 10, ''], ['III', 3, '']]
      : [['I', 0, ''], ['IV', 5, ''], ['V', 7, ''], ['vi', 9, 'm'], ['ii', 2, 'm'], ['iii', 4, 'm']];
    return rows.map(([label, off, q]) => ({ label, chord: name(off) + q }));
  }
  // 슬래시 베이스로 자주 쓰는 음(그 키의 음계 7음)
  function bassNotes(keyStr) {
    const k = Chord.parseKey(keyStr);
    if (!k) return null;
    const flats = Chord.keyUsesFlats(keyStr);
    const tonic = k.minor ? mod12(k.idx + 3) : k.idx; // 단조는 나란한 장조의 음계
    return [0, 2, 4, 5, 7, 9, 11].map((o) => Chord.noteName(tonic + o, flats));
  }
  function scalePcs(keyStr) {
    const k = Chord.parseKey(keyStr);
    if (!k) return null;
    const tonic = k.minor ? mod12(k.idx + 3) : k.idx;
    const s = new Set([0, 2, 4, 5, 7, 9, 11].map((o) => mod12(tonic + o)));
    if (k.minor) s.add(mod12(k.idx + 11)); // 화성단음계의 올린 7음
    return s;
  }

  // ---------- 커서가 들어 있는 [코드] 찾기와 바꾸기 ----------
  // 커서가 '[' 바로 뒤 ~ ']' 바로 뒤 사이일 때 그 코드로 본다. 반환: {start, end, inner} (start='[' 위치, end=']' 다음 위치)
  function chordAt(text, pos) {
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    let le = text.indexOf('\n', pos);
    if (le < 0) le = text.length;
    const line = text.slice(ls, le);
    const re = /\[([^\]\[]*)\]/g;
    let m;
    while ((m = re.exec(line))) {
      const start = ls + m.index;
      const end = start + m[0].length;
      if (start < pos && pos <= end) return { start, end, inner: m[1] };
    }
    return null;
  }
  // 코드 글자에서 품질(quality)이나 베이스(bass)만 바꾼다. 안 바꿀 항목은 undefined. 코드가 아니면 null.
  function changeChord(inner, opt) {
    const m = /^([A-G][#b]?)([^/]*)(?:\/(.*))?$/.exec(String(inner).trim());
    if (!m) return null;
    const q = opt.quality === undefined ? m[2] : opt.quality;
    const bass = opt.bass === undefined ? m[3] : opt.bass;
    return m[1] + q + (bass ? '/' + bass : '');
  }

  // ---------- 구간 버튼 ----------
  const SECTION_NAMES = ['인트로', '1절', '2절', '3절', '프리코러스', '후렴', '브릿지', '간주', '엔딩'];
  function prevLineBlank(text, from) {
    if (from <= 0) return true;
    const before = text.slice(0, from - 1);
    return before.slice(before.lastIndexOf('\n') + 1).trim() === '';
  }
  // 누른 구간 버튼이 글자에 어떻게 반영될지 계산. 반환: {from, to, insert, cursor} — text[from,to)를 insert로 바꾸고 커서는 cursor(바뀐 뒤 기준).
  function sectionEdit(text, selStart, selEnd, name) {
    const a = Math.min(selStart, selEnd), b = Math.max(selStart, selEnd);
    const from = text.lastIndexOf('\n', a - 1) + 1;
    const gap = prevLineBlank(text, from) ? '' : '\n';
    if (name !== '후렴') {
      const insert = gap + '{comment: ' + name + '}\n';
      return { from, to: from, insert, cursor: from + insert.length };
    }
    const head = gap + '{comment: 후렴}\n{soc}\n';
    if (a === b) {
      const insert = head + '\n{eoc}\n';
      return { from, to: from, insert, cursor: from + head.length };
    }
    // 선택한 줄들을 후렴으로 감싼다
    const bEff = text[b - 1] === '\n' ? b - 1 : b;
    let to = text.indexOf('\n', bEff);
    if (to < 0) to = text.length;
    const insert = head + text.slice(from, to) + '\n{eoc}';
    return { from, to, insert, cursor: from + insert.length };
  }

  // ---------- 저장 전 점검 ----------
  const KNOWN_DIRECTIVES = new Set(['title', 't', 'subtitle', 'st', 'artist', 'key', 'tempo', 'capo', 'comment', 'c', 'comment_italic', 'ci', 'soc', 'start_of_chorus', 'eoc', 'end_of_chorus']);
  // 반환: [{level:'warn'|'info', line:번호(1부터, 0=전체), msg}]
  // warn = 저장 전에 한 번 더 알려 줄 문제 / info = 참고
  function check(text, keyStr) {
    const out = [];
    const src = String(text || '').replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const chords = [];
    let inChorus = 0; // 열려 있는 {soc}의 줄 번호(없으면 0)
    const add = (level, line, msg) => out.push({ level, line, msg });
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const n = i + 1;
      const d = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/.exec(raw);
      if (d) {
        const name = d[1].toLowerCase();
        if (name === 'soc' || name === 'start_of_chorus') {
          if (inChorus) add('warn', n, '{soc}가 닫히기 전에 또 시작됩니다. ({eoc}가 빠졌는지 확인)');
          inChorus = n;
        } else if (name === 'eoc' || name === 'end_of_chorus') {
          if (!inChorus) add('warn', n, '{eoc}가 있는데 시작({soc})이 없습니다.');
          inChorus = 0;
        } else if (!KNOWN_DIRECTIVES.has(name)) {
          add('info', n, '{' + name + '}는 모르는 지시어라 화면에 나오지 않습니다.');
        }
        continue;
      }
      if (/^\s*#/.test(raw)) continue; // 주석
      if (/^\s*\{/.test(raw) || /\}\s*$/.test(raw) && !/\[/.test(raw)) {
        add('warn', n, '{ } 모양이 맞지 않아 글자 그대로 악보에 보입니다.');
        continue;
      }
      // 대괄호 짝과 코드 모양
      let open = -1;
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j];
        if (ch === '[') {
          if (open >= 0) add('warn', n, '[ 가 닫히지 않은 채 또 열렸습니다.');
          open = j;
        } else if (ch === ']') {
          if (open < 0) {
            add('warn', n, '여는 [ 없이 ] 만 있습니다.');
          } else {
            const inner = raw.slice(open + 1, j).trim();
            if (!inner) add('warn', n, '빈 코드 [ ] 가 있습니다.');
            else if (!isChord(inner)) add('warn', n, '코드 모양이 이상합니다: [' + inner + ']');
            else chords.push({ chord: inner, line: n });
            open = -1;
          }
        }
      }
      if (open >= 0) add('warn', n, '[ 가 닫히지 않았습니다. 이 줄은 가사로 보일 수 있어요.');
    }
    if (inChorus) add('warn', inChorus, '{soc}에 맞는 {eoc}가 없습니다.');

    if (src.trim() && !chords.length) add('info', 0, '코드가 하나도 없습니다. (가사만 있는 악보면 괜찮아요)');

    // 곡 키와 첫·마지막 코드
    let key = keyStr;
    if (!Chord.parseKey(key)) {
      const km = /\{\s*key\s*:\s*([^}]*?)\s*\}/i.exec(src);
      key = km ? km[1] : '';
    }
    const pcs = scalePcs(key);
    if (pcs && chords.length) {
      const real = chords.filter((c) => rootPc(c.chord) !== null);
      const test = (c, label) => {
        if (!c) return;
        const pc = rootPc(c.chord);
        if (pc !== null && !pcs.has(pc)) add('info', c.line, label + ' 코드 ' + c.chord + '는 키 ' + key + '의 음계 밖입니다. (키가 맞는지 확인)');
      };
      test(real[0], '첫');
      if (real.length > 1) test(real[real.length - 1], '마지막');
    }
    return out;
  }

  return { isChord, diatonic, bassNotes, chordAt, changeChord, sectionEdit, check, SECTION_NAMES, QUALITIES: [['', '장'], ['m', 'm'], ['7', '7'], ['maj7', 'maj7'], ['m7', 'm7'], ['sus4', 'sus4'], ['add9', 'add9'], ['dim', 'dim'], ['6', '6']] };
});
