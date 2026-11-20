// 試験用：操作記録を読みやすく書く補助。at は [録音ファイル番号, サンプル] で書くと、pos を自動で付ける。
export const RAWS = [
  { name: 'rec-000001', sampleRate: 48000, samples: 480000 },
  { name: 'rec-000002', sampleRate: 48000, samples: 480000 },
  { name: 'rec-000003', sampleRate: 44100, samples: 100000 },
];

export function posOf(raws, rawName, sample) {
  let base = 0;
  for (const r of [...raws].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (r.name === rawName) return base + sample;
    base += r.samples;
  }
  return sample;
}

/** list の各項目：[type, fields]。fields.at = [n, sample] → {raw:'rec-00000n', sample, pos}。toAt も同様 */
export function build(list, raws = RAWS) {
  const conv = (a) => (Array.isArray(a) ? { raw: `rec-${String(a[0]).padStart(6, '0')}`, sample: a[1], pos: posOf(raws, `rec-${String(a[0]).padStart(6, '0')}`, a[1]) } : a);
  return list.map(([type, fields = {}], seq) => {
    const e = { seq, eventId: `e${seq}`, type, wall: `2026-11-16T07:50:${String(seq % 60).padStart(2, '0')}.000Z`, mono: seq * 1000, ...fields };
    if (fields.at) e.at = conv(fields.at);
    if (fields.toAt) e.toAt = conv(fields.toAt);
    for (const k of ['from', 'to']) if (typeof fields[k] === 'number') e[k] = `rec-${String(fields[k]).padStart(6, '0')}`;
    return e;
  });
}

export const segView = (r) => r.segments.map((s) => [s.segmentId, s.raw, s.start, s.end, s.status, s.reason ?? null, s.order]);
export const takeView = (r) => r.takes.map((t) => [t.takeId, t.slideId, t.status, t.segments, t.samples, t.candidate]);
export const issueView = (r) => r.issues.map((i) => [i.code, i.seq]);
export const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
