// 実際の faster-whisper の出力（work/ にある transcript.json）で boundary review を作り、意図的に誤認識を入れた箇所で flags が付くことを確かめる。
// 素材（work/Q/check1、work/Q/check2、work/G1/ws1 のどれか。無ければ skip）。`npm run test:speech`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { runCli } from '../../cli/narrate.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const PACK = path.join(ROOT, 'examples', 'packs', 'jp15.zip');
const CANDIDATES = ['work/Q/check1', 'work/Q/check2', 'work/G1/ws1', 'work/G1/wsq1'].map((p) => path.join(ROOT, p));
const SRC = CANDIDATES.find((d) => existsSync(path.join(d, 'transcript.json')) && existsSync(path.join(d, 'final', 'all.wav')));
const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';

async function cli(...argv) {
  let out = '';
  const { exitCode } = await runCli(argv.flat(), { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  return { code: exitCode, env: JSON.parse(out.trim().split('\n').at(-1)) };
}
const warn = (cut) => cut.flags.filter((f) => f.severity === 'warn').map((f) => f.code);

test('実際の faster-whisper の transcript：誤認識を入れた切れ目に flags が付き、離れた切れ目には付かない', { skip: !SRC }, async () => {
  const ws = path.join(ROOT, 'work', 'G1', 'test', `rv-real-${process.pid}`);
  await fsp.mkdir(path.join(ws, 'final'), { recursive: true });
  try {
    await fsp.copyFile(path.join(SRC, 'final', 'all.wav'), path.join(ws, 'final', 'all.wav'));
    const tr0 = JSON.parse(await fsp.readFile(path.join(SRC, 'transcript.json'), 'utf8'));
    tr0.audio.file = 'final/all.wav';
    await fsp.writeFile(path.join(ws, 'transcript.json'), JSON.stringify(tr0));
    const al = await cli('align', '--workspace', ws, '--script', PACK);
    assert.ok([0, 4].includes(al.code), JSON.stringify(al.env.errors));
    assert.equal(typeof al.env.result.reviewHint, 'string');
    const base = await cli('boundary', 'review', '--workspace', ws, '--script', PACK, '--format', 'json');
    assert.equal(base.code, 0, JSON.stringify(base.env.errors));
    const cuts0 = base.env.result.cuts;
    assert.equal(cuts0.length, 12);
    for (const c of cuts0) assert.ok(c.transcript.before.length + c.transcript.after.length > 20);
    assert.ok(base.env.result.summary.markdownChars < 6000, `review size ${base.env.result.summary.markdownChars}`);
    const clean = cuts0.filter((c) => c.status === 'auto' && warn(c).length === 0);
    assert.ok(clean.length >= 8, 'most cuts of a real transcript are unflagged');
    // 誤認識を入れる：切れ目の直前 4 秒の語を、別のかなに置き換える
    for (const target of [3, 7]) {
      const sec = cuts0[target].sec;
      const tr = JSON.parse(JSON.stringify(tr0));
      let k = 0;
      for (const w of tr.words) if (sec - 4.4 <= w.start && w.end <= sec - 0.4) w.w = [...w.w].map(() => KANA[(k++ * 7 + 3) % KANA.length]).join('');
      assert.ok(k > 5, 'some words were garbled');
      await fsp.writeFile(path.join(ws, 'transcript.json'), JSON.stringify(tr));
      const r = await cli('boundary', 'review', '--workspace', ws, '--script', PACK, '--format', 'json');
      assert.equal(r.code, 0, JSON.stringify(r.env.errors));
      const flagged = warn(r.env.result.cuts[target]);
      assert.ok(flagged.length > 0, `cut ${target} (${cuts0[target].slideId}) must be flagged after garbling: ${JSON.stringify(r.env.result.cuts[target].flags)}`);
      // 離れた切れ目（3 つ以上先）は、もともと印のなかったものは変わらない
      for (let i = 0; i < cuts0.length; i++) {
        if (Math.abs(i - target) >= 3 && warn(cuts0[i]).length === 0) assert.deepEqual(warn(r.env.result.cuts[i]), [], `far cut ${i} stays unflagged`);
      }
    }
  } finally { await fsp.rm(ws, { recursive: true, force: true }); }
});
