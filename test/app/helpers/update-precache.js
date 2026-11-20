// app/sw.js の PRECACHE の一覧を、実在するファイルから作り直す。
//   node test/app/helpers/update-precache.js          （書き換える）
//   node test/app/helpers/update-precache.js --check  （差があれば終了コード 1）
// 対象：app/ の下（sw.js、i18n/、organizer/ を除く）と core/ の .js。
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './static-server.js';

const walk = (dir, accept, out = []) => {
  for (const e of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!(dir === 'app' && ['i18n', 'organizer'].includes(e.name))) walk(rel, accept, out); } else if (accept(rel)) out.push(rel);
  }
  return out;
};

const app = walk('app', (f) => f !== 'app/sw.js').map((f) => `./${f.slice(4)}`);
const core = walk('core', (f) => f.endsWith('.js')).map((f) => `../${f}`);
const shell = ['./', './index.html', './manifest.webmanifest', './styles.css'];
const rest = app.filter((u) => !shell.includes(u));
const body = [...shell, ...rest, ...core].map((u) => `  '${u}',`).join('\n');
const block = `// PRECACHE-BEGIN\nconst PRECACHE = [\n${body}\n];\n// PRECACHE-END`;

const swFile = path.join(REPO_ROOT, 'app', 'sw.js');
const text = fs.readFileSync(swFile, 'utf8');
const next = text.replace(/\/\/ PRECACHE-BEGIN[\s\S]*?\/\/ PRECACHE-END/, block);
if (process.argv.includes('--check')) process.exit(next === text ? 0 : 1);
fs.writeFileSync(swFile, next);
console.log(`PRECACHE: ${shell.length + rest.length + core.length} 件`);
