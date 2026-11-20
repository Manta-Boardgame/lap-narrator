// 操作記録の解釈（reduce）の、正解を出す別実装。
//
// dev/CONTRACTS.md 1.5 を、上から 1 行ずつ読んで素直に実装した、単純で遅くてよいもの。
// core/ は読まない、呼ばない。曖昧な点の自分の読み方は、dev/proposals/E-001.md に書いてある。
//
// oracleReduce(events, rawFiles, opts?) → ReduceResult（segments.json の中身）
//   events   : seq の昇順の操作記録（events.jsonl の各行）
//   rawFiles : [{name:'rec-000001', sampleRate, samples, durableSamples}]
//   opts     : {sessionId?}  session-start がなければ使う

const UNDOABLE = new Set(['ok', 'retake', 'next-slide', 'goto-slide', 'mark']);

const rawNumber = (name) => parseInt(String(name).slice(4), 10);
const pad5 = (n) => 'g' + String(n).padStart(5, '0');

export function oracleReduce(events0, rawFiles, opts = {}) {
  const issues = [];

  // ---- 不正なイベント（CONTRACTS.md 7.7 の 7）：課題コード bad-event を出して、そのイベントを無視する ----
  // seq が整数でない、eventId が e<seq> と違う、retake に toCheckpoint のキーがない。
  // seq が整数でないときの課題の seq は、イベントの並びの番号を使う。
  const events = [];
  events0.forEach((ev, i) => {
    let why = null;
    if (!Number.isInteger(ev.seq)) why = 'seq is not an integer';
    else if (ev.eventId !== 'e' + ev.seq) why = `eventId ${ev.eventId} does not match e${ev.seq}`;
    else if (ev.type === 'retake' && !Object.prototype.hasOwnProperty.call(ev, 'toCheckpoint')) why = 'retake has no toCheckpoint key';
    if (why) issues.push({ code: 'bad-event', seq: Number.isInteger(ev.seq) ? ev.seq : i, message: why });
    else events.push(ev);
  });
  const rawByName = new Map(rawFiles.map((f) => [f.name, f]));

  /** raw の番号が小さいファイルの samples の合計（CONTRACTS.md 1.4） */
  const offsetOf = (name) => {
    const n = rawNumber(name);
    let sum = 0;
    for (const f of rawFiles) if (rawNumber(f.name) < n) sum += f.samples;
    return sum;
  };

  // ---- seq の欠番（問題の報告 10）----
  {
    let next = 0;
    for (const ev of events0.filter((e) => Number.isInteger(e.seq))) {
      if (ev.seq !== next) issues.push({ code: 'seq-gap', seq: ev.seq, message: `seq jumps from ${next - 1} to ${ev.seq}` });
      next = ev.seq + 1;
    }
  }

  // ---- 規則 1：取り消し ----
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const invalid = new Set();
  for (const ev of events) {
    if (ev.type !== 'undo' && ev.type !== 'redo') continue;
    const target = byId.get(ev.target);
    if (!target || !UNDOABLE.has(target.type) || target.seq >= ev.seq) {
      issues.push({ code: 'bad-undo-target', seq: ev.seq, message: `${ev.type} target ${ev.target} is not an earlier undoable event` });
      continue;
    }
    if (ev.type === 'undo') invalid.add(target.eventId);
    else invalid.delete(target.eventId);
  }
  const live = events.filter((e) => e.type !== 'undo' && e.type !== 'redo' && !invalid.has(e.eventId));

  // ---- 位置の検査（問題の報告 10）。存在するイベントだけを調べる ----
  const checkAt = (ev, at) => {
    const f = rawByName.get(at.raw);
    if (!f) {
      issues.push({ code: 'unknown-raw', seq: ev.seq, message: `${at.raw} is not in rawFiles` });
      return;
    }
    if (at.sample > f.samples) issues.push({ code: 'beyond-raw-length', seq: ev.seq, message: `sample ${at.sample} is beyond ${at.raw} length ${f.samples}` });
    const want = offsetOf(at.raw) + at.sample;
    if (at.pos !== want) issues.push({ code: 'position-mismatch', seq: ev.seq, message: `pos ${at.pos} does not match ${at.raw} sample ${at.sample} (expected ${want})` });
  };
  for (const ev of live) {
    if (ev.at) checkAt(ev, ev.at);
    if (ev.toAt) checkAt(ev, ev.toAt);
  }

  // ---- 規則 2：状態 ----
  let slideId = null;
  let take = null; // 開いているテイク
  let recording = false;
  let pending = []; // 断片 {raw, start, end, recovered}
  let durablePos = null;
  let durableAt = null;
  let nextSegNo = 1;
  const takes = []; // 作った順
  const allSegments = []; // 作った順（segmentId の順）
  const marks = [];
  let orphans = []; // recording が真のまま next-slide した位置 [{seq, pos}]。次の「状態を変えるイベント」で、next-slide ごとに判定する（CONTRACTS.md 1.5、7 章、7.7 の 5）
  void slideId;

  const newPiece = (raw, sample) => ({ raw, start: sample, end: sample, recovered: false });

  /** 断片から区間を作る。長さ 0 の断片は捨てる（規則 6）。 */
  const makeSegment = (t, piece, status, reason) => {
    if (piece.end - piece.start <= 0) return null;
    const seg = { segmentId: pad5(nextSegNo++), takeId: t.takeId, slideId: t.slideId, raw: piece.raw, start: piece.start, end: piece.end, status, reason };
    allSegments.push(seg);
    return seg;
  };

  /** 最後の断片の終わりを at.sample まで伸ばす（同じ録音ファイルのときだけ。縮めない） */
  const extendLast = (at) => {
    const last = pending[pending.length - 1];
    if (last && last.raw === at.raw) last.end = Math.max(last.end, at.sample);
  };

  /** 規則 4：閉じる */
  const closeTake = (seq) => {
    for (const piece of pending) {
      if (piece.recovered) makeSegment(take, piece, 'uncommitted', 'uncommitted-after-recovery');
      else makeSegment(take, piece, 'discarded', 'abandoned');
    }
    pending = [];
    take.status = 'closed';
    take.endSeq = seq;
    take = null;
  };

  /** ok と同じ処理（ok と next-slide が使う） */
  const doOk = (ev) => {
    if (!take) return;
    extendLast(ev.at);
    const cp = { checkpointId: ev.checkpointId, eventSeq: ev.seq, at: ev.at, segs: [] };
    for (const piece of pending) {
      const seg = makeSegment(take, piece, 'kept', undefined);
      if (seg) cp.segs.push(seg);
    }
    take.checkpoints.push(cp);
    pending = recording ? [newPiece(ev.at.raw, ev.at.sample)] : [];
  };

  // ---- 規則 3：各イベントの処理 ----
  let lastSeq = -1;
  for (const ev of live) {
    lastSeq = ev.seq;
    if (orphans.length && ['rec-start', 'pause', 'retake', 'goto-slide', 'recovered'].includes(ev.type)) {
      // 位置を持たない goto-slide は出さない。ほかは pos が大きいときだけ、next-slide ごとに出す。next-slide は数えない
      for (const o of orphans) {
        if (ev.at && ev.at.pos > o.pos) issues.push({ code: 'orphan-audio', seq: o.seq, message: 'recording continued after next-slide' });
      }
      orphans = [];
    }
    switch (ev.type) {
      case 'rec-start': {
        if (take) closeTake(ev.seq);
        take = { takeId: ev.takeId, slideId: ev.slideId, status: 'open', startSeq: ev.seq, endSeq: null, checkpoints: [] };
        takes.push(take);
        recording = true;
        pending = [newPiece(ev.at.raw, ev.at.sample)];
        slideId = ev.slideId;
        break;
      }
      case 'file-rotate': {
        if (!recording || pending.length === 0) break;
        const last = pending[pending.length - 1];
        if (last.raw === ev.at.raw) last.end = ev.at.sample;
        pending.push(newPiece(ev.to, 0));
        break;
      }
      case 'durable': {
        if (durablePos === null || ev.at.pos > durablePos) {
          durablePos = ev.at.pos;
          durableAt = { raw: ev.at.raw, sample: ev.at.sample };
        }
        if (recording) extendLast(ev.at);
        break;
      }
      case 'ok': {
        doOk(ev);
        break;
      }
      case 'pause': {
        extendLast(ev.at);
        recording = false;
        break;
      }
      case 'resume': {
        recording = true;
        if (!take) break;
        const last = pending[pending.length - 1];
        const piece = newPiece(ev.at.raw, ev.at.sample);
        if (last && last.end - last.start === 0) pending[pending.length - 1] = piece;
        else pending.push(piece);
        break;
      }
      case 'retake': {
        if (!take) break;
        extendLast(ev.at);
        for (const piece of pending) makeSegment(take, piece, 'discarded', 'retake');
        let removed = [];
        if (ev.toCheckpoint === null) {
          removed = take.checkpoints;
          take.checkpoints = [];
        } else {
          const idx = take.checkpoints.findIndex((c) => c.checkpointId === ev.toCheckpoint);
          if (idx >= 0) removed = take.checkpoints.splice(idx + 1);
        }
        for (const cp of removed) {
          for (const seg of cp.segs) {
            seg.status = 'discarded';
            seg.reason = 'retake';
          }
        }
        recording = false;
        pending = [];
        break;
      }
      case 'next-slide': {
        if (take) {
          doOk(ev);
          closeTake(ev.seq);
        }
        slideId = ev.nextSlideId;
        take = null;
        pending = [];
        if (recording) orphans.push({ seq: ev.seq, pos: ev.at.pos });
        break;
      }
      case 'goto-slide': {
        if (recording) issues.push({ code: 'goto-while-recording', seq: ev.seq, message: 'goto-slide while recording' });
        if (take) closeTake(ev.seq);
        slideId = ev.slideId;
        pending = [];
        break;
      }
      case 'recovered': {
        if (take) {
          const kept = [];
          for (const piece of pending) {
            if (rawNumber(piece.raw) > rawNumber(ev.at.raw)) continue; // 復旧できた位置より後の録音ファイル
            if (piece.raw === ev.at.raw) piece.end = Math.max(piece.start, Math.min(piece.end, ev.at.sample));
            piece.recovered = true;
            kept.push(piece);
          }
          pending = kept;
        }
        recording = false;
        break;
      }
      case 'mark': {
        const m = { seq: ev.seq, at: ev.at };
        if (ev.note !== undefined) m.note = ev.note;
        marks.push(m);
        break;
      }
      default:
        break; // session-start、test-rec、export は解釈に影響しない
    }
  }

  // イベントがもう無く、recording が真のままなら出す
  for (const o of orphans) issues.push({ code: 'orphan-audio', seq: o.seq, message: 'recording continued after next-slide until the end' });

  // ---- 規則 5：セッションの終わり ----
  if (take) closeTake(lastSeq);

  // ---- 規則 6、7：区間の order、テイク ----
  const orderOf = new Map(); // segmentId → order
  const takesOut = takes.map((t) => {
    const kept = [];
    for (const cp of t.checkpoints) for (const seg of cp.segs) kept.push(seg);
    kept.forEach((seg, i) => orderOf.set(seg.segmentId, i + 1));
    const samples = kept.reduce((s, seg) => s + (seg.end - seg.start), 0);
    return {
      takeId: t.takeId,
      slideId: t.slideId,
      status: t.status,
      startSeq: t.startSeq,
      endSeq: t.endSeq,
      segments: kept.map((s) => s.segmentId),
      samples,
      candidate: t.status === 'closed' && kept.length >= 1,
    };
  });

  const segmentsOut = allSegments.map((seg) => {
    const o = { segmentId: seg.segmentId, takeId: seg.takeId, slideId: seg.slideId, raw: seg.raw, start: seg.start, end: seg.end };
    const f = rawByName.get(seg.raw);
    if (f) {
      o.startSec = seg.start / f.sampleRate;
      o.endSec = seg.end / f.sampleRate;
    }
    o.status = seg.status;
    if (seg.reason !== undefined) o.reason = seg.reason;
    o.order = seg.status === 'kept' ? orderOf.get(seg.segmentId) : null;
    return o;
  });

  // ---- 規則 8：既定の採用 ----
  const defaultTakes = {};
  {
    const best = new Map(); // slideId → takeOut
    for (const t of takesOut) {
      if (!t.candidate) continue;
      const cur = best.get(t.slideId);
      if (!cur || t.startSeq > cur.startSeq) best.set(t.slideId, t);
    }
    for (const [s, t] of best) defaultTakes[s] = t.takeId;
  }

  // ---- 規則 9：復旧の表示用 ----
  let lastCp = null; // 取り除かれずに残っているチェックポイントのうち eventSeq が最大のもの
  for (const t of takes) for (const cp of t.checkpoints) if (!lastCp || cp.eventSeq > lastCp.eventSeq) lastCp = cp;
  let recoverable = null;
  if (durablePos !== null) {
    recoverable = { pos: durablePos, raw: durableAt.raw, sample: durableAt.sample, lastCheckpointId: lastCp ? lastCp.checkpointId : null };
  } else if (lastCp) {
    recoverable = { pos: lastCp.at.pos, raw: lastCp.at.raw, sample: lastCp.at.sample, lastCheckpointId: lastCp.checkpointId };
  }

  // 問題は seq の順、同じ seq なら見つけた順に並べる
  const sortedIssues = issues.map((x, i) => ({ x, i })).sort((a, b) => a.x.seq - b.x.seq || a.i - b.i).map((o) => o.x);

  const first = events.find((e) => e.type === 'session-start');
  return {
    format: 'lap-narrator/segments',
    version: 1,
    sessionId: first?.sessionId ?? opts.sessionId ?? '',
    segments: segmentsOut,
    takes: takesOut,
    defaultTakes,
    recoverable,
    marks,
    issues: sortedIssues,
  };
}
