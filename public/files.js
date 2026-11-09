// 이미지·PDF 악보 도우미: 업로드 전 이미지 줄이기, 악보 사진 표시, 확대 보기
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 사진은 가로·세로 2400px 이내 JPEG로 줄여서 올린다. (PDF·GIF는 그대로)
  async function prepare(file) {
    const type = (file.type || '').toLowerCase();
    if (type === 'application/pdf' || type === 'image/gif') return { blob: file, type };
    if (!type.startsWith('image/')) throw new Error(`이미지나 PDF만 올릴 수 있습니다: ${file.name}`);
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * scale);
      const h = Math.round(bmp.height * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; // 투명 배경 PNG가 검게 나오지 않도록
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      if (blob && (scale < 1 || type !== 'image/jpeg' || blob.size < file.size)) return { blob, type: 'image/jpeg' };
    } catch (e) {
      /* 아래에서 원본 그대로 시도 */
    }
    if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) return { blob: file, type };
    throw new Error(`이 이미지 형식은 올릴 수 없습니다: ${file.name} (JPG나 PNG로 저장해서 올려 주세요)`);
  }

  // 곡 보기 화면의 이미지 악보 영역
  function renderPane(files) {
    if (!files.length) return '<p class="muted">등록된 이미지 악보가 없습니다.</p>';
    let n = 0;
    return files
      .map((f, i) =>
        f.kind === 'image'
          ? `<img class="sheet" src="${esc(f.url)}" alt="악보 ${++n}" data-n="${n - 1}" loading="${i < 2 ? 'eager' : 'lazy'}">`
          : `<a class="pdf-link" href="${esc(f.url)}" target="_blank" rel="noopener">📄 PDF 악보 열기</a>`
      )
      .join('');
  }
  function bindPane(root, files) {
    const urls = files.filter((f) => f.kind === 'image').map((f) => f.url);
    root.onclick = (ev) => {
      const t = ev.target.closest && ev.target.closest('img.sheet');
      if (t) lightbox(urls, +t.dataset.n);
    };
  }

  // 전체 화면 확대 보기: 버튼으로 확대/축소, 손가락 확대와 스크롤도 그대로 동작
  function lightbox(urls, start) {
    let i = start || 0;
    const steps = [1, 1.5, 2, 3, 4];
    let z = 0;
    const ov = document.createElement('div');
    ov.className = 'lb';
    ov.innerHTML = `
      <div class="lb-bar">
        <span class="lb-n"></span>
        <span>
          <button data-a="prev" aria-label="이전">‹</button>
          <button data-a="next" aria-label="다음">›</button>
          <button data-a="out" aria-label="축소">−</button>
          <button data-a="in" aria-label="확대">+</button>
          <button data-a="x">닫기</button>
        </span>
      </div>
      <div class="lb-scroll"><img alt="악보"></div>`;
    document.body.appendChild(ov);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const img = ov.querySelector('img');
    const scroller = ov.querySelector('.lb-scroll');
    const label = ov.querySelector('.lb-n');
    function show() {
      img.src = urls[i];
      // 처음(z=0)은 위아래·좌우 모두 화면 안에 통째로 맞춘다. 누르면 가로 폭 기준으로 확대된다.
      scroller.classList.toggle('fit', z === 0);
      img.style.width = z === 0 ? '' : steps[z] * 100 + '%';
      label.textContent = `${i + 1} / ${urls.length}` + (z ? ` · ${steps[z]}배` : '');
      scroller.scrollTop = 0;
    }
    function close() {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      ov.remove();
    }
    function act(a) {
      if (a === 'x') return close();
      if (a === 'prev') i = (i - 1 + urls.length) % urls.length;
      if (a === 'next') i = (i + 1) % urls.length;
      if (a === 'in') z = Math.min(steps.length - 1, z + 1);
      if (a === 'out') z = Math.max(0, z - 1);
      show();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') act('prev');
      else if (e.key === 'ArrowRight') act('next');
    }
    ov.querySelector('.lb-bar').onclick = (e) => e.target.dataset.a && act(e.target.dataset.a);
    img.onclick = () => {
      z = (z + 1) % steps.length;
      show();
    };
    document.addEventListener('keydown', onKey);
    show();
  }

  window.Files = { prepare, renderPane, bindPane, lightbox };
})();
