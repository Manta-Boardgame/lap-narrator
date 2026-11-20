// 試験用の正しい見本（架空の内容）。schema/ の各形式に対して 1 つずつ。
import { textHash, scriptHash } from '../../../core/script.js';

const H = (c) => c.repeat(64);

export function sampleScript() {
  const slides = [
    { slideId: 's256', order: 1, title: '表紙', text: 'これは見本の文です。', recordable: true, speaker: '担当A', targetSec: 12, image: 'slides/0001.png', imageSha256: H('a') },
    { slideId: 's257', order: 2, title: '補足', text: '補足スライド', recordable: false, image: 'slides/0002.png', imageSha256: H('b') },
    { slideId: 's258', order: 3, title: 'まとめ', text: 'Second "quoted" text\nwith newline.', recordable: true, image: 'slides/0003.png' },
  ];
  for (const s of slides) s.textHash = textHash(s);
  return { format: 'lap-narrator/script', version: 1, projectId: 'proj-001', title: '見本の発表', scriptHash: scriptHash(slides), slides };
}

export function sampleManifest() {
  return {
    format: 'lap-narrator/manifest', version: 1, kind: 'full', projectId: 'proj-001', scriptHash: H('c'),
    sessionId: 'sess-0001', exportId: 'exp-0001', volume: 1, volumes: 1, appVersion: '0.0.0',
    speaker: '担当A', device: { ua: 'x' }, mic: { requested: {}, actual: {} },
    rawFiles: [{ file: 'rec-000001', sampleRate: 48000, samples: 96000, sha256: H('d'), durableSamples: 96000 }],
    files: [{ path: 'events.jsonl', bytes: 10, sha256: H('e') }],
    createdAt: '2026-11-16T07:50:00.123Z',
  };
}

export function sampleFinalManifest() {
  return {
    ...sampleManifest(), kind: 'final', rawFiles: undefined,
    renderSpec: { version: 1 },
    finals: [{
      slideId: 's256', takeId: 't0001', samples: 96000, sampleRate: 48000,
      parts: [{ file: 'final/s256.wav', samples: 96000, sha256: H('f') }],
      applied: { gainDb: 0, limiter: 'none', fadeSamples: 384, joinAdjust: [] },
    }],
  };
}

export function sampleEvent() {
  return { seq: 3, eventId: 'e3', type: 'ok', wall: '2026-11-16T07:50:01.000Z', mono: 1000.5, checkpointId: 'c0001', at: { raw: 'rec-000001', sample: 48000, pos: 48000 } };
}

export function sampleSegments() {
  return {
    format: 'lap-narrator/segments', version: 1, sessionId: 'sess-0001',
    segments: [{ segmentId: 'g00001', takeId: 't0001', slideId: 's256', raw: 'rec-000001', start: 0, end: 48000, startSec: 0, endSec: 1, status: 'kept', order: 1 }],
    takes: [{ takeId: 't0001', slideId: 's256', status: 'closed', startSeq: 1, endSeq: 5, segments: ['g00001'], samples: 48000, candidate: true }],
    defaultTakes: { s256: 't0001' },
    recoverable: { pos: 48000, raw: 'rec-000001', sample: 48000, lastCheckpointId: 'c0001' },
    marks: [], issues: [{ code: 'orphan-audio', seq: 4, message: 'x' }],
  };
}

export function sampleEdits() {
  return {
    format: 'lap-narrator/edits', version: 1, sessionId: 'sess-0001', editVersion: 1,
    joins: [{ takeId: 't0003', index: 2, trimPrevEnd: -480, shiftNextStart: 240 }],
    fadeSamples: 384, gainDb: { 'speaker-a': 1.5 }, selections: { s256: 't0003' }, limiter: { ceilingDb: -1.5 },
  };
}

export function sampleTimeline() {
  return {
    format: 'lap-narrator/timeline', version: 1, sampleRate: 48000, fps: 30, prePadSamples: 14400, postPadSamples: 24000,
    slides: [
      { slideId: 's256', order: 1, image: 'slides/0001.png', audio: 'final/s256.wav', audioSamples: 123456, showStart: 0, audioStart: 14400, audioEnd: 137856, showEnd: 161856 },
      { slideId: 's258', order: 3, image: 'slides/0003.png', audio: ['final/s258.p001.wav', 'final/s258.p002.wav'], audioSamples: 1000, showStart: 161856, audioStart: 176256, audioEnd: 177256, showEnd: 201256 },
    ],
    totalSamples: 201256,
  };
}

export function sampleIndex() {
  return {
    format: 'lap-narrator/index', version: 1, exportId: 'exp-0001', kind: 'full', projectId: 'proj-001', sessionId: 'sess-0001', volumes: 1,
    zips: [{ volume: 1, file: 'proj-001_sess-0001_full_v001.zip', bytes: 12345, sha256: H('9') }],
  };
}

export function sampleCliResult() {
  return { ok: true, command: 'import', result: { received: [] }, warnings: [{ code: 'w', message: 'm' }], errors: [] };
}

export function sampleBoundaries() {
  return {
    format: 'lap-narrator/boundaries', version: 1, sampleRate: 48000,
    audio: { file: 'final/all.wav', sha256: H('a'), samples: 300000 },
    transcript: { file: 'transcript.json', sha256: H('b'), model: 'small' },
    script: { scriptHash: H('c') },
    slides: [
      { slideId: 's256', order: 1, startSample: 0, endSample: 180000, confidence: 0.97, method: 'asr-align', status: 'auto', candidates: [{ sample: 180000, score: 0.97 }, { sample: 170000, score: 0.41 }] },
      { slideId: 's258', order: 3, startSample: 180000, endSample: 300000, confidence: 0.5, method: 'interpolated', status: 'needs-decision', candidates: [] },
    ],
  };
}

export function sampleTranscript() {
  return {
    format: 'lap-narrator/transcript', version: 1,
    audio: { file: 'final/all.wav', sha256: H('a'), sampleRate: 48000, samples: 300000 },
    model: 'small', language: 'ja',
    engine: { name: 'faster-whisper', version: '1.2.1', computeType: 'int8', device: 'cpu' },
    words: [{ w: 'これは', start: 0.5, end: 0.9, p: 0.93 }, { w: '試験', start: 0.9, end: 1.3, p: 0.8 }],
    segments: [{ start: 0.5, end: 1.3, text: 'これは試験' }],
    timing: { loadSec: 1.2, transcribeSec: 3.4, audioSec: 6.25, rtf: 0.54 },
  };
}

export const SAMPLES = {
  script: sampleScript, manifest: sampleManifest, events: sampleEvent, segments: sampleSegments,
  edits: sampleEdits, timeline: sampleTimeline, index: sampleIndex, 'cli-result': sampleCliResult,
  boundaries: sampleBoundaries, transcript: sampleTranscript,
};
