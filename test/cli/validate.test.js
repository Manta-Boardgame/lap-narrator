// validate：形式（schema）とハッシュだけの検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';
import { run, tmpDir, cleanup, writeTinySource, exampleExport, ROOT, EXAMPLES, zipBytes } from './helpers/cli.js';

const T = { timeout: 120000 };

test('見本の台本パック・全記録（zip）・フォルダ・各 JSON はすべて通る', T, async () => {
  const dir = await tmpDir('val');
  try {
    for (const name of ['tiny3', 'tiny3h', 'jp15', 'edge', 'en']) {
      const r = await run('validate', path.join(ROOT, 'examples', 'packs', `${name}.zip`));
      assert.equal(r.code, 0, `${name} ${r.stdout}`);
      assert.equal(r.env.result.ok, true);
      assert.equal(r.env.result.checked[0].schema, 'script');
    }
    const ex = await exampleExport('file-rotate', path.join(dir, 'ex'), { volumeFiles: [['README.txt', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', 'raw/rec-000001.wav'], ['raw/rec-000002.wav']] });
    for (const z of ex.zips) {
      const r = await run('validate', z);
      assert.equal(r.code, 0, r.stdout);
      assert.ok(r.env.result.checked.some((c) => c.schema === 'manifest'));
    }
    assert.equal((await run('validate', ex.index)).code, 0);
    const clean = path.join(dir, 'clean');
    await fsp.mkdir(path.join(clean, 'raw'), { recursive: true });
    for (const n of ['manifest.json', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', 'README.txt', 'raw/rec-000001.wav']) await fsp.copyFile(path.join(EXAMPLES, 'tiny3-full', n), path.join(clean, n));
    const folder = await run('validate', clean);
    assert.equal(folder.code, 0, folder.stdout);
    assert.deepEqual(folder.env.result.checked.map((c) => c.schema).sort(), ['edits', 'events', 'manifest', 'script', 'segments']);
    // 1 つの JSON
    assert.equal((await run('validate', path.join(EXAMPLES, 'tiny3-full', 'segments.json'))).code, 0);
    assert.equal((await run('validate', path.join(EXAMPLES, 'tiny3-full', 'events.jsonl'))).code, 0);
  } finally { await cleanup(dir); }
});

test('台本の textHash／scriptHash の誤りを見つける（終了コード 3）', T, async () => {
  const dir = await tmpDir('val');
  try {
    const good = JSON.parse(readFileSync(path.join(EXAMPLES, 'tiny3-full', 'script.json'), 'utf8'));
    const f = path.join(dir, 'script.json');
    await fsp.writeFile(f, JSON.stringify(good));
    assert.equal((await run('validate', f)).code, 0);
    const bad1 = JSON.parse(JSON.stringify(good));
    bad1.slides[1].text += '！';
    await fsp.writeFile(f, JSON.stringify(bad1));
    let r = await run('validate', f);
    assert.equal(r.code, 3, r.stdout);
    assert.equal(r.env.ok, false);
    assert.equal(r.env.errors[0].code, 'script-hash');
    assert.ok(r.env.result.errors.some((e) => /textHash/.test(e.path)));
    const bad2 = JSON.parse(JSON.stringify(good));
    bad2.scriptHash = '0'.repeat(64);
    await fsp.writeFile(f, JSON.stringify(bad2));
    r = await run('validate', f);
    assert.equal(r.code, 3);
    assert.ok(r.env.result.errors.some((e) => /scriptHash/.test(e.path)));
    // schema の誤り（必須の欠け）
    const bad3 = JSON.parse(JSON.stringify(good));
    delete bad3.title;
    await fsp.writeFile(f, JSON.stringify(bad3));
    r = await run('validate', f);
    assert.equal(r.code, 3);
    assert.equal(r.env.errors[0].code, 'schema-error');
  } finally { await cleanup(dir); }
});

test('zip の中身が manifest と違う、manifest にないファイルがある：ハッシュの不一致（終了コード 3）', T, async () => {
  const dir = await tmpDir('val');
  try {
    const ex = await exampleExport('basic', path.join(dir, 'ex'), {
      mutate: (manifest, vol, datas) => {
        const raw = datas.find(([n]) => n === 'raw/rec-000001.wav')[1].slice();
        raw[200] ^= 1;
        return { manifest, datas: datas.map(([n, d]) => [n, n === 'raw/rec-000001.wav' ? raw : d]) };
      },
    });
    let r = await run('validate', ex.zips[0]);
    assert.equal(r.code, 3, r.stdout);
    assert.ok(r.env.errors.some((e) => e.code === 'hash-mismatch' && /rec-000001/.test(e.message)));
    // フォルダにして、同じ検出
    const unz = path.join(dir, 'unz');
    await fsp.mkdir(path.join(unz, 'raw'), { recursive: true });
    for (const n of ['manifest.json', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', 'README.txt']) await fsp.copyFile(path.join(EXAMPLES, 'basic', n), path.join(unz, n));
    await fsp.copyFile(path.join(EXAMPLES, 'basic', 'raw', 'rec-000001.wav'), path.join(unz, 'raw', 'rec-000001.wav'));
    assert.equal((await run('validate', unz)).code, 0);
    await fsp.appendFile(path.join(unz, 'raw', 'rec-000001.wav'), Buffer.from([0, 0]));
    r = await run('validate', unz);
    assert.equal(r.code, 3);
    assert.match(r.env.errors[0].message, /size/);
    // manifest にないファイル
    const extra = path.join(dir, 'extra.zip');
    const files = ['manifest.json', 'script.json', 'events.jsonl', 'segments.json', 'edits.json', 'README.txt'].map((n) => [n, new Uint8Array(readFileSync(path.join(EXAMPLES, 'basic', n)))]);
    files.push(['raw/rec-000001.wav', new Uint8Array(readFileSync(path.join(EXAMPLES, 'basic', 'raw', 'rec-000001.wav')))], ['stowaway.txt', new TextEncoder().encode('x')]);
    await fsp.writeFile(extra, await zipBytes(files));
    r = await run('validate', extra);
    assert.equal(r.code, 3);
    assert.ok(r.env.result.errors.some((e) => /stowaway/.test(e.message)));
  } finally { await cleanup(dir); }
});

test('events.jsonl の壊れた行、予定表のつながりの誤り、未知の JSON、読めないパス', T, async () => {
  const dir = await tmpDir('val');
  try {
    const ev = path.join(dir, 'events.jsonl');
    await fsp.writeFile(ev, '{"seq":0,"eventId":"e0","type":"session-start","wall":"x","mono":0}\n{"seq":1,"eventId":"bad","type":"nope","wall":"x","mono":0}\n');
    let r = await run('validate', ev);
    assert.equal(r.code, 3);
    assert.ok(r.env.result.errors.some((e) => /line 2/.test(e.path)));
    await fsp.writeFile(ev, '{"seq":0\n');
    r = await run('validate', ev);
    assert.equal(r.code, 3);
    const tl = {
      format: 'lap-narrator/timeline', version: 1, sampleRate: 48000, fps: 30, prePadSamples: 100, postPadSamples: 200, totalSamples: 1000,
      slides: [{ slideId: 's1', order: 1, image: 'a.png', audio: 'a.wav', audioSamples: 500, showStart: 0, audioStart: 100, audioEnd: 600, showEnd: 800 }],
    };
    const tp = path.join(dir, 'timeline.json');
    await fsp.writeFile(tp, JSON.stringify(tl));
    r = await run('validate', tp);
    assert.equal(r.code, 3);
    assert.ok(r.env.result.errors.some((e) => e.path === '/totalSamples'));
    tl.totalSamples = 800;
    await fsp.writeFile(tp, JSON.stringify(tl));
    assert.equal((await run('validate', tp)).code, 0);
    const odd = path.join(dir, 'odd.json');
    await fsp.writeFile(odd, '{"hello":1}');
    r = await run('validate', odd);
    assert.equal(r.code, 3);
    r = await run('validate', odd, '--schema', 'edits');
    assert.equal(r.code, 3);
    assert.equal((await run('validate', odd, '--schema', 'bogus')).code, 2);
    r = await run('validate', path.join(dir, 'nothere.json'));
    assert.equal(r.code, 1);
    assert.equal(r.env.errors[0].code, 'cannot-read');
    assert.equal((await run('validate')).code, 2);
    assert.equal((await run('validate', 'a', 'b')).code, 2);
  } finally { await cleanup(dir); }
});

test('validate は台本パックの画像のハッシュも見る', T, async () => {
  const dir = await tmpDir('val');
  try {
    await writeTinySource(path.join(dir, 'src'));
    const pack = path.join(dir, 'p.zip');
    assert.equal((await run('pack', '--from-json', path.join(dir, 'src'), '--out', pack)).code, 0);
    assert.equal((await run('validate', pack)).code, 0);
    // 画像を差し替えた zip
    const png = new Uint8Array(readFileSync(path.join(dir, 'src', 'slides', '0001.png')));
    const other = png.slice();
    other[other.length - 20] ^= 0x55;
    const packScript = JSON.parse(readFileSync(path.join(EXAMPLES, 'tiny3-full', 'script.json'), 'utf8'));
    for (const s of packScript.slides) { s.image = `slides/${String(s.order).padStart(4, '0')}.png`; }
    const files = [['script.json', new TextEncoder().encode(JSON.stringify(packScript))]];
    for (let i = 1; i <= 3; i++) files.push([`slides/000${i}.png`, i === 1 ? other : new Uint8Array(readFileSync(path.join(dir, 'src', 'slides', `000${i}.png`)))]);
    // imageSha256 がないと照合できないので、本物の画像のハッシュを入れる
    const { sha256Hex } = await import('../../core/sha256.js');
    packScript.slides.forEach((s, i) => { s.imageSha256 = sha256Hex(new Uint8Array(readFileSync(path.join(dir, 'src', 'slides', `000${i + 1}.png`)))); });
    files[0] = ['script.json', new TextEncoder().encode(JSON.stringify(packScript))];
    const bad = path.join(dir, 'bad.zip');
    await fsp.writeFile(bad, await zipBytes(files));
    const r = await run('validate', bad);
    assert.equal(r.code, 3, r.stdout);
    assert.ok(r.env.result.errors.some((e) => e.kind === 'hash-mismatch' && /imageSha256/.test(e.path)));
  } finally { await cleanup(dir); }
});
