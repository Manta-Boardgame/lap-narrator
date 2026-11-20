// pptxgenjs で、台本の指定（specs/*.json）に対応する pptx を作る。ノート欄に読む文を入れる。
// 作ったあと、zip の中の日付と docProps の時刻を固定して、同じ指定から同じバイト列になるようにする。
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import { slideText } from './script-pack.js';
import { slideColors } from './lib/png.js';

const hex = (rgb) => rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const FIXED = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * @param {object} spec
 * @returns {Promise<Uint8Array>}
 */
export async function buildPptx(spec) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'testgen';
  pptx.company = 'testgen';
  pptx.title = spec.title;
  pptx.subject = 'synthetic test material';
  spec.slides.forEach((s, i) => {
    const order = i + 1;
    const { bg, fg } = slideColors(order);
    const slide = pptx.addSlide();
    slide.background = { color: hex(bg) };
    slide.addText(String(order), { x: 0.5, y: 0.8, w: 9, h: 3, fontSize: 160, bold: true, color: hex(fg), align: 'center', fontFace: 'Arial' });
    slide.addText(s.title, { x: 0.5, y: 0.2, w: 9, h: 0.6, fontSize: 24, color: hex(fg), align: 'center' });
    const notes = s.notes !== undefined ? s.notes : slideText(s);
    if (notes !== '') slide.addNotes(notes);
    if (s.hidden) slide.hidden = true;
  });
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).sort();
  const out = new JSZip();
  const iso = '2026-01-01T00:00:00Z';
  for (const n of names) {
    const f = zip.files[n];
    if (f.dir) continue;
    let data = await f.async('nodebuffer');
    if (n === 'docProps/core.xml') {
      let t = data.toString('utf8');
      t = t.replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g, `$1${iso}$2`);
      data = Buffer.from(t, 'utf8');
    }
    out.file(n, data, { date: FIXED, createFolders: false });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
}
