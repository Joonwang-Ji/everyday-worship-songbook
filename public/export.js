// 내보내기 (6차): 콘티 → 표지 이미지(PNG) / PDF(표지 + 곡별 악보)
// 브라우저에서만 만든다. 한글 글꼴을 PDF에 넣지 않으려고 표지·코드 악보는 캔버스에 그려 이미지 쪽으로 넣고,
// 이미지·PDF 악보는 원본을 그대로 합친다. PDF 합치기는 vendor/pdf-lib.min.js (MIT) 를 쓴다.
// 필요할 때만 불러오므로(앱이 처음 열릴 때는 읽지 않음) 평소 속도에는 영향이 없다.
(function () {
  'use strict';
  const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif';
  const INK = '#1d2430', MUTED = '#6b7280', BRAND = '#2a6670', CHORD = '#bf4b32', LINE = '#d9d6cc', SOFT = '#e8f1f1';
  const A4 = { w: 1240, h: 1754 }; // 150dpi
  const PT = { w: 595.28, h: 841.89 }; // A4 (pt)
  const M = 90; // 바깥 여백

  const font = (px, weight) => `${weight || 400} ${px}px ${FONT}`;
  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.round(w);
    c.height = Math.round(h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.textBaseline = 'alphabetic';
    return c;
  }
  const toBlob = (cv, type, q) =>
    new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했습니다.'))), type, q));
  const release = (cv) => { cv.width = 0; cv.height = 0; };

  // 글자 나누기: 띄어쓰기에서 줄을 바꾸고, 한 덩어리가 너무 길면 글자 단위로 쪼갠다
  function wrap(g, text, maxW) {
    const lines = [];
    for (const para of String(text || '').split('\n')) {
      let cur = '';
      for (const tok of para.match(/\S+\s*|\s+/g) || ['']) {
        if (g.measureText(cur + tok).width <= maxW) { cur += tok; continue; }
        if (cur.trim()) { lines.push(cur.trimEnd()); cur = ''; }
        if (g.measureText(tok).width <= maxW) { cur = tok; continue; }
        for (const ch of tok) {
          if (g.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ''; }
          cur += ch;
        }
      }
      lines.push(cur.trimEnd());
    }
    return lines.length ? lines : [''];
  }

  // ---------- 표지 (날짜 · 제목 · 곡 순서 · 키 · 송폼 · 메모) ----------
  // pageH 가 0 이면 한 장으로 길게(카톡 공유용 이미지), 아니면 그 높이로 쪽을 나눈다(PDF 표지).
  function coverCanvases(s, W, pageH) {
    const k = W / 1080;
    const sc = mk(10, 10).getContext('2d');
    const pad = 70 * k, cw = W - 2 * pad;
    const blocks = [];

    // 머리: 날짜, 제목, 메모
    {
      const date = SongForm.fmtDate(s.date);
      const title = (s.title || '').trim();
      const name = title ? (/콘티$/.test(title) ? title : title + ' 콘티') : '콘티';
      sc.font = font(62 * k, 800);
      const tl = wrap(sc, name, cw);
      sc.font = font(30 * k, 400);
      const who = SongForm.leaderList(s.leaders);
      const memoText = [who.length ? '🎤 인도: ' + who.join(', ') : '', (s.memo || '').trim() ? '※ ' + s.memo.trim().replace(/\n+/g, '  ') : ''].filter(Boolean).join('   ');
      const ml = memoText ? wrap(sc, memoText, cw) : [];
      const h = (date ? 50 * k : 0) + tl.length * 76 * k + (ml.length ? 14 * k + ml.length * 42 * k : 0) + 40 * k;
      blocks.push({
        h,
        draw(g, x, y) {
          let yy = y;
          if (date) { g.font = font(34 * k, 700); g.fillStyle = BRAND; g.fillText(date, x, yy + 36 * k); yy += 50 * k; }
          g.font = font(62 * k, 800); g.fillStyle = INK;
          for (const l of tl) { g.fillText(l, x, yy + 58 * k); yy += 76 * k; }
          if (ml.length) {
            yy += 14 * k;
            g.font = font(30 * k, 400); g.fillStyle = MUTED;
            for (const l of ml) { g.fillText(l, x, yy + 30 * k); yy += 42 * k; }
          }
          g.fillStyle = BRAND; g.fillRect(x, yy + 14 * k, cw, 4 * k);
        },
      });
    }

    // 곡
    (s.items || []).forEach((it, i) => {
      const key = (it.key || it.original_key || '').trim();
      const numW = 80 * k;
      sc.font = font(40 * k, 800);
      const keyW = key ? sc.measureText(key).width + 40 * k : 0;
      const titleW = cw - numW - keyW - 10 * k;
      const tl = wrap(sc, it.title, titleW);
      const rows = [];
      sc.font = font(30 * k, 400);
      const labW = 84 * k;
      if ((it.form || '').trim()) rows.push({ label: '송폼', lines: wrap(sc, it.form.trim(), cw - numW - labW) });
      if ((it.memo || '').trim()) rows.push({ label: '메모', lines: wrap(sc, it.memo.trim().replace(/\s*\n\s*/g, ' '), cw - numW - labW) });
      let h = 26 * k + tl.length * 54 * k;
      for (const r of rows) h += 8 * k + r.lines.length * 42 * k;
      h += 26 * k;
      blocks.push({
        h,
        draw(g, x, y) {
          let yy = y + 26 * k;
          // 번호 원
          g.fillStyle = BRAND;
          g.beginPath(); g.arc(x + 28 * k, yy + 24 * k, 28 * k, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#fff'; g.font = font(30 * k, 800); g.textAlign = 'center';
          g.fillText(String(i + 1), x + 28 * k, yy + 35 * k);
          g.textAlign = 'left';
          // 제목, 키
          g.fillStyle = INK; g.font = font(40 * k, 800);
          for (const l of tl) { g.fillText(l, x + numW, yy + 38 * k); yy += 54 * k; }
          if (key) {
            g.font = font(40 * k, 800);
            const kw = g.measureText(key).width + 40 * k;
            g.fillStyle = SOFT;
            g.beginPath(); g.roundRect ? g.roundRect(x + cw - kw, y + 26 * k, kw, 56 * k, 14 * k) : g.rect(x + cw - kw, y + 26 * k, kw, 56 * k);
            g.fill();
            g.fillStyle = BRAND; g.textAlign = 'center';
            g.fillText(key, x + cw - kw / 2, y + 26 * k + 40 * k);
            g.textAlign = 'left';
          }
          for (const r of rows) {
            yy += 8 * k;
            g.font = font(26 * k, 700); g.fillStyle = MUTED; g.fillText(r.label, x + numW, yy + 30 * k);
            g.font = font(30 * k, 400); g.fillStyle = INK;
            for (const l of r.lines) { g.fillText(l, x + numW + labW, yy + 30 * k); yy += 42 * k; }
          }
          g.fillStyle = LINE; g.fillRect(x, y + h - 2 * k, cw, 2 * k);
        },
      });
    });

    // 쪽 나누기
    const pages = [];
    let cur = { blocks: [], h: pad };
    for (const b of blocks) {
      if (pageH && cur.blocks.length && cur.h + b.h > pageH - pad) { pages.push(cur); cur = { blocks: [], h: pad }; }
      cur.blocks.push(b);
      cur.h += b.h;
    }
    pages.push(cur);
    return pages.map((p) => {
      const cv = mk(W, pageH || Math.ceil(p.h + pad));
      const g = cv.getContext('2d');
      let y = pad;
      for (const b of p.blocks) { b.draw(g, pad, y); y += b.h; }
      return cv;
    });
  }

  // ---------- 곡 머리글 (번호 · 제목 · 키 · 송폼 · 메모) ----------
  function drawHeader(g, W, n, it, info, keyText, first) {
    let y = M;
    if (!first) {
      g.font = font(26, 600); g.fillStyle = MUTED;
      g.fillText(`${n}. ${it.title} (이어서)`, M, y + 22);
      return y + 56;
    }
    const keyLabel = keyText ? `키 ${keyText}` : '';
    g.font = font(44, 800);
    const keyW = keyLabel ? g.measureText(keyLabel).width : 0;
    g.font = font(50, 800);
    const tl = wrap(g, `${n}. ${it.title}`, W - 2 * M - keyW - 30);
    g.fillStyle = INK;
    for (const l of tl) { g.fillText(l, M, y + 46); y += 62; }
    if (keyLabel) { g.font = font(44, 800); g.fillStyle = BRAND; g.textAlign = 'right'; g.fillText(keyLabel, W - M, M + 44); g.textAlign = 'left'; }
    const sub = [info.artist, info.origKey && info.origKey !== keyText ? `원키 ${info.origKey}` : '', String(info.timeSig || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean).join(', '), info.tempo ? `♩${info.tempo}` : ''].filter(Boolean).join('  ·  ');
    if (sub) { g.font = font(26, 400); g.fillStyle = MUTED; g.fillText(sub, M, y + 28); y += 40; }
    for (const [label, text] of [['송폼', it.form], ['메모', it.memo]]) {
      if (!(text || '').trim()) continue;
      y += 6;
      g.font = font(26, 700); g.fillStyle = MUTED; g.fillText(label, M, y + 30);
      g.font = font(30, 400); g.fillStyle = INK;
      for (const l of wrap(g, text.trim().replace(/\s*\n\s*/g, ' '), W - 2 * M - 90)) { g.fillText(l, M + 90, y + 30); y += 40; }
    }
    g.fillStyle = LINE; g.fillRect(M, y + 10, W - 2 * M, 2);
    return y + 34;
  }

  // 곡 정보 + 한 줄 안내만 있는 쪽 (PDF 악보를 이어 붙이기 전, 악보가 없는 곡, 합치지 못한 곡)
  function notePage(n, it, info, keyText, note) {
    const cv = mk(A4.w, A4.h), g = cv.getContext('2d');
    const y = drawHeader(g, A4.w, n, it, info, keyText, true);
    g.font = font(30, 400); g.fillStyle = MUTED;
    wrap(g, note, A4.w - 2 * M).forEach((l, i) => g.fillText(l, M, y + 40 + i * 44));
    return cv;
  }

  // ---------- 코드 악보 ----------
  // 코드가 있는 줄을 "코드 위 · 가사 아래" 로 그린다. 폭을 넘으면 낱말 단위로 줄을 바꾼다.
  function renderChord(n, it, song, parsed, p, info, keyText, scale) {
    const W = A4.w, H = A4.h, maxW = W - 2 * M;
    const LYR = 30 * scale, CHD = 26 * scale;
    const CH_H = Math.round(CHD * 1.3), LY_H = Math.round(LYR * 1.35), ROW_GAP = Math.round(8 * scale), PLAIN_H = Math.round(LYR * 1.55);
    const conv = (c) => (c ? Chord.transposeChord(c, p.semis, p.flats) : '');
    const pages = [];
    let cv, g, y, barY = null, inChorus = false;
    const endBar = () => { if (barY !== null) { g.fillStyle = BRAND; g.fillRect(M - 26, barY, 6, Math.max(0, y - barY - 4)); barY = null; } };
    let newPage = (first) => {
      cv = mk(W, H); g = cv.getContext('2d'); pages.push(cv);
      y = drawHeader(g, W, n, it, info, keyText, first);
      barY = inChorus ? y : null;
    };
    const need = (h) => { if (y + h > H - M) { endBar(); newPage(false); } };
    newPage(true);

    const tw = (px, weight, t) => { g.font = font(px, weight); return g.measureText(t).width; };
    function pack(segs) {
      const units = [];
      for (const sg of segs) (sg.text.match(/\S+\s*|\s+/g) || ['']).forEach((t, i) => units.push({ chord: i === 0 ? conv(sg.chord) : '', text: t }));
      const groups = [];
      let cur = [];
      for (const u of units) { cur.push(u); if (/\s$/.test(u.text)) { groups.push(cur); cur = []; } }
      if (cur.length) groups.push(cur);
      const uw = (u) => Math.max(tw(LYR, 400, u.text), u.chord ? tw(CHD, 700, u.chord) + 14 * scale : 0);
      const rows = [];
      let row = { items: [], w: 0 };
      const put = (u) => { row.items.push({ x: row.w, chord: u.chord, text: u.text }); row.w += uw(u); };
      const flush = () => { if (row.items.length) rows.push(row); row = { items: [], w: 0 }; };
      for (const grp of groups) {
        const gw = grp.reduce((a, u) => a + uw(u), 0);
        if (row.w + gw <= maxW) grp.forEach(put);
        else if (gw <= maxW) { flush(); grp.forEach(put); }
        else for (const u of grp) { if (row.w + uw(u) > maxW) flush(); put(u); } // 아주 긴 낱말은 조각 단위로
      }
      flush();
      return rows;
    }

    // 구간 자리표시({ref})는 줄 단위로 그리다가: 원본 구간이 지금 쪽에 이미 그려져 있으면 "↻ Chorus"만, 아니면 원본을 펼쳐서 그린다.
    // (연주 모드 쪽 넘기기와 같은 규칙. 원본이 다른 쪽에 있으면 보면서 넘겨 다니지 않게 한다)
    const secAt = (i) => {
      const ss = parsed.sections || [];
      for (let k = 0; k < ss.length; k++) if (i >= ss[k].start && i < ss[k].end) return k;
      return -1;
    };
    let pageSecs = new Set();
    const baseNewPage = newPage;
    newPage = (first) => { pageSecs = new Set(); baseNewPage(first); };
    const drawLn = (ln, si) => {
      if (ln.type === 'colbreak') return; // 단 나누기는 화면(2단 보기)에서만 쓴다
      if (ln.type === 'blank') { endBar(); inChorus = false; need(24 * scale); y += Math.round(24 * scale); return; }
      if (ln.type === 'comment') {
        endBar(); inChorus = false;
        g.font = font(28 * scale, 700);
        const ls = wrap(g, Sections.label(ln.text, 'full'), maxW);
        need(ls.length * Math.round(40 * scale) + 10);
        g.fillStyle = BRAND;
        for (const l of ls) { g.fillText(l, M, y + Math.round(30 * scale)); y += Math.round(40 * scale); }
        if (si >= 0) pageSecs.add(si);
        return;
      }
      if (si >= 0) pageSecs.add(si);
      if (ln.chorus && !inChorus) inChorus = true;
      if (!ln.chorus) { endBar(); inChorus = false; }
      if (!ln.hasChords) {
        g.font = font(LYR, 400);
        for (const l of wrap(g, ln.segs.map((s) => s.text).join(''), maxW)) {
          need(PLAIN_H);
          if (inChorus && barY === null) barY = y;
          g.font = font(LYR, 400); g.fillStyle = INK; g.fillText(l, M, y + Math.round(LYR * 1.05)); y += PLAIN_H;
        }
        return;
      }
      for (const row of pack(ln.segs)) {
        need(CH_H + LY_H + ROW_GAP);
        if (inChorus && barY === null) barY = y;
        for (const u of row.items) {
          if (u.chord) { g.font = font(CHD, 700); g.fillStyle = CHORD; g.fillText(u.chord, M + u.x, y + Math.round(CHD * 1.05)); }
          if (u.text.trim()) { g.font = font(LYR, 400); g.fillStyle = INK; g.fillText(u.text, M + u.x, y + CH_H + Math.round(LYR * 1.05)); }
        }
        y += CH_H + LY_H + ROW_GAP;
      }
    };
    parsed.lines.forEach((ln, i) => {
      const si = secAt(i);
      if (ln.type !== 'ref') { drawLn(ln, si); return; }
      const name = Sections.label(ln.id + (ln.rest ? ' ' + ln.rest : ''), 'full');
      if (ln.src >= 0 && !pageSecs.has(ln.src)) {
        // 원본이 이 쪽에 없다 → 펼쳐서 그린다
        drawLn({ type: 'comment', text: ln.id + (ln.rest ? ' ' + ln.rest : '') }, -1);
        for (const b of Chord.sectionBody(parsed, ln.src)) drawLn(b, -1);
        pageSecs.add(ln.src);
        return;
      }
      endBar(); inChorus = false;
      g.font = font(26 * scale, 700);
      need(Math.round(40 * scale) + 10);
      g.fillStyle = BRAND;
      g.fillText('↻ ' + name + (ln.src >= 0 ? '  (위와 같음)' : ''), M, y + Math.round(30 * scale));
      y += Math.round(40 * scale);
    });
    endBar();
    return pages;
  }
  // 2쪽 안에 들어오도록 글자를 조금씩 줄여 본다 (너무 작아지지 않게 하한을 둔다)
  function chordPages(n, it, song, info) {
    const parsed = Chord.parseChordPro(song.chordpro);
    const gk = Chord.guessKey(parsed, song.original_key);
    const ko = Chord.parseKey(gk.key), kt = Chord.parseKey(it.key || song.team_key || '');
    const shift = ko && kt ? (((kt.idx - ko.idx) % 12) + 12) % 12 : 0;
    const p = Chord.plan(gk.key, shift, 0, 'auto');
    info.origKey = gk.key;
    const keyText = p.soundKey || (it.key || '');
    let best = null;
    for (const scale of [1, 0.9, 0.8, 0.72]) {
      if (best) best.forEach(release);
      best = renderChord(n, it, song, parsed, p, info, keyText, scale);
      if (best.length <= 2) break;
    }
    return best;
  }

  // ---------- 이미지 악보 ----------
  function loadImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => res({ img, done: () => URL.revokeObjectURL(url) });
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); };
      img.src = url;
    });
  }
  // 가로로 긴 악보는 가로 쪽에, 세로 악보는 세로 쪽에. 위쪽에 곡 정보 띠를 둔다.
  function imagePage(n, it, info, keyText, img, first) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const land = iw > ih * 1.15;
    const W = land ? A4.h : A4.w, H = land ? A4.w : A4.h;
    const cv = mk(W, H), g = cv.getContext('2d');
    const top = drawHeader(g, W, n, it, info, keyText, first) - 14;
    const bx = 40, by = top, bw = W - 80, bh = H - top - 40;
    const r = Math.min(bw / iw, bh / ih, 2); // 너무 작은 그림을 억지로 키우지는 않는다(최대 2배)
    const dw = iw * r, dh = ih * r;
    g.drawImage(img, bx + (bw - dw) / 2, by, dw, dh); // 가로는 가운데, 세로는 곡 정보 띠 바로 아래부터
    return cv;
  }

  // ---------- 공개 함수 ----------
  async function coverPng(s) {
    const [cv] = coverCanvases(s, 1080, 0);
    const blob = await toBlob(cv, 'image/png');
    release(cv);
    return blob;
  }

  // s: 콘티(items 포함). o: { getSong(id) → 곡(chordpro, files …), getBytes(url) → ArrayBuffer, onProgress(done, total, label) }
  async function buildPdf(s, o) {
    if (!window.PDFLib) throw new Error('PDF 도구를 불러오지 못했습니다.');
    const { PDFDocument } = window.PDFLib;
    const pdf = await PDFDocument.create();
    pdf.setTitle(((s.title || '콘티') + ' ' + (s.date || '')).trim());
    pdf.setCreator('Everyday Worship Songbook');
    const warnings = [];
    const items = s.items || [];
    const total = items.length + 1;
    let done = 0;
    const tick = (label) => { done++; if (o.onProgress) o.onProgress(done, total, label); };

    const addCanvas = async (cv) => {
      const land = cv.width > cv.height;
      const pw = land ? PT.h : PT.w, ph = land ? PT.w : PT.h;
      const img = await pdf.embedJpg(await (await toBlob(cv, 'image/jpeg', 0.9)).arrayBuffer());
      pdf.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      release(cv);
    };

    for (const cv of coverCanvases(s, A4.w, A4.h)) await addCanvas(cv);
    tick('표지');

    for (let i = 0; i < items.length; i++) {
      const it = items[i], n = i + 1;
      if (o.onProgress) o.onProgress(done, total, `${n}. ${it.title}`);
      let song = null;
      try { song = await o.getSong(it.song_id); } catch { /* 아래에서 안내 쪽을 넣는다 */ }
      const info = { artist: song ? song.artist : '', origKey: song ? song.original_key : '', tempo: song ? song.tempo : '', timeSig: song ? song.time_sig : '' };
      const files = song ? song.files || [] : [];
      const hasChord = !!song && /\S/.test(song.chordpro || '');
      let mode = it.view || 'auto';
      if (mode === 'auto') mode = hasChord ? 'chord' : files.length ? 'image' : 'none';
      if (mode === 'chord' && !hasChord) mode = files.length ? 'image' : 'none';
      if (mode === 'image' && !files.length) mode = hasChord ? 'chord' : 'none';
      const recKey = (it.key || it.original_key || '').trim();

      if (!song) {
        warnings.push(`"${it.title}" 곡을 불러오지 못했습니다.`);
        await addCanvas(notePage(n, it, info, recKey, '이 곡의 악보를 불러오지 못했습니다.'));
      } else if (mode === 'chord') {
        for (const cv of chordPages(n, it, song, info)) await addCanvas(cv);
      } else if (mode === 'image') {
        let headerDone = false;
        for (const f of files) {
          try {
            const bytes = await o.getBytes(f.url);
            if (f.kind === 'pdf') {
              if (!headerDone) { await addCanvas(notePage(n, it, info, recKey, 'PDF 악보가 다음 쪽부터 이어집니다.')); headerDone = true; }
              const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
              (await pdf.copyPages(src, src.getPageIndices())).forEach((pg) => pdf.addPage(pg));
            } else {
              const { img, done: free } = await loadImage(new Blob([bytes]));
              await addCanvas(imagePage(n, it, info, recKey, img, !headerDone));
              free();
              headerDone = true;
            }
          } catch {
            warnings.push(`"${it.title}"의 악보 파일 하나를 넣지 못했습니다.`);
            if (!headerDone) { await addCanvas(notePage(n, it, info, recKey, '악보 파일을 넣지 못했습니다. 앱에서 직접 열어 주세요.')); headerDone = true; }
          }
        }
      } else {
        await addCanvas(notePage(n, it, info, recKey, '등록된 악보가 없습니다.'));
      }
      tick(it.title);
    }
    const bytes = await pdf.save();
    return { blob: new Blob([bytes], { type: 'application/pdf' }), warnings, pages: pdf.getPageCount() };
  }

  window.Exporter = { coverPng, buildPdf };
})();
