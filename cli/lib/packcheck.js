// `--script <pack>` を status／render／build に渡したとき、台本のハッシュで一致を確かめる（設計書 5.1）。
import path from 'node:path';
import { openPack } from './scriptpack.js';
import { CliError, mismatchError } from './errors.js';

export async function checkPackMatches(store, packPath) {
  const pack = await openPack(path.resolve(packPath));
  try {
    const ws = await store.readJson('script.json');
    if (!ws) throw new CliError('no-script', 'the workspace has no script; import it first with: import --script <pack.zip>');
    if (ws.scriptHash !== pack.script.scriptHash) {
      throw mismatchError('script-mismatch', 'the given script pack does not match the workspace script (scriptHash differs)', { workspace: ws.scriptHash, pack: pack.script.scriptHash });
    }
  } finally {
    await pack.close();
  }
}
