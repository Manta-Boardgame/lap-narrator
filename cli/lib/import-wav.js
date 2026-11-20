import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { assembleScript } from './scriptpack.js';
import { createSha256, sha256Hex, createZipWriter } from '../../core/index.js';
import { builderDir, parseJsonOutput, pythonCommand, pythonPath, runProcess, tail, toolExists } from './exec.js';
import { fileExists, openAtomicWrite, streamFile } from './fsutil.js';
import { CliError } from './errors.js';

const encodeJson = (value) => Buffer.from(JSON.stringify(value) + '\n');

export async function prepareWavImport(source, temp) {
  const converter = path.join(builderDir(), 'import-wav.py');
  if (!await fileExists(source)) throw new CliError('cannot-read', `no such WAV file: ${source}`);
  if (!toolExists(pythonPath()) || !toolExists(converter)) {
    throw new CliError('tool-missing', 'WAV import requires Python with PyAV and NumPy; see docs/pc-setup.md');
  }
  const wav = path.join(temp, 'converted.wav');
  const spec = pythonCommand(converter, [source, wav]);
  const conversion = await runProcess(spec.cmd, spec.args, { timeoutMs: 300000 });
  const info = parseJsonOutput(conversion.stdout);
  if (conversion.code !== 0 || info?.sampleRate !== 48000 || !Number.isSafeInteger(info?.samples)) {
    throw new CliError('wav-import-failed', info?.error || 'could not read or resample the WAV', { detail: { stderr: tail(conversion.stderr) } });
  }

  const hash = createSha256();
  const bytes = await streamFile(wav, (chunk) => hash.update(chunk));
  const sha256 = hash.digestHex();
  const id = `wav-${sha256.slice(0, 32)}`;
  const { script } = assembleScript({
    projectId: id,
    title: 'Continuous WAV',
    slides: [{ slideId: 'free', title: 'Continuous WAV', text: '', recordable: true }],
  });
  const scriptBytes = encodeJson(script);
  const file = 'final/free.wav';
  const manifest = {
    format: 'lap-narrator/manifest', version: 1, kind: 'final', projectId: id, scriptHash: script.scriptHash,
    sessionId: id, exportId: id, volume: 1, volumes: 1, appVersion: 'narrate-wav-import',
    recording: 'continuous',
    // No recording date is known. Keep the synthesized archive identical on reimport.
    createdAt: '1970-01-01T00:00:00.000Z',
    files: [{ path: 'script.json', bytes: scriptBytes.length, sha256: sha256Hex(scriptBytes) }, { path: file, bytes, sha256 }],
    finals: [{ slideId: 'free', takeId: 't0001', sampleRate: info.sampleRate, samples: info.samples, parts: [{ file, samples: info.samples, sha256 }] }],
  };
  const zipPath = path.join(temp, `${id}.zip`);
  const output = await openAtomicWrite(zipPath);
  try {
    const zip = createZipWriter({ write: (chunk) => output.write(chunk) });
    await zip.addFile('manifest.json', encodeJson(manifest));
    await zip.addFile('script.json', scriptBytes);
    await zip.addFile(file, wavChunks(wav), { size: bytes });
    await zip.finish();
    await output.commit();
  } catch (error) {
    await output.abort();
    throw error;
  }
  return { zipPath, info: { source, ...info } };
}

async function* wavChunks(file) {
  const fh = await fsp.open(file, 'r');
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const { bytesRead } = await fh.read(buffer);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await fh.close();
  }
}
