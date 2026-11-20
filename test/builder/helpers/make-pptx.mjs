// Makes the minimal test decks for the builder tests (owner: D).
//   node test/builder/helpers/make-pptx.mjs --variant simple --out work/D/fixture/deck3.pptx
// simple : 3 slides, one background colour and one huge digit each, notes on every slide.
// mixed  : 5 slides. 1 red, 2 yellow (visible, NOT in the timeline), 3 green, 4 blue,
//          5 grey (hidden in the source deck). Used to test hiding and the hidden flag.
import pptxgen from 'pptxgenjs';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const variant = opt('variant', 'simple');
const out = resolve(opt('out', 'work/D/fixture/deck3.pptx'));

const defs = variant === 'mixed'
  ? [
      { bg: 'DC2828', label: '1', notes: 'First slide narration. 一枚目の原稿です。' },
      { bg: 'F0D020', label: '2', notes: 'Excluded slide (not in the timeline).' },
      { bg: '28A03C', label: '3', notes: 'Third slide.\n二行目のノート。' },
      { bg: '2846DC', label: '4', notes: '' },
      { bg: '808080', label: '5', notes: 'Hidden in the source deck.', hidden: true },
    ]
  : [
      { bg: 'DC2828', label: '1', notes: 'First slide narration. 一枚目の原稿です。' },
      { bg: '28A03C', label: '2', notes: 'Second slide.\n二行目のノート。' },
      { bg: '2846DC', label: '3', notes: '' },
    ];

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 in (16:9)
pres.title = 'lap-narrator builder test deck';
for (const d of defs) {
  const slide = pres.addSlide();
  slide.background = { color: d.bg };
  slide.addText(d.label, {
    x: 0, y: 0, w: 13.333, h: 7.5, fontSize: 300, bold: true, color: 'FFFFFF',
    align: 'center', valign: 'middle', fontFace: 'Arial',
  });
  if (d.notes) slide.addNotes(d.notes);
  if (d.hidden) slide.hidden = true;
}
mkdirSync(dirname(out), { recursive: true });
await pres.writeFile({ fileName: out });
console.log(JSON.stringify({ out, variant, slides: defs.length }));
