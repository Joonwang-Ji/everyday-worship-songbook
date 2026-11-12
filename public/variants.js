// 곡의 "버전" 도우미 (28차) — 브라우저와 Node 테스트 양쪽에서 쓰는 순수 함수 모음.
// 한 곡에는 기본 버전(곡 본문 songs.chordpro + variant_id가 없는 이미지)과, 추가 버전(song.variants[])이 있다.
// 버전마다 이름(예: "영어", "쉬운 코드")·언어(ko/en/…)·코드 악보·이미지가 따로 있다.
// 콘티의 곡 칸은 쓸 버전(variant_id)과, 구간별로 다른 버전을 쓰는 지정(variant_map)을 가진다.
//   variant_map 글자 규칙: {"V2": 3, "C#2": 0}  — "C#2" = 송폼에서 두 번째로 나오는 C, "V2" = 그 구간 이름 전체. 0 = 기본 버전.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Variants = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LANGS = [
    ['ko', '한글'],
    ['en', '영어'],
    ['ja', '일본어'],
    ['zh', '중국어'],
    ['es', '스페인어'],
  ];
  const LANG_NAME = Object.fromEntries(LANGS);

  // 곡 → [{id, name, lang, chordpro, files, isBase}] (기본 버전이 항상 맨 앞, id 0)
  function list(song) {
    if (!song) return [];
    const files = song.files || [];
    const base = {
      id: 0,
      name: song.chart_name || '',
      lang: song.chart_lang || '',
      chordpro: song.chordpro || '',
      files: files.filter((f) => !f.variant_id),
      isBase: true,
    };
    const extra = (song.variants || []).map((v) => ({
      id: v.id,
      name: v.name || '',
      lang: v.lang || '',
      chordpro: v.chordpro || '',
      files: files.filter((f) => f.variant_id === v.id),
      isBase: false,
    }));
    return [base, ...extra];
  }
  // 버전 번호 → 그 버전. 없는 번호면 기본 버전.
  function get(song, vid) {
    const all = list(song);
    return all.find((v) => v.id === (+vid || 0)) || all[0] || { id: 0, name: '', lang: '', chordpro: '', files: [], isBase: true };
  }
  // 이름표: 이름이 있으면 이름, 없으면 언어 이름, 그것도 없으면 기본/"버전 n"
  function label(v, idx) {
    if (!v) return '';
    if (v.name) return v.name;
    if (v.lang && LANG_NAME[v.lang]) return LANG_NAME[v.lang];
    return v.isBase ? '기본' : '버전' + (idx ? ' ' + idx : '');
  }
  // 같은 이름이 둘 이상이면 뒤에 번호를 붙여 구별한다
  function labels(song) {
    const all = list(song);
    const names = all.map((v, i) => label(v, i));
    return all.map((v, i) => {
      const dup = names.filter((n) => n === names[i]).length > 1;
      return { id: v.id, text: dup ? names[i] + ' ' + (i + 1) : names[i], lang: v.lang, isBase: v.isBase };
    });
  }
  // 곡 칸(it)이 쓰는 버전을 반영한 곡 — chordpro·files를 그 버전 것으로 바꾼 얕은 복사. 다른 칸은 그대로라 기존 코드가 그대로 쓴다.
  // 버전이 없거나 번호가 맞지 않으면 원래 곡을 그대로 돌려준다.
  // 기본 버전(0)이어도 이미지는 "기본 버전 것만" 남긴다(다른 버전의 이미지가 섞여 보이지 않게).
  function apply(song, it) {
    if (!song) return song;
    const vid = it && it.variant_id ? +it.variant_id : 0;
    const v = get(song, vid);
    if (v.id !== vid || !vid) {
      if (!(song.files || []).some((f) => f.variant_id)) return song; // 다른 버전 이미지가 없으면 그대로
      return Object.assign({}, song, { files: list(song)[0].files });
    }
    return Object.assign({}, song, { chordpro: v.chordpro, files: v.files, variant_id: v.id, variant_label: labels(song).find((x) => x.id === v.id).text });
  }
  // 송폼 한 칸(구간 이름 + 몇 번째로 나왔는지) → 쓸 버전 번호. 우선순위: "C#2"(그 번째만) → "C"(구간 이름 전체) → 곡 칸의 버전 → 0
  function pick(it, id, nth) {
    const map = (it && it.variant_map) || {};
    if (nth > 1 && Object.prototype.hasOwnProperty.call(map, id + '#' + nth)) return +map[id + '#' + nth] || 0;
    if (nth === 1 && Object.prototype.hasOwnProperty.call(map, id + '#1')) return +map[id + '#1'] || 0;
    if (Object.prototype.hasOwnProperty.call(map, id)) return +map[id] || 0;
    return it && it.variant_id ? +it.variant_id : 0;
  }
  const hasMap = (it) => !!it && !!it.variant_map && Object.keys(it.variant_map).length > 0;
  return { LANGS, LANG_NAME, list, get, label, labels, apply, pick, hasMap };
});
