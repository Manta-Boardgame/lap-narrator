// <workspace>/last-build.json：build が成功したときに書く、動画と予定表の場所（verify --workspace が読む）。形式は dev/proposals/C-001.md の 2 章 14。
//   { "format": "lap-narrator/last-build", "version": 1, "method": "B", "video": "out/video.mp4", "timeline": "out/timeline.json", "outDir": "out", "builtAt": "<ISO 8601>" }
// 場所は、作業場の中なら作業場からの相対（/ 区切り）、外なら絶対パス。
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const LAST_BUILD = 'last-build.json';

const toStored = (workspace, p) => {
  const rel = path.relative(workspace, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.resolve(p);
};
const fromStored = (workspace, s) => path.resolve(workspace, s);

export async function writeLastBuild(workspace, { method, video, timeline, outDir }) {
  const doc = {
    format: 'lap-narrator/last-build', version: 1, method,
    video: toStored(workspace, video), timeline: toStored(workspace, timeline), outDir: toStored(workspace, outDir),
    builtAt: new Date().toISOString(),
  };
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.writeFile(path.join(workspace, LAST_BUILD), JSON.stringify(doc, null, 2) + '\n');
}

/** 読めなければ null（無い、壊れている、形が違う） */
export async function readLastBuild(workspace) {
  try {
    const d = JSON.parse((await fsp.readFile(path.join(workspace, LAST_BUILD), 'utf8')).replace(/^﻿/, ''));
    if (!d || d.format !== 'lap-narrator/last-build' || typeof d.video !== 'string' || typeof d.timeline !== 'string') return null;
    return { method: d.method, video: fromStored(workspace, d.video), timeline: fromStored(workspace, d.timeline), outDir: d.outDir ? fromStored(workspace, d.outDir) : null };
  } catch { return null; }
}
