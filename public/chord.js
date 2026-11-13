// ChordPro 파서 + 이조 + 렌더링 (브라우저와 Node 테스트 양쪽에서 사용)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sections.js'));
  else root.Chord = factory(root.Sections);
})(typeof self !== 'undefined' ? self : this, function (Sections) {
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

  // acc(27차): 'sharp'/'flat'이면 검은 건반 키 이름을 모두 그 표기로, 'auto'(기본)이면 흔히 쓰는 이름(Db·Eb·F#·Ab·Bb …)을 쓰되
  // 두 가지가 비슷하게 쓰이는 F#/Gb(장조)·D#m/Ebm(단조)만 시작 키의 표기(샵 계열/플랫 계열)를 따른다.
  function transposeKey(keyStr, semis, acc) {
    const k = parseKey(keyStr);
    if (!k) return keyStr;
    const idx = mod12(k.idx + semis);
    let names = k.minor ? MINOR_NAMES : MAJOR_NAMES;
    if (acc === 'sharp') names = SHARP;
    else if (acc === 'flat') names = FLAT;
    else {
      const fam = keyUsesFlats(keyStr);
      names = names.slice();
      if (!k.minor && idx === 6) names[6] = fam ? 'Gb' : 'F#';
      if (k.minor && idx === 3) names[3] = fam ? 'Eb' : 'D#';
    }
    return names[idx] + (k.minor ? 'm' : '');
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
        else if (['comment', 'c'].includes(name)) lines.push({ type: 'comment', text: val });
        // 메모 줄 (27차): {ci: 문구}는 구간을 나누지 않는 작은 표시(전조 Ab · 2nd time · D.S. …). 후렴 한가운데 있어도 후렴이 쪼개지지 않는다.
        else if (['comment_italic', 'ci'].includes(name)) { if (val) lines.push({ type: 'memo', text: val, chorus: section === 'chorus' }); }
        else if (['column_break', 'colb'].includes(name)) lines.push({ type: 'colbreak' });
        // 구간 자리표시 (18차): {ref: C} = 앞에 나온 C 구간을 여기서 다시. 표준 ChordPro의 {chorus}도 {ref: C}로 읽는다.
        else if (name === 'ref' || name === 'chorus') {
          const c = Sections.canon(val);
          lines.push({ type: 'ref', id: c ? c.id : name === 'chorus' && !val ? 'C' : val, rest: c ? c.rest : '', raw: val });
        }
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
    return { meta, lines, sections: buildSections(lines) };
  }

  // ---------- 구간 (18차) ----------
  // 구간 = 구간 이름({comment}) 줄부터 다음 구간 이름 직전까지. 이름 없이 시작하는 {soc} 후렴 블록은 그 블록이 한 구간(이름 C).
  // 자리표시({ref})는 줄 하나짜리 구간이다. (renderHTML의 parts 규칙과 같은 해석)
  function buildSections(lines) {
    const secs = [];
    let cur = null;
    let inChorusDiv = false;
    const close = (i) => { if (cur) cur.end = i; };
    lines.forEach((ln, i) => {
      if (ln.type === 'comment') {
        close(i);
        const c = Sections.canon(ln.text);
        cur = { start: i, end: lines.length, id: c ? c.id : '', label: ln.text, isRef: false, hasLyrics: false, named: true };
        secs.push(cur);
        inChorusDiv = false;
      } else if (ln.type === 'ref') {
        close(i);
        secs.push({ start: i, end: i + 1, id: ln.id, label: ln.raw, isRef: true, hasLyrics: false, named: true });
        cur = null;
        inChorusDiv = false;
      } else if (ln.type === 'colbreak') {
        inChorusDiv = false;
      } else if (ln.type === 'blank') {
        inChorusDiv = false;
      } else if (ln.type === 'lyric') {
        if (ln.chorus && !inChorusDiv && cur && cur.hasLyrics) { close(i); cur = null; }
        if (!cur) {
          cur = { start: i, end: lines.length, id: ln.chorus ? 'C' : '', label: '', isRef: false, hasLyrics: false, named: false };
          secs.push(cur);
        } else if (!cur.id && !cur.hasLyrics && ln.chorus && !cur.named) cur.id = 'C';
        cur.hasLyrics = true;
        inChorusDiv = !!ln.chorus;
      }
    });
    // 자리표시의 원본: 같은 이름이고 가사가 있는 구간 중 바로 앞의 것, 없으면 곡 안 첫 번째. 없으면 -1(원본 없음).
    secs.forEach((s, si) => {
      if (!s.isRef) return;
      let best = -1;
      for (let k = 0; k < secs.length; k++) {
        const o = secs[k];
        if (o.isRef || !o.hasLyrics || o.id !== s.id) continue;
        if (o.start < s.start) best = k;
        else if (best < 0) { best = k; break; }
      }
      s.src = best;
      lines[s.start].src = best;
      lines[s.start].sec = si;
    });
    return secs;
  }
  // 구간 안의 줄 목록(이름표·단 나누기 제외, 끝의 빈 줄 제외). 자리표시를 펼칠 때·가사 복사에 쓴다.
  function sectionBody(parsed, si) {
    const s = parsed.sections[si];
    if (!s) return [];
    let a = s.start, b = s.end;
    if (parsed.lines[a] && parsed.lines[a].type === 'comment') a++;
    const body = parsed.lines.slice(a, b).filter((l) => l.type !== 'colbreak' && l.type !== 'ref' && l.type !== 'keychg');
    while (body.length && body[body.length - 1].type === 'blank') body.pop();
    while (body.length && body[0].type === 'blank') body.shift();
    return body;
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

  // 30차: "전조 Ab" · "Key of G" 같은 메모 줄의 키 이름을 semis만큼 옮긴다. 전조·Key로 시작하는 메모에만 쓴다.
  function shiftMemoKey(text, semis, acc) {
    text = String(text || '');
    if (!/^\s*(전조|key\b)/i.test(text) || !semis || semis % 12 === 0) return text;
    return text.replace(/\b([A-G][#b♯♭]?)(m(?:in)?)?(?![A-Za-z0-9])/g, (m0, r, mi) => {
      const key = r.replace('♯', '#').replace('♭', 'b') + (mi ? 'm' : '');
      return parseKey(key) ? transposeKey(key, semis, acc) : m0;
    });
  }

  // 이조 계산: 표시할 코드와 키 이름을 한꺼번에 돌려준다.
  // shift: 원래 키에서 올린 반음 수, capo: 카포 프렛, acc: 'auto' | 'sharp' | 'flat'
  function plan(originalKey, shift, capo, acc) {
    const hasKey = !!parseKey(originalKey);
    const soundKey = hasKey ? transposeKey(originalKey, shift, acc) : '';
    const shapeKey = hasKey ? transposeKey(originalKey, shift - capo, acc) : '';
    const pick = (keyName) => (acc === 'sharp' ? false : acc === 'flat' ? true : keyUsesFlats(keyName));
    return {
      soundKey,
      shapeKey,
      semis: shift - capo,
      flats: hasKey ? pick(shapeKey) : acc === 'flat',
    };
  }

  // opt.names: 'full'(Verse 1 · Chorus …, 기본) | 'abbr'(V1 · C …) — 구간 이름표를 보이는 글자로 바꾼다
  // opt.refs: 'mark'(자리표시를 "↻ Chorus"로만, 기본) | 'all'(모두 원본으로 펼침) | Set(펼칠 자리표시 줄 번호)
  function renderHTML(parsed, opt) {
    const o = Object.assign({ originalKey: '', shift: 0, capo: 0, acc: 'auto', showChords: true, parts: false, names: 'full', refs: 'mark' }, opt);
    // 22차: 송폼 순서로 다시 배열한 악보는 줄마다 전조 누적 반음(ks)을 갖는다. 그 줄의 코드는 키를 ks만큼 더 올려서 쓴다.
    const plans = {};
    const planFor = (ks) => plans[ks || 0] || (plans[ks || 0] = plan(o.originalKey, o.shift + (ks || 0), o.capo, o.acc));
    const conv = (c, ks) => {
      if (!c) return '';
      const pp = planFor(ks);
      return transposeChord(c, pp.semis, pp.flats);
    };
    const out = [];
    let inChorus = false;
    let usedBreak = false; // 단 나누기는 한 곡에 첫 번째 표시만 쓴다(2단 보기에서 3단이 생기지 않게)
    // parts: 구간(1절·후렴·브릿지…)을 <div class="part">로 묶는다. 연주 모드 쪽 넘기기가 구간 단위로 쪽을 나눌 때 쓴다.
    // 구간 = 구간 이름({comment}) 줄부터 다음 구간 이름 직전까지. 이름 없이 시작하는 후렴은 그 블록이 한 구간.
    // 각 part에는 data-s(구간 번호, parsed.sections 기준)가 붙는다. 자리표시 part는 data-ri(자리표시 줄 번호)·data-src(원본 구간 번호).
    let inPart = false;
    let partHasBody = false;
    const secAt = (i) => {
      const ss = parsed.sections || [];
      for (let k = 0; k < ss.length; k++) if (i >= ss[k].start && i < ss[k].end) return k;
      return -1;
    };
    const closeChorus = () => {
      if (inChorus) out.push('</div>');
      inChorus = false;
    };
    const closePart = () => {
      closeChorus();
      if (inPart) out.push('</div>');
      inPart = false;
      partHasBody = false;
    };
    const openPart = (attrs) => {
      if (inPart) return;
      out.push('<div class="part"' + (attrs || '') + '>');
      inPart = true;
      partHasBody = false;
    };
    const nameOf = (text) => Sections.label(text, o.names);
    const isOpen = (i) => o.refs === 'all' || (o.refs instanceof Set && o.refs.has(i));
    // 펼친 자리표시는 "이름표 + 원본 구간 줄들"로 바꿔 아래에서 같은 규칙으로 그린다
    const items = [];
    parsed.lines.forEach((ln, i) => {
      if (ln.type === 'ref' && isOpen(i) && ln.src >= 0) {
        items.push({ ln: { type: 'comment', text: ln.id + (ln.rest ? ' ' + ln.rest : '') }, i, ri: i });
        sectionBody(parsed, ln.src).forEach((b) => items.push({ ln: b, i, ri: i }));
      } else items.push({ ln, i });
    });
    for (const { ln, i, ri } of items) {
      const sAttr = (k) => (k >= 0 ? ' data-s="' + k + '"' : '') + (ri !== undefined ? ' data-ri="' + ri + '"' : '');
      if (ln.type === 'blank') {
        closeChorus();
        out.push('<div class="gap"></div>');
      } else if (ln.type === 'colbreak') {
        if (o.parts) closePart();
        closeChorus();
        if (!usedBreak) out.push('<div class="colb" aria-hidden="true"></div>');
        usedBreak = true;
      } else if (ln.type === 'ref') {
        closeChorus();
        const txt = nameOf(ln.id + (ln.rest ? ' ' + ln.rest : ''));
        // 27차: 구간 이름표 한 줄만 쓴다(아랫줄 없음). 이름 옆의 ↻가 "위와 같음"이고, 이름표를 탭하면 그 자리에서 펼친다.
        const chip =
          ln.src >= 0
            ? '<div class="cm refc" data-ri="' + i + '" role="button" tabindex="0" title="탭하면 펼쳐요">' + esc(txt) + ' ↻</div>'
            : '<div class="cm refc orphan" data-ri="' + i + '">' + esc(txt) + ' ↻ · 원본 구간이 없어요</div>';
        if (o.parts) {
          closePart();
          out.push('<div class="part refp" data-s="' + secAt(i) + '" data-ri="' + i + '" data-src="' + ln.src + '">' + chip + '</div>');
        } else out.push(chip);
      } else if (ln.type === 'keychg') {
        // 전조 표시줄 (송폼 순서로 배열한 악보에만 있다)
        closeChorus();
        const kc = '<div class="keychg">' + esc(ln.text || '♯ 전조') + '</div>';
        if (o.parts) { closePart(); out.push('<div class="part kcpart">' + kc + '</div>'); } else out.push(kc);
      } else if (ln.type === 'memo') {
        // 메모 줄: 구간을 시작하거나 끊지 않는다. 후렴 안에 있으면 후렴 막대 안에 그대로 둔다.
        if (o.parts) {
          if (ln.chorus && !inChorus && inPart && partHasBody) closePart();
          openPart(sAttr(secAt(i)));
        }
        if (ln.chorus && !inChorus) {
          out.push('<div class="chorus">');
          inChorus = true;
        }
        if (!ln.chorus) closeChorus();
        const isKc = /^\s*(전조|key\b)/i.test(ln.text);
        // 30차: "전조 Ab" 같은 메모의 키 이름도 곡 키를 바꾼 만큼 함께 옮긴다(코드만 바뀌고 메모는 그대로이던 문제)
        const mtext = shiftMemoKey(ln.text, o.shift, o.acc);
        out.push('<div class="mline' + (isKc ? ' kc' : '') + '">' + esc(mtext) + '</div>');
      } else if (ln.type === 'comment') {
        if (o.parts) {
          closePart();
          openPart(sAttr(secAt(i)) + (ri !== undefined ? ' data-open="1"' : ''));
        }
        closeChorus();
        out.push('<div class="cm' + (ri !== undefined ? ' refopen' : '') + '"' + (ri !== undefined ? ' data-ri="' + ri + '" role="button" tabindex="0" title="탭하면 접어요"' : '') + '>' + esc(nameOf(ln.text)) + '</div>');
      } else {
        if (o.parts) {
          if (ln.chorus && !inChorus && inPart && partHasBody) closePart();
          openPart(sAttr(ri !== undefined ? secAt(i) : secAt(i)));
          partHasBody = true;
        }
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
                    '<span class="sg"><span class="ch">' + esc(conv(s.chord, ln.ks)) + '</span><span class="ly">' + esc(s.text) + '</span></span>'
                )
                .join('') +
              '</div>'
          );
        }
      }
    }
    if (o.parts) closePart();
    closeChorus();
    return out.join('');
  }

  return {
    MAJOR_NAMES, MINOR_NAMES,
    parseKey, keyUsesFlats, transposeChord, transposeKey, noteName,
    parseChordPro, guessKey, plan, renderHTML, sectionBody, buildSections, shiftMemoKey,
  };
});
