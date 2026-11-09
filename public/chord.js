// ChordPro 파서 + 이조 + 렌더링 (브라우저와 Node 테스트 양쪽에서 사용)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Chord = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  // 키 선택 목록에 보여 줄 대표 표기
  const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  // 장조 기준으로 플랫을 쓰는 키: Db, Eb, F, Ab, Bb (G키는 F#, 즉 샵)
  const FLAT_MAJORS = new Set([1, 3, 5, 8, 10]);

  const mod12 = (n) => ((n % 12) + 12) % 12;

  function parseNote(s) {
    const m = /^([A-G])([#b]?)/.exec(s || '');
    if (!m) return null;
    let idx = LETTER[m[1]];
    if (m[2] === '#') idx += 1;
    if (m[2] === 'b') idx -= 1;
    return { idx: mod12(idx), len: m[0].length };
  }

  function noteName(idx, flats) {
    return (flats ? FLAT : SHARP)[mod12(idx)];
  }

  // "G", "Am", "Bb", "F#m" → { idx, minor, accidental }
  function parseKey(str) {
    const m = /^([A-G][#b]?)(m|min|-)?$/.exec((str || '').trim());
    if (!m) return null;
    const n = parseNote(m[1]);
    return { idx: n.idx, minor: !!m[2], accidental: m[1].length > 1 ? m[1][1] : '' };
  }

  // 이 키에서 플랫(♭) 표기를 쓸지 여부
  function keyUsesFlats(keyStr) {
    const k = parseKey(keyStr);
    if (!k) return false;
    if (k.accidental === 'b') return true;
    if (k.accidental === '#') return false;
    const major = k.minor ? mod12(k.idx + 3) : k.idx;
    return FLAT_MAJORS.has(major);
  }

  // "Am7", "D/F#", "Bbmaj7" → 반음 이동. 코드가 아닌 것([?], N.C.)은 그대로 둔다.
  function transposeChord(chord, semis, flats) {
    const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(chord);
    if (!m) return chord;
    const root = parseNote(m[1]);
    let out = noteName(root.idx + semis, flats) + m[2];
    if (m[3]) out += '/' + noteName(parseNote(m[3]).idx + semis, flats);
    return out;
  }

  function transposeKey(keyStr, semis) {
    const k = parseKey(keyStr);
    if (!k) return keyStr;
    const names = k.minor ? MINOR_NAMES : MAJOR_NAMES;
    return names[mod12(k.idx + semis)] + (k.minor ? 'm' : '');
  }

  // ---------- ChordPro 파싱 ----------
  function parseChordPro(text) {
    const meta = {};
    const lines = [];
    let section = null; // 'chorus' 안인지
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      const d = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/.exec(raw);
      if (d) {
        const name = d[1].toLowerCase();
        const val = (d[2] || '').trim();
        if (name === 'title' || name === 't') meta.title = val;
        else if (name === 'subtitle' || name === 'st') meta.subtitle = val;
        else if (name === 'artist') meta.artist = val;
        else if (name === 'key') meta.key = val;
        else if (name === 'tempo') meta.tempo = val;
        else if (name === 'capo') meta.capo = val;
        else if (['comment', 'c', 'comment_italic', 'ci'].includes(name)) lines.push({ type: 'comment', text: val });
        else if (['soc', 'start_of_chorus'].includes(name)) section = 'chorus';
        else if (['eoc', 'end_of_chorus'].includes(name)) section = null;
        continue;
      }
      if (/^\s*#/.test(raw)) continue;
      if (raw.trim() === '') {
        lines.push({ type: 'blank' });
        continue;
      }
      const re = /\[([^\]]*)\]/g;
      const segs = [];
      let cur = { chord: '', text: '' };
      let last = 0;
      let m;
      while ((m = re.exec(raw))) {
        cur.text = raw.slice(last, m.index);
        segs.push(cur);
        cur = { chord: m[1].trim(), text: '' };
        last = re.lastIndex;
      }
      cur.text = raw.slice(last);
      segs.push(cur);
      const clean = segs.filter((s, i) => !(i === 0 && !s.chord && !s.text));
      lines.push({ type: 'lyric', segs: clean, chorus: section === 'chorus', hasChords: clean.some((s) => s.chord) });
    }
    return { meta, lines };
  }

  // 곡의 원래 키: 입력값 → {key:} → 첫 코드로 추정
  function guessKey(parsed, given) {
    if (parseKey(given)) return { key: given, guessed: false };
    if (parseKey(parsed.meta.key)) return { key: parsed.meta.key, guessed: false };
    for (const ln of parsed.lines) {
      if (ln.type !== 'lyric') continue;
      for (const s of ln.segs) {
        const m = /^([A-G][#b]?)(m(?!aj))?/.exec(s.chord);
        if (m) return { key: m[1] + (m[2] ? 'm' : ''), guessed: true };
      }
    }
    return { key: '', guessed: false };
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 이조 계산: 표시할 코드와 키 이름을 한꺼번에 돌려준다.
  // shift: 원래 키에서 올린 반음 수, capo: 카포 프렛, acc: 'auto' | 'sharp' | 'flat'
  function plan(originalKey, shift, capo, acc) {
    const hasKey = !!parseKey(originalKey);
    const soundKey = hasKey ? transposeKey(originalKey, shift) : '';
    const shapeKey = hasKey ? transposeKey(originalKey, shift - capo) : '';
    const pick = (keyName) => (acc === 'sharp' ? false : acc === 'flat' ? true : keyUsesFlats(keyName));
    return {
      soundKey,
      shapeKey,
      semis: shift - capo,
      flats: hasKey ? pick(shapeKey) : acc === 'flat',
    };
  }

  function renderHTML(parsed, opt) {
    const o = Object.assign({ originalKey: '', shift: 0, capo: 0, acc: 'auto', showChords: true }, opt);
    const p = plan(o.originalKey, o.shift, o.capo, o.acc);
    const conv = (c) => (c ? transposeChord(c, p.semis, p.flats) : '');
    const out = [];
    let inChorus = false;
    const closeChorus = () => {
      if (inChorus) out.push('</div>');
      inChorus = false;
    };
    for (const ln of parsed.lines) {
      if (ln.type === 'blank') {
        closeChorus();
        out.push('<div class="gap"></div>');
      } else if (ln.type === 'comment') {
        closeChorus();
        out.push('<div class="cm">' + esc(ln.text) + '</div>');
      } else {
        if (ln.chorus && !inChorus) {
          out.push('<div class="chorus">');
          inChorus = true;
        }
        if (!ln.chorus) closeChorus();
        if (!o.showChords || !ln.hasChords) {
          const text = ln.segs.map((s) => s.text).join('');
          if (!o.showChords && !text.trim()) continue; // 간주 등 코드만 있는 줄은 가사 모드에서 숨김
          out.push('<div class="ln plain">' + (esc(text) || '&nbsp;') + '</div>');
        } else {
          out.push(
            '<div class="ln">' +
              ln.segs
                .map(
                  (s) =>
                    '<span class="sg"><span class="ch">' + esc(conv(s.chord)) + '</span><span class="ly">' + esc(s.text) + '</span></span>'
                )
                .join('') +
              '</div>'
          );
        }
      }
    }
    closeChorus();
    return out.join('');
  }

  return {
    MAJOR_NAMES, MINOR_NAMES,
    parseKey, keyUsesFlats, transposeChord, transposeKey, noteName,
    parseChordPro, guessKey, plan, renderHTML,
  };
});
