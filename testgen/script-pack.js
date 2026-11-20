// 台本パック（CONTRACTS.md 1.1）の生成。同じ指定（specs/*.json）から同じバイト列ができる。
import { readFileSync } from 'node:fs';
import { sha256Hex, textHash, scriptHash } from './lib/hash.js';
import { renderSlidePng } from './lib/png.js';
import { writeZip } from './lib/zip.js';

const pad4 = (n) => String(n).padStart(4, '0');

/** @param {string} path */
export function loadSpec(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 指定の中の「textRepeat」を展開して、スライドの文にする。 */
export function slideText(s) {
  if (typeof s.text === 'string') return s.text;
  if (s.textRepeat) return s.textRepeat.unit.repeat(s.textRepeat.times);
  return '';
}

/**
 * @param {object} spec
 * @returns {{script:object, scriptJson:string, images:{path:string,data:Uint8Array}[], zip:Uint8Array, zipSha256:string}}
 */
export function buildScriptPack(spec) {
  const w = spec.image?.width ?? 320;
  const h = spec.image?.height ?? 180;
  const images = [];
  const slides = spec.slides.map((s, i) => {
    const order = i + 1;
    const png = renderSlidePng(order, { width: w, height: h });
    const path = `slides/${pad4(order)}.png`;
    images.push({ path, data: png });
    const slide = {
      slideId: spec.slideIdStyle === 'pptx' ? `s${256 + i}` : `s${pad4(order)}`,
      order,
      title: s.title,
      text: slideText(s),
      recordable: s.recordable,
    };
    if (s.speaker !== undefined) slide.speaker = s.speaker;
    if (s.targetSec !== undefined) slide.targetSec = s.targetSec;
    slide.image = path;
    slide.imageSha256 = sha256Hex(png);
    slide.textHash = textHash(slide);
    return slide;
  });
  const script = {
    format: 'lap-narrator/script',
    version: 1,
    projectId: spec.projectId,
    title: spec.title,
    scriptHash: scriptHash(slides),
    slides,
  };
  const scriptJson = JSON.stringify(script, null, 2) + '\n';
  const zip = writeZip([{ name: 'script.json', data: Buffer.from(scriptJson, 'utf8') }, ...images.map((im) => ({ name: im.path, data: im.data }))]);
  return { script, scriptJson, images, zip, zipSha256: sha256Hex(zip) };
}
