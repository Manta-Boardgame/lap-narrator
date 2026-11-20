// 画面のための状態の追跡。操作記録（events）を seq の順にたどり、「今どのスライドか」「録音中か」
// 「OK 点はどこか」「撮り直しの戻り先」などを求める。
//
// これは画面の操作（撮り直しの戻り先の決定、取り消しの対象、再生する範囲）のためのもので、
// 区間・テイクの正式な計算（segments.json、完成した音声）は core/reduce.js の仕事。ここでは音声の
// 内容に触れず、通しの位置（pos）だけを扱う。同じ events から、いつも同じ状態になる。

export const UNDOABLE = new Set(['ok', 'retake', 'next-slide', 'goto-slide', 'mark']);

/** CONTRACTS.md 1.5 の 1：undo／redo を seq の順に処理して、無効な eventId の集合を作る。 */
export function computeInvalid(events) {
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const invalid = new Set();
  for (const ev of events) {
    if (ev.type === 'undo') {
      const target = byId.get(ev.target);
      if (target && UNDOABLE.has(target.type)) invalid.add(ev.target);
    } else if (ev.type === 'redo') {
      invalid.delete(ev.target);
    }
  }
  return invalid;
}

const numOf = (id, re) => { const m = re.exec(id || ''); return m ? Number(m[1]) : 0; };

/**
 * @param {any[]} events seq の昇順
 * @returns {Tracked}
 */
export function track(events) {
  const invalid = computeInvalid(events);
  const st = {
    sessionStart: null,
    slideId: null,
    take: null,
    takes: new Map(),
    recording: false,
    frag: null, // 開いている断片の始まりの通しの位置（録音中だけ）
    pending: [], // 最後の OK 点より後の、閉じた断片 [{start, end}]（通しの位置）
    durable: null, // 最後の durable の at
    unresolved: null, // recovered のあと、本人がまだ選んでいないときの at
    recoveredCount: 0,
    marks: [],
    nextTakeNo: 1,
    nextCheckpointNo: 1,
    nextSeq: 0,
    endPos: 0,
    lastRecStartSeq: -1,
    undoable: [],
    redoStack: [],
    invalid,
  };

  const closeFrag = (pos) => {
    if (st.frag !== null) {
      if (Number.isFinite(pos) && pos > st.frag) st.pending.push({ start: st.frag, end: pos });
      st.frag = null;
    }
  };
  const closeTake = () => {
    if (st.take) st.take.closed = true;
    st.take = null;
    st.pending = [];
    st.frag = null;
  };
  const commit = (ev, checkpointId) => {
    closeFrag(ev.at?.pos);
    if (st.take) {
      st.take.checkpoints.push({
        checkpointId,
        seq: ev.seq,
        pos: ev.at?.pos ?? 0,
        at: ev.at,
        pieces: st.pending,
      });
    }
    st.pending = [];
    st.frag = st.recording && ev.at ? ev.at.pos : null;
  };

  for (const ev of events) {
    st.nextSeq = ev.seq + 1;
    if (ev.at && Number.isFinite(ev.at.pos)) st.endPos = Math.max(st.endPos, ev.at.pos);
    if (ev.toAt && Number.isFinite(ev.toAt.pos)) st.endPos = Math.max(st.endPos, ev.toAt.pos);

    // 採番は、無効になった操作も含めて進める（番号を再利用しない）。
    if (ev.type === 'rec-start') st.nextTakeNo = Math.max(st.nextTakeNo, numOf(ev.takeId, /^t(\d+)$/) + 1);
    if (ev.type === 'ok' || ev.type === 'next-slide') st.nextCheckpointNo = Math.max(st.nextCheckpointNo, numOf(ev.checkpointId, /^c(\d+)$/) + 1);

    if (ev.type === 'undo') {
      const t = events.find((e) => e.eventId === ev.target);
      if (t && UNDOABLE.has(t.type)) st.redoStack.push(ev.target);
      continue;
    }
    if (ev.type === 'redo') {
      st.redoStack = st.redoStack.filter((id) => id !== ev.target);
      continue;
    }
    // 新しい操作（取り消せる種類、または録音の開始）は、やり直しの列を空にする。
    if (UNDOABLE.has(ev.type) || ev.type === 'rec-start') st.redoStack = [];
    if (invalid.has(ev.eventId)) continue;

    switch (ev.type) {
      case 'session-start':
        st.sessionStart = ev;
        break;
      case 'rec-start': {
        closeTake();
        const take = { takeId: ev.takeId, slideId: ev.slideId, checkpoints: [], closed: false, startSeq: ev.seq };
        st.take = take;
        st.takes.set(take.takeId, take);
        st.slideId = ev.slideId;
        st.recording = true;
        st.pending = [];
        st.frag = ev.at.pos;
        st.lastRecStartSeq = ev.seq;
        st.undoable = [];
        break;
      }
      case 'resume':
        st.recording = true;
        st.frag = ev.at.pos;
        break;
      case 'pause':
        closeFrag(ev.at?.pos);
        st.recording = false;
        break;
      case 'durable':
        st.durable = ev.at;
        break;
      case 'ok':
        commit(ev, ev.checkpointId);
        st.unresolved = null;
        st.undoable.push(ev);
        break;
      case 'next-slide':
        commit(ev, ev.checkpointId);
        closeTake();
        st.slideId = ev.nextSlideId;
        st.unresolved = null;
        st.undoable.push(ev);
        break;
      case 'goto-slide':
        closeTake();
        st.slideId = ev.slideId;
        st.unresolved = null;
        st.undoable.push(ev);
        break;
      case 'retake': {
        closeFrag(ev.at?.pos);
        if (st.take) {
          if (ev.toCheckpoint === null || ev.toCheckpoint === undefined) st.take.checkpoints = [];
          else {
            const i = st.take.checkpoints.findIndex((c) => c.checkpointId === ev.toCheckpoint);
            if (i >= 0) st.take.checkpoints = st.take.checkpoints.slice(0, i + 1);
          }
        }
        st.pending = [];
        st.frag = null;
        st.recording = false;
        st.unresolved = null;
        st.undoable.push(ev);
        break;
      }
      case 'recovered':
        closeFrag(ev.at?.pos);
        st.recording = false;
        st.unresolved = { at: ev.at, lastCheckpointId: ev.lastCheckpointId ?? null, seq: ev.seq };
        st.recoveredCount++;
        break;
      case 'mark':
        st.marks.push({ seq: ev.seq, slideId: st.slideId, pos: ev.at?.pos ?? null, note: ev.note });
        st.undoable.push(ev);
        break;
      default:
        break;
    }
  }
  return st;
}

/** 最後の OK 点より後に録った音声の長さ（サンプル数）。curPos は今の通しの位置。 */
export function pendingSamples(st, curPos) {
  let n = 0;
  for (const f of st.pending) n += f.end - f.start;
  if (st.frag !== null && Number.isFinite(curPos) && curPos > st.frag) n += curPos - st.frag;
  return n;
}

/** 開いているテイクの、採用した音声の長さ（サンプル数）。 */
export function keptSamples(take) {
  if (!take) return 0;
  let n = 0;
  for (const c of take.checkpoints) for (const p of c.pieces) n += p.end - p.start;
  return n;
}

/**
 * 確定した録音時間（サンプル数）：OK（保存点）までに採用された音声の合計。スライドごとに、採用するテイク
 * （チェックポイントのある最新のテイク）の分を足す。撮り直しで捨てた分と、最後の OK より後の分は含まない。
 * core/reduce.js の defaultTakes（既定の採用）の区間の合計と一致する（test/app/unit.test.js が確かめる）。
 */
export function confirmedSamples(st) {
  const latest = new Map();
  for (const t of st.takes.values()) {
    if (t.checkpoints.length === 0) continue;
    const cur = latest.get(t.slideId);
    if (!cur || t.startSeq > cur.startSeq) latest.set(t.slideId, t);
  }
  let n = 0;
  for (const t of latest.values()) n += keptSamples(t);
  return n;
}

/**
 * 撮り直しの戻り先（設計書 4.2）。最後の OK 点より後に録った音声があれば、最後の OK 点へ。
 * なければ（連続で押したとき）、さらに前の OK 点へ。OK 点がなくなれば null（テイクの最初）。
 * @returns {{ok:boolean, to?:string|null}}
 */
export function retakeTarget(st, curPos) {
  const take = st.take;
  if (!take) return { ok: false };
  const cps = take.checkpoints;
  if (pendingSamples(st, curPos) > 0) return { ok: true, to: cps.length ? cps[cps.length - 1].checkpointId : null };
  if (cps.length === 0) return { ok: false };
  return { ok: true, to: cps.length >= 2 ? cps[cps.length - 2].checkpointId : null };
}

export function lastCheckpoint(st) {
  const cps = st.take?.checkpoints;
  return cps && cps.length ? cps[cps.length - 1] : null;
}

export function undoTarget(st) { return st.undoable.length ? st.undoable[st.undoable.length - 1] : null; }
export function redoTarget(st) { return st.redoStack.length ? st.redoStack[st.redoStack.length - 1] : null; }

/** スライドごとの状態（未収録／収録済み／要確認）と、採用した長さ。 */
export function slideSummary(st, slideId) {
  let keptTake = null;
  for (const t of st.takes.values()) {
    if (t.slideId !== slideId || t.checkpoints.length === 0) continue;
    if (!keptTake || t.startSeq > keptTake.startSeq) keptTake = t;
  }
  const marked = st.marks.some((m) => m.slideId === slideId && !st.invalid.has(`e${m.seq}`));
  return {
    state: marked ? 'review' : keptTake ? 'done' : 'todo',
    takes: [...st.takes.values()].filter((t) => t.slideId === slideId && t.checkpoints.length > 0).length,
    keptSamples: keptTake ? keptSamples(keptTake) : 0,
  };
}
