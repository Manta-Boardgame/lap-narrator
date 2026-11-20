// split-takes：破棄した区間も含め、区間ごとの WAV に切り出す（設計書 5.1、CONTRACTS.md 3.2）。
//   narrate split-takes --session <id> --out <dir> --workspace <dir>
// 区間は、セッションの events.jsonl から core の reduceEvents で求める（segments.json と食い違ったら events.jsonl が正）。
// ファイル名：<segmentId>_<slideId>_<takeId>_<status>.wav（status は kept／discarded／uncommitted）。音は元の録音のまま（フェードなどはかけない）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { wavHeader, parseWavHeader, createSha256 } from '../../core/index.js';
import { CliError, usageError } from '../lib/errors.js';
import { createFsStore } from '../lib/store.js';
import { openAtomicWrite } from '../lib/fsutil.js';
import { analyzeSession, loadSessions } from '../lib/workspace.js';
import { requireOption } from '../lib/args.js';
import { secOf } from '../lib/output.js';

export const options = { session: 'string', out: 'string' };

const CHUNK_SAMPLES = 1 << 18;

export async function run({ ctx, opts, workspace }) {
  if (!workspace) throw usageError('--workspace is required');
  const sessionId = requireOption(opts, 'session');
  const outDir = path.resolve(requireOption(opts, 'out'));
  const store = createFsStore(workspace);
  const sess = (await loadSessions(store)).find((s) => s.sessionId === sessionId);
  if (!sess) throw new CliError('no-such-session', `no such session: ${sessionId}`, { detail: { sessions: (await loadSessions(store)).map((s) => s.sessionId) } });
  const an = await analyzeSession(store, sess);
  if (!an.reduce) throw new CliError('no-recording', `session ${sessionId} has no full recording (only finished audio); there are no takes to split`);
  await fsp.mkdir(outDir, { recursive: true });

  const readers = new Map();
  const reader = async (raw) => {
    let h = readers.get(raw);
    if (!h) {
      const p = `${an.sdir}raw/${raw}.wav`;
      if (!(await store.exists(p))) return null;
      const r = await store.openRead(p);
      const info = parseWavHeader(await r.read(0, Math.min(r.size, 4096)));
      h = { r, offset: info.dataOffset, sampleRate: info.sampleRate, samples: Math.min(info.samples, Math.floor((r.size - info.dataOffset) / 2)) };
      readers.set(raw, h);
    }
    return h;
  };

  const segs = an.reduce.segments;
  const files = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    ctx.progress('split-takes', i, segs.length);
    const h = await reader(s.raw);
    if (!h) { ctx.warn('raw-missing', `segment ${s.segmentId}: the recording ${s.raw} is not in the workspace`, { segmentId: s.segmentId }); continue; }
    const start = Math.min(s.start, h.samples);
    const end = Math.min(s.end, h.samples);
    if (end <= start) { ctx.warn('segment-empty', `segment ${s.segmentId} lies outside ${s.raw} (${s.start}-${s.end}); skipped`, { segmentId: s.segmentId }); continue; }
    if (end !== s.end) ctx.warn('segment-clipped', `segment ${s.segmentId} was cut at the end of ${s.raw}`, { segmentId: s.segmentId });
    const name = `${s.segmentId}_${s.slideId}_${s.takeId}_${s.status}.wav`;
    const w = await openAtomicWrite(path.join(outDir, name));
    const hash = createSha256();
    try {
      const head = wavHeader({ sampleRate: h.sampleRate, samples: end - start });
      hash.update(head);
      await w.write(head);
      for (let o = start; o < end; o += CHUNK_SAMPLES) {
        const e = Math.min(end, o + CHUNK_SAMPLES);
        const u8 = await h.r.read(h.offset + o * 2, h.offset + e * 2);
        hash.update(u8);
        await w.write(u8);
      }
      await w.commit();
    } catch (e) { await w.abort(); throw e; }
    files.push({
      file: name, path: path.join(outDir, name), segmentId: s.segmentId, slideId: s.slideId, takeId: s.takeId, status: s.status,
      ...(s.reason ? { reason: s.reason } : {}), ...(s.order !== null && s.order !== undefined ? { order: s.order } : {}),
      raw: s.raw, start, end, samples: end - start, sampleRate: h.sampleRate, sec: secOf(end - start, h.sampleRate), sha256: hash.digestHex(),
    });
  }
  ctx.progress('split-takes', segs.length, segs.length);
  return { result: { sessionId, out: outDir, files, issues: an.reduce.issues } };
}
