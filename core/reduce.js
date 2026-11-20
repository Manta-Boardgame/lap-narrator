// 操作記録の解釈（CONTRACTS.md 1.5）。
// 純粋な関数：同じ入力から、いつも同じ出力（segmentId を含む）。時刻の値（wall、mono）は使わない。順序は seq だけで決める。
// 例外を投げない：問題は issues に出し、解釈できる範囲で出力を作る。

const UNDOABLE = new Set(['ok', 'retake', 'next-slide', 'goto-slide', 'mark']);
const pad = (n, w) => String(n).padStart(w, '0');

/** 録音ファイル名の正規化：ディレクトリと拡張子を取る（'raw/rec-000001.wav' → 'rec-000001'） */
function normRaw(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const validAt = (at) => at !== null && typeof at === 'object' && typeof at.raw === 'string' && isInt(at.sample) && at.sample >= 0;

/**
 * 操作記録を解釈して、区間・テイク・復旧の位置・問題の一覧を作る。規則は CONTRACTS.md 1.5。
 *
 * 戻り値は `segments.json`（1.6）の中身（`format`、`version`、`sessionId`、`segments`、`takes`、`defaultTakes`、`recoverable`、`marks`、`issues`）
 * に、状態 `state`（`slideId`、`takeId`、`recording`、`pending`、`durablePos`）を足したもの。`segments.json` に保存するときは `state` を除く。
 * `sessionId` は `session-start` の `sessionId`（無ければ `opts.sessionId`、それも無ければ null）。
 * `recoverable` の録音ファイル名の欄は、schema/segments と同じ `raw`（1.5 の本文の `rawFile` ではない）。
 *
 * 入力の扱い：
 * - `events` は seq で並べ直す（順序を入れ替えて渡しても同じ結果）。同じ seq が重なれば先のものだけを使い、`seq-gap` を出す。
 * - `rawFiles` の `name` は拡張子とディレクトリを付けてもよい（'rec-000001' に正規化する）。
 * - 必須の項目（位置 `at` など）が欠けた操作は、無視して `position-mismatch` を出す。
 * - `opts.closeAtEnd`（既定 true）：真のとき、記録の終わりで開いているテイクを閉じる（1.5 の 5）。
 *   偽にすると、開いたテイクと未確定の断片を `state` にそのまま残す（録音中の画面用。区間は作らない）。
 *
 * 細部は CONTRACTS.md 7.1 に従う。7.1 が決めていない扱い（このコードの選択）：
 * - `pause` は、録音中のときだけ終わりを伸ばす（二重の `pause` で、一時停止中の音を取り込まないため）。
 * - 不正なイベント（`retake` に `toCheckpoint` のキーが無い、`eventId` が `e<seq>` と違う、`seq` が整数でない）は `bad-event` を出して無視する（7.7 の 7）。
 * - `orphan-audio` は `next-slide` ごと（7.7 の 5）。`recovered` の切り詰めは 7.7 の 1、2。`resume` は 7.7 の 3。
 * - 必須の位置 `at` が無い操作、`takeId` が無い `rec-start` は無視して `position-mismatch` を出す。
 * - 同じ seq が重なれば先のものだけを使い `seq-gap` を出す。
 * - `marks` の `at` の録音ファイル名は拡張子なしに正規化する。
 *
 * @param {import('./types.js').LapEvent[]} events
 * @param {import('./types.js').RawInfo[]} rawFiles
 * @param {{sessionId?: string, closeAtEnd?: boolean, trackFileRotations?: boolean}} [opts]
 * @returns {import('./types.js').ReduceResult & {format:string, version:number, sessionId:string|null, state:{slideId:string|null, takeId:string|null, recording:boolean, pending:{raw:string,start:number,end:number}[], durablePos:number|null}}}
 */
export function reduceEvents(events, rawFiles, opts) {
  const closeAtEnd = !(opts && opts.closeAtEnd === false);
  /** @type {{code:string, seq?:number, message:string}[]} */
  const issues = [];
  const issue = (code, seq, message) => { issues.push(seq === undefined ? { code, message } : { code, seq, message }); };

  // ---- 入力の整理
  const rawInfo = new Map();
  const rawNames = [];
  if (Array.isArray(rawFiles)) {
    for (const r of rawFiles) {
      if (!r || typeof r !== 'object') continue;
      const name = normRaw(r.name ?? r.file);
      if (!name || rawInfo.has(name)) continue;
      rawInfo.set(name, { samples: isInt(r.samples) ? r.samples : null, sampleRate: isInt(r.sampleRate) && r.sampleRate > 0 ? r.sampleRate : null });
      rawNames.push(name);
    }
  }
  rawNames.sort();
  const prefix = new Map(); // 録音ファイルの前までのサンプル数の合計
  {
    let acc = 0;
    let known = true;
    for (const n of rawNames) {
      prefix.set(n, known ? acc : null);
      const s = rawInfo.get(n).samples;
      if (s === null) known = false; else acc += s;
    }
  }

  const sorted = (Array.isArray(events) ? events : [])
    .filter((e) => {
      if (e && typeof e === 'object' && isInt(e.seq) && e.seq >= 0) return true;
      // seq が整数でない（または負）→ bad-event。無視する（7.7 の 7）
      issue('bad-event', e && typeof e === 'object' && typeof e.seq === 'number' && Number.isFinite(e.seq) ? e.seq : undefined, 'seq is not a non-negative integer; event ignored');
      return false;
    })
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.seq - b.e.seq) || (a.i - b.i))
    .map((x) => x.e);
  /** @type {any[]} */
  const evs = [];
  {
    let expected = 0;
    let prev = -1;
    for (const e of sorted) {
      if (e.seq === prev) { issue('seq-gap', e.seq, `duplicate seq ${e.seq} ignored`); continue; }
      if (e.seq !== expected) issue('seq-gap', e.seq, `seq jumps from ${expected} to ${e.seq}`);
      expected = e.seq + 1;
      prev = e.seq;
      evs.push(e);
    }
  }
  const idOf = (e) => `e${e.seq}`;
  // eventId が e<seq> と一致しない（無い）イベントは bad-event。無視する（7.7 の 7）。seq の連なりには数える
  const badEvents = new Set();
  for (const e of evs) {
    if (e.eventId !== `e${e.seq}`) {
      badEvents.add(e);
      issue('bad-event', e.seq, `eventId ${JSON.stringify(e.eventId)} is not "e${e.seq}"; event ignored`);
    }
  }
  const byId = new Map();
  for (const e of evs) if (!badEvents.has(e)) byId.set(idOf(e), e);

  // ---- 1. 取り消し
  const invalid = new Set();
  for (const e of evs) {
    if (badEvents.has(e)) continue;
    if (e.type !== 'undo' && e.type !== 'redo') continue;
    const target = typeof e.target === 'string' ? byId.get(e.target) : undefined;
    if (!target || !UNDOABLE.has(target.type) || target.seq >= e.seq) {
      issue('bad-undo-target', e.seq, `${e.type} target ${JSON.stringify(e.target)} cannot be ${e.type === 'undo' ? 'undone' : 'redone'}`);
      continue;
    }
    if (e.type === 'undo') invalid.add(idOf(target)); else invalid.delete(idOf(target));
  }

  // ---- 状態
  let sessionId = typeof (opts && opts.sessionId) === 'string' ? opts.sessionId : null;
  let sessionSeen = false;
  let slideId = null;
  let take = null;
  let recording = false;
  /** @type {{raw:string,start:number,end:number,uncommitted:boolean,rotationFrom?:{raw:string,end:number}}[]} */
  let pending = [];
  let durablePos = null;
  let durableAt = null;
  const orphans = []; // 録音中のまま通り過ぎた next-slide の印 {seq, pos}（next-slide ごと。7.7 の 5）
  let lastValidSeq = -1;
  let segCounter = 0;
  const segments = [];
  const takesInternal = [];
  const marks = [];

  const newPiece = (raw, start, end) => ({ raw, start, end, uncommitted: false });

  function makeSegment(tk, p, status, reason) {
    if (!(p.end > p.start)) return null; // 長さ 0 の断片は捨てる
    const info = rawInfo.get(p.raw);
    const seg = { segmentId: `g${pad(++segCounter, 5)}`, takeId: tk.takeId, slideId: tk.slideId, raw: p.raw, start: p.start, end: p.end,
      ...(p.rotationFrom ? { rotationFrom: p.rotationFrom } : {}) };
    if (info && info.sampleRate) { seg.startSec = p.start / info.sampleRate; seg.endSec = p.end / info.sampleRate; }
    seg.status = status;
    if (reason !== undefined) seg.reason = reason;
    seg.order = null;
    segments.push(seg);
    return seg;
  }

  function discard(segs, reason) {
    for (const s of segs) { s.status = 'discarded'; s.reason = reason; s.order = null; }
  }

  /** 最後の断片の終わりを at.sample まで伸ばす */
  function extendLast(seq, at) {
    if (!pending.length || !validAt(at)) return;
    const last = pending[pending.length - 1];
    if (last.raw !== at.raw) return; // 同じ録音ファイルの最後の断片だけを伸ばす（7.1 の 9）
    if (at.sample > last.end) last.end = at.sample;
  }

  function closeTake(seq) {
    if (!take) return;
    for (const p of pending) {
      if (p.uncommitted) makeSegment(take, p, 'uncommitted', 'uncommitted-after-recovery');
      else makeSegment(take, p, 'discarded', 'abandoned');
    }
    take.status = 'closed';
    take.endSeq = seq;
    take = null;
    pending = [];
  }

  function commitCheckpoint(seq, checkpointId, at) {
    const id = typeof checkpointId === 'string' ? checkpointId : `c${pad(take.checkpoints.length + 1, 4)}`;
    const segs = [];
    for (const p of pending) {
      const s = makeSegment(take, p, 'kept');
      if (s) segs.push(s);
    }
    take.checkpoints.push({ checkpointId: id, seq, segs, at });
    pending = recording ? [newPiece(at.raw, at.sample, at.sample)] : [];
  }

  /** 位置の検査（unknown-raw、beyond-raw-length、position-mismatch） */
  function checkAt(seq, at, label) {
    if (!at || typeof at !== 'object') return;
    const raw = normRaw(at.raw);
    const info = rawInfo.get(raw);
    if (!info) { issue('unknown-raw', seq, `${label}: raw file ${JSON.stringify(at.raw)} is not in rawFiles`); return; }
    if (info.samples !== null && isInt(at.sample) && at.sample > info.samples) {
      issue('beyond-raw-length', seq, `${label}: sample ${at.sample} is beyond ${raw} (${info.samples} samples)`);
    }
    const base = prefix.get(raw);
    if (base !== null && base !== undefined && isInt(at.sample) && isInt(at.pos) && at.pos !== base + at.sample) {
      issue('position-mismatch', seq, `${label}: pos ${at.pos} != ${base} + ${at.sample}`);
    }
  }

  // ---- 3. 各イベントの処理
  let lastSeq = -1;
  for (const e of evs) {
    lastSeq = e.seq;
    if (badEvents.has(e)) continue;
    if (e.type === 'undo' || e.type === 'redo') continue;
    if (invalid.has(idOf(e))) continue;
    const seq = e.seq;
    if (e.type === 'retake' && !(Object.prototype.hasOwnProperty.call(e, 'toCheckpoint') && (e.toCheckpoint === null || typeof e.toCheckpoint === 'string'))) {
      issue('bad-event', seq, 'retake without toCheckpoint (null or a checkpointId); event ignored');
      continue;
    }
    lastValidSeq = seq;
    const needsAt = ['rec-start', 'file-rotate', 'durable', 'ok', 'retake', 'next-slide', 'pause', 'resume', 'recovered', 'mark'];
    if (needsAt.includes(e.type)) {
      if (!validAt(e.at)) {
        if (e.type !== 'mark' && e.type !== 'file-rotate') {
          issue('position-mismatch', seq, `${e.type}: missing or invalid position "at"; event ignored`);
          continue;
        }
        if (e.type === 'file-rotate') {
          issue('position-mismatch', seq, 'file-rotate: missing or invalid position "at"');
        }
      } else {
        checkAt(seq, e.at, e.type);
      }
    }
    // orphan-audio：録音中のまま通り過ぎた next-slide ごとに、次の「状態を変えるイベント」（next-slide は数えない）の位置が
    // その next-slide より先なら、その next-slide の seq で 1 件出す。位置を持たない goto-slide が次なら出さない
    if (orphans.length && ['rec-start', 'pause', 'retake', 'goto-slide', 'recovered'].includes(e.type)) {
      if (e.type !== 'goto-slide' && validAt(e.at) && isInt(e.at.pos)) {
        for (const o of orphans) if (e.at.pos > o.pos) issue('orphan-audio', o.seq, 'next-slide while recording: audio was recorded that belongs to no take');
      }
      orphans.length = 0;
    }
    switch (e.type) {
      case 'session-start': {
        if (!sessionSeen) { sessionSeen = true; if (typeof e.sessionId === 'string') sessionId = e.sessionId; }
        break;
      }
      case 'rec-start': {
        if (typeof e.takeId !== 'string') { issue('position-mismatch', seq, 'rec-start: takeId is missing; event ignored'); break; }
        closeTake(seq);
        const sid = typeof e.slideId === 'string' ? e.slideId : slideId;
        take = { takeId: e.takeId, slideId: sid, status: 'open', startSeq: seq, endSeq: null, checkpoints: [] };
        takesInternal.push(take);
        slideId = sid;
        recording = true;
        pending = [newPiece(normRaw(e.at.raw), e.at.sample, e.at.sample)];
        break;
      }
      case 'file-rotate': {
        const to = normRaw(typeof e.to === 'string' ? e.to : e.toAt && e.toAt.raw);
        if (e.toAt) checkAt(seq, e.toAt, 'file-rotate toAt');
        for (const k of ['from', 'to']) {
          if (typeof e[k] === 'string' && !rawInfo.has(normRaw(e[k]))) issue('unknown-raw', seq, `file-rotate ${k}: raw file ${JSON.stringify(e[k])} is not in rawFiles`);
        }
        if (recording && pending.length) {
          const at = e.at && { ...e.at, raw: normRaw(e.at.raw) };
          extendLast(seq, at);
          if (to) {
            const last = pending[pending.length - 1];
            const next = newPiece(to, 0, 0);
            if (opts?.trackFileRotations && at && at.raw === last.raw && at.raw !== to &&
                normRaw(e.from) === at.raw && rawInfo.get(at.raw)?.samples === at.sample &&
                last.end === at.sample && validAt(e.toAt) && normRaw(e.toAt.raw) === to && e.toAt.sample === 0 &&
                isInt(at.pos) && at.pos === e.toAt.pos && prefix.get(to) === at.pos) {
              pending.push({ ...next, rotationFrom: { raw: at.raw, end: at.sample } });
            } else pending.push(next);
          }
        }
        break;
      }
      case 'durable': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        if (recording && pending.length && pending[pending.length - 1].raw === at.raw && at.sample > pending[pending.length - 1].end) {
          pending[pending.length - 1].end = at.sample;
        }
        if (isInt(at.pos) && (durablePos === null || at.pos > durablePos)) { durablePos = at.pos; durableAt = at; }
        break;
      }
      case 'ok': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        if (!take) break; // 開いているテイクが無いときは何もしない
        extendLast(seq, at);
        commitCheckpoint(seq, e.checkpointId, at);
        break;
      }
      case 'pause': {
        if (recording) extendLast(seq, { ...e.at, raw: normRaw(e.at.raw) });
        recording = false;
        break;
      }
      case 'resume': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        recording = true; // recording の真偽によらず、新しい断片を足す。前の断片は伸ばさない（7.7 の 3）
        const last = pending[pending.length - 1];
        const piece = newPiece(at.raw, at.sample, at.sample);
        if (last && last.end === last.start) pending[pending.length - 1] = piece; else pending.push(piece);
        break;
      }
      case 'retake': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        extendLast(seq, at);
        if (take) {
          for (const p of pending) makeSegment(take, p, 'discarded', 'retake');
          let removed = [];
          const to = e.toCheckpoint; // null か文字列（上で確かめた）
          if (to === null) {
            removed = take.checkpoints.splice(0);
          } else {
            const idx = take.checkpoints.findIndex((c) => c.checkpointId === to);
            if (idx >= 0) removed = take.checkpoints.splice(idx + 1); // 見つからなければ、待ち行列だけ捨てる（7.1 の 9）
          }
          for (const c of removed) discard(c.segs, 'retake');
        }
        recording = false;
        pending = [];
        break;
      }
      case 'next-slide': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        if (take) {
          extendLast(seq, at);
          commitCheckpoint(seq, e.checkpointId, at);
          closeTake(seq);
        } else {
          pending = [];
        }
        if (typeof e.nextSlideId === 'string') slideId = e.nextSlideId;
        if (recording) orphans.push({ seq, pos: at.pos });
        break;
      }
      case 'goto-slide': {
        if (recording) issue('goto-while-recording', seq, 'goto-slide while recording');
        closeTake(seq);
        pending = [];
        if (typeof e.slideId === 'string') slideId = e.slideId;
        break;
      }
      case 'recovered': {
        const at = { ...e.at, raw: normRaw(e.at.raw) };
        // 同じ録音ファイル（at.raw）の断片は終わりを min(終わり, at.sample) に切り詰め、長さ 0 になれば捨てる。
        // 後ろの録音ファイルの断片は捨てる。前の録音ファイルの断片は変えない（7.7 の 1）。断片の録音ファイルが違っても問題にしない（7.7 の 2）
        pending = pending.filter((p) => {
          if (p.raw > at.raw) return false;
          if (p.raw === at.raw) { p.end = Math.min(p.end, at.sample); return p.end > p.start; }
          return true;
        });
        for (const p of pending) p.uncommitted = true;
        recording = false;
        break;
      }
      case 'mark': {
        const m = { seq };
        if (validAt(e.at)) m.at = { raw: normRaw(e.at.raw), sample: e.at.sample, pos: e.at.pos };
        if (typeof e.note === 'string') m.note = e.note;
        marks.push(m);
        break;
      }
      default:
        break; // test-rec、export、未知の種類：解釈に影響しない
    }
  }

  // ---- 5. セッションの終わり
  if (closeAtEnd) closeTake(lastValidSeq);
  if (recording) for (const o of orphans) issue('orphan-audio', o.seq, 'next-slide while recording and no event followed: audio belongs to no take');

  // ---- 6〜8. 区間の順番、テイク、既定の採用
  const takes = [];
  const defaultTakes = {};
  let lastCp = null;
  for (const tk of takesInternal) {
    let order = 0;
    let samples = 0;
    const ids = [];
    for (const cp of tk.checkpoints) {
      if (lastCp === null || cp.seq > lastCp.seq) lastCp = cp;
      for (const s of cp.segs) {
        s.order = ++order;
        samples += s.end - s.start;
        ids.push(s.segmentId);
      }
    }
    const candidate = tk.status === 'closed' && ids.length > 0;
    takes.push({ takeId: tk.takeId, slideId: tk.slideId, status: tk.status, startSeq: tk.startSeq, endSeq: tk.endSeq, segments: ids, samples, candidate });
    if (candidate) defaultTakes[tk.slideId] = tk.takeId; // startSeq 昇順なので、後のものが最大
  }

  // ---- 9. 復旧の表示用
  const lastCheckpointId = lastCp ? lastCp.checkpointId : null;
  const lastAt = lastCp && lastCp.at && isInt(lastCp.at.pos) ? lastCp.at : null;
  let recoverable = null;
  if (durableAt) recoverable = { pos: durablePos, raw: durableAt.raw, sample: durableAt.sample, lastCheckpointId };
  else if (lastAt) recoverable = { pos: lastAt.pos, raw: lastAt.raw, sample: lastAt.sample, lastCheckpointId };

  // 問題は seq の順（同じ seq の中では出した順）に並べる
  const issuesSorted = issues
    .map((x, i) => ({ x, i }))
    .sort((a, b) => ((a.x.seq ?? -1) - (b.x.seq ?? -1)) || (a.i - b.i))
    .map((o) => o.x);

  return {
    format: 'lap-narrator/segments',
    version: 1,
    sessionId,
    segments,
    takes,
    defaultTakes,
    recoverable,
    marks,
    issues: issuesSorted,
    state: {
      slideId,
      takeId: take ? take.takeId : null,
      recording,
      pending: pending.map((p) => ({ raw: p.raw, start: p.start, end: p.end })),
      durablePos,
    },
  };
}
