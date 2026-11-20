// アプリの「通しで録る」形の台本パック：スライドが 1 枚だけ（slideId は free、題名「通し録音」、文は空）。画像は 1 枚。
import { sha256Hex, textHash, scriptHash } from './lib/hash.js';
import { renderSlidePng } from './lib/png.js';
import { writeZip } from './lib/zip.js';

export function buildFreePack({ projectId = 'jp15_demo', title = '通し録音' } = {}) {
  const png = renderSlidePng(1, { width: 320, height: 180 });
  const slide = { slideId: 'free', order: 1, title, text: '', recordable: true, image: 'slides/0001.png', imageSha256: sha256Hex(png) };
  slide.textHash = textHash(slide);
  const script = { format: 'lap-narrator/script', version: 1, projectId, title, scriptHash: scriptHash([slide]), slides: [slide] };
  const json = JSON.stringify(script, null, 2) + '\n';
  const zip = writeZip([{ name: 'script.json', data: Buffer.from(json, 'utf8') }, { name: 'slides/0001.png', data: png }]);
  return { script, zip };
}
